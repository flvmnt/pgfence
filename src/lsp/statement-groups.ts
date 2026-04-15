/**
 * Helpers for collapsing statement-scoped LSP output to one entry per SQL statement.
 */

import type { AnalyzeTextResult, SourceRange } from './analyze-text.js';
import type { CheckResult, RiskLevel as RiskLevelType } from '../types.js';
import { RiskLevel } from '../types.js';

export interface StatementEntry {
  check: CheckResult;
  sourceRange: SourceRange;
}

function riskRank(risk: RiskLevelType): number {
  switch (risk) {
    case RiskLevel.SAFE: return 0;
    case RiskLevel.LOW: return 1;
    case RiskLevel.MEDIUM: return 2;
    case RiskLevel.HIGH: return 3;
    case RiskLevel.CRITICAL: return 4;
  }
}

function effectiveRisk(check: CheckResult): RiskLevelType {
  return check.adjustedRisk ?? check.risk;
}

function isMoreSevere(candidate: CheckResult, current: CheckResult): boolean {
  return riskRank(effectiveRisk(candidate)) > riskRank(effectiveRisk(current));
}

/**
 * Group check results by exact statement range and keep the most severe
 * representative for statement-scoped UI surfaces.
 */
export function getStatementEntries(analysis: AnalyzeTextResult): StatementEntry[] {
  const entries: StatementEntry[] = [];
  const indexByRange = new Map<string, number>();

  for (let i = 0; i < analysis.checks.length; i++) {
    const check = analysis.checks[i];
    const sourceRange = analysis.sourceRanges[i];
    const key = `${sourceRange.startOffset}:${sourceRange.endOffset}`;
    const existingIndex = indexByRange.get(key);

    if (existingIndex == null) {
      indexByRange.set(key, entries.length);
      entries.push({ check, sourceRange });
      continue;
    }

    if (isMoreSevere(check, entries[existingIndex].check)) {
      entries[existingIndex] = { check, sourceRange };
    }
  }

  return entries;
}
