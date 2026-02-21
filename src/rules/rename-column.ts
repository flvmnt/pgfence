/**
 * Rule: RENAME checks
 *
 * Detects:
 * - ALTER TABLE ... RENAME COLUMN (ACCESS EXCLUSIVE, but instant on PG14+)
 * - ALTER TABLE ... RENAME TO (ACCESS EXCLUSIVE, breaks all client references)
 *
 * AST node: RenameStmt with renameType === 'OBJECT_COLUMN' or 'OBJECT_TABLE'
 */

import type { ParsedStatement } from '../parser.js';
import type { CheckResult, PgfenceConfig } from '../types.js';
import { LockMode, RiskLevel, getBlockedOperations } from '../types.js';
import { makePreview } from '../parser.js';

export function checkRenameColumn(
  stmt: ParsedStatement,
  _config: PgfenceConfig,
): CheckResult[] {
  if (stmt.nodeType !== 'RenameStmt') return [];

  const node = stmt.node as {
    renameType: string;
    relation?: { relname: string };
    subname?: string;
    newname?: string;
  };

  const results: CheckResult[] = [];
  const tableName = node.relation?.relname ?? null;

  if (node.renameType === 'OBJECT_COLUMN') {
    const oldName = node.subname ?? '<unknown>';
    const newName = node.newname ?? '<unknown>';
    results.push({
      statement: stmt.sql,
      statementPreview: makePreview(stmt.sql),
      tableName,
      lockMode: LockMode.ACCESS_EXCLUSIVE,
      blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
      risk: RiskLevel.LOW,
      message: `RENAME COLUMN "${oldName}" TO "${newName}" — acquires ACCESS EXCLUSIVE lock (instant metadata-only on PG14+)`,
      ruleId: 'rename-column',
      safeRewrite: {
        description:
          'Instant on PG14+. On older versions, use expand/contract: add new column, migrate reads, drop old.',
        steps: [
          `-- PG14+: This is instant (metadata-only), generally safe for short-lived lock`,
          `-- Pre-PG14 expand/contract:`,
          `ALTER TABLE ${tableName} ADD COLUMN ${newName} <type>;`,
          `-- Backfill ${newName} from ${oldName} in batches`,
          `-- Update application to read from ${newName}`,
          `-- Drop old column after verification`,
        ],
      },
    });
  }

  if (node.renameType === 'OBJECT_TABLE') {
    const oldName = tableName ?? '<unknown>';
    const newName = node.newname ?? '<unknown>';
    results.push({
      statement: stmt.sql,
      statementPreview: makePreview(stmt.sql),
      tableName,
      lockMode: LockMode.ACCESS_EXCLUSIVE,
      blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
      risk: RiskLevel.HIGH,
      message: `RENAME TABLE "${oldName}" TO "${newName}" — acquires ACCESS EXCLUSIVE lock and breaks all queries, views, and foreign keys referencing the old name`,
      ruleId: 'rename-table',
      safeRewrite: {
        description: 'Use a view to maintain backwards compatibility during transition',
        steps: [
          `-- 1. Rename the table:`,
          `ALTER TABLE ${oldName} RENAME TO ${newName};`,
          `-- 2. Create a view with the old name for backwards compatibility:`,
          `CREATE VIEW ${oldName} AS SELECT * FROM ${newName};`,
          `-- 3. Migrate all application references to the new name`,
          `-- 4. Drop the view after all references are updated`,
        ],
      },
    });
  }

  return results;
}
