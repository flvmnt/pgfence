import type { AnalysisResult } from '../types.js';

export interface CoverageSummary {
  analyzedStatements: number;
  unanalyzableStatements: number;
  totalStatements: number;
  coveragePercent: number;
  /** Sorted, deduplicated list of source lines where unanalyzable statements were found. */
  unanalyzableLines: number[];
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
  const coveragePercent = totalStatements > 0
    ? Math.round((analyzedStatements / totalStatements) * 100)
    : 100;

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
  return `Analyzed ${coverage.analyzedStatements} SQL ${plural(coverage.analyzedStatements, 'statement')}. ` +
    `${coverage.unanalyzableStatements} dynamic ${plural(coverage.unanalyzableStatements, 'statement')} not analyzable${formatUnanalyzableLineSuffix(coverage)}. ` +
    `Coverage: ${coverage.coveragePercent}%`;
}
