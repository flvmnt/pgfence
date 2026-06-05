import type { AnalysisResult, CheckResult, TraceResult } from '../types.js';

export function checksForReport(result: AnalysisResult): CheckResult[] {
  const traceChecks = (result as Partial<TraceResult>).traceChecks;
  return Array.isArray(traceChecks) ? traceChecks : result.checks;
}
