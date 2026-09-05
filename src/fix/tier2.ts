/**
 * Tier 2 (--fix --split): multi-file migration scaffolds.
 *
 * pgfence's documented safe rewrites for these three findings are multi-migration
 * campaigns (CLAUDE.md's "Safe Rewrite Recipes"), not single-statement edits. This
 * module NEVER edits the original migration file: it only generates new sibling
 * files that implement the documented expand/backfill/contract sequence, and it
 * refuses (skips, with a reason) rather than guesses whenever the original
 * statement carries something it cannot safely reproduce (a name it would have to
 * invent, a modifier the recipe doesn't support, more than one action bundled into
 * one ALTER TABLE statement, ...).
 *
 * Each builder is self-contained: it re-parses the single statement text carried
 * on the CheckResult in isolation (never the original multi-statement file), so it
 * needs no access to the source file or its offsets.
 *
 * Covers exactly the three recipes CLAUDE.md documents:
 * - add-column-not-null-no-default -> ADD COLUMN with NOT NULL (+ optional DEFAULT)
 * - add-constraint-fk-no-not-valid -> ADD FOREIGN KEY
 * - add-constraint-unique          -> ADD UNIQUE CONSTRAINT
 *
 * NOT covered (deliberately, different code path / different scope):
 * - add-column-inline-foreign-key(-not-valid): FK declared inline inside ADD
 *   COLUMN rather than as its own ADD CONSTRAINT statement. A future extension,
 *   not one of the three documented recipes above.
 * - add-column-non-constant-default / add-column-default-pre-pg11: same shape as
 *   the NOT NULL recipe but needs a <fill_value> pgfence cannot infer for the
 *   SET DEFAULT step; left as a manual recipe.
 * - add-pk-without-using-index: same shape as add-constraint-unique but for
 *   PRIMARY KEY; not in CLAUDE.md's documented list, left as a manual recipe.
 */

import type { ParsedStatement } from '../parser.js';
import type { CheckResult } from '../types.js';
import { parseSQL } from '../parser.js';

export interface Tier2FileSpec {
  suffix: string;
  label: string;
  content: string;
}

export type Tier2BuildResult =
  // `slug` identifies THIS specific finding (table + column/constraint), not
  // just the ruleId: `suffix` values like '1-expand' are hardcoded constants
  // shared by every finding of a given rule, and even collide across
  // different rules (add-constraint-fk-no-not-valid and add-constraint-unique
  // both use '1-expand'/'2-contract'). A file with two Tier2-eligible
  // statements - two NOT NULL columns, or an FK plus a UNIQUE constraint -
  // would otherwise have its second finding's sibling files collide with the
  // first's and get silently skipped as "already exists", even though the
  // only reason the file already exists is that pgfence itself created it one
  // loop iteration earlier in the same run. The caller folds `slug` into the
  // sibling filename so each finding gets its own files.
  | { status: 'generated'; files: Tier2FileSpec[]; slug: string }
  | { status: 'skipped'; reason: string };

export const TIER2_RULE_IDS = new Set([
  'add-column-not-null-no-default',
  'add-constraint-fk-no-not-valid',
  'add-constraint-unique',
]);

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function sanitizeIdentifierFragment(fragment: string): string {
  const cleaned = fragment.trim().replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || 'col';
}

function formatQualifiedRelation(relation?: { schemaname?: string; relname?: string }): string {
  if (!relation?.relname) return '<unknown>';
  const parts = relation.schemaname ? [relation.schemaname, relation.relname] : [relation.relname];
  return parts.map(quoteIdentifier).join('.');
}

/** Re-parse a single statement's own text in isolation. Never touches the source file. */
async function reparseSingle(statementSql: string): Promise<ParsedStatement | null> {
  const sql = statementSql.trim().endsWith(';') ? statementSql.trim() : `${statementSql.trim()};`;
  try {
    const stmts = await parseSQL(sql);
    return stmts[0] ?? null;
  } catch {
    return null;
  }
}

const MANUAL_BACKFILL_BANNER = [
  '-- ============================================================',
  '-- MANUAL BACKFILL TEMPLATE -- DO NOT RUN AS A NORMAL MIGRATION',
  '-- ============================================================',
  '-- pgfence generated this file as a starting point. It is NOT wired into',
  '-- your migration runner and every statement below is commented out on',
  '-- purpose, so running this file as-is is a no-op.',
  '--',
  '-- Backfilling touches every existing row and can run for a long time. It',
  '-- must run out-of-band (not inside migration CI), in batches, with a real',
  '-- fill value you choose, and with monitoring (pg_stat_activity, lock',
  '-- waits, replication lag). Re-run the batch loop until it updates 0 rows.',
  '--',
  '-- pgfence cannot determine the correct fill value, so this file makes no',
  '-- claim that the backfill is safe or complete until a human runs it.',
].join('\n');

interface AlterTableCmdNode {
  subtype: string;
  missing_ok?: boolean;
  def?: {
    ColumnDef?: {
      colname: string;
      location?: number;
      constraints?: Array<{ Constraint: { contype: string; location?: number } }>;
    };
    Constraint?: {
      contype: string;
      conname?: string;
      indexname?: string;
      skip_validation?: boolean;
      deferrable?: boolean;
      initdeferred?: boolean;
      nulls_not_distinct?: boolean;
      including?: unknown[];
      options?: unknown[];
      indexspace?: string;
      keys?: Array<{ String: { sval: string } }>;
    };
  };
}

interface AlterTableStmtNode {
  relation: { schemaname?: string; relname: string };
  cmds: Array<{ AlterTableCmd: AlterTableCmdNode }>;
}

/**
 * ADD COLUMN ... NOT NULL (no DEFAULT) -> expand / manual-backfill / contract.
 * Scope: exactly `ADD COLUMN col type NOT NULL` - a single column, a single NOT
 * NULL constraint and nothing else (no inline UNIQUE/CHECK/REFERENCES/IDENTITY,
 * which would need their own reasoning), and a single action in the ALTER TABLE
 * statement. Anything more complex is left for manual splitting.
 */
async function buildAddColumnNotNull(check: CheckResult): Promise<Tier2BuildResult> {
  const stmt = await reparseSingle(check.statement);
  if (!stmt || stmt.nodeType !== 'AlterTableStmt') {
    return { status: 'skipped', reason: 'internal: could not re-parse as an ALTER TABLE ADD COLUMN statement' };
  }
  const node = stmt.node as unknown as AlterTableStmtNode;
  if (node.cmds.length !== 1) {
    return {
      status: 'skipped',
      reason: 'statement contains more than one ALTER TABLE action; split the ADD COLUMN into its own statement first, then re-run --fix --split',
    };
  }
  const cmd = node.cmds[0].AlterTableCmd;
  const colDef = cmd.def?.ColumnDef;
  if (cmd.subtype !== 'AT_AddColumn' || !colDef) {
    return { status: 'skipped', reason: 'internal: expected a single AT_AddColumn action' };
  }
  const constraints = colDef.constraints ?? [];
  if (constraints.length !== 1 || constraints[0].Constraint.contype !== 'CONSTR_NOTNULL') {
    return {
      status: 'skipped',
      reason: 'column definition has additional constraints (UNIQUE, CHECK, REFERENCES, IDENTITY, ...) beyond NOT NULL; pgfence\'s --split only handles the plain "ADD COLUMN col type NOT NULL" shape, apply the recipe manually',
    };
  }
  const colLoc = colDef.location;
  const notNullLoc = constraints[0].Constraint.location;
  if (colLoc == null || notNullLoc == null) {
    return { status: 'skipped', reason: 'internal: missing source location info for the column definition' };
  }

  const isolatedText = check.statement.trim().endsWith(';') ? check.statement.trim() : `${check.statement.trim()};`;
  const beforeColumn = isolatedText.slice(0, colLoc); // e.g. "ALTER TABLE orders ADD COLUMN "
  const columnAndType = isolatedText.slice(colLoc, notNullLoc).trimEnd(); // e.g. "status text"
  const ifNotExists = cmd.missing_ok === true ? '' : 'IF NOT EXISTS ';
  const expandSql = `${beforeColumn}${ifNotExists}${columnAndType};`;

  const tableName = formatQualifiedRelation(node.relation);
  const colName = quoteIdentifier(colDef.colname);
  const constraintName = `chk_${sanitizeIdentifierFragment(colDef.colname)}_nn`;

  const backfillSql = [
    MANUAL_BACKFILL_BANNER,
    '--',
    '-- 1. Fill in the actual value on the line below (pgfence cannot infer it).',
    '-- 2. Run this loop out-of-band, uncommented, until it reports 0 rows updated.',
    '--',
    '-- WITH batch AS (',
    `--   SELECT ctid FROM ${tableName} WHERE ${colName} IS NULL LIMIT 1000 FOR UPDATE SKIP LOCKED`,
    '-- )',
    `-- UPDATE ${tableName} t SET ${colName} = <fill_value> FROM batch WHERE t.ctid = batch.ctid;`,
  ].join('\n');

  const contractSql = [
    `ALTER TABLE ${tableName} ADD CONSTRAINT ${constraintName} CHECK (${colName} IS NOT NULL) NOT VALID;`,
    `ALTER TABLE ${tableName} VALIDATE CONSTRAINT ${constraintName};`,
    `ALTER TABLE ${tableName} ALTER COLUMN ${colName} SET NOT NULL;`,
    `ALTER TABLE ${tableName} DROP CONSTRAINT ${constraintName};`,
  ].join('\n');

  return {
    status: 'generated',
    slug: `${sanitizeIdentifierFragment(node.relation.relname)}_${sanitizeIdentifierFragment(colDef.colname)}`,
    files: [
      { suffix: '1-expand', label: 'Expand: add the column as nullable (instant, no lock)', content: expandSql },
      { suffix: '2-backfill.MANUAL', label: 'Backfill: out-of-band template, needs manual scheduling', content: backfillSql },
      { suffix: '3-contract', label: 'Contract: enforce NOT NULL via NOT VALID + VALIDATE', content: contractSql },
    ],
  };
}

/**
 * ADD CONSTRAINT ... FOREIGN KEY (no NOT VALID) -> expand (NOT VALID) / contract (VALIDATE).
 * Scope: a single ALTER TABLE action, and the constraint must be explicitly named
 * (VALIDATE CONSTRAINT needs a name to target; pgfence will not guess Postgres's
 * auto-generated name).
 */
async function buildAddForeignKey(check: CheckResult): Promise<Tier2BuildResult> {
  const stmt = await reparseSingle(check.statement);
  if (!stmt || stmt.nodeType !== 'AlterTableStmt') {
    return { status: 'skipped', reason: 'internal: could not re-parse as an ALTER TABLE ADD CONSTRAINT statement' };
  }
  const node = stmt.node as unknown as AlterTableStmtNode;
  if (node.cmds.length !== 1) {
    return {
      status: 'skipped',
      reason: 'statement contains more than one ALTER TABLE action; split the FOREIGN KEY into its own statement first, then re-run --fix --split',
    };
  }
  const cmd = node.cmds[0].AlterTableCmd;
  const constraint = cmd.def?.Constraint;
  if (cmd.subtype !== 'AT_AddConstraint' || !constraint || constraint.contype !== 'CONSTR_FOREIGN') {
    return { status: 'skipped', reason: 'internal: expected a single ADD CONSTRAINT ... FOREIGN KEY action' };
  }
  if (constraint.skip_validation === true) {
    return { status: 'skipped', reason: 'internal: constraint already uses NOT VALID' };
  }
  if (!constraint.conname) {
    return {
      status: 'skipped',
      reason: 'the foreign key has no explicit constraint name; add "CONSTRAINT <name>" so a follow-up VALIDATE CONSTRAINT can target it, then re-run --fix --split',
    };
  }

  const expandSql = `${check.statement.trim().replace(/;+$/, '')} NOT VALID;`;
  const tableName = formatQualifiedRelation(node.relation);
  const contractSql = `ALTER TABLE ${tableName} VALIDATE CONSTRAINT ${quoteIdentifier(constraint.conname)};`;

  return {
    status: 'generated',
    slug: `${sanitizeIdentifierFragment(node.relation.relname)}_${sanitizeIdentifierFragment(constraint.conname)}`,
    files: [
      { suffix: '1-expand', label: 'Expand: add the FK as NOT VALID (brief lock, no scan)', content: expandSql },
      { suffix: '2-contract', label: 'Contract: validate the FK (non-blocking scan)', content: contractSql },
    ],
  };
}

const UNIQUE_UNSUPPORTED_MODIFIERS = [
  'deferrable', 'initdeferred', 'nulls_not_distinct', 'including', 'options', 'indexspace',
] as const;

/**
 * ADD CONSTRAINT ... UNIQUE (no USING INDEX) -> expand (CREATE UNIQUE INDEX
 * CONCURRENTLY) / contract (ADD CONSTRAINT ... UNIQUE USING INDEX).
 * Scope: a single ALTER TABLE action, plain column list only. "ADD CONSTRAINT
 * ... UNIQUE USING INDEX" only supports a plain b-tree index with no expression
 * columns, no partial WHERE, no INCLUDE and no storage/tablespace options
 * (postgresql.org/docs/current/sql-altertable.html), so any of those on the
 * original constraint means the recipe cannot be reproduced and pgfence skips
 * rather than emit an index the ADD CONSTRAINT step could never legally adopt.
 */
async function buildAddUnique(check: CheckResult): Promise<Tier2BuildResult> {
  const stmt = await reparseSingle(check.statement);
  if (!stmt || stmt.nodeType !== 'AlterTableStmt') {
    return { status: 'skipped', reason: 'internal: could not re-parse as an ALTER TABLE ADD CONSTRAINT statement' };
  }
  const node = stmt.node as unknown as AlterTableStmtNode;
  if (node.cmds.length !== 1) {
    return {
      status: 'skipped',
      reason: 'statement contains more than one ALTER TABLE action; split the UNIQUE constraint into its own statement first, then re-run --fix --split',
    };
  }
  const cmd = node.cmds[0].AlterTableCmd;
  const constraint = cmd.def?.Constraint;
  if (cmd.subtype !== 'AT_AddConstraint' || !constraint || constraint.contype !== 'CONSTR_UNIQUE') {
    return { status: 'skipped', reason: 'internal: expected a single ADD CONSTRAINT ... UNIQUE action' };
  }
  if (constraint.indexname) {
    return { status: 'skipped', reason: 'internal: constraint already uses USING INDEX' };
  }
  for (const modifier of UNIQUE_UNSUPPORTED_MODIFIERS) {
    if ((constraint as Record<string, unknown>)[modifier]) {
      return {
        status: 'skipped',
        reason: `UNIQUE constraint uses "${modifier}", which "ADD CONSTRAINT ... UNIQUE USING INDEX" does not support ` +
          '(postgresql.org/docs/current/sql-altertable.html); apply the recipe manually',
      };
    }
  }
  const keys = (constraint.keys ?? [])
    .map((k) => k.String?.sval)
    .filter((v): v is string => Boolean(v));
  if (keys.length === 0) {
    return { status: 'skipped', reason: 'internal: could not resolve the constraint\'s columns' };
  }

  const tableName = formatQualifiedRelation(node.relation);
  const indexBase = constraint.conname
    ? sanitizeIdentifierFragment(constraint.conname)
    : sanitizeIdentifierFragment(`${node.relation.relname}_${keys.join('_')}`);
  const indexName = quoteIdentifier(`${indexBase}_idx`);
  const columnList = keys.map(quoteIdentifier).join(', ');
  const constraintClause = constraint.conname ? `CONSTRAINT ${quoteIdentifier(constraint.conname)} ` : '';

  const expandSql = `CREATE UNIQUE INDEX CONCURRENTLY ${indexName} ON ${tableName} (${columnList});`;
  const contractSql = `ALTER TABLE ${tableName} ADD ${constraintClause}UNIQUE USING INDEX ${indexName};`;

  return {
    status: 'generated',
    slug: `${sanitizeIdentifierFragment(node.relation.relname)}_${indexBase}`,
    files: [
      { suffix: '1-expand', label: 'Expand: build the unique index concurrently (non-blocking)', content: expandSql },
      { suffix: '2-contract', label: 'Contract: attach the constraint to the index (brief lock)', content: contractSql },
    ],
  };
}

export const TIER2_BUILDERS: Record<string, (check: CheckResult) => Promise<Tier2BuildResult>> = {
  'add-column-not-null-no-default': buildAddColumnNotNull,
  'add-constraint-fk-no-not-valid': buildAddForeignKey,
  'add-constraint-unique': buildAddUnique,
};
