/**
 * Rule: Data type best practices
 *
 * Detects:
 * - integer/int/int4/int2/smallint instead of bigint (overflow risk)
 * - varchar(N) instead of text (unnecessary ALTER TYPE lock risk)
 * - timestamp without time zone instead of timestamptz (timezone bugs)
 *
 * Applies to both CREATE TABLE column defs and ALTER TABLE ADD COLUMN.
 * These are style/correctness checks, not lock-mode warnings —
 * they fire even on tables created in the same migration (appliesToNewTables: true).
 */

import type { ParsedStatement } from '../parser.js';
import type { CheckResult } from '../types.js';
import { LockMode, getBlockedOperations } from '../types.js';
import { RiskLevel } from '../types.js';
import { makePreview } from '../parser.js';

interface TypeName {
  names: Array<{ String: { sval: string } }>;
  typmods?: unknown[];
}

interface ColumnDef {
  colname: string;
  typeName?: TypeName;
}

export function checkBestPractices(stmt: ParsedStatement): CheckResult[] {
  const results: CheckResult[] = [];
  const columns = extractColumnDefs(stmt);

  for (const { colDef, tableName } of columns) {
    const typeName = getTypeName(colDef.typeName);

    // prefer-bigint-over-int: int4, int2 → use bigint
    if (isSmallIntType(typeName)) {
      results.push({
        statement: stmt.sql,
        statementPreview: makePreview(stmt.sql),
        tableName,
        lockMode: LockMode.ACCESS_EXCLUSIVE,
        blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
        risk: RiskLevel.LOW,
        message: `Column "${colDef.colname}" uses ${typeName} — consider bigint to avoid overflow on growing tables. Changing column type later requires ACCESS EXCLUSIVE lock + table rewrite`,
        ruleId: 'prefer-bigint-over-int',
        appliesToNewTables: true,
      });
    }

    // prefer-text-field: varchar → use text
    if (typeName === 'varchar') {
      const hasLimit = colDef.typeName?.typmods && colDef.typeName.typmods.length > 0;
      if (hasLimit) {
        results.push({
          statement: stmt.sql,
          statementPreview: makePreview(stmt.sql),
          tableName,
          lockMode: LockMode.ACCESS_EXCLUSIVE,
          blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
          risk: RiskLevel.LOW,
          message: `Column "${colDef.colname}" uses varchar(N) — use text instead. Changing varchar length later requires ACCESS EXCLUSIVE lock + table rewrite. text with a CHECK constraint is equally safe and changeable`,
          ruleId: 'prefer-text-field',
          appliesToNewTables: true,
        });
      }
    }

    // prefer-timestamptz: timestamp → use timestamptz
    if (typeName === 'timestamp') {
      results.push({
        statement: stmt.sql,
        statementPreview: makePreview(stmt.sql),
        tableName,
        lockMode: LockMode.ACCESS_EXCLUSIVE,
        blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
        risk: RiskLevel.LOW,
        message: `Column "${colDef.colname}" uses timestamp without time zone — use timestamptz instead. timestamp silently drops timezone info, causing bugs when servers or clients are in different timezones`,
        ruleId: 'prefer-timestamptz',
        appliesToNewTables: true,
      });
    }
  }

  return results;
}

/**
 * Extract column definitions from both CREATE TABLE and ALTER TABLE ADD COLUMN.
 */
function extractColumnDefs(stmt: ParsedStatement): Array<{ colDef: ColumnDef; tableName: string | null }> {
  const results: Array<{ colDef: ColumnDef; tableName: string | null }> = [];

  if (stmt.nodeType === 'CreateStmt') {
    const node = stmt.node as {
      relation?: { relname?: string };
      tableElts?: Array<{ ColumnDef?: ColumnDef }>;
    };
    const tableName = node.relation?.relname ?? null;
    for (const elt of node.tableElts ?? []) {
      if (elt.ColumnDef) {
        results.push({ colDef: elt.ColumnDef, tableName });
      }
    }
  }

  if (stmt.nodeType === 'AlterTableStmt') {
    const node = stmt.node as {
      relation: { relname: string };
      cmds: Array<{
        AlterTableCmd: {
          subtype: string;
          def?: { ColumnDef?: ColumnDef };
        };
      }>;
    };
    const tableName = node.relation?.relname ?? null;
    for (const cmd of node.cmds ?? []) {
      if (cmd.AlterTableCmd?.subtype === 'AT_AddColumn' && cmd.AlterTableCmd.def?.ColumnDef) {
        results.push({ colDef: cmd.AlterTableCmd.def.ColumnDef, tableName });
      }
    }
  }

  return results;
}

function getTypeName(tn?: TypeName): string {
  if (!tn?.names?.length) return '';
  return tn.names[tn.names.length - 1]?.String?.sval ?? '';
}

function isSmallIntType(typeName: string): boolean {
  return ['int4', 'int2', 'integer', 'smallint'].includes(typeName);
}
