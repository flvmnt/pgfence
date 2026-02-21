/**
 * Policy checks — migration-level requirements
 *
 * Scans all statements in a file for:
 * 1. SET lock_timeout present (prevents lock queue death spiral)
 * 2. SET statement_timeout present (prevents runaway operations)
 * 3. SET application_name present (enables pg_stat_activity visibility)
 * 4. SET idle_in_transaction_session_timeout present (prevents orphaned locks)
 * 5. CREATE INDEX CONCURRENTLY not inside BEGIN/COMMIT (will fail)
 * 6. UPDATE inside migration (should be out-of-band)
 * 7. NOT VALID + VALIDATE CONSTRAINT in same transaction (defeats the purpose)
 * 8. Multiple statements after ACCESS EXCLUSIVE lock (compounding danger)
 *
 * Transaction tracking uses a depth counter (not boolean) for nested BEGIN/COMMIT.
 */

import type { ParsedStatement } from '../parser.js';
import { makePreview } from '../parser.js';
import type { PgfenceConfig, PolicyViolation } from '../types.js';

export function checkPolicies(
  stmts: ParsedStatement[],
  config: PgfenceConfig,
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];

  let hasLockTimeout = false;
  let hasStatementTimeout = false;
  let hasApplicationName = false;
  let hasIdleTimeout = false;
  let txDepth = 0;

  // Track ACCESS EXCLUSIVE for compounding danger detection (Eugene's E4)
  let hasAccessExclusive = false;
  let accessExclusiveStmt: string | null = null;

  // Track NOT VALID constraints in current transaction for same-tx validate detection
  const notValidConstraintsInTx: Set<string> = new Set();

  for (const stmt of stmts) {
    // Track VariableSetStmt
    if (stmt.nodeType === 'VariableSetStmt') {
      const node = stmt.node as { name: string };
      switch (node.name) {
        case 'lock_timeout':
          hasLockTimeout = true;
          break;
        case 'statement_timeout':
          hasStatementTimeout = true;
          break;
        case 'application_name':
          hasApplicationName = true;
          break;
        case 'idle_in_transaction_session_timeout':
          hasIdleTimeout = true;
          break;
      }
    }

    // Track transaction depth
    if (stmt.nodeType === 'TransactionStmt') {
      const node = stmt.node as { kind: string };
      if (node.kind === 'TRANS_STMT_BEGIN' || node.kind === 'TRANS_STMT_START') {
        txDepth++;
      } else if (node.kind === 'TRANS_STMT_COMMIT' || node.kind === 'TRANS_STMT_ROLLBACK') {
        txDepth = Math.max(0, txDepth - 1);
        // Reset per-transaction state on commit/rollback
        hasAccessExclusive = false;
        accessExclusiveStmt = null;
        notValidConstraintsInTx.clear();
      }
    }

    // Track ACCESS EXCLUSIVE statements for compounding danger (Eugene E4)
    // These are statements that take ACCESS EXCLUSIVE on existing tables
    if (isAccessExclusiveStatement(stmt)) {
      if (hasAccessExclusive) {
        // Second ACCESS EXCLUSIVE statement in same transaction — compounding danger
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

    // Track NOT VALID constraints and detect same-tx VALIDATE.
    // Only track within explicit transactions (txDepth > 0).
    // Without explicit BEGIN, each statement is auto-committed so
    // NOT VALID followed by VALIDATE in sequence is fine.
    if (stmt.nodeType === 'AlterTableStmt' && txDepth > 0) {
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
      if (node.concurrent === true && txDepth > 0) {
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

  // Check required policies
  if (config.requireLockTimeout && !hasLockTimeout) {
    violations.push({
      ruleId: 'missing-lock-timeout',
      message: 'Missing SET lock_timeout — without this, an ACCESS EXCLUSIVE lock will queue behind running queries and every new query queues behind it, causing a lock queue death spiral',
      suggestion: "Add SET lock_timeout = '2s'; at the start of the migration",
      severity: 'error',
    });
  }

  if (config.requireStatementTimeout && !hasStatementTimeout) {
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
            def?: { Constraint?: { skip_validation?: boolean } };
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
        // These subtypes hold ACCESS EXCLUSIVE for significant duration
        if (sub === 'AT_DropColumn' ||
            sub === 'AT_AlterColumnType' || sub === 'AT_SetNotNull' ||
            sub === 'AT_AddConstraint' || sub === 'AT_DropConstraint') {
          return true;
        }
      }
      return false;
    }
    case 'DropStmt': {
      const node = stmt.node as { removeType: string };
      return node.removeType === 'OBJECT_TABLE' || node.removeType === 'OBJECT_INDEX';
    }
    case 'TruncateStmt':
      return true;
    case 'RenameStmt':
      return true;
    default:
      return false;
  }
}
