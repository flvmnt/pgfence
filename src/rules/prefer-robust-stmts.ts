/**
 * Rule: Prefer robust DDL statements
 *
 * Warns when statements could be made idempotent/safer with:
 * - CREATE INDEX ... IF NOT EXISTS
 * - CREATE TABLE ... IF NOT EXISTS
 * - DROP INDEX ... IF EXISTS
 * - DROP TABLE ... IF EXISTS
 *
 * Protobuf3 omits false booleans, so we check `=== true`, not `!== false`.
 */

import type { ParsedStatement } from '../parser.js';
import type { CheckResult } from '../types.js';
import { LockMode, RiskLevel, getBlockedOperations } from '../types.js';
import { makePreview } from '../parser.js';

export function checkPreferRobustStmts(stmt: ParsedStatement): CheckResult[] {
  const results: CheckResult[] = [];

  if (stmt.nodeType === 'IndexStmt') {
    const node = stmt.node as { if_not_exists?: boolean; idxname?: string; relation?: { relname: string } };
    if (node.if_not_exists === true) return results;
    const indexName = node.idxname ?? '<unnamed>';
    const tableName = node.relation?.relname ?? null;
    results.push({
      statement: stmt.sql,
      statementPreview: makePreview(stmt.sql),
      tableName,
      lockMode: LockMode.SHARE,
      blocks: getBlockedOperations(LockMode.SHARE),
      risk: RiskLevel.LOW,
      message: `CREATE INDEX "${indexName}" — add IF NOT EXISTS for idempotency`,
      ruleId: 'prefer-robust-create-index',
    });
  }

  if (stmt.nodeType === 'CreateStmt') {
    const node = stmt.node as { if_not_exists?: boolean; relation?: { relname: string } };
    if (node.if_not_exists === true) return results;
    const tableName = node.relation?.relname ?? null;
    results.push({
      statement: stmt.sql,
      statementPreview: makePreview(stmt.sql),
      tableName,
      lockMode: LockMode.ACCESS_EXCLUSIVE,
      blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
      risk: RiskLevel.LOW,
      message: `CREATE TABLE — add IF NOT EXISTS for idempotency`,
      ruleId: 'prefer-robust-create-table',
    });
  }

  if (stmt.nodeType === 'DropStmt') {
    const node = stmt.node as {
      removeType: string;
      missing_ok?: boolean;
      objects?: Array<{ List: { items: Array<{ String: { sval: string } }> } }>;
    };
    if (node.missing_ok === true) return results;
    if (node.removeType === 'OBJECT_INDEX') {
      const name = extractDropName(node.objects);
      results.push({
        statement: stmt.sql,
        statementPreview: makePreview(stmt.sql),
        tableName: null,
        lockMode: LockMode.ACCESS_EXCLUSIVE,
        blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
        risk: RiskLevel.LOW,
        message: `DROP INDEX "${name}" — add IF EXISTS for idempotency`,
        ruleId: 'prefer-robust-drop-index',
      });
    }
    if (node.removeType === 'OBJECT_TABLE') {
      const name = extractDropTableName(node.objects);
      results.push({
        statement: stmt.sql,
        statementPreview: makePreview(stmt.sql),
        tableName: name,
        lockMode: LockMode.ACCESS_EXCLUSIVE,
        blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
        risk: RiskLevel.LOW,
        message: `DROP TABLE "${name}" — add IF EXISTS for idempotency`,
        ruleId: 'prefer-robust-drop-table',
      });
    }
  }

  return results;
}

function extractDropName(
  objects: Array<{ List: { items: Array<{ String: { sval: string } }> } }> | undefined,
): string {
  if (!objects || objects.length === 0) return '<unknown>';
  const items = objects[0]?.List?.items;
  if (!items || items.length === 0) return '<unknown>';
  return items[items.length - 1]?.String?.sval ?? '<unknown>';
}

function extractDropTableName(
  objects: Array<{ List: { items: Array<{ String: { sval: string } }> } }> | undefined,
): string | null {
  if (!objects || objects.length === 0) return null;
  const items = objects[0]?.List?.items;
  if (!items || items.length === 0) return null;
  return items[items.length - 1]?.String?.sval ?? null;
}
