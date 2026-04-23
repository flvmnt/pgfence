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
    version: '1.0',
    coverage: {
      totalStatements: coverage.totalStatements,
      analyzedStatements: coverage.analyzedStatements,
      dynamicStatements: coverage.unanalyzableStatements,
      coveragePercent: coverage.coveragePercent,
    },
    results,
  };

  return JSON.stringify(report, null, 2);
}
