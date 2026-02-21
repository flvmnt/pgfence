/**
 * Rule: RENAME COLUMN check
 *
 * Detects:
 * - ALTER TABLE ... RENAME COLUMN (ACCESS EXCLUSIVE, but instant on PG14+)
 *
 * AST node: RenameStmt with renameType === 'OBJECT_COLUMN'
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

  if (node.renameType !== 'OBJECT_COLUMN') return [];

  const tableName = node.relation?.relname ?? null;
  const oldName = node.subname ?? '<unknown>';
  const newName = node.newname ?? '<unknown>';

  return [
    {
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
    },
  ];
}
