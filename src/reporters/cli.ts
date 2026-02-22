/**
 * CLI reporter — terminal table output with color-coded risk levels.
 *
 * Uses chalk for colors and cli-table3 for table formatting.
 */

import chalk from 'chalk';
import Table from 'cli-table3';
import type { AnalysisResult, CheckResult, PgfenceConfig } from '../types.js';
import { RiskLevel } from '../types.js';
import { RISK_ORDER } from '../analyzer.js';

function riskIndex(risk: RiskLevel): number {
  return RISK_ORDER.indexOf(risk);
}

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

export function reportCLI(results: AnalysisResult[], config: PgfenceConfig): string {
  const lines: string[] = [];

  for (const result of results) {
    const hasUnanalyzable = result.extractionWarnings?.some(w => w.message.includes('Unanalyzable'));
    const displayRisk = (result.maxRisk === RiskLevel.SAFE && hasUnanalyzable) ? 'UNANALYZABLE' : result.maxRisk;
    const color = displayRisk === 'UNANALYZABLE' ? chalk.yellow : riskColor(result.maxRisk);

    lines.push('');
    lines.push(chalk.bold(`  ${result.filePath}`) + '  ' + color(`[${displayRisk}]`));

    // Per-file summary for files that have actual checks
    if (result.checks.length > 0) {
      let worstCheck = result.checks[0];
      for (const c of result.checks) {
        if (riskIndex(c.adjustedRisk ?? c.risk) > riskIndex(worstCheck.adjustedRisk ?? worstCheck.risk)) {
          worstCheck = c;
        }
      }

      const worstRisk = worstCheck.adjustedRisk ?? worstCheck.risk;
      const worstLock = worstCheck.lockMode;
      const worstBlocks = blocksStr(worstCheck).replace(/, /g, '+') || 'none';
      const primaryRule = worstCheck.ruleId;

      lines.push(chalk.dim(`  Lock:`) + ` ${worstLock} ` + chalk.dim(`| Blocks:`) + ` ${worstBlocks} ` + chalk.dim(`| Risk:`) + ` ${worstRisk} ` + chalk.dim(`| Rule:`) + ` ${primaryRule}`);
    }

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
        colWidths: [4, 46, 20, 16, 12, 46],
        wordWrap: true,
        style: { head: [], border: [] },
      });

      // Group checks by statement string to avoid duplicate rows
      const grouped = new Map<string, CheckResult[]>();
      for (const check of result.checks) {
        if (!grouped.has(check.statement)) grouped.set(check.statement, []);
        grouped.get(check.statement)!.push(check);
      }

      let i = 0;
      const notes: string[] = [];

      for (const checkGroup of grouped.values()) {
        const preview = checkGroup[0].statementPreview;

        let lockMode = checkGroup[0].lockMode;
        let effectiveRisk = checkGroup[0].adjustedRisk ?? checkGroup[0].risk;
        let originalRisk = checkGroup[0].risk;
        let isAdjusted = checkGroup[0].adjustedRisk != null;

        for (const check of checkGroup) {
          const currentEffective = check.adjustedRisk ?? check.risk;
          if (riskIndex(currentEffective) > riskIndex(effectiveRisk)) {
            effectiveRisk = currentEffective;
            originalRisk = check.risk;
            isAdjusted = check.adjustedRisk != null;
            lockMode = check.lockMode;
          }
        }

        const rc = riskColor(effectiveRisk);
        const riskStr = isAdjusted
          ? `${rc(effectiveRisk)} (was ${originalRisk})`
          : rc(effectiveRisk);

        const primaryCheck = checkGroup.find(c => c.risk === originalRisk && c.lockMode === lockMode) || checkGroup[0];
        const secondaryChecks = checkGroup.filter(c => c !== primaryCheck);

        table.push([
          String(i + 1),
          preview,
          lockMode,
          blocksStr(primaryCheck),
          riskStr,
          primaryCheck.message,
        ]);

        for (const sec of secondaryChecks) {
          notes.push(`Statement #${i + 1} [${sec.ruleId}]: ${sec.message}`);
        }

        i++;
      }

      lines.push(table.toString());

      if (notes.length > 0) {
        lines.push('');
        lines.push(chalk.bold('  Notes & Suggestions:'));
        for (const note of notes) {
          lines.push(chalk.cyan(`  • ${note}`));
        }
      }

      // Safe rewrite recipes vs. Notes
      const actualRewrites = result.checks.filter((c) => c.safeRewrite && c.risk !== RiskLevel.LOW && c.risk !== RiskLevel.SAFE);
      const safeNotes = result.checks.filter((c) => c.safeRewrite && (c.risk === RiskLevel.LOW || c.risk === RiskLevel.SAFE));

      if (actualRewrites.length > 0) {
        lines.push('');
        lines.push(chalk.bold('  Safe Rewrite Recipes:'));
        for (const check of actualRewrites) {
          lines.push('');
          lines.push(chalk.cyan(`  ${check.ruleId}: ${check.safeRewrite!.description}`));
          for (const step of check.safeRewrite!.steps) {
            lines.push(chalk.dim(`    ${step}`));
          }
        }
      }

      if (safeNotes.length > 0) {
        lines.push('');
        lines.push(chalk.bold('  Notes / Why this is safe:'));
        for (const check of safeNotes) {
          lines.push('');
          lines.push(chalk.cyan(`  ${check.ruleId}: ${check.safeRewrite!.description}`));
          for (const step of check.safeRewrite!.steps) {
            lines.push(chalk.dim(`    ${step}`));
          }
        }
      }
    } else {
      const hasUnanalyzable = result.extractionWarnings?.some(w => w.message.includes('Unanalyzable'));
      if (hasUnanalyzable) {
        lines.push(chalk.yellow('  File contains unanalyzable statements requiring manual review.'));
      } else {
        lines.push(chalk.green('  No dangerous statements detected.'));
      }
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
  lines.push(`Postgres ruleset: PG${config.minPostgresVersion}+ (configurable)`);
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
