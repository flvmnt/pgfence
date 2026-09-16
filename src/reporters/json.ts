/**
 * JSON reporter: machine-readable output.
 *
 * Wraps results in a metadata envelope with version and coverage stats.
 */

import type { AnalysisResult } from '../types.js';
import { summarizeCoverage } from './coverage.js';

export function reportJSON(results: AnalysisResult[]): string {
  const coverage = summarizeCoverage(results);

  const report = {
    version: '1.1',
    coverage: {
      totalStatements: coverage.totalStatements,
      analyzedStatements: coverage.analyzedStatements,
      dynamicStatements: coverage.unanalyzableStatements,
      dynamicStatementLines: coverage.unanalyzableLines,
      coveragePercent: coverage.coveragePercent,
      analyzedNothing: coverage.analyzedNothing,
      filesWithNoStatements: coverage.filesWithNoStatements,
    },
    results,
  };

  return JSON.stringify(report, null, 2);
}
