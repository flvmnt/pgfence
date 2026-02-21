/**
 * CLI reporter — terminal table output with color-coded risk levels.
 *
 * Uses chalk for colors and cli-table3 for table formatting.
 */

import chalk from 'chalk';
import Table from 'cli-table3';
import type { AnalysisResult, CheckResult } from '../types.js';
import { RiskLevel } from '../types.js';

function riskColor(risk: RiskLevel): (s: string) => string {
  switch (risk) {
    case RiskLevel.SAFE:
    case RiskLevel.LOW:
      return chalk.green;
    case RiskLevel.MEDIUM:
      return chalk.yellow;
    case RiskLevel.HIGH:
      return chalk.red;
    case RiskLevel.CRITICAL:
      return chalk.bgRed.white.bold;
  }
}

function severityColor(severity: 'error' | 'warning'): (s: string) => string {
  return severity === 'error' ? chalk.red : chalk.yellow;
}

function blocksStr(check: CheckResult): string {
  const parts: string[] = [];
  if (check.blocks.reads) parts.push('reads');
  if (check.blocks.writes) parts.push('writes');
  if (check.blocks.otherDdl) parts.push('DDL');
  return parts.join(', ') || 'none';
}

export function reportCLI(results: AnalysisResult[]): string {
  const lines: string[] = [];

  for (const result of results) {
    const color = riskColor(result.maxRisk);
    lines.push('');
    lines.push(chalk.bold(`  ${result.filePath}`) + '  ' + color(`[${result.maxRisk}]`));
    lines.push('');

    // Extraction warnings
    if (result.extractionWarnings && result.extractionWarnings.length > 0) {
      for (const w of result.extractionWarnings) {
        lines.push(chalk.yellow(`  ⚠ ${w.message} (${w.filePath}:${w.line}:${w.column})`));
      }
      lines.push('');
    }

    // Statement checks
    if (result.checks.length > 0) {
      const table = new Table({
        head: ['#', 'Statement', 'Lock Mode', 'Blocks', 'Risk', 'Message'].map((h) => chalk.dim(h)),
        colWidths: [4, 40, 22, 18, 10, 50],
        wordWrap: true,
        style: { head: [], border: [] },
      });

      for (let i = 0; i < result.checks.length; i++) {
        const check = result.checks[i];
        const effectiveRisk = check.adjustedRisk ?? check.risk;
        const rc = riskColor(effectiveRisk);
        const riskStr = check.adjustedRisk
          ? `${rc(effectiveRisk)} (was ${check.risk})`
          : rc(effectiveRisk);

        table.push([
          String(i + 1),
          check.statementPreview,
          check.lockMode,
          blocksStr(check),
          riskStr,
          check.message,
        ]);
      }

      lines.push(table.toString());

      // Safe rewrite recipes
      const rewrites = result.checks.filter((c) => c.safeRewrite);
      if (rewrites.length > 0) {
        lines.push('');
        lines.push(chalk.bold('  Safe Rewrite Recipes:'));
        for (const check of rewrites) {
          lines.push('');
          lines.push(chalk.cyan(`  ${check.ruleId}: ${check.safeRewrite!.description}`));
          for (const step of check.safeRewrite!.steps) {
            lines.push(chalk.dim(`    ${step}`));
          }
        }
      }
    } else {
      lines.push(chalk.green('  No dangerous statements detected.'));
    }

    // Policy violations
    if (result.policyViolations.length > 0) {
      lines.push('');
      lines.push(chalk.bold('  Policy Violations:'));
      for (const v of result.policyViolations) {
        const sc = severityColor(v.severity);
        lines.push(`  ${sc(v.severity.toUpperCase())} ${v.message}`);
        lines.push(chalk.dim(`    → ${v.suggestion}`));
      }
    }

    lines.push('');
  }

  // Coverage summary (Trust Contract requirement)
  const totalStatements = results.reduce((sum, r) => sum + r.statementCount, 0);
  const dynamicWarnings = results.reduce(
    (sum, r) => sum + (r.extractionWarnings?.length ?? 0),
    0,
  );
  lines.push(chalk.bold('=== Coverage ==='));
  const coveragePct = totalStatements > 0
    ? Math.round(((totalStatements - dynamicWarnings) / totalStatements) * 100)
    : 100;
  lines.push(
    `Analyzed: ${totalStatements} statements  |  ` +
    `Unanalyzable: ${dynamicWarnings}  |  ` +
    `Coverage: ${coveragePct}%`,
  );
  lines.push('');

  return lines.join('\n');
}
