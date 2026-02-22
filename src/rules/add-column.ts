/**
 * Rule: ADD COLUMN checks
 *
 * Detects:
 * - ADD COLUMN ... NOT NULL without DEFAULT (fails on non-empty table)
 * - ADD COLUMN with non-constant DEFAULT (table rewrite)
 * - ADD COLUMN with constant DEFAULT (instant on PG11+, LOW risk)
 * - ADD COLUMN with type json instead of jsonb (common mistake)
 * - ADD COLUMN with serial/bigserial instead of IDENTITY (deprecated pseudo-type)
 * - ADD COLUMN with GENERATED ALWAYS AS ... STORED (table rewrite)
 *
 * Default detection strategy (per user feedback):
 * - Only A_Const and TypeCast(A_Const) are treated as "constant" (safe on PG11+)
 * - Everything else (FuncCall, SQLValueFunction, expressions) = non-constant = unsafe
 * - No hardcoded "volatile list" — we don't pretend to know function immutability
 */

import type { ParsedStatement } from '../parser.js';
import type { CheckResult, PgfenceConfig } from '../types.js';
import { LockMode, RiskLevel, getBlockedOperations } from '../types.js';
import { makePreview } from '../parser.js';

interface TypeName {
  names: Array<{ String: { sval: string } }>;
  typmods?: unknown[];
  typemod: number;
}

interface AlterTableCmd {
  AlterTableCmd: {
    subtype: string;
    def?: {
      ColumnDef?: {
        colname: string;
        typeName?: TypeName;
        constraints?: Array<{
          Constraint: {
            contype: string;
            raw_expr?: Record<string, unknown>;
            generated_when?: string;
          };
        }>;
      };
    };
    behavior: string;
    missing_ok?: boolean;
  };
}

export function checkAddColumn(
  stmt: ParsedStatement,
  config: PgfenceConfig,
): CheckResult[] {
  if (stmt.nodeType !== 'AlterTableStmt') return [];
  const node = stmt.node as {
    relation: { relname: string };
    cmds: AlterTableCmd[];
    objtype: string;
  };

  const results: CheckResult[] = [];
  const tableName = node.relation?.relname ?? null;

  for (const cmd of node.cmds ?? []) {
    const c = cmd.AlterTableCmd;
    if (c.subtype !== 'AT_AddColumn') continue;

    const colDef = c.def?.ColumnDef;
    if (!colDef) continue;

    const constraints = colDef.constraints ?? [];
    const hasNotNull = constraints.some(
      (con) => con.Constraint.contype === 'CONSTR_NOTNULL',
    );
    const defaultConstraint = constraints.find(
      (con) => con.Constraint.contype === 'CONSTR_DEFAULT',
    );
    const hasDefault = !!defaultConstraint;
    const defaultExpr = defaultConstraint?.Constraint.raw_expr;

    // Case 1: NOT NULL without DEFAULT → HIGH
    if (hasNotNull && !hasDefault) {
      results.push({
        statement: stmt.sql,
        statementPreview: makePreview(stmt.sql),
        tableName,
        lockMode: LockMode.ACCESS_EXCLUSIVE,
        blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
        risk: RiskLevel.HIGH,
        message: `ADD COLUMN "${colDef.colname}" with NOT NULL but no DEFAULT — fails on non-empty tables and requires ACCESS EXCLUSIVE lock`,
        ruleId: 'add-column-not-null-no-default',
        safeRewrite: {
          description: 'Add nullable column, backfill, then add NOT NULL constraint',
          steps: [
            `ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS ${colDef.colname} ${getTypeName(colDef.typeName) || '<type>'};`,
            `-- Backfill out-of-band in batches (repeat until 0 rows updated):`,
            `-- WITH batch AS (`,
            `--   SELECT ctid FROM ${tableName} WHERE ${colDef.colname} IS NULL LIMIT 1000 FOR UPDATE SKIP LOCKED`,
            `-- )`,
            `-- UPDATE ${tableName} t SET ${colDef.colname} = <fill_value> FROM batch WHERE t.ctid = batch.ctid;`,
            `ALTER TABLE ${tableName} ADD CONSTRAINT chk_${colDef.colname}_nn CHECK (${colDef.colname} IS NOT NULL) NOT VALID;`,
            `ALTER TABLE ${tableName} VALIDATE CONSTRAINT chk_${colDef.colname}_nn;`,
            `ALTER TABLE ${tableName} ALTER COLUMN ${colDef.colname} SET NOT NULL;`,
            `ALTER TABLE ${tableName} DROP CONSTRAINT chk_${colDef.colname}_nn;`,
          ],
        },
      });
      continue;
    }

    // Case 2: Has DEFAULT — check if constant or non-constant
    if (hasDefault && defaultExpr) {
      const isConstant = isConstantDefault(defaultExpr);

      if (isConstant && config.minPostgresVersion >= 11) {
        // Constant default on PG11+ → instant metadata-only, LOW risk
        results.push({
          statement: stmt.sql,
          statementPreview: makePreview(stmt.sql),
          tableName,
          lockMode: LockMode.ACCESS_EXCLUSIVE,
          blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
          risk: RiskLevel.LOW,
          message: `ADD COLUMN "${colDef.colname}" with constant DEFAULT — instant metadata-only on PG11+ (ACCESS EXCLUSIVE lock is brief)`,
          ruleId: 'add-column-constant-default',
          safeRewrite: {
            description: 'Safe on Postgres 11+',
            steps: [
              `-- Note: on PG10 and below, this pattern can rewrite the entire table.`,
            ],
          },
        });
      } else if (!isConstant) {
        // Non-constant default → table rewrite, HIGH risk
        results.push({
          statement: stmt.sql,
          statementPreview: makePreview(stmt.sql),
          tableName,
          lockMode: LockMode.ACCESS_EXCLUSIVE,
          blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
          risk: RiskLevel.HIGH,
          message: `ADD COLUMN "${colDef.colname}" with non-constant DEFAULT — causes table rewrite under ACCESS EXCLUSIVE lock`,
          ruleId: 'add-column-non-constant-default',
          safeRewrite: {
            description: 'Add column without default, backfill in batches, then set default',
            steps: [
              `ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS ${colDef.colname} ${getTypeName(colDef.typeName) || '<type>'};`,
              `-- Backfill out-of-band in batches (repeat until 0 rows updated):`,
              `-- WITH batch AS (`,
              `--   SELECT ctid FROM ${tableName} WHERE ${colDef.colname} IS NULL LIMIT 1000 FOR UPDATE SKIP LOCKED`,
              `-- )`,
              `-- UPDATE ${tableName} t SET ${colDef.colname} = <fill_value> FROM batch WHERE t.ctid = batch.ctid;`,
              `ALTER TABLE ${tableName} ALTER COLUMN ${colDef.colname} SET DEFAULT <fill_value>;`,
            ],
          },
        });
      }
      // If constant but PG < 11, it's still a rewrite — flag as HIGH
      if (isConstant && config.minPostgresVersion < 11) {
        results.push({
          statement: stmt.sql,
          statementPreview: makePreview(stmt.sql),
          tableName,
          lockMode: LockMode.ACCESS_EXCLUSIVE,
          blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
          risk: RiskLevel.HIGH,
          message: `ADD COLUMN "${colDef.colname}" with DEFAULT — causes table rewrite on PG < 11`,
          ruleId: 'add-column-default-pre-pg11',
          safeRewrite: {
            description: 'Add column without default, backfill in batches, then set default',
            steps: [
              `ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS ${colDef.colname} ${getTypeName(colDef.typeName) || '<type>'};`,
              `-- Backfill out-of-band in batches (repeat until 0 rows updated):`,
              `-- WITH batch AS (`,
              `--   SELECT ctid FROM ${tableName} WHERE ${colDef.colname} IS NULL LIMIT 1000 FOR UPDATE SKIP LOCKED`,
              `-- )`,
              `-- UPDATE ${tableName} t SET ${colDef.colname} = <fill_value> FROM batch WHERE t.ctid = batch.ctid;`,
              `ALTER TABLE ${tableName} ALTER COLUMN ${colDef.colname} SET DEFAULT <fill_value>;`,
            ],
          },
        });
      }
    }

    // NOT NULL + non-constant default = also flag NOT NULL separately if needed
    if (hasNotNull && hasDefault && defaultExpr && !isConstantDefault(defaultExpr)) {
      // Already flagged for non-constant default above, the NOT NULL compounds the issue
      // but we don't double-flag — the non-constant default recipe covers it
    }

    // Type-specific checks on ADD COLUMN
    const typeName = getTypeName(colDef.typeName);

    // ADD COLUMN with json type — should use jsonb instead
    if (typeName === 'json') {
      results.push({
        statement: stmt.sql,
        statementPreview: makePreview(stmt.sql),
        tableName,
        lockMode: LockMode.ACCESS_EXCLUSIVE,
        blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
        risk: RiskLevel.LOW,
        message: `ADD COLUMN "${colDef.colname}" with type json — use jsonb instead. json has no equality operator, cannot be used in GROUP BY, and is generally slower`,
        ruleId: 'add-column-json',
        appliesToNewTables: true,
      });
    }

    // ADD COLUMN with serial/bigserial — should use IDENTITY instead
    const serialTypes = ['serial', 'serial4', 'serial8', 'bigserial', 'smallserial', 'serial2'];
    if (serialTypes.includes(typeName)) {
      results.push({
        statement: stmt.sql,
        statementPreview: makePreview(stmt.sql),
        tableName,
        lockMode: LockMode.ACCESS_EXCLUSIVE,
        blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
        risk: RiskLevel.MEDIUM,
        message: `ADD COLUMN "${colDef.colname}" with ${typeName} — use GENERATED ALWAYS AS IDENTITY instead. SERIAL creates an implicit sequence with unexpected ownership/permission semantics`,
        ruleId: 'add-column-serial',
        appliesToNewTables: true,
        safeRewrite: {
          description: 'Use IDENTITY columns (SQL standard) instead of SERIAL pseudo-types',
          steps: [
            `ALTER TABLE ${tableName} ADD COLUMN ${colDef.colname} ${typeName === 'bigserial' || typeName === 'serial8' ? 'bigint' : 'integer'} GENERATED ALWAYS AS IDENTITY;`,
          ],
        },
      });
    }

    // ADD COLUMN with GENERATED ALWAYS AS ... STORED — table rewrite
    const hasStoredGenerated = constraints.some(
      (con) => con.Constraint.contype === 'CONSTR_GENERATED',
    );
    if (hasStoredGenerated) {
      results.push({
        statement: stmt.sql,
        statementPreview: makePreview(stmt.sql),
        tableName,
        lockMode: LockMode.ACCESS_EXCLUSIVE,
        blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
        risk: RiskLevel.HIGH,
        message: `ADD COLUMN "${colDef.colname}" with GENERATED ALWAYS AS ... STORED — causes a full table rewrite under ACCESS EXCLUSIVE lock`,
        ruleId: 'add-column-stored-generated',
        safeRewrite: {
          description: 'Add a regular column, create a trigger to compute the value, backfill in batches',
          steps: [
            `-- 1. Add a regular column:`,
            `ALTER TABLE ${tableName} ADD COLUMN ${colDef.colname} <type>;`,
            `-- 2. Create a trigger to compute the value for new rows`,
            `-- 3. Backfill existing rows out-of-band in batches`,
          ],
        },
      });
    }
  }

  return results;
}

/**
 * Extract the final type name string from a TypeName AST node.
 * Handles both qualified (pg_catalog.int4) and unqualified (json) forms.
 */
function getTypeName(tn?: TypeName): string {
  if (!tn?.names?.length) return '';
  // Last name entry is the actual type (first may be schema like pg_catalog)
  return tn.names[tn.names.length - 1]?.String?.sval ?? '';
}

/**
 * Check if a default expression is a constant.
 *
 * ONLY A_Const and TypeCast(A_Const) are treated as constant.
 * Everything else — FuncCall, SQLValueFunction, expressions — is non-constant.
 */
function isConstantDefault(expr: Record<string, unknown>): boolean {
  // Direct A_Const
  if ('A_Const' in expr) return true;

  // TypeCast wrapping A_Const
  if ('TypeCast' in expr) {
    const cast = expr.TypeCast as { arg?: Record<string, unknown> };
    if (cast.arg && 'A_Const' in cast.arg) return true;
  }

  return false;
}
