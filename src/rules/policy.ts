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
 *
 * Transaction tracking uses a depth counter (not boolean) for nested BEGIN/COMMIT.
 */

import type { ParsedStatement } from '../parser.js';
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
