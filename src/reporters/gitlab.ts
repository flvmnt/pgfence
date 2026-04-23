/**
 * GitLab Code Quality reporter.
 *
 * Produces a JSON array consumable by GitLab CI as a Code Quality artifact:
 *   artifacts:
 *     reports:
 *       codequality: gl-code-quality-report.json
 *
 * See: https://docs.gitlab.com/ci/testing/code_quality/
 *
 * Note: CheckResult does not carry line numbers, so all findings report line 1.
 * This matches the SARIF reporter's behavior (same upstream limitation).
 */

import { createHash } from 'node:crypto';
import type { AnalysisResult } from '../types.js';
import { RiskLevel } from '../types.js';
import { countUnanalyzable } from './coverage.js';

type GitLabSeverity = 'info' | 'minor' | 'major' | 'critical' | 'blocker';

interface GitLabViolation {
  description: string;
  check_name: string;
  fingerprint: string;
  severity: GitLabSeverity;
  location: {
    path: string;
    lines: { begin: number };
  };
}

function riskToSeverity(risk: RiskLevel): GitLabSeverity {
  switch (risk) {
    case RiskLevel.CRITICAL: return 'blocker';
    case RiskLevel.HIGH: return 'major';
    case RiskLevel.MEDIUM: return 'minor';
    case RiskLevel.LOW:
    case RiskLevel.SAFE: return 'info';
  }
}

function fingerprint(...parts: Array<string | number>): string {
  return createHash('sha1').update(parts.join(':')).digest('hex');
}

function normalizePath(filePath: string): string {
  return filePath.replace(/^\.\//, '').replace(/^\//, '');
}

export function reportGitLab(results: AnalysisResult[]): string {
  const violations: GitLabViolation[] = [];

  for (const result of results) {
    const path = normalizePath(result.filePath);
    const fingerprintsBySeed = new Map<string, number>();

    const pushViolation = (
      violation: Omit<GitLabViolation, 'fingerprint'>,
      seed: string,
      beginLine: number,
    ): void => {
      const nextOccurrence = (fingerprintsBySeed.get(seed) ?? 0) + 1;
      fingerprintsBySeed.set(seed, nextOccurrence);
      violations.push({
        ...violation,
        location: {
          ...violation.location,
          lines: { begin: beginLine },
        },
        fingerprint: fingerprint(seed, path, nextOccurrence),
      });
    };

    let syntheticLine = 1;
    for (const check of result.checks) {
      const effectiveRisk = check.adjustedRisk ?? check.risk;
      pushViolation({
        description: check.message,
        check_name: check.ruleId,
        severity: riskToSeverity(effectiveRisk),
        location: { path, lines: { begin: 1 } },
      }, check.ruleId, syntheticLine++);
    }

    for (const warning of result.extractionWarnings ?? []) {
      pushViolation({
        description: `${warning.message}${warning.unanalyzable ? ' [UNANALYZABLE]' : ''}`,
        check_name: 'pgfence-extraction-warning',
        severity: warning.unanalyzable ? 'minor' : 'info',
        location: { path, lines: { begin: warning.line ?? 1 } },
      }, `${warning.filePath}:${warning.line}:${warning.column}:${warning.message}`, warning.line ?? syntheticLine++);
    }

    for (const v of result.policyViolations) {
      const severity: GitLabSeverity = v.severity === 'error' ? 'critical' : 'minor';
      const checkName = `policy-${v.ruleId}`;
      pushViolation({
        description: `${v.message} Fix: ${v.suggestion}`,
        check_name: checkName,
        severity,
        location: { path, lines: { begin: 1 } },
      }, checkName, syntheticLine++);
    }

    const dynamicWarnings = countUnanalyzable(result);
    const totalStatements = result.statementCount + dynamicWarnings;
    const coveragePct = totalStatements > 0
      ? Math.round((result.statementCount / totalStatements) * 100)
      : 100;
    pushViolation({
      description: `Analyzed ${result.statementCount} SQL statements. ${dynamicWarnings} dynamic statements not analyzable. Coverage: ${coveragePct}%.`,
      check_name: 'pgfence-coverage-summary',
      severity: 'info',
      location: { path, lines: { begin: 1 } },
    }, 'pgfence-coverage-summary', syntheticLine++);
  }

  return JSON.stringify(violations, null, 2);
}
