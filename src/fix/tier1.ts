/**
 * Tier 1 --fix: true in-place, single-statement, side-effect-free fixes.
 *
 * This is an explicit allowlist, NOT a generic "apply every safeRewrite" function.
 * pgfence's own documented safe rewrites are mostly multi-migration campaigns (see
 * CLAUDE.md's Safe Rewrite Recipes), so blindly concatenating safeRewrite.steps and
 * writing it back would silently produce wrong or incomplete SQL for most rules.
 * Only a rule whose fix is a pure, unambiguous, mechanically-derivable single
 * statement (or single SET to prepend) belongs here.
 *
 * ============================================================================
 * ALLOWLIST (and why each ruleId qualifies)
 * ============================================================================
 *
 * Statement-level:
 * - create-index-not-concurrent: safeRewrite.steps[0] is produced by a textual
 *   regex substitution on the ORIGINAL statement text (insert CONCURRENTLY, and
 *   IF NOT EXISTS when safe to do so) - every other clause (columns, USING
 *   method, WHERE, INCLUDE, ...) is preserved verbatim, so there is nothing to
 *   reconstruct and nothing to lose. See the guard below for the one edge case
 *   (unnamed index) that needed a matching fix in the rule itself.
 * - drop-index-not-concurrent: same shape as create-index-not-concurrent - a
 *   textual regex substitution on the ORIGINAL statement text, preserving the
 *   target's exact quoting and schema qualification instead of reconstructing
 *   it from parsed AST `sval` fields (which fold case and drop the schema
 *   prefix) - gated by two Postgres restrictions that DROP INDEX CONCURRENTLY
 *   cannot violate: only one index name, and no CASCADE
 *   (postgresql.org/docs/current/sql-dropindex.html). Both are visible in the
 *   statement's own AST, so they are checked before fixing. A residual,
 *   statically-undetectable caveat (CONCURRENTLY cannot drop an index backing a
 *   UNIQUE/PRIMARY KEY constraint) is always surfaced, never silently assumed
 *   away, per the Trust Contract. Both rules additionally refuse to fix a
 *   statement sitting inside an explicit BEGIN...COMMIT block (see
 *   TIER1_REQUIRES_AUTOCOMMIT_RULE_IDS below) - CONCURRENTLY cannot run in a
 *   transaction block at all, so applying it there would trade a working
 *   statement for one guaranteed to fail.
 *
 * Policy-level (a single SET statement to prepend before the first statement):
 * - missing-lock-timeout: suggestion is exactly "SET lock_timeout = '2s';" with
 *   no placeholder.
 * - missing-statement-timeout: suggestion is exactly "SET statement_timeout =
 *   '5min';" with no placeholder.
 * - missing-idle-timeout: suggestion is exactly "SET
 *   idle_in_transaction_session_timeout = '30s';" with no placeholder.
 *
 * The exact SET text is extracted from PolicyViolation.suggestion at fix time
 * (via extractSetStatement below) rather than duplicated as a literal here, so
 * this file cannot silently drift from policy.ts's actual recommended values.
 *
 * ============================================================================
 * EXCLUDED, despite having a safeRewrite or suggestion (why, briefly)
 * ============================================================================
 *
 * - missing-application-name: suggestion is "SET application_name =
 *   'migrate:<migration_name>';" - the <migration_name> value would have to be
 *   invented (e.g. guessed from the file name), which is a naming judgment call,
 *   not a mechanical fix.
 * - lock-timeout-after-dangerous-statement: fix requires physically relocating
 *   an EXISTING SET statement earlier in the file, a structural move across
 *   other statements/comments, not an insertion.
 * - lock-timeout-zero / lock-timeout-too-long / statement-timeout-too-long: fix
 *   requires rewriting the VALUE of a statement the author deliberately wrote;
 *   choosing the replacement value is a judgment call about why it was set that
 *   way, and doing so needs the same "locate the exact existing statement"
 *   machinery as the ones above, not a pure prepend.
 * - unclosed-transaction: suggestion explicitly offers two different fixes
 *   ("COMMIT; ... or ROLLBACK;") - inherently ambiguous.
 * - update-in-migration, concurrent-in-transaction, statement-after-access-
 *   exclusive, wide-lock-window, not-valid-validate-same-tx: all require
 *   restructuring the migration (batching logic, splitting transactions/files),
 *   not a single-statement/single-line change.
 * - reindex-non-concurrent: looks like a peer of create-index-not-concurrent but
 *   is NOT: its safeRewrite is RECONSTRUCTED from parsed fields
 *   (`REINDEX ${kind} CONCURRENTLY ${targetName}`) rather than a textual patch
 *   of the original statement, so it silently drops information the regex
 *   approach above preserves - schema qualification (relname is unqualified)
 *   and any other original clauses (TABLESPACE, VERBOSE, ...). Verified via a
 *   parser probe and excluded on that basis.
 * - refresh-matview-blocking: steps[0] is a comment, not SQL (the actual
 *   statement is steps[3]), and it depends on a precondition - a unique index
 *   already existing on the view - that pgfence cannot verify statically.
 *   Applying it could produce a runtime failure pgfence has no way to predict.
 * - Everything else with a safeRewrite (add-column-*, add-constraint-* other
 *   than the two Tier 2 cases, alter-column-*, destructive.ts's rules,
 *   partition.ts's rules, trigger.ts's rules, prod-footguns.ts's rules,
 *   rename-column.ts's rules, alter-enum.ts's rules, fk-missing-index): each of
 *   these is a genuine multi-statement recipe, needs a table/column/value
 *   pgfence cannot infer (e.g. <fill_value>, <type>, a new index name), or is
 *   explicitly an operational judgment call ("minimize lock duration",
 *   "schedule in a maintenance window", "no concurrent alternative exists").
 *   Three of them (add-column-not-null-no-default, add-constraint-fk-no-
 *   not-valid, add-constraint-unique) graduate into Tier 2 instead, matching
 *   CLAUDE.md's documented recipes exactly.
 */

import type { ParsedStatement } from '../parser.js';
import type { CheckResult, PolicyViolation } from '../types.js';
import { makePreview } from '../parser.js';

export type Tier1Outcome =
  | { status: 'fixed'; replacement: string; caveat?: string }
  | { status: 'skipped'; reason: string };

interface DropStmtNode {
  objects: Array<{ List: { items: Array<{ String: { sval: string } }> } }>;
  removeType: string;
  behavior?: string;
  concurrent?: boolean;
}

function buildCreateIndexFix(stmt: ParsedStatement, check: CheckResult): Tier1Outcome {
  if (stmt.nodeType !== 'IndexStmt' || !check.safeRewrite) {
    return { status: 'skipped', reason: 'internal: expected an IndexStmt with a safe rewrite' };
  }
  return { status: 'fixed', replacement: check.safeRewrite.steps[0] };
}

function buildDropIndexFix(stmt: ParsedStatement, check: CheckResult): Tier1Outcome {
  if (stmt.nodeType !== 'DropStmt' || !check.safeRewrite) {
    return { status: 'skipped', reason: 'internal: expected a DropStmt with a safe rewrite' };
  }
  const node = stmt.node as unknown as DropStmtNode;
  if (!node.objects || node.objects.length !== 1) {
    return {
      status: 'skipped',
      reason: 'DROP INDEX names more than one index in a single statement; ' +
        'DROP INDEX CONCURRENTLY only supports a single index per statement ' +
        '(postgresql.org/docs/current/sql-dropindex.html). Split into separate ' +
        'DROP INDEX statements first, then re-run --fix.',
    };
  }
  if (node.behavior === 'DROP_CASCADE') {
    return {
      status: 'skipped',
      reason: 'DROP INDEX ... CASCADE cannot be combined with CONCURRENTLY ' +
        '(Postgres restriction). Drop the dependent objects explicitly first, ' +
        'or apply the safe rewrite manually.',
    };
  }
  return {
    status: 'fixed',
    replacement: check.safeRewrite.steps[0],
    caveat: 'DROP INDEX CONCURRENTLY will fail at runtime if this index backs a ' +
      'UNIQUE or PRIMARY KEY constraint (Postgres does not allow CONCURRENTLY in ' +
      'that case). This cannot be determined statically; verify before running.',
  };
}

interface Tier1StatementRule {
  ruleId: string;
  build(stmt: ParsedStatement, check: CheckResult): Tier1Outcome;
}

export const TIER1_STATEMENT_RULES: Tier1StatementRule[] = [
  { ruleId: 'create-index-not-concurrent', build: buildCreateIndexFix },
  { ruleId: 'drop-index-not-concurrent', build: buildDropIndexFix },
];

export const TIER1_STATEMENT_RULE_IDS = new Set(TIER1_STATEMENT_RULES.map((r) => r.ruleId));

/**
 * Statement-level Tier 1 rules whose replacement SQL adds CONCURRENTLY.
 * CREATE/DROP INDEX CONCURRENTLY cannot run inside an explicit transaction
 * block (postgresql.org/docs/current/sql-createindex.html,
 * sql-dropindex.html) - Postgres rejects it outright every time, not just
 * under some conditions. The caller (src/fix/index.ts) uses this to refuse
 * the fix when the matched statement sits inside a BEGIN...COMMIT block,
 * rather than writing SQL that is guaranteed to fail at runtime. Kept as its
 * own explicit list (not reusing TIER1_STATEMENT_RULE_IDS) so a future
 * Tier 1 rule that doesn't touch CONCURRENTLY would not silently inherit
 * this guard.
 */
export const TIER1_REQUIRES_AUTOCOMMIT_RULE_IDS = new Set([
  'create-index-not-concurrent',
  'drop-index-not-concurrent',
]);

/**
 * Extract the literal `SET name = 'value';` statement embedded in a policy
 * suggestion string. Returns null (fail closed) if the suggestion does not
 * contain exactly that shape, e.g. because it carries a placeholder like
 * <migration_name> or because policy.ts's wording changed in a way this no
 * longer recognizes.
 */
export function extractSetStatement(suggestion: string): string | null {
  const match = suggestion.match(/SET\s+[a-zA-Z_][a-zA-Z0-9_]*\s*=\s*'[^'<>]*';/);
  return match ? match[0] : null;
}

export const TIER1_POLICY_RULE_IDS = new Set([
  'missing-lock-timeout',
  'missing-statement-timeout',
  'missing-idle-timeout',
]);

export function buildPolicyFix(violation: PolicyViolation): Tier1Outcome {
  if (!TIER1_POLICY_RULE_IDS.has(violation.ruleId)) {
    return { status: 'skipped', reason: 'not in the Tier 1 policy allowlist' };
  }
  const statement = extractSetStatement(violation.suggestion);
  if (!statement) {
    return {
      status: 'skipped',
      reason: 'could not derive an exact SET statement from the policy suggestion text',
    };
  }
  return { status: 'fixed', replacement: statement };
}

export function previewOf(sql: string): string {
  return makePreview(sql, 80);
}
