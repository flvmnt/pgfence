/**
 * SARIF 2.1.0 reporter — consumed by GitHub Code Scanning.
 *
 * Upload the output with actions/upload-sarif in your CI workflow to get
 * pgfence findings as inline annotations on pull requests.
 *
 * See: https://docs.github.com/en/code-security/code-scanning/integrating-with-code-scanning/sarif-support-for-code-scanning
 */

import type { AnalysisResult } from '../types.js';
import { RiskLevel } from '../types.js';

interface SarifLocation {
  physicalLocation: {
    artifactLocation: { uri: string; uriBaseId?: string };
  };
}

interface SarifResult {
  ruleId: string;
  level: 'error' | 'warning' | 'note';
  message: { text: string };
  locations: SarifLocation[];
}

interface SarifRule {
  id: string;
  name: string;
  shortDescription: { text: string };
  helpUri: string;
  properties: { tags: string[] };
}

function riskToLevel(risk: RiskLevel): 'error' | 'warning' | 'note' {
  switch (risk) {
    case RiskLevel.CRITICAL:
    case RiskLevel.HIGH:
      return 'error';
    case RiskLevel.MEDIUM:
      return 'warning';
    case RiskLevel.LOW:
    case RiskLevel.SAFE:
      return 'note';
  }
}

function toSarifResults(
  result: AnalysisResult,
  rules: Map<string, SarifRule>,
): SarifResult[] {
  const sarifResults: SarifResult[] = [];
  const uri = result.filePath.replace(/\\/g, '/');

  for (const check of result.checks) {
    const effectiveRisk = check.adjustedRisk ?? check.risk;
    if (effectiveRisk === RiskLevel.SAFE) continue;

    if (!rules.has(check.ruleId)) {
      rules.set(check.ruleId, {
        id: check.ruleId,
        name: check.ruleId
          .split('-')
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(''),
        shortDescription: { text: check.message },
        helpUri: `https://pgfence.com/docs/checks/lock-safety`,
        properties: { tags: ['postgres', 'migration', 'locks'] },
      });
    }

    const messageText = check.safeRewrite
      ? `${check.message} Safe rewrite: ${check.safeRewrite.description}`
      : check.message;

    sarifResults.push({
      ruleId: check.ruleId,
      level: riskToLevel(effectiveRisk),
      message: { text: messageText },
      locations: [{ physicalLocation: { artifactLocation: { uri, uriBaseId: '%SRCROOT%' } } }],
    });
  }

  for (const v of result.policyViolations) {
    const policyRuleId = `policy-${v.ruleId}`;
    if (!rules.has(policyRuleId)) {
      rules.set(policyRuleId, {
        id: policyRuleId,
        name: policyRuleId
          .split('-')
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(''),
        shortDescription: { text: v.message },
        helpUri: `https://pgfence.com/docs/checks/policy`,
        properties: { tags: ['postgres', 'migration', 'policy'] },
      });
    }

    sarifResults.push({
      ruleId: policyRuleId,
      level: v.severity === 'error' ? 'error' : 'warning',
      message: { text: `${v.message} Fix: ${v.suggestion}` },
      locations: [{ physicalLocation: { artifactLocation: { uri, uriBaseId: '%SRCROOT%' } } }],
    });
  }

  return sarifResults;
}

export function reportSARIF(results: AnalysisResult[]): string {
  const rules = new Map<string, SarifRule>();
  const sarifResults: SarifResult[] = [];

  let totalStatements = 0;
  let dynamicWarnings = 0;
  for (const result of results) {
    sarifResults.push(...toSarifResults(result, rules));
    totalStatements += result.statementCount;
    dynamicWarnings += result.extractionWarnings?.length ?? 0;
  }

  const coveragePct = totalStatements > 0
    ? Math.max(0, Math.round(((totalStatements - dynamicWarnings) / totalStatements) * 100))
    : 100;

  const sarif = {
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'pgfence',
            informationUri: 'https://pgfence.com',
            rules: Array.from(rules.values()),
          },
        },
        results: sarifResults,
        properties: {
          coverageSummary: {
            totalStatements,
            dynamicStatements: dynamicWarnings,
            coveragePercent: coveragePct,
          },
        },
      },
    ],
  };

  return JSON.stringify(sarif, null, 2);
}
