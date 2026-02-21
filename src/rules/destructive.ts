/**
 * Rule: Destructive operation checks
 *
 * Detects:
 * - DROP TABLE (ACCESS EXCLUSIVE, CRITICAL)
 * - TRUNCATE (ACCESS EXCLUSIVE, CRITICAL)
 * - DELETE without WHERE (ROW EXCLUSIVE, HIGH)
 * - VACUUM FULL (ACCESS EXCLUSIVE, HIGH)
 */

import type { ParsedStatement } from '../parser.js';
import type { CheckResult } from '../types.js';
import { LockMode, RiskLevel, getBlockedOperations } from '../types.js';
import { makePreview } from '../parser.js';

export function checkDestructive(stmt: ParsedStatement): CheckResult[] {
  const results: CheckResult[] = [];

  switch (stmt.nodeType) {
    case 'DropStmt': {
      const node = stmt.node as {
        objects: Array<{ List: { items: Array<{ String: { sval: string } }> } }>;
        removeType: string;
      };
      if (node.removeType !== 'OBJECT_TABLE') break;

      const tableName = extractDropTableName(node.objects);
      results.push({
        statement: stmt.sql,
        statementPreview: makePreview(stmt.sql),
        tableName,
        lockMode: LockMode.ACCESS_EXCLUSIVE,
        blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
        risk: RiskLevel.CRITICAL,
        message: `DROP TABLE "${tableName}" — irreversible data loss, acquires ACCESS EXCLUSIVE lock`,
        ruleId: 'drop-table',
        safeRewrite: {
          description: 'Drop table in a separate release after confirming no references remain',
          steps: [
            `-- 1. Remove all application references to "${tableName}"`,
            `-- 2. Deploy and verify in production`,
            `-- 3. Drop in a follow-up migration after confirmation period`,
            `DROP TABLE IF EXISTS ${tableName};`,
          ],
        },
      });
      break;
    }

    case 'TruncateStmt': {
      const node = stmt.node as {
        relations: Array<{ RangeVar: { relname: string } }>;
      };
      const tableName = node.relations?.[0]?.RangeVar?.relname ?? null;
      results.push({
        statement: stmt.sql,
        statementPreview: makePreview(stmt.sql),
        tableName,
        lockMode: LockMode.ACCESS_EXCLUSIVE,
        blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
        risk: RiskLevel.CRITICAL,
        message: `TRUNCATE "${tableName}" — deletes all rows, acquires ACCESS EXCLUSIVE lock`,
        ruleId: 'truncate',
        safeRewrite: {
          description: 'Use batched DELETE instead of TRUNCATE for safer data removal',
          steps: [
            `-- Delete in batches out-of-band:`,
            `-- DELETE FROM ${tableName} WHERE ctid IN (SELECT ctid FROM ${tableName} LIMIT 1000);`,
          ],
        },
      });
      break;
    }

    case 'DeleteStmt': {
      const node = stmt.node as {
        relation: { relname: string };
        whereClause?: unknown;
      };
      // Only flag DELETE without WHERE
      // whereClause can be absent, null, or empty object — all mean no WHERE
      if (node.whereClause && typeof node.whereClause === 'object' && Object.keys(node.whereClause as Record<string, unknown>).length > 0) break;

      const tableName = node.relation?.relname ?? null;
      results.push({
        statement: stmt.sql,
        statementPreview: makePreview(stmt.sql),
        tableName,
        lockMode: LockMode.ROW_EXCLUSIVE,
        blocks: getBlockedOperations(LockMode.ROW_EXCLUSIVE),
        risk: RiskLevel.HIGH,
        message: `DELETE FROM "${tableName}" without WHERE — deletes all rows`,
        ruleId: 'delete-without-where',
        safeRewrite: {
          description: 'Add a WHERE clause or use batched deletion',
          steps: [
            `-- Delete in batches out-of-band:`,
            `-- DELETE FROM ${tableName} WHERE ctid IN (SELECT ctid FROM ${tableName} LIMIT 1000);`,
          ],
        },
      });
      break;
    }

    case 'VacuumStmt': {
      const node = stmt.node as {
        options?: Array<{ DefElem: { defname: string } }>;
        rels?: Array<{ VacuumRelation: { relation: { relname: string } } }>;
      };
      const isFull = (node.options ?? []).some(
        (opt) => opt.DefElem?.defname === 'full',
      );
      if (!isFull) break;

      const tableName = node.rels?.[0]?.VacuumRelation?.relation?.relname ?? null;
      results.push({
        statement: stmt.sql,
        statementPreview: makePreview(stmt.sql),
        tableName,
        lockMode: LockMode.ACCESS_EXCLUSIVE,
        blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
        risk: RiskLevel.HIGH,
        message: `VACUUM FULL "${tableName}" — rewrites table, acquires ACCESS EXCLUSIVE lock for entire duration`,
        ruleId: 'vacuum-full',
        safeRewrite: {
          description: 'Use pg_repack instead of VACUUM FULL',
          steps: [
            `-- Use pg_repack (non-blocking alternative):`,
            `-- pg_repack --table ${tableName} --no-superuser-check`,
          ],
        },
      });
      break;
    }
  }

  return results;
}

function extractDropTableName(
  objects: Array<{ List: { items: Array<{ String: { sval: string } }> } }>,
): string | null {
  if (!objects || objects.length === 0) return null;
  const items = objects[0]?.List?.items;
  if (!items || items.length === 0) return null;
  return items[items.length - 1]?.String?.sval ?? null;
}
