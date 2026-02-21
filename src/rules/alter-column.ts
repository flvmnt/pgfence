/**
 * Rule: ALTER COLUMN checks
 *
 * Detects:
 * - ALTER COLUMN TYPE (table rewrite, ACCESS EXCLUSIVE)
 * - ALTER COLUMN SET NOT NULL (ACCESS EXCLUSIVE, full table scan)
 */

import type { ParsedStatement } from '../parser.js';
import type { CheckResult, PgfenceConfig } from '../types.js';
import { LockMode, RiskLevel, getBlockedOperations } from '../types.js';
import { makePreview } from '../parser.js';

interface AlterTableCmd {
  AlterTableCmd: {
    subtype: string;
    name?: string;
    behavior: string;
  };
}

export function checkAlterColumn(
  stmt: ParsedStatement,
  _config: PgfenceConfig,
): CheckResult[] {
  if (stmt.nodeType !== 'AlterTableStmt') return [];

  const node = stmt.node as {
    relation: { relname: string };
    cmds: AlterTableCmd[];
  };

  const results: CheckResult[] = [];
  const tableName = node.relation?.relname ?? null;

  for (const cmd of node.cmds ?? []) {
    const c = cmd.AlterTableCmd;

    if (c.subtype === 'AT_AlterColumnType') {
      const colName = c.name ?? '<unknown>';
      results.push({
        statement: stmt.sql,
        statementPreview: makePreview(stmt.sql),
        tableName,
        lockMode: LockMode.ACCESS_EXCLUSIVE,
        blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
        risk: RiskLevel.HIGH,
        message: `ALTER COLUMN "${colName}" TYPE — rewrites the entire table under ACCESS EXCLUSIVE lock`,
        ruleId: 'alter-column-type',
        safeRewrite: {
          description: 'Use expand/contract pattern: add new column, backfill, swap',
          steps: [
            `-- 1. Add new column with target type`,
            `ALTER TABLE ${tableName} ADD COLUMN ${colName}_new <new_type>;`,
            `-- 2. Backfill out-of-band in batches`,
            `-- UPDATE ${tableName} SET ${colName}_new = ${colName}::new_type WHERE ${colName}_new IS NULL LIMIT 1000;`,
            `-- 3. Swap columns (application-level)`,
            `-- 4. Drop old column after verification`,
          ],
        },
      });
    }

    if (c.subtype === 'AT_SetNotNull') {
      const colName = c.name ?? '<unknown>';
      results.push({
        statement: stmt.sql,
        statementPreview: makePreview(stmt.sql),
        tableName,
        lockMode: LockMode.ACCESS_EXCLUSIVE,
        blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
        risk: RiskLevel.MEDIUM,
        message: `ALTER COLUMN "${colName}" SET NOT NULL — scans entire table under ACCESS EXCLUSIVE lock`,
        ruleId: 'alter-column-set-not-null',
        safeRewrite: {
          description: 'Use CHECK constraint NOT VALID + VALIDATE to avoid full table lock',
          steps: [
            `ALTER TABLE ${tableName} ADD CONSTRAINT chk_${colName}_nn CHECK (${colName} IS NOT NULL) NOT VALID;`,
            `ALTER TABLE ${tableName} VALIDATE CONSTRAINT chk_${colName}_nn;`,
            `ALTER TABLE ${tableName} ALTER COLUMN ${colName} SET NOT NULL;`,
            `ALTER TABLE ${tableName} DROP CONSTRAINT chk_${colName}_nn;`,
          ],
        },
      });
    }
  }

  return results;
}
