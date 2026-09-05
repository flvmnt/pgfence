/**
 * Orchestrates pgfence's two-tier --fix for a single analyzed file.
 *
 * Tier 1 findings are applied in place, but ONLY for files that resolve to the
 * raw 'sql' format: the text splice below relies on ParsedStatement offsets
 * mapping 1:1 onto the file's own bytes, which is only guaranteed for
 * extractRawSQL (it returns the file content verbatim, see
 * src/extractors/raw-sql.ts). For ORM-extracted formats the "SQL" the analyzer
 * sees is generated/joined text with no reliable byte mapping back into the
 * original .ts/.js source, so in-place editing is refused rather than risking
 * a corrupted source file; the finding is reported with that reason instead.
 *
 * Tier 2 never edits the original file (any format), so it is not gated the
 * same way: it only needs the flagged statement's own text, available on every
 * CheckResult regardless of source format.
 */

import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ParsedStatement } from '../parser.js';
import type { AnalysisResult, PgfenceConfig } from '../types.js';
import { detectFormat, extractSQL, parseExtractedStatements } from '../analyzer.js';
import { readTextMigrationFile } from '../extractors/file-guards.js';
import { createTransactionState, processTransactionStmt } from '../transaction-state.js';
import {
  TIER1_POLICY_RULE_IDS,
  TIER1_REQUIRES_AUTOCOMMIT_RULE_IDS,
  TIER1_STATEMENT_RULES,
  TIER1_STATEMENT_RULE_IDS,
  buildPolicyFix,
  previewOf,
} from './tier1.js';
import { TIER2_BUILDERS, TIER2_RULE_IDS } from './tier2.js';
import type { FileFixReport, FixedFinding, Tier2Finding, Tier2GeneratedFile } from './types.js';

export type { FileFixReport, FixedFinding, Tier2Finding, Tier2GeneratedFile } from './types.js';

interface TextEdit {
  start: number;
  end: number;
  replacement: string;
}

/**
 * Replace each edit's span with its replacement text, preserving the leading
 * and trailing whitespace of the original span exactly. Edits are applied from
 * the highest offset down so earlier offsets stay valid throughout.
 *
 * ParsedStatement.startOffset/endOffset come from libpg-query's stmt_location/
 * stmt_len, which do NOT include the statement's own trailing ";" - that
 * character sits in the one-character gap between this statement's endOffset
 * and the next statement's startOffset (verified empirically; parser.ts's own
 * rawSql trimming works around the same quirk). Every Tier 1 replacement text
 * already carries its own trailing ";", so if we replaced only [start, end)
 * the original ";" would be left behind right after it, producing "...;;".
 * Extend the replaced span to swallow that one orphaned ";" when present.
 */
function applyEdits(fullText: string, edits: TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let text = fullText;
  for (const edit of sorted) {
    const end = text[edit.end] === ';' ? edit.end + 1 : edit.end;
    const segment = text.slice(edit.start, end);
    const leading = segment.match(/^\s*/)?.[0] ?? '';
    const trailing = segment.match(/\s*$/)?.[0] ?? '';
    text = text.slice(0, edit.start) + leading + edit.replacement + trailing + text.slice(end);
  }
  return text;
}

function siblingPath(filePath: string, suffix: string): string {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  return path.join(dir, `${base}.${suffix}.sql`);
}

async function resolveFormat(filePath: string, config: PgfenceConfig): Promise<string> {
  if (config.format !== 'auto') return config.format;
  const content = await readTextMigrationFile(filePath);
  return detectFormat(filePath, content);
}

export async function applyFixesToFile(
  filePath: string,
  result: AnalysisResult,
  config: PgfenceConfig,
  opts: { split: boolean },
): Promise<FileFixReport> {
  const resolvedFormat = await resolveFormat(filePath, config);
  const supportsInPlaceFix = resolvedFormat === 'sql';

  const tier1: FixedFinding[] = [];
  const tier2: Tier2Finding[] = [];
  const manual: FixedFinding[] = [];

  let fileText = '';
  let fileStmts: ParsedStatement[] = [];
  if (supportsInPlaceFix) {
    const extraction = await extractSQL(filePath, config);
    fileText = extraction.sql;
    fileStmts = await parseExtractedStatements(extraction, filePath);
  }

  // For every statement, was it reached while an explicit BEGIN...COMMIT block
  // was open? CREATE/DROP INDEX CONCURRENTLY cannot run inside a transaction
  // block (postgresql.org/docs/current/sql-createindex.html,
  // sql-dropindex.html) - Postgres rejects it outright, at every call, not
  // just sometimes. Rewriting such a statement to add CONCURRENTLY would turn
  // a working (if slower) statement into one guaranteed to fail the moment
  // the file runs, which is a regression, not a fix. Uses the same
  // transaction-state machine policy.ts uses for the same detection, so this
  // cannot silently drift from what the analyzer itself considers "in a
  // transaction" for e.g. the concurrent-in-transaction policy check.
  const inTransactionBlock = new Map<ParsedStatement, boolean>();
  if (supportsInPlaceFix) {
    const txState = createTransactionState();
    for (const stmt of fileStmts) {
      if (stmt.nodeType === 'TransactionStmt') {
        const node = stmt.node as { kind: string; savepoint_name?: string };
        processTransactionStmt(txState, node.kind, node.savepoint_name);
        continue;
      }
      inTransactionBlock.set(stmt, txState.active);
    }
  }

  const edits: TextEdit[] = [];
  const policyInsertLines: string[] = [];

  // Matches a check's statement text back to its ORIGINAL ParsedStatement in
  // this file, by text equality, consuming each fileStmts entry at most once.
  // Without consumption, two byte-for-byte identical statements (e.g. a
  // copy-pasted duplicate CREATE INDEX) would both resolve to the FIRST
  // occurrence's offsets, silently double-editing one location while leaving
  // the second occurrence's real finding entirely unfixed.
  const usedStmtIndices = new Set<number>();
  function matchStatement(sql: string): ParsedStatement | undefined {
    for (let i = 0; i < fileStmts.length; i++) {
      if (usedStmtIndices.has(i)) continue;
      if (fileStmts[i].sql === sql) {
        usedStmtIndices.add(i);
        return fileStmts[i];
      }
    }
    return undefined;
  }

  // --- Tier 1: statement-level findings ---
  for (const check of result.checks) {
    const rule = TIER1_STATEMENT_RULES.find((r) => r.ruleId === check.ruleId);
    if (!rule) continue;

    if (!supportsInPlaceFix) {
      tier1.push({
        ruleId: check.ruleId,
        kind: 'statement',
        status: 'skipped',
        reason: `in-place --fix only supports raw .sql migration files; this file resolved to format "${resolvedFormat}". Apply the safe rewrite from the report manually.`,
        before: previewOf(check.statement),
      });
      continue;
    }

    const stmt = matchStatement(check.statement);
    if (!stmt) {
      tier1.push({
        ruleId: check.ruleId,
        kind: 'statement',
        status: 'skipped',
        reason: 'internal: could not re-locate this statement in the file (it may have been edited by another fix in the same run)',
        before: previewOf(check.statement),
      });
      continue;
    }

    if (TIER1_REQUIRES_AUTOCOMMIT_RULE_IDS.has(check.ruleId) && inTransactionBlock.get(stmt)) {
      tier1.push({
        ruleId: check.ruleId,
        kind: 'statement',
        status: 'skipped',
        reason: 'this statement is inside an explicit BEGIN...COMMIT block; CONCURRENTLY cannot run inside a ' +
          'transaction block and Postgres will reject it outright, so rewriting it here would replace a working ' +
          '(if lock-holding) statement with one guaranteed to fail. Move it outside the transaction, or into its ' +
          'own migration file, then re-run --fix.',
        before: previewOf(check.statement),
      });
      continue;
    }

    const outcome = rule.build(stmt, check);
    if (outcome.status === 'skipped') {
      tier1.push({
        ruleId: check.ruleId,
        kind: 'statement',
        status: 'skipped',
        reason: outcome.reason,
        before: previewOf(check.statement),
      });
      continue;
    }

    edits.push({ start: stmt.startOffset, end: stmt.endOffset, replacement: outcome.replacement });
    tier1.push({
      ruleId: check.ruleId,
      kind: 'statement',
      status: 'fixed',
      before: previewOf(check.statement),
      after: previewOf(outcome.replacement),
      caveat: outcome.caveat,
    });
  }

  // --- Everything else with a safeRewrite: reported, never touched ---
  for (const check of result.checks) {
    if (!check.safeRewrite) continue;
    if (TIER1_STATEMENT_RULE_IDS.has(check.ruleId) || TIER2_RULE_IDS.has(check.ruleId)) continue;
    manual.push({
      ruleId: check.ruleId,
      kind: 'statement',
      status: 'skipped',
      reason: 'not automated: this recipe needs judgment pgfence cannot make safely ' +
        '(multi-step, needs a name/value pgfence cannot infer, or an operational choice). ' +
        'See the safe rewrite steps in the analyze report.',
      before: previewOf(check.statement),
    });
  }

  // --- Tier 1: policy findings (prepend a single SET statement) ---
  for (const violation of result.policyViolations) {
    if (!TIER1_POLICY_RULE_IDS.has(violation.ruleId)) continue;

    if (!supportsInPlaceFix) {
      tier1.push({
        ruleId: violation.ruleId,
        kind: 'policy',
        status: 'skipped',
        reason: `in-place --fix only supports raw .sql migration files; this file resolved to format "${resolvedFormat}". Add the suggested SET statement manually.`,
      });
      continue;
    }

    const outcome = buildPolicyFix(violation);
    if (outcome.status === 'skipped') {
      tier1.push({ ruleId: violation.ruleId, kind: 'policy', status: 'skipped', reason: outcome.reason });
      continue;
    }

    policyInsertLines.push(outcome.replacement);
    tier1.push({ ruleId: violation.ruleId, kind: 'policy', status: 'fixed', after: outcome.replacement });
  }

  let modified = false;
  if (supportsInPlaceFix && (edits.length > 0 || policyInsertLines.length > 0)) {
    let newText = applyEdits(fileText, edits);
    if (policyInsertLines.length > 0 && fileStmts.length > 0) {
      const insertAt = fileStmts[0].startOffset;
      const block = `${policyInsertLines.join('\n')}\n\n`;
      newText = newText.slice(0, insertAt) + block + newText.slice(insertAt);
    }
    await writeFile(filePath, newText, 'utf8');
    modified = true;
  }

  // --- Tier 2: multi-file scaffolds (--split), never touches the original file ---
  for (const check of result.checks) {
    if (!TIER2_RULE_IDS.has(check.ruleId)) continue;

    if (!opts.split) {
      tier2.push({
        ruleId: check.ruleId,
        status: 'skipped',
        reason: 'not generated: pass --split together with --fix to scaffold the expand/backfill/contract sequence for this recipe',
      });
      continue;
    }

    const builder = TIER2_BUILDERS[check.ruleId];
    const outcome = await builder(check);
    if (outcome.status === 'skipped') {
      tier2.push({ ruleId: check.ruleId, status: 'skipped', reason: outcome.reason });
      continue;
    }

    // Fold the finding's own slug (table + column/constraint) into the sibling
    // filename, not just the rule's fixed suffix ('1-expand', ...): those
    // suffixes are shared by every finding of a rule, and even collide across
    // different rules, so two Tier2-eligible statements in the same file
    // (two NOT NULL columns, or an FK plus a UNIQUE constraint) would
    // otherwise target the same sibling paths and the second would be wrongly
    // reported as colliding with a "pre-existing" file pgfence itself just
    // wrote for the first.
    const collisions = outcome.files
      .map((file) => siblingPath(filePath, `${outcome.slug}.${file.suffix}`))
      .filter((target) => existsSync(target));
    if (collisions.length > 0) {
      tier2.push({
        ruleId: check.ruleId,
        status: 'skipped',
        reason: `not generated: sibling file already exists and pgfence will not overwrite it: ${collisions[0]}`,
      });
      continue;
    }

    const written: Tier2GeneratedFile[] = [];
    for (const file of outcome.files) {
      const target = siblingPath(filePath, `${outcome.slug}.${file.suffix}`);
      const header = `-- Generated by pgfence --fix --split from ${path.basename(filePath)}\n-- ${file.label}\n\n`;
      await writeFile(target, header + file.content.trimEnd() + '\n', 'utf8');
      written.push({ path: target, label: file.label });
    }
    tier2.push({ ruleId: check.ruleId, status: 'generated', files: written });
  }

  return { filePath, resolvedFormat, supportsInPlaceFix, tier1, tier2, manual, modified };
}
