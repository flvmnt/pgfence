/**
 * Policy checks — migration-level requirements
 *
 * Scans all statements in a file for:
 * 1. SET lock_timeout present and ordered before dangerous DDL
 * 2. SET statement_timeout present
 * 3. SET application_name present (enables pg_stat_activity visibility)
 * 4. SET idle_in_transaction_session_timeout present (prevents orphaned locks)
 * 5. CREATE INDEX CONCURRENTLY not inside BEGIN/COMMIT (will fail)
 * 6. UPDATE inside migration (should be out-of-band)
 * 7. NOT VALID + VALIDATE CONSTRAINT in same transaction (defeats the purpose)
 * 8. Multiple statements after ACCESS EXCLUSIVE lock (compounding danger)
 * 9. Timeout value validation (lock_timeout > threshold = warning)
 *
 * Transaction tracking uses a depth counter (not boolean) for nested BEGIN/COMMIT.
 */

import type { ParsedStatement } from '../parser.js';
import { makePreview } from '../parser.js';
import type { PgfenceConfig, PolicyViolation } from '../types.js';
import type { LockMode } from '../types.js';
import { createTransactionState, processTransactionStmt, recordLock } from '../transaction-state.js';

/**
 * Parse a Postgres timeout string to milliseconds.
 * Supports: '2s', '2000', '2000ms', '5min', '1h', '2 seconds', etc.
 * Returns null if the format is unrecognized.
 */
export function parseTimeoutString(value: string): number | null {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === '0') return 0;

  // Pure numeric — Postgres interprets as milliseconds
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);

  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec|seconds?|min|minutes?|h|hours?)$/);
  if (!match) return null;

  const num = parseFloat(match[1]);
  const unit = match[2];

  if (unit.startsWith('ms') || unit.startsWith('millisecond')) return Math.round(num);
  if (unit.startsWith('s')) return Math.round(num * 1000);
  if (unit.startsWith('min')) return Math.round(num * 60 * 1000);
  if (unit.startsWith('h')) return Math.round(num * 3600 * 1000);

  return null;
}

function parsePostgresTimeoutMs(node: { kind?: string; args?: unknown[] }): { ms: number; raw: string } | null {
  // kind must be VAR_SET_VALUE (not RESET or DEFAULT)
  if (node.kind !== undefined && node.kind !== 'VAR_SET_VALUE') return null;
  if (!node.args || node.args.length === 0) return null;

  const arg = node.args[0] as Record<string, unknown>;

  if (arg.A_Const) {
    const aConst = arg.A_Const as { ival?: { ival: number }; sval?: { sval: string } };
    if (aConst.ival !== undefined) {
      return { ms: aConst.ival.ival, raw: String(aConst.ival.ival) };
    }
    if (aConst.sval?.sval) {
      const ms = parseTimeoutString(aConst.sval.sval);
      if (ms !== null) return { ms, raw: aConst.sval.sval };
    }
  }

  return null;
}

export function checkPolicies(
  stmts: ParsedStatement[],
  config: PgfenceConfig,
  options?: { autoCommit?: boolean },
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];

  // Index-based tracking for ordering validation (Gap 2)
  let lockTimeoutIndex = -1;
  let statementTimeoutIndex = -1;
  let hasApplicationName = false;
  let hasIdleTimeout = false;

  // Gap 12: Transaction state machine (replaces txDepth counter)
  const txState = createTransactionState();

  // Track first dangerous statement position for ordering validation
  let firstDangerousIndex = -1;
  let firstDangerousSql = '';

  // Track ACCESS EXCLUSIVE for compounding danger detection (Eugene's E4)
  let hasAccessExclusive = false;
  let accessExclusiveStmt: string | null = null;

  // Track NOT VALID constraints in current transaction for same-tx validate detection
  const notValidConstraintsInTx: Set<string> = new Set();

  for (let i = 0; i < stmts.length; i++) {
    const stmt = stmts[i];

    // Track VariableSetStmt
    if (stmt.nodeType === 'VariableSetStmt') {
      const node = stmt.node as { name: string; kind?: string; args?: unknown[] };
      switch (node.name) {
        case 'lock_timeout': {
          if (lockTimeoutIndex === -1 && node.kind !== 'VAR_RESET' && node.kind !== 'VAR_SET_DEFAULT') {
            lockTimeoutIndex = i;
          }
          // Gap 5: timeout value validation
          const parsed = parsePostgresTimeoutMs(node);
          const threshold = config.maxLockTimeoutMs ?? 5000;
          if (parsed !== null && parsed.ms > threshold) {
            violations.push({
              ruleId: 'lock-timeout-too-long',
              message: `lock_timeout is set to ${parsed.ms}ms ('${parsed.raw}') — exceeds recommended maximum of ${threshold}ms. A long lock_timeout means ACCESS EXCLUSIVE locks will block all reads and writes for up to ${parsed.ms}ms`,
              suggestion: `Reduce lock_timeout to ${threshold}ms or less. If the DDL needs more time, split it into smaller operations`,
              severity: 'warning',
            });
          }
          break;
        }
        case 'statement_timeout': {
          if (statementTimeoutIndex === -1 && node.kind !== 'VAR_RESET' && node.kind !== 'VAR_SET_DEFAULT') {
            statementTimeoutIndex = i;
          }
          const parsed = parsePostgresTimeoutMs(node);
          const threshold = config.maxStatementTimeoutMs ?? 600000;
          if (parsed !== null && parsed.ms > threshold) {
            violations.push({
              ruleId: 'statement-timeout-too-long',
              message: `statement_timeout is set to ${parsed.ms}ms ('${parsed.raw}') — exceeds recommended maximum of ${threshold}ms`,
              suggestion: `Reduce statement_timeout to ${threshold}ms or less`,
              severity: 'warning',
            });
          }
          break;
        }
        case 'application_name':
          hasApplicationName = true;
          break;
        case 'idle_in_transaction_session_timeout':
          hasIdleTimeout = true;
          break;
      }
    }

    // Gap 12: Transaction state machine (replaces simple txDepth counter)
    if (stmt.nodeType === 'TransactionStmt') {
      const node = stmt.node as { kind: string; savepoint_name?: string; options?: Array<{ DefElem?: { defname: string; arg?: { String?: { sval: string } } } }> };
      const savepointName = node.savepoint_name ??
        node.options?.find((o) => o.DefElem?.defname === 'savepoint_name')?.DefElem?.arg?.String?.sval;

      const wasActive = txState.active;
      processTransactionStmt(txState, node.kind, savepointName);

      // Reset per-transaction state on commit/rollback
      if (wasActive && !txState.active) {
        hasAccessExclusive = false;
        accessExclusiveStmt = null;
        notValidConstraintsInTx.clear();
      }
    }

    // Track ACCESS EXCLUSIVE statements for compounding danger (Eugene E4)
    // Also track the first dangerous statement for ordering validation (Gap 2)
    if (isAccessExclusiveStatement(stmt)) {
      // Track first dangerous statement position
      if (firstDangerousIndex === -1) {
        firstDangerousIndex = i;
        firstDangerousSql = makePreview(stmt.sql, 60);
      }

      // Compounding danger detection
      // Skip when autoCommit is true (e.g. TypeORM transaction = false) since
      // each statement auto-commits and locks don't compound across statements.
      if (!options?.autoCommit) {
        if (hasAccessExclusive) {
          violations.push({
            ruleId: 'statement-after-access-exclusive',
            message: `Multiple statements holding ACCESS EXCLUSIVE lock in same transaction — "${makePreview(stmt.sql, 60)}" runs while ACCESS EXCLUSIVE is already held from "${accessExclusiveStmt}". This compounds the lock duration, blocking all reads and writes for the entire transaction.`,
            suggestion: 'Split into separate transactions so each ACCESS EXCLUSIVE lock is held for the minimum time',
            severity: 'warning',
          });
        } else {
          hasAccessExclusive = true;
          accessExclusiveStmt = makePreview(stmt.sql, 60);
        }
      }
    }

    // Gap 12: Record locks in transaction state and detect wide lock windows
    if (txState.active && !options?.autoCommit) {
      const tableName = getStatementTable(stmt);
      const lockMode = getStatementLockMode(stmt);
      if (tableName && lockMode) {
        const result = recordLock(txState, tableName, lockMode);
        if (result.wideLockWindow) {
          violations.push({
            ruleId: 'wide-lock-window',
            message: `Wide lock window — ACCESS EXCLUSIVE locks held on multiple tables ("${result.previousTable}" and "${tableName}") in the same transaction. This multiplies the blast radius of lock contention.`,
            suggestion: 'Split operations on different tables into separate transactions to minimize lock overlap',
            severity: 'warning',
          });
        }
      }
    }

    // Track NOT VALID constraints and detect same-tx VALIDATE.
    // Only track within explicit transactions (txState.active).
    // Without explicit BEGIN, each statement is auto-committed so
    // NOT VALID followed by VALIDATE in sequence is fine.
    if (stmt.nodeType === 'AlterTableStmt' && txState.active) {
      const alterNode = stmt.node as {
        relation: { relname: string };
        cmds: Array<{
          AlterTableCmd: {
            subtype: string;
            name?: string;
            def?: { Constraint?: { skip_validation?: boolean; conname?: string } };
          };
        }>;
      };
      const tbl = alterNode.relation?.relname ?? '';
      for (const cmd of alterNode.cmds ?? []) {
        const c = cmd.AlterTableCmd;
        // Track ADD CONSTRAINT ... NOT VALID
        if (c.subtype === 'AT_AddConstraint' && c.def?.Constraint?.skip_validation === true) {
          const key = `${tbl}.${c.def.Constraint.conname ?? c.name ?? ''}`;
          notValidConstraintsInTx.add(key);
        }
        // Detect VALIDATE CONSTRAINT on a NOT VALID constraint in same tx
        if (c.subtype === 'AT_ValidateConstraint' && c.name) {
          const key = `${tbl}.${c.name}`;
          if (notValidConstraintsInTx.has(key)) {
            violations.push({
              ruleId: 'not-valid-validate-same-tx',
              message: `NOT VALID + VALIDATE CONSTRAINT "${c.name}" in same transaction — this defeats the purpose of NOT VALID because the table scan runs while the ACCESS EXCLUSIVE lock from ADD CONSTRAINT is still held`,
              suggestion: `Split into separate migrations: add the constraint with NOT VALID in one migration, then VALIDATE CONSTRAINT in a follow-up migration`,
              severity: 'error',
            });
          }
        }
      }
    }

    // CONCURRENTLY inside transaction → error
    if (stmt.nodeType === 'IndexStmt') {
      const node = stmt.node as { concurrent?: boolean };
      if (node.concurrent === true && txState.active) {
        violations.push({
          ruleId: 'concurrent-in-transaction',
          message: 'CREATE INDEX CONCURRENTLY inside a transaction — this will fail at runtime',
          suggestion: 'Run CONCURRENTLY operations outside of BEGIN/COMMIT blocks',
          severity: 'error',
        });
      }
    }

    // UPDATE inside migration → warning (only flag bulk updates without WHERE)
    if (stmt.nodeType === 'UpdateStmt') {
      const updateNode = stmt.node as { whereClause?: unknown };
      const hasWhere = updateNode.whereClause && typeof updateNode.whereClause === 'object' && Object.keys(updateNode.whereClause as Record<string, unknown>).length > 0;
      if (!hasWhere) {
        violations.push({
          ruleId: 'update-in-migration',
          message: 'UPDATE without WHERE in migration — bulk backfills should run out-of-band in batches',
          suggestion: 'Move data backfill to an out-of-band job using batched UPDATE with FOR UPDATE SKIP LOCKED',
          severity: 'warning',
        });
      }
    }
  }

  // Gap 2: lock_timeout ordering validation
  if (lockTimeoutIndex >= 0 && firstDangerousIndex >= 0 && firstDangerousIndex < lockTimeoutIndex) {
    violations.push({
      ruleId: 'lock-timeout-after-dangerous-statement',
      message: `SET lock_timeout appears AFTER the first ACCESS EXCLUSIVE statement ("${firstDangerousSql}") — the dangerous DDL runs without timeout protection`,
      suggestion: "Move SET lock_timeout = '2s'; to the very start of the migration, before any DDL statements",
      severity: 'error',
    });
  }

  // Check required policies
  if (config.requireLockTimeout && lockTimeoutIndex === -1) {
    violations.push({
      ruleId: 'missing-lock-timeout',
      message: 'Missing SET lock_timeout — without this, an ACCESS EXCLUSIVE lock will queue behind running queries and every new query queues behind it, causing a lock queue death spiral',
      suggestion: "Add SET lock_timeout = '2s'; at the start of the migration",
      severity: 'error',
    });
  }

  if (config.requireStatementTimeout && statementTimeoutIndex === -1) {
    violations.push({
      ruleId: 'missing-statement-timeout',
      message: 'Missing SET statement_timeout — long-running operations can block other queries indefinitely',
      suggestion: "Add SET statement_timeout = '5min'; at the start of the migration",
      severity: 'warning',
    });
  }

  if (!hasApplicationName) {
    violations.push({
      ruleId: 'missing-application-name',
      message: 'Missing SET application_name — makes it harder to identify migration locks in pg_stat_activity',
      suggestion: "Add SET application_name = 'migrate:<migration_name>';",
      severity: 'warning',
    });
  }

  if (!hasIdleTimeout) {
    violations.push({
      ruleId: 'missing-idle-timeout',
      message: 'Missing SET idle_in_transaction_session_timeout — orphaned connections with open transactions can hold locks indefinitely',
      suggestion: "Add SET idle_in_transaction_session_timeout = '30s';",
      severity: 'warning',
    });
  }

  return violations;
}

/**
 * Determines whether a statement takes an ACCESS EXCLUSIVE lock.
 * Used for compounding danger detection (Eugene's E4 pattern).
 */
function isAccessExclusiveStatement(stmt: ParsedStatement): boolean {
  switch (stmt.nodeType) {
    case 'AlterTableStmt': {
      // Only flag ALTER TABLE commands that hold ACCESS EXCLUSIVE for a significant duration.
      // Nullable ADD COLUMN and NOT VALID constraints are instant — skip them.
      const node = stmt.node as {
        cmds: Array<{
          AlterTableCmd: {
            subtype: string;
            def?: {
              Constraint?: { skip_validation?: boolean };
              PartitionCmd?: { concurrent?: boolean };
            };
          };
        }>;
      };
      for (const cmd of node.cmds ?? []) {
        const sub = cmd.AlterTableCmd?.subtype;
        // VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE — skip
        if (sub === 'AT_ValidateConstraint') continue;
        // ADD COLUMN is technically ACCESS EXCLUSIVE but instant — skip
        if (sub === 'AT_AddColumn') continue;
        // ADD CONSTRAINT with NOT VALID is brief (metadata only) — skip
        if (sub === 'AT_AddConstraint' && cmd.AlterTableCmd.def?.Constraint?.skip_validation === true) continue;
        // ENABLE/DISABLE TRIGGER takes SHARE ROW EXCLUSIVE — skip
        if (sub === 'AT_EnableTrig' || sub === 'AT_DisableTrig' ||
          sub === 'AT_EnableTrigAll' || sub === 'AT_DisableTrigAll' ||
          sub === 'AT_EnableTrigUser' || sub === 'AT_DisableTrigUser') continue;
        // DETACH PARTITION CONCURRENTLY takes SHARE UPDATE EXCLUSIVE — skip
        if (sub === 'AT_DetachPartition' && cmd.AlterTableCmd.def?.PartitionCmd?.concurrent === true) continue;
        // These subtypes hold ACCESS EXCLUSIVE for significant duration
        if (sub === 'AT_DropColumn' ||
          sub === 'AT_AlterColumnType' || sub === 'AT_SetNotNull' ||
          sub === 'AT_AddConstraint' || sub === 'AT_DropConstraint' ||
          sub === 'AT_AttachPartition' || sub === 'AT_DetachPartition') {
          return true;
        }
      }
      return false;
    }
    case 'DropStmt': {
      const node = stmt.node as { removeType: string };
      return node.removeType === 'OBJECT_TABLE' || node.removeType === 'OBJECT_INDEX' || node.removeType === 'OBJECT_TRIGGER';
    }
    case 'TruncateStmt':
      return true;
    case 'RenameStmt':
      return true;
    case 'CreateTrigStmt':
      return true;
    case 'ReindexStmt': {
      const node = stmt.node as { params?: Array<{ DefElem: { defname: string } }> };
      return !(node.params ?? []).some((p) => p.DefElem?.defname === 'concurrently');
    }
    case 'RefreshMatViewStmt': {
      const node = stmt.node as { concurrent?: boolean };
      return node.concurrent !== true;
    }
    default:
      return false;
  }
}

/**
 * Extract the primary table name from a statement (for lock tracking).
 */
function getStatementTable(stmt: ParsedStatement): string | null {
  switch (stmt.nodeType) {
    case 'AlterTableStmt': {
      const n = stmt.node as { relation?: { relname?: string } };
      return n.relation?.relname?.toLowerCase() ?? null;
    }
    case 'IndexStmt': {
      const n = stmt.node as { relation?: { relname?: string } };
      return n.relation?.relname?.toLowerCase() ?? null;
    }
    case 'DropStmt': {
      const n = stmt.node as { objects?: unknown[]; removeType?: string };
      if (n.removeType === 'OBJECT_TABLE' && Array.isArray(n.objects) && n.objects.length > 0) {
        const obj = n.objects[0] as { List?: { items?: Array<{ String?: { sval: string } }> } };
        const items = obj.List?.items;
        if (items && items.length > 0) {
          return items[items.length - 1].String?.sval?.toLowerCase() ?? null;
        }
      }
      return null;
    }
    case 'TruncateStmt': {
      const n = stmt.node as { relations?: Array<{ RangeVar?: { relname?: string } }> };
      if (n.relations && n.relations.length > 0) {
        return n.relations[0].RangeVar?.relname?.toLowerCase() ?? null;
      }
      return null;
    }
    case 'CreateTrigStmt': {
      const n = stmt.node as { relation?: { relname?: string } };
      return n.relation?.relname?.toLowerCase() ?? null;
    }
    case 'RenameStmt': {
      const n = stmt.node as { relation?: { relname?: string } };
      return n.relation?.relname?.toLowerCase() ?? null;
    }
    case 'RefreshMatViewStmt': {
      const n = stmt.node as { relation?: { relname?: string } };
      return n.relation?.relname?.toLowerCase() ?? null;
    }
    default:
      return null;
  }
}

/**
 * Determine the lock mode a statement acquires (simplified for tracking).
 */
function getStatementLockMode(stmt: ParsedStatement): LockMode | null {
  if (isAccessExclusiveStatement(stmt)) return 'ACCESS EXCLUSIVE' as LockMode;

  switch (stmt.nodeType) {
    case 'IndexStmt': {
      const n = stmt.node as { concurrent?: boolean };
      return n.concurrent ? ('SHARE UPDATE EXCLUSIVE' as LockMode) : ('SHARE' as LockMode);
    }
    case 'UpdateStmt':
      return 'ROW EXCLUSIVE' as LockMode;
    default:
      return null;
  }
}
