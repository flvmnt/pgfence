/**
 * Rule: CREATE INDEX / DROP INDEX checks
 *
 * Detects:
 * - CREATE INDEX without CONCURRENTLY (SHARE lock, blocks writes)
 * - DROP INDEX without CONCURRENTLY (ACCESS EXCLUSIVE)
 *
 * Protobuf3 omits false booleans, so we check `=== true`, not `!== false`.
 */

import type { ParsedStatement } from '../parser.js';
import type { CheckResult } from '../types.js';
import { LockMode, RiskLevel, getBlockedOperations } from '../types.js';
import { makePreview } from '../parser.js';

export function checkCreateIndex(stmt: ParsedStatement): CheckResult[] {
  const results: CheckResult[] = [];

  if (stmt.nodeType === 'IndexStmt') {
    const node = stmt.node as {
      idxname?: string;
      relation: { relname: string };
      concurrent?: boolean;
      unique?: boolean;
    };

    // concurrent === true → safe, emit nothing
    if (node.concurrent === true) return [];

    const tableName = node.relation?.relname ?? null;
    const indexName = node.idxname ?? '<unnamed>';

    results.push({
      statement: stmt.sql,
      statementPreview: makePreview(stmt.sql),
      tableName,
      lockMode: LockMode.SHARE,
      blocks: getBlockedOperations(LockMode.SHARE),
      risk: RiskLevel.MEDIUM,
      message: `CREATE INDEX "${indexName}" without CONCURRENTLY — acquires SHARE lock, blocking all writes on "${tableName}"`,
      ruleId: 'create-index-not-concurrent',
      safeRewrite: {
        description: 'Use CREATE INDEX CONCURRENTLY to allow reads and writes during index build.',
        steps: [
          `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${indexName} ON ${tableName}(...);`,
          `-- Note: CONCURRENTLY must run outside a transaction block (disable ORM transaction wrappers)`,
        ],
      },
    });
  }

  if (stmt.nodeType === 'DropStmt') {
    const node = stmt.node as {
      objects: Array<{ List: { items: Array<{ String: { sval: string } }> } }>;
      removeType: string;
      concurrent?: boolean;
    };

    if (node.removeType !== 'OBJECT_INDEX') return [];
    if (node.concurrent === true) return [];

    const indexName = extractDropName(node.objects);

    results.push({
      statement: stmt.sql,
      statementPreview: makePreview(stmt.sql),
      tableName: null,
      lockMode: LockMode.ACCESS_EXCLUSIVE,
      blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
      risk: RiskLevel.MEDIUM,
      message: `DROP INDEX "${indexName}" without CONCURRENTLY — acquires ACCESS EXCLUSIVE lock`,
      ruleId: 'drop-index-not-concurrent',
      safeRewrite: {
        description: 'Use DROP INDEX CONCURRENTLY to avoid ACCESS EXCLUSIVE lock',
        steps: [
          `DROP INDEX CONCURRENTLY IF EXISTS ${indexName};`,
        ],
      },
    });
  }

  return results;
}

function extractDropName(
  objects: Array<{ List: { items: Array<{ String: { sval: string } }> } }>,
): string {
  if (!objects || objects.length === 0) return '<unknown>';
  const items = objects[0]?.List?.items;
  if (!items || items.length === 0) return '<unknown>';
  // Last item is the unqualified name
  return items[items.length - 1]?.String?.sval ?? '<unknown>';
}
