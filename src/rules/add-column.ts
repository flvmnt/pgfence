/**
 * Rule: ADD COLUMN checks
 *
 * Detects:
 * - ADD COLUMN ... NOT NULL without DEFAULT (fails on non-empty table)
 * - ADD COLUMN with volatile DEFAULT (potential table rewrite, flagged as HIGH risk)
 * - ADD COLUMN with constant or stable DEFAULT (instant metadata-only on PG11+, LOW risk)
 * - ADD COLUMN with type json instead of jsonb (common mistake)
 * - ADD COLUMN with serial/bigserial instead of IDENTITY (deprecated pseudo-type)
 * - ADD COLUMN with GENERATED ALWAYS AS ... STORED (table rewrite)
 *
 * Default detection strategy:
 * - A_Const and TypeCast(A_Const) are constant fast defaults
 * - Known stable functions and SQL value functions are stable fast defaults
 * - Everything else is volatile and rewrite-causing
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

interface ForeignKeyConstraint {
  contype: string;
  conname?: string;
  skip_validation?: boolean;
  pktable?: {
    schemaname?: string;
    relname: string;
  };
  fk_attrs?: Array<{ String: { sval: string } }>;
  pk_attrs?: Array<{ String: { sval: string } }>;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function formatColumnList(columns: string): string {
  return columns
    .split(',')
    .map((column) => column.trim())
    .filter(Boolean)
    .map((column) => (column.startsWith('<') && column.endsWith('>')) ? column : quoteIdentifier(column))
    .join(', ');
}

function formatQualifiedRelation(relation?: { schemaname?: string; relname?: string }): string {
  if (!relation?.relname) return '<unknown>';
  const qualified = relation.schemaname
    ? [relation.schemaname, relation.relname]
    : [relation.relname];
  return qualified.map(quoteIdentifier).join('.');
}

function formatTypeName(typeName?: TypeName): string {
  const parts = (typeName?.names ?? [])
    .map((part) => part.String?.sval)
    .filter((part): part is string => Boolean(part));
  return parts.join('.') || '<type>';
}

function relationStatsKey(relation?: { schemaname?: string; relname?: string }): string | null {
  if (!relation?.relname) return null;
  return relation.schemaname
    ? `${relation.schemaname}.${relation.relname}`
    : relation.relname;
}

function sanitizeIdentifierFragment(fragment: string): string {
  const cleaned = fragment.trim().replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || 'fk';
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
    const foreignKeyConstraint = constraints.find(
      (con) => con.Constraint.contype === 'CONSTR_FOREIGN',
    )?.Constraint as ForeignKeyConstraint | undefined;
    const hasIdentity = constraints.some(
      (con) => con.Constraint.contype === 'CONSTR_IDENTITY',
    );

    if (foreignKeyConstraint) {
      const refTable = formatQualifiedRelation(foreignKeyConstraint.pktable);
      const refStatsKey = relationStatsKey(foreignKeyConstraint.pktable);
      const fkCols = (foreignKeyConstraint.fk_attrs ?? [])
        .map((attr) => attr.String?.sval ?? '?')
        .filter((col) => col.length > 0)
        .join(', ');
      const refCols = (foreignKeyConstraint.pk_attrs ?? [])
        .map((attr) => attr.String?.sval ?? '?')
        .filter((col) => col.length > 0)
        .join(', ');
      const columnList = fkCols || colDef.colname;
      const referencedList = refCols || '<referenced_column>';
      const constraintName = foreignKeyConstraint.conname
        ?? `fk_${sanitizeIdentifierFragment(tableName ?? 'tbl')}_${sanitizeIdentifierFragment(colDef.colname)}`;
      const safeTableName = tableName ? quoteIdentifier(tableName) : '<table>';
      const safeColumnName = quoteIdentifier(colDef.colname);
      const safeColumnList = formatColumnList(columnList);
      const safeReferencedList = formatColumnList(referencedList);
      const safeConstraintName = quoteIdentifier(constraintName);
      const safeTypeName = getTypeName(colDef.typeName) || '<type>';

      results.push({
        statement: stmt.sql,
        statementPreview: makePreview(stmt.sql),
        tableName,
        affectedTableNames: refStatsKey ? [refStatsKey] : undefined,
        lockMode: LockMode.ACCESS_EXCLUSIVE,
        blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
        risk: foreignKeyConstraint.skip_validation === true ? RiskLevel.LOW : RiskLevel.HIGH,
        message: foreignKeyConstraint.skip_validation === true
          ? `ADD COLUMN "${colDef.colname}" with REFERENCES ${refTable}(${referencedList}) NOT VALID: acquires ACCESS EXCLUSIVE lock on "${tableName}" and defers referenced-table validation`
          : `ADD COLUMN "${colDef.colname}" with REFERENCES ${refTable}(${referencedList}) without NOT VALID: acquires ACCESS EXCLUSIVE lock on "${tableName}" and also takes SHARE ROW EXCLUSIVE lock on ${refTable}`,
        ruleId: foreignKeyConstraint.skip_validation === true
          ? 'add-column-inline-foreign-key-not-valid'
          : 'add-column-inline-foreign-key',
        safeRewrite: {
          description: 'Add the column first, then add the foreign key as NOT VALID and validate separately',
          steps: [
            `ALTER TABLE ${safeTableName} ADD COLUMN IF NOT EXISTS ${safeColumnName} ${safeTypeName};`,
            `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${quoteIdentifier(`idx_${sanitizeIdentifierFragment(tableName ?? 'tbl')}_${sanitizeIdentifierFragment(columnList)}`)} ON ${safeTableName} (${safeColumnList});`,
            `ALTER TABLE ${safeTableName} ADD CONSTRAINT ${safeConstraintName} FOREIGN KEY (${safeColumnList}) REFERENCES ${refTable}(${safeReferencedList}) NOT VALID;`,
            `ALTER TABLE ${safeTableName} VALIDATE CONSTRAINT ${safeConstraintName};`,
          ],
        },
      });
    }

    if (hasIdentity) {
      results.push({
        statement: stmt.sql,
        statementPreview: makePreview(stmt.sql),
        tableName,
        lockMode: LockMode.ACCESS_EXCLUSIVE,
        blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
        risk: RiskLevel.HIGH,
        message: `ADD COLUMN "${colDef.colname}" with IDENTITY: rewrites existing rows to populate the sequence-backed identity value under ACCESS EXCLUSIVE lock`,
        ruleId: 'add-column-identity',
        safeRewrite: {
          description: 'Add the column first, then backfill and attach identity behavior separately',
          steps: [
            `ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS ${colDef.colname} ${getTypeName(colDef.typeName) || '<type>'};`,
            `-- Backfill existing rows out-of-band in batches before adding identity semantics.`,
          ],
        },
      });
    }

    // Case 1: NOT NULL without DEFAULT → HIGH
    if (hasNotNull && !hasDefault) {
      results.push({
        statement: stmt.sql,
        statementPreview: makePreview(stmt.sql),
        tableName,
        lockMode: LockMode.ACCESS_EXCLUSIVE,
        blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
        risk: RiskLevel.HIGH,
        message: `ADD COLUMN "${colDef.colname}" with NOT NULL but no DEFAULT: fails on non-empty tables and requires ACCESS EXCLUSIVE lock`,
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

    // Case 2: Has DEFAULT - check if fast or rewrite-causing
    if (hasDefault && defaultExpr) {
      const defaultKind = classifyDefault(defaultExpr);
      const isFastDefault = defaultKind === 'constant' || defaultKind === 'stable';

      if (isFastDefault && config.minPostgresVersion >= 11) {
        // Constant and stable defaults on PG11+ use fast default storage.
        const notNullNote = hasNotNull
          ? `. NOT NULL is satisfied: the constant DEFAULT fills all existing rows`
          : '';
        results.push({
          statement: stmt.sql,
          statementPreview: makePreview(stmt.sql),
          tableName,
          lockMode: LockMode.ACCESS_EXCLUSIVE,
          blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
          risk: RiskLevel.LOW,
          message: defaultKind === 'constant'
            ? `ADD COLUMN "${colDef.colname}" with constant DEFAULT: instant metadata-only on PG11+ (ACCESS EXCLUSIVE lock is brief)${notNullNote}`
            : `ADD COLUMN "${colDef.colname}" with stable DEFAULT: instant metadata-only on PG11+ (ACCESS EXCLUSIVE lock is brief)${notNullNote}`,
          ruleId: defaultKind === 'constant' ? 'add-column-constant-default' : 'add-column-stable-default',
          safeRewrite: {
            description: 'Safe: instant metadata-only on Postgres 11+',
            steps: [
              `-- This is safe on Postgres 11+: the DEFAULT is stored metadata-only.`,
            ],
          },
        });
      } else if (defaultKind === 'volatile') {
        // Volatile default causes a table rewrite.
        results.push({
          statement: stmt.sql,
          statementPreview: makePreview(stmt.sql),
          tableName,
          lockMode: LockMode.ACCESS_EXCLUSIVE,
          blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
          risk: RiskLevel.HIGH,
          message: `ADD COLUMN "${colDef.colname}" with non-constant DEFAULT: causes table rewrite under ACCESS EXCLUSIVE lock`,
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
      // If fast-default eligible but PG < 11, it is still a rewrite.
      if (isFastDefault && config.minPostgresVersion < 11) {
        results.push({
          statement: stmt.sql,
          statementPreview: makePreview(stmt.sql),
          tableName,
          lockMode: LockMode.ACCESS_EXCLUSIVE,
          blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
          risk: RiskLevel.HIGH,
          message: `ADD COLUMN "${colDef.colname}" with DEFAULT: causes table rewrite on PG < 11`,
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

    // NOT NULL + volatile default: patch the recipe to include SET NOT NULL steps
    if (hasNotNull && hasDefault && defaultExpr && classifyDefault(defaultExpr) === 'volatile') {
      const lastResult = results[results.length - 1];
      if (lastResult?.ruleId === 'add-column-non-constant-default' && lastResult.safeRewrite) {
        lastResult.message += '. Column is also NOT NULL, requiring an additional constraint step';
        lastResult.safeRewrite.steps.push(
          `ALTER TABLE ${tableName} ADD CONSTRAINT chk_${colDef.colname}_nn CHECK (${colDef.colname} IS NOT NULL) NOT VALID;`,
          `ALTER TABLE ${tableName} VALIDATE CONSTRAINT chk_${colDef.colname}_nn;`,
          `ALTER TABLE ${tableName} ALTER COLUMN ${colDef.colname} SET NOT NULL;`,
          `ALTER TABLE ${tableName} DROP CONSTRAINT chk_${colDef.colname}_nn;`,
        );
      }
    }

    // Type-specific checks on ADD COLUMN
    const typeName = getTypeName(colDef.typeName);

    const typeKeys = typeLookupKeys(colDef.typeName);
    const isConstrainedDomain = typeKeys.some((key) => config.constrainedDomains?.has(key));
    if (isConstrainedDomain) {
      results.push({
        statement: stmt.sql,
        statementPreview: makePreview(stmt.sql),
        tableName,
        lockMode: LockMode.ACCESS_EXCLUSIVE,
        blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
        risk: RiskLevel.HIGH,
        message: `ADD COLUMN "${colDef.colname}" with constrained domain "${typeName}": validates the domain constraint against existing rows and can rewrite the table under ACCESS EXCLUSIVE lock`,
        ruleId: 'add-column-constrained-domain',
        safeRewrite: {
          description: 'Add a base-type column first, backfill, then enforce the domain constraint in a controlled contract step',
          steps: [
            `ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS ${colDef.colname} <base_type>;`,
            `-- Backfill and validate in a follow-up migration before switching to the constrained domain.`,
          ],
        },
      });
    } else if (isPotentialCustomType(colDef.typeName) && !typeKeys.some((key) => config.knownCustomTypes?.has(key))) {
      results.push({
        statement: stmt.sql,
        statementPreview: makePreview(stmt.sql),
        tableName,
        lockMode: LockMode.ACCESS_EXCLUSIVE,
        blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
        risk: RiskLevel.MEDIUM,
        message: `ADD COLUMN "${colDef.colname}" uses unresolved custom type "${formatTypeName(colDef.typeName)}": pgfence cannot rule out a constrained domain without a schema snapshot`,
        ruleId: 'add-column-unresolved-custom-type',
        safeRewrite: {
          description: 'Provide a schema snapshot or review the custom type before treating this migration as fully analyzed',
          steps: [
            `pgfence snapshot --db-url <readonly-url> --output pgfence-snapshot.json`,
            `pgfence analyze --snapshot pgfence-snapshot.json migrations/*.sql`,
          ],
        },
      });
    }

    // ADD COLUMN with json type - should use jsonb instead
    if (typeName === 'json') {
      results.push({
        statement: stmt.sql,
        statementPreview: makePreview(stmt.sql),
        tableName,
        lockMode: LockMode.ACCESS_EXCLUSIVE,
        blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
        risk: RiskLevel.LOW,
        message: `ADD COLUMN "${colDef.colname}" with type json: use jsonb instead. json has no equality operator, cannot be used in GROUP BY, and is generally slower`,
        ruleId: 'add-column-json',
        appliesToNewTables: true,
      });
    }

    // ADD COLUMN with serial/bigserial - should use IDENTITY instead
    const serialTypes = ['serial', 'serial4', 'serial8', 'bigserial', 'smallserial', 'serial2'];
    if (serialTypes.includes(typeName)) {
      results.push({
        statement: stmt.sql,
        statementPreview: makePreview(stmt.sql),
        tableName,
        lockMode: LockMode.ACCESS_EXCLUSIVE,
        blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
        risk: RiskLevel.MEDIUM,
        message: `ADD COLUMN "${colDef.colname}" with ${typeName}: use GENERATED ALWAYS AS IDENTITY instead. SERIAL creates an implicit sequence with unexpected ownership/permission semantics`,
        ruleId: 'add-column-serial',
        appliesToNewTables: true,
        safeRewrite: {
          description: 'Use IDENTITY columns (SQL standard) instead of SERIAL pseudo-types',
          steps: [
            `ALTER TABLE ${tableName} ADD COLUMN ${colDef.colname} ${typeName === 'bigserial' || typeName === 'serial8' ? 'bigint' : typeName === 'smallserial' || typeName === 'serial2' ? 'smallint' : 'integer'} GENERATED ALWAYS AS IDENTITY;`,
          ],
        },
      });
    }

    // ADD COLUMN with GENERATED ALWAYS AS ... STORED - table rewrite
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
        message: `ADD COLUMN "${colDef.colname}" with GENERATED ALWAYS AS ... STORED: causes a full table rewrite under ACCESS EXCLUSIVE lock`,
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

function typeLookupKeys(tn?: TypeName): string[] {
  const parts = (tn?.names ?? [])
    .map((part) => part.String?.sval)
    .filter((part): part is string => Boolean(part));
  if (parts.length === 0) return [];
  const exact = parts.join('.').toLowerCase();
  const bare = parts[parts.length - 1].toLowerCase();
  return exact === bare ? [bare] : [exact, bare];
}

function isPotentialCustomType(tn?: TypeName): boolean {
  const parts = (tn?.names ?? [])
    .map((part) => part.String?.sval)
    .filter((part): part is string => Boolean(part));
  if (parts.length === 0) return false;
  if (parts.length > 1 && (parts[0] === 'pg_catalog' || parts[0] === 'information_schema')) return false;
  return !BUILTIN_TYPE_NAMES.has(parts[parts.length - 1].toLowerCase());
}

const BUILTIN_TYPE_NAMES = new Set([
  'bool',
  'boolean',
  'bpchar',
  'bytea',
  'char',
  'date',
  'float4',
  'float8',
  'inet',
  'int',
  'int2',
  'int4',
  'int8',
  'integer',
  'json',
  'jsonb',
  'numeric',
  'serial',
  'serial2',
  'serial4',
  'serial8',
  'bigserial',
  'smallserial',
  'smallint',
  'bigint',
  'text',
  'time',
  'timetz',
  'timestamp',
  'timestamptz',
  'uuid',
  'varbit',
  'varchar',
]);

/**
 * Classify default expressions for PG11+ fast-default behavior.
 */
function classifyDefault(expr: Record<string, unknown>): 'constant' | 'stable' | 'volatile' {
  // Direct A_Const
  if ('A_Const' in expr) return 'constant';

  // TypeCast wrapping A_Const
  if ('TypeCast' in expr) {
    const cast = expr.TypeCast as { arg?: Record<string, unknown> };
    if (cast.arg && 'A_Const' in cast.arg) return 'constant';
  }

  if ('FuncCall' in expr) {
    const call = expr.FuncCall as { funcname?: Array<{ String?: { sval?: string } }> };
    const functionName = call.funcname?.map((part) => part.String?.sval).filter(Boolean).join('.').toLowerCase();
    if (functionName && STABLE_DEFAULT_FUNCTIONS.has(functionName)) return 'stable';
  }

  if ('SQLValueFunction' in expr) {
    const sqlValue = expr.SQLValueFunction as { op?: string };
    if (sqlValue.op && STABLE_SQL_VALUE_FUNCTIONS.has(sqlValue.op)) return 'stable';
  }

  return 'volatile';
}

const STABLE_DEFAULT_FUNCTIONS = new Set([
  'now',
  'transaction_timestamp',
  'statement_timestamp',
]);

const STABLE_SQL_VALUE_FUNCTIONS = new Set([
  'SVFOP_CURRENT_DATE',
  'SVFOP_CURRENT_TIME',
  'SVFOP_CURRENT_TIME_N',
  'SVFOP_CURRENT_TIMESTAMP',
  'SVFOP_CURRENT_TIMESTAMP_N',
]);
