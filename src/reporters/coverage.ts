import type { AnalysisResult } from '../types.js';

export interface CoverageSummary {
  analyzedStatements: number;
  unanalyzableStatements: number;
  totalStatements: number;
  coveragePercent: number;
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

  return {
    analyzedStatements,
    unanalyzableStatements,
    totalStatements,
    coveragePercent,
  };
}
