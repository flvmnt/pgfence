/**
 * Rule: Destructive operation checks
 *
 * Detects:
 * - DROP TABLE (ACCESS EXCLUSIVE, CRITICAL)
 * - DROP COLUMN (ACCESS EXCLUSIVE, HIGH)
 * - DROP DATABASE (CRITICAL)
 * - DROP SCHEMA [CASCADE] (ACCESS EXCLUSIVE, CRITICAL)
 * - TRUNCATE [CASCADE] (ACCESS EXCLUSIVE, CRITICAL)
 * - DELETE without WHERE (ROW EXCLUSIVE, HIGH)
 * - VACUUM FULL (ACCESS EXCLUSIVE, HIGH)
 * - SET LOGGED/UNLOGGED (ACCESS EXCLUSIVE, HIGH) - full table rewrite
 * - DROP CONSTRAINT (ACCESS EXCLUSIVE, MEDIUM)
 */

import type { ParsedStatement } from '../parser.js';
import type { CheckResult } from '../types.js';
import { LockMode, RiskLevel, getBlockedOperations } from '../types.js';
import { makePreview } from '../parser.js';

export function checkDestructive(stmt: ParsedStatement): CheckResult[] {
  const results: CheckResult[] = [];

  switch (stmt.nodeType) {
    case 'AlterTableStmt': {
      const alterNode = stmt.node as {
        relation: { relname: string };
        cmds: Array<{ AlterTableCmd: { subtype: string; name?: string } }>;
      };
      const tableName = alterNode.relation?.relname ?? null;
      for (const cmd of alterNode.cmds ?? []) {
        const subtype = cmd.AlterTableCmd?.subtype;
        if (subtype === 'AT_SetLogged' || subtype === 'AT_SetUnLogged') {
          const action = subtype === 'AT_SetLogged' ? 'SET LOGGED' : 'SET UNLOGGED';
          results.push({
            statement: stmt.sql,
            statementPreview: makePreview(stmt.sql),
            tableName,
            lockMode: LockMode.ACCESS_EXCLUSIVE,
            blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
            risk: RiskLevel.HIGH,
            message: `${action} on "${tableName}": rewrites entire table, acquires ACCESS EXCLUSIVE lock for full duration`,
            ruleId: 'set-logged-unlogged',
            safeRewrite: {
              description: `${action} requires a full table rewrite. Consider the impact on large tables.`,
              steps: [
                `-- SET LOGGED/UNLOGGED rewrites the entire table under ACCESS EXCLUSIVE.`,
                `-- There is no non-blocking alternative. Minimize impact:`,
                `SET lock_timeout = '2s';`,
                `ALTER TABLE ${tableName} ${action};`,
                `-- Retry in a loop if lock_timeout expires.`,
              ],
            },
          });
        }
        if (subtype === 'AT_DropColumn') {
          const colName = cmd.AlterTableCmd.name ?? '<unknown>';
          results.push({
            statement: stmt.sql,
            statementPreview: makePreview(stmt.sql),
            tableName,
            lockMode: LockMode.ACCESS_EXCLUSIVE,
            blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
            risk: RiskLevel.HIGH,
            message: `DROP COLUMN "${colName}" on "${tableName}": acquires ACCESS EXCLUSIVE lock, may break existing clients`,
            ruleId: 'drop-column',
            safeRewrite: {
              description: 'Remove all application references first, then drop in a follow-up migration',
              steps: [
                `-- 1. Stop reading "${colName}" in application code`,
                `-- 2. Deploy the code change and verify in production`,
                `-- 3. Drop the column in a separate migration:`,
                `ALTER TABLE ${tableName} DROP COLUMN IF EXISTS ${colName};`,
              ],
            },
          });
        }
        if (subtype === 'AT_DropConstraint') {
          const constraintName = cmd.AlterTableCmd.name ?? '<unknown>';
          results.push({
            statement: stmt.sql,
            statementPreview: makePreview(stmt.sql),
            tableName,
            lockMode: LockMode.ACCESS_EXCLUSIVE,
            blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
            risk: RiskLevel.MEDIUM,
            message: `DROP CONSTRAINT "${constraintName}" on "${tableName}": acquires ACCESS EXCLUSIVE lock`,
            ruleId: 'drop-constraint',
          });
        }
      }
      break;
    }

    case 'DropStmt': {
      const node = stmt.node as {
        objects: Array<{ List: { items: Array<{ String: { sval: string } }> } }>;
        removeType: string;
        behavior?: string;
      };
      if (node.removeType === 'OBJECT_SCHEMA') {
        const schemaName = extractDropTableName(node.objects);
        const isCascade = node.behavior === 'DROP_CASCADE';
        results.push({
          statement: stmt.sql,
          statementPreview: makePreview(stmt.sql),
          tableName: null,
          lockMode: LockMode.ACCESS_EXCLUSIVE,
          blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
          risk: RiskLevel.CRITICAL,
          message: isCascade
            ? `DROP SCHEMA "${schemaName}" CASCADE: drops the schema and ALL objects within it, irreversible data loss`
            : `DROP SCHEMA "${schemaName}": drops the schema, acquires ACCESS EXCLUSIVE lock`,
          ruleId: isCascade ? 'drop-schema-cascade' : 'drop-schema',
        });
        break;
      }
      if (node.removeType !== 'OBJECT_TABLE') break;

      const tableName = extractDropTableName(node.objects);
      results.push({
        statement: stmt.sql,
        statementPreview: makePreview(stmt.sql),
        tableName,
        lockMode: LockMode.ACCESS_EXCLUSIVE,
        blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
        risk: RiskLevel.CRITICAL,
        message: `DROP TABLE "${tableName}": irreversible data loss, acquires ACCESS EXCLUSIVE lock`,
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
        behavior?: string;
      };
      const tableName = node.relations?.[0]?.RangeVar?.relname ?? null;
      const isCascade = node.behavior === 'DROP_CASCADE';

      if (isCascade) {
        results.push({
          statement: stmt.sql,
          statementPreview: makePreview(stmt.sql),
          tableName,
          lockMode: LockMode.ACCESS_EXCLUSIVE,
          blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
          risk: RiskLevel.CRITICAL,
          message: `TRUNCATE "${tableName}" CASCADE: deletes all rows in this table AND all referencing tables via foreign keys, acquires ACCESS EXCLUSIVE on all affected tables`,
          ruleId: 'truncate-cascade',
          safeRewrite: {
            description: 'Remove CASCADE and explicitly truncate each table, or use batched DELETE',
            steps: [
              `-- Delete in batches out-of-band, table by table:`,
              `-- DELETE FROM ${tableName} WHERE ctid IN (SELECT ctid FROM ${tableName} LIMIT 1000);`,
            ],
          },
        });
      } else {
        results.push({
          statement: stmt.sql,
          statementPreview: makePreview(stmt.sql),
          tableName,
          lockMode: LockMode.ACCESS_EXCLUSIVE,
          blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
          risk: RiskLevel.CRITICAL,
          message: `TRUNCATE "${tableName}": deletes all rows, acquires ACCESS EXCLUSIVE lock`,
          ruleId: 'truncate',
          safeRewrite: {
            description: 'Use batched DELETE instead of TRUNCATE for safer data removal',
            steps: [
              `-- Delete in batches out-of-band:`,
              `-- DELETE FROM ${tableName} WHERE ctid IN (SELECT ctid FROM ${tableName} LIMIT 1000);`,
            ],
          },
        });
      }
      break;
    }

    case 'DeleteStmt': {
      const node = stmt.node as {
        relation: { relname: string };
        whereClause?: unknown;
      };
      // Flag DELETE when the predicate is absent or provably tautological.
      // Unknown predicates are left alone rather than over-approximated.
      if (node.whereClause && !isAlwaysTrueWhereClause(node.whereClause)) break;

      const tableName = node.relation?.relname ?? null;
      results.push({
        statement: stmt.sql,
        statementPreview: makePreview(stmt.sql),
        tableName,
        lockMode: LockMode.ROW_EXCLUSIVE,
        blocks: getBlockedOperations(LockMode.ROW_EXCLUSIVE),
        risk: RiskLevel.HIGH,
        message: `DELETE FROM "${tableName}" without WHERE: deletes all rows`,
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

    case 'DropdbStmt': {
      const node = stmt.node as { dbname?: string };
      results.push({
        statement: stmt.sql,
        statementPreview: makePreview(stmt.sql),
        tableName: null,
        lockMode: LockMode.ACCESS_EXCLUSIVE,
        blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
        risk: RiskLevel.CRITICAL,
        message: `DROP DATABASE "${node.dbname}": irreversible, destroys the entire database and all its data`,
        ruleId: 'drop-database',
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
        message: `VACUUM FULL "${tableName}": rewrites table, acquires ACCESS EXCLUSIVE lock for entire duration`,
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

function isAlwaysTrueWhereClause(whereClause: unknown): boolean {
  const value = evaluateBooleanExpression(whereClause);
  return value === true;
}

function evaluateBooleanExpression(expr: unknown): boolean | null {
  if (!expr || typeof expr !== 'object') return null;

  const node = expr as Record<string, unknown>;
  if (node.A_Const) {
    return readBooleanConst(node.A_Const) ?? null;
  }

  if (node.NullTest) {
    const nullTest = node.NullTest as {
      nulltesttype?: string;
      arg?: unknown;
    };
    const isNull = readNullConst(nullTest.arg);
    if (isNull === null) return null;
    if (nullTest.nulltesttype === 'IS_NULL') return isNull;
    if (nullTest.nulltesttype === 'IS_NOT_NULL') return !isNull;
    return null;
  }

  if (node.BooleanTest) {
    const booleanTest = node.BooleanTest as {
      booltesttype?: string;
      arg?: unknown;
    };
    const isNull = readNullConst(booleanTest.arg);
    if (isNull === true) {
      switch (booleanTest.booltesttype) {
        case 'IS_TRUE':
        case 'IS_FALSE':
          return false;
        case 'IS_NOT_TRUE':
        case 'IS_NOT_FALSE':
          return true;
        default:
          return null;
      }
    }
    const value = evaluateBooleanExpression(booleanTest.arg);
    if (value === null) return null;
    switch (booleanTest.booltesttype) {
      case 'IS_TRUE':
        return value === true;
      case 'IS_NOT_TRUE':
        return value === false;
      case 'IS_FALSE':
        return value === false;
      case 'IS_NOT_FALSE':
        return value === true;
      default:
        return null;
    }
  }

  if (node.BoolExpr) {
    const boolExpr = node.BoolExpr as { boolop?: string; args?: unknown[] };
    const args = boolExpr.args ?? [];
    if (boolExpr.boolop === 'NOT_EXPR' && args.length === 1) {
      const value = evaluateBooleanExpression(args[0]);
      return value === null ? null : !value;
    }
    if (boolExpr.boolop === 'AND_EXPR') {
      let sawUnknown = false;
      for (const arg of args) {
        const value = evaluateBooleanExpression(arg);
        if (value === false) return false;
        if (value === null) sawUnknown = true;
      }
      return sawUnknown ? null : true;
    }
    if (boolExpr.boolop === 'OR_EXPR') {
      let sawUnknown = false;
      for (const arg of args) {
        const value = evaluateBooleanExpression(arg);
        if (value === true) return true;
        if (value === null) sawUnknown = true;
      }
      return sawUnknown ? null : false;
    }
    return null;
  }

  if (node.A_Expr) {
    const exprNode = node.A_Expr as {
      kind?: string;
      name?: Array<{ String?: { sval?: string } }>;
      lexpr?: unknown;
      rexpr?: unknown;
    };
    const op = exprNode.name?.[0]?.String?.sval;
    if (exprNode.kind === 'AEXPR_OP' && (op === '=' || op === '<>' || op === '!=')) {
      const left = readLiteralValue(exprNode.lexpr);
      const right = readLiteralValue(exprNode.rexpr);
      if (left === null || right === null) return null;
      const equal = left === right;
      return op === '=' ? equal : !equal;
    }
  }

  return null;
}

function readBooleanConst(node: unknown): boolean | null {
  if (!node || typeof node !== 'object') return null;
  const constNode = node as { boolval?: { boolval?: boolean } };
  if (constNode.boolval === undefined) return null;
  return constNode.boolval.boolval === true;
}

function readNullConst(node: unknown): boolean | null {
  if (!node || typeof node !== 'object') return null;
  const constNode = node as {
    A_Const?: {
      boolval?: { boolval?: boolean };
      ival?: { ival?: number };
      sval?: { sval?: string };
      isnull?: boolean;
    };
  };
  if (!constNode.A_Const) return null;
  const value = constNode.A_Const;
  if (value.isnull === true) return true;
  if (value.boolval !== undefined || value.ival !== undefined || value.sval !== undefined) return false;
  return null;
}

function readLiteralValue(node: unknown): string | number | boolean | null {
  if (!node || typeof node !== 'object') return null;
  const constNode = node as {
    A_Const?: {
      boolval?: { boolval?: boolean };
      ival?: { ival?: number };
      sval?: { sval?: string };
    };
  };
  if (!constNode.A_Const) return null;
  const value = constNode.A_Const;
  if (value.boolval !== undefined) return value.boolval.boolval === true;
  if (value.ival?.ival !== undefined) return value.ival.ival;
  if (value.sval?.sval !== undefined) return value.sval.sval;
  return null;
}

function extractDropTableName(
  objects: Array<{ List: { items: Array<{ String: { sval: string } }> } }>,
): string | null {
  if (!objects || objects.length === 0) return null;
  const items = objects[0]?.List?.items;
  if (!items || items.length === 0) return null;
  return items[items.length - 1]?.String?.sval ?? null;
}
