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
import type { SchemaLookup } from '../schema-snapshot.js';
import { LockMode, RiskLevel, getBlockedOperations } from '../types.js';
import { makePreview } from '../parser.js';

export function checkCreateIndex(stmt: ParsedStatement, schemaLookup?: SchemaLookup): CheckResult[] {
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

    // Derive safe SQL from original: insert CONCURRENTLY (and IF NOT EXISTS,
    // but only when the statement already names the index or already used IF
    // NOT EXISTS). "IF NOT EXISTS" needs an index name to check against;
    // `CREATE INDEX IF NOT EXISTS ON t (col)` is a Postgres syntax error, so
    // blindly inserting it for an unnamed CREATE INDEX would turn a safe
    // rewrite suggestion into invalid SQL.
    const hadExplicitIfNotExists = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+/i.test(stmt.sql.trim());
    const canUseIfNotExists = node.idxname != null || hadExplicitIfNotExists;
    const safeSql = stmt.sql.trim().replace(/;?\s*$/, '')
      .replace(
        /^CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?/i,
        (_, unique) => `CREATE ${unique ? 'UNIQUE ' : ''}INDEX CONCURRENTLY ${canUseIfNotExists ? 'IF NOT EXISTS ' : ''}`,
      ) + ';';

    results.push({
      statement: stmt.sql,
      statementPreview: makePreview(stmt.sql),
      tableName,
      lockMode: LockMode.SHARE,
      blocks: getBlockedOperations(LockMode.SHARE),
      risk: RiskLevel.MEDIUM,
      message: `CREATE INDEX "${indexName}" without CONCURRENTLY: acquires SHARE lock, blocking all writes on "${tableName}"`,
      ruleId: 'create-index-not-concurrent',
      safeRewrite: {
        description: 'Use CREATE INDEX CONCURRENTLY to allow reads and writes during index build.',
        steps: [
          safeSql,
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

    // DROP INDEX names only the index. Resolve it back to its parent table via
    // the schema snapshot (when available) so size-aware scoring can escalate a
    // drop on an index that belongs to a large table.
    const parentTable = indexName !== '<unknown>'
      ? schemaLookup?.getTableByIndex(indexName) ?? null
      : null;

    // Derive safe SQL from the original statement TEXT, not from the parsed
    // AST's `sval` fields: libpg-query's sval strips quoting and keeps only
    // the last path segment of a schema-qualified name, so reconstructing
    // `DROP INDEX ... ${indexName}` from it would silently drop the schema
    // qualifier and fold a quoted mixed-case/special-character name to a
    // different identifier (see create-index-not-concurrent above for the
    // same reasoning). Instead, insert CONCURRENTLY and IF EXISTS ahead of
    // whatever the author actually wrote for the target, preserving it byte
    // for byte.
    const safeSql = stmt.sql.trim().replace(/;?\s*$/, '')
      .replace(
        /^DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?/i,
        'DROP INDEX CONCURRENTLY IF EXISTS ',
      ) + ';';

    results.push({
      statement: stmt.sql,
      statementPreview: makePreview(stmt.sql),
      tableName: parentTable?.tableName ?? null,
      lockMode: LockMode.ACCESS_EXCLUSIVE,
      blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
      risk: RiskLevel.MEDIUM,
      message: `DROP INDEX "${indexName}" without CONCURRENTLY: acquires ACCESS EXCLUSIVE lock`,
      ruleId: 'drop-index-not-concurrent',
      safeRewrite: {
        description: 'Use DROP INDEX CONCURRENTLY to avoid ACCESS EXCLUSIVE lock',
        steps: [
          safeSql,
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
