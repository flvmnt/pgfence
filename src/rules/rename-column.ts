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
  config: PgfenceConfig,
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
    const safeRewrite = config.minPostgresVersion < 14
      ? {
          description: 'Pre-PG14: RENAME COLUMN still takes ACCESS EXCLUSIVE lock, so plan a maintenance window or use expand/contract.',
          steps: [
            `-- Pre-PG14, there is no non-blocking alternative for RENAME COLUMN.`,
            `-- Use expand/contract if you need a zero-downtime migration: add the new column, backfill, switch reads, then drop the old column.`,
          ],
        }
      : undefined;

    results.push({
      statement: stmt.sql,
      statementPreview: makePreview(stmt.sql),
      tableName,
      lockMode: LockMode.ACCESS_EXCLUSIVE,
      blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
      risk: RiskLevel.LOW,
      message: config.minPostgresVersion >= 14
        ? `RENAME COLUMN "${oldName}" TO "${newName}": instant metadata-only (ACCESS EXCLUSIVE lock is brief)`
        : `RENAME COLUMN "${oldName}" TO "${newName}": acquires ACCESS EXCLUSIVE lock`,
      ruleId: 'rename-column',
      ...(safeRewrite ? { safeRewrite } : {}),
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
      message: `RENAME TABLE "${oldName}" TO "${newName}": acquires ACCESS EXCLUSIVE lock and breaks all queries, views, and foreign keys referencing the old name`,
      ruleId: 'rename-table',
      safeRewrite: {
        description: 'Use a view to maintain backwards compatibility during transition',
        steps: [
          `-- 1. Rename the table:`,
          `ALTER TABLE ${oldName} RENAME TO ${newName};`,
          `-- 2. Create a view with the old name for backwards compatibility:`,
          `CREATE VIEW ${oldName} AS SELECT * FROM ${newName};`,
          `-- This simple view is auto-updatable: SELECT, INSERT, UPDATE, DELETE all work through it.`,
          `-- 3. Migrate all application references to the new name`,
          `-- 4. Drop the view after all references are updated`,
        ],
      },
    });
  }

  if (node.renameType === 'OBJECT_SCHEMA') {
    const oldName = node.subname ?? '<unknown>';
    const newName = node.newname ?? '<unknown>';
    results.push({
      statement: stmt.sql,
      statementPreview: makePreview(stmt.sql),
      tableName: null,
      lockMode: LockMode.ACCESS_EXCLUSIVE,
      blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
      risk: RiskLevel.HIGH,
      message: `RENAME SCHEMA "${oldName}" TO "${newName}": acquires ACCESS EXCLUSIVE lock and breaks all schema-qualified queries, views, functions, and ORM configs that reference "${oldName}"`,
      ruleId: 'rename-schema',
      safeRewrite: {
        description: 'Schema renames have no non-blocking alternative. Prefer creating a new schema and migrating objects.',
        steps: [
          `-- Create the target schema first, then migrate objects one by one.`,
          `-- Move tables, views, and functions with ALTER ... SET SCHEMA.`,
          `-- Update application code, ORM configs, and connection strings to use "${newName}".`,
          `-- Drop the old schema only after all references to "${oldName}" are gone.`,
        ],
      },
    });
  }

  return results;
}
