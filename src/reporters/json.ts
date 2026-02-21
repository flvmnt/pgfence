/**
 * JSON reporter — machine-readable output.
 *
 * Wraps results in a metadata envelope with version and coverage stats.
 */

import type { AnalysisResult } from '../types.js';

export function reportJSON(results: AnalysisResult[]): string {
  const totalStatements = results.reduce((sum, r) => sum + r.statementCount, 0);
  const dynamicWarnings = results.reduce(
    (sum, r) => sum + (r.extractionWarnings?.length ?? 0),
    0,
  );
  const coveragePct = totalStatements > 0
    ? Math.round(((totalStatements - dynamicWarnings) / totalStatements) * 100)
    : 100;

  const report = {
    version: '1.0',
    coverage: {
      totalStatements,
      dynamicStatements: dynamicWarnings,
      coveragePercent: coveragePct,
    },
    results,
  };

  return JSON.stringify(report, null, 2);
}
