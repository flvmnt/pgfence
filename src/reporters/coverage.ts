import type { AnalysisResult } from '../types.js';

export interface CoverageSummary {
  analyzedStatements: number;
  unanalyzableStatements: number;
  totalStatements: number;
  /** null when totalStatements is 0: 0 of 0 statements is not 100% coverage. */
  coveragePercent: number | null;
  /** Sorted, deduplicated list of source lines where unanalyzable statements were found. */
  unanalyzableLines: number[];
  /** True when the whole run produced zero statements, analyzed or unanalyzable. */
  analyzedNothing: boolean;
  /** Files with statementCount 0 and no unanalyzable warnings, in input order. */
  filesWithNoStatements: string[];
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm;
}

export function countUnanalyzable(result: AnalysisResult): number {
  return result.extractionWarnings?.filter((warning) => warning.unanalyzable).length ?? 0;
}

export function summarizeCoverage(results: AnalysisResult[]): CoverageSummary {
  const analyzedStatements = results.reduce((sum, result) => sum + result.statementCount, 0);
  const unanalyzableStatements = results.reduce((sum, result) => sum + countUnanalyzable(result), 0);
  const totalStatements = analyzedStatements + unanalyzableStatements;
  // null, never 100: a run that read no SQL has not covered anything, and reporting
  // 100% there is the single most misleading string pgfence can print.
  const coveragePercent = totalStatements > 0
    ? Math.round((analyzedStatements / totalStatements) * 100)
    : null;

  const filesWithNoStatements = results
    .filter((result) => result.statementCount === 0 && countUnanalyzable(result) === 0)
    .map((result) => result.filePath);

  const lineSet = new Set<number>();
  for (const result of results) {
    for (const warning of result.extractionWarnings ?? []) {
      if (warning.unanalyzable && typeof warning.line === 'number') {
        lineSet.add(warning.line);
      }
    }
  }
  const unanalyzableLines = Array.from(lineSet).sort((a, b) => a - b);

  return {
    analyzedStatements,
    unanalyzableStatements,
    totalStatements,
    coveragePercent,
    unanalyzableLines,
    analyzedNothing: totalStatements === 0,
    filesWithNoStatements,
  };
}

/**
 * Render the (lines A, B, ...) suffix per the Trust Contract spec.
 * Returns an empty string if there are no unanalyzable statements, or if none of them
 * carry a line number. Truncates after MAX lines and appends "+N more".
 */
export function formatUnanalyzableLineSuffix(coverage: CoverageSummary, max = 8): string {
  if (coverage.unanalyzableStatements === 0) return '';
  const lines = coverage.unanalyzableLines;
  if (lines.length === 0) return '';
  if (lines.length <= max) {
    return ` (lines ${lines.join(', ')})`;
  }
  const shown = lines.slice(0, max).join(', ');
  return ` (lines ${shown}, +${lines.length - max} more)`;
}

export function formatCoverageLine(coverage: CoverageSummary): string {
  const percent = coverage.coveragePercent === null
    ? 'n/a (no SQL statements found)'
    : `${coverage.coveragePercent}%`;
  return `Analyzed ${coverage.analyzedStatements} SQL ${plural(coverage.analyzedStatements, 'statement')}. ` +
    `${coverage.unanalyzableStatements} dynamic ${plural(coverage.unanalyzableStatements, 'statement')} not analyzable${formatUnanalyzableLineSuffix(coverage)}. ` +
    `Coverage: ${percent}`;
}

const NO_STATEMENT_FILE_LIST_MAX = 10;

function renderFileList(files: string[]): string {
  const shown = files.slice(0, NO_STATEMENT_FILE_LIST_MAX);
  const lines = shown.map((file) => `  ${file}`);
  if (files.length > shown.length) {
    lines.push(`  +${files.length - shown.length} more`);
  }
  return lines.join('\n');
}

/** Fatal diagnostic for a run that analyzed zero SQL statements. Always written to stderr. */
export function formatNothingAnalyzed(filePaths: string[]): string {
  return `pgfence error: nothing was analyzed.

pgfence read ${filePaths.length} ${plural(filePaths.length, 'file')} and found 0 SQL statements in them, so no safety
check ran. This is a failure, not a pass. Exiting 0 here would report "your
migrations are safe" about migrations that were never checked.

Files that produced no SQL:
${renderFileList(filePaths)}

What to check, in this order:
  1. Are these the files you meant to check? Print the list your CI passes in:
       ls -l <the glob from your workflow>
  2. Do those files contain SQL? An empty file, or a file with only comments,
     analyzes to zero statements.
  3. Is --format right for ORM migrations? A TypeORM, Knex, or Kysely
     migration whose up() has no recognized query call extracts no SQL:
       pgfence analyze --format typeorm <file>

If a migration is intentionally a no-op, say so in SQL so it is analyzed and
recorded rather than looking like a mistake:
    -- no-op: reverts 20260101_add_foo
    SELECT 1;

Exit code 2 means pgfence could not do its job. It does not mean a migration
failed a risk check, so raising --max-risk will not help.
https://pgfence.com/docs/ci-cd#nothing-analyzed
`;
}

/** Non-fatal stderr notice for machine output formats when only some files produced no SQL. */
export function formatPartialNoStatements(filesWithNoStatements: string[], totalFiles: number): string {
  const n = filesWithNoStatements.length;
  const verb = n === 1 ? 'was' : 'were';
  const shown = filesWithNoStatements.slice(0, NO_STATEMENT_FILE_LIST_MAX);
  const suffix = filesWithNoStatements.length > shown.length
    ? `${shown.join(', ')}, +${filesWithNoStatements.length - shown.length} more`
    : shown.join(', ');
  return `pgfence: ${n} of ${totalFiles} files produced no SQL statements and ${verb} not checked: ${suffix}\n`;
}
