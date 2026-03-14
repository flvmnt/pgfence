/**
 * Trace CLI reporter: terminal table output with verification status.
 *
 * Extends the standard CLI reporter pattern with trace-specific columns
 * (Verified, Duration) and a trace coverage summary.
 */

import chalk from 'chalk';
import Table from 'cli-table3';
import type { TraceResult, TraceCheckResult } from '../types.js';
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

function blocksStr(check: TraceCheckResult): string {
  const parts: string[] = [];
  if (check.blocks.reads) parts.push('R');
  if (check.blocks.writes) parts.push('W');
  if (check.blocks.otherDdl) parts.push('DDL');
  return parts.join(' + ') || 'none';
}

function verifiedColor(status: TraceCheckResult['verification']): (s: string) => string {
  switch (status) {
    case 'confirmed':
      return chalk.green;
    case 'mismatch':
      return chalk.red;
    case 'trace-only':
      return chalk.yellow;
    case 'static-only':
      return chalk.dim;
    case 'error':
      return chalk.red;
    case 'cascade-error':
      return chalk.dim;
  }
}

function verifiedLabel(status: TraceCheckResult['verification']): string {
  switch (status) {
    case 'confirmed':
      return 'Confirmed';
    case 'mismatch':
      return 'Mismatch';
    case 'trace-only':
      return 'Trace-only';
    case 'static-only':
      return 'Static-only';
    case 'error':
      return 'Error';
    case 'cascade-error':
      return 'Cascade';
  }
}

function formatDuration(ms: number | undefined): string {
  if (ms == null) return '-';
  if (ms < 1) return '<1ms';
  return `${Math.round(ms)}ms`;
}

export function reportTraceCLI(results: TraceResult[]): string {
  const lines: string[] = [];

  // Header with PG version info from first result
  const pgVersion = results[0]?.pgVersion ?? 17;
  lines.push('');
  lines.push(chalk.bold(`pgfence - Trace Report (PostgreSQL ${pgVersion}, Docker)`));

  for (const result of results) {
    lines.push('');
    const color = riskColor(result.maxRisk);
    lines.push(chalk.bold(`  ${result.filePath}`) + '  ' + color(`[${result.maxRisk}]`));
    lines.push('');

    // Extraction warnings
    if (result.extractionWarnings && result.extractionWarnings.length > 0) {
      for (const w of result.extractionWarnings) {
        lines.push(chalk.yellow(`  ! ${w.message} (${w.filePath}:${w.line}:${w.column})`));
      }
      lines.push('');
    }

    // Statement checks table
    const traceChecks: TraceCheckResult[] = result.traceChecks ?? result.checks as TraceCheckResult[];
    if (traceChecks.length > 0) {
      const table = new Table({
        head: ['#', 'Statement', 'Lock Mode', 'Blocks', 'Risk', 'Verified', 'Duration'].map(
          (h) => chalk.dim(h),
        ),
        colWidths: [4, 44, 22, 10, 12, 14, 10],
        wordWrap: true,
        style: { head: [], border: [] },
      });

      // Group checks by statement to avoid duplicate rows
      const grouped = new Map<string, TraceCheckResult[]>();
      for (const check of traceChecks) {
        if (!grouped.has(check.statement)) grouped.set(check.statement, []);
        grouped.get(check.statement)!.push(check);
      }

      let i = 0;

      for (const checkGroup of grouped.values()) {
        const preview = checkGroup[0].statementPreview;

        let lockMode = checkGroup[0].lockMode;
        let effectiveRisk = checkGroup[0].adjustedRisk ?? checkGroup[0].risk;
        let bestCheck = checkGroup[0];

        for (const check of checkGroup) {
          const currentEffective = check.adjustedRisk ?? check.risk;
          if (riskIndex(currentEffective) > riskIndex(effectiveRisk)) {
            effectiveRisk = currentEffective;
            lockMode = check.lockMode;
            bestCheck = check;
          }
        }

        const rc = riskColor(effectiveRisk);
        const vc = verifiedColor(bestCheck.verification);

        let statementCell = preview;
        if (bestCheck.verification === 'mismatch' && bestCheck.tracedLockMode) {
          statementCell = preview + '\n' + chalk.dim(`(predicted: ${lockMode})`);
          lockMode = bestCheck.tracedLockMode;
        }

        table.push([
          String(i + 1),
          statementCell,
          lockMode,
          blocksStr(bestCheck),
          rc(effectiveRisk),
          vc(verifiedLabel(bestCheck.verification)),
          formatDuration(bestCheck.durationMs),
        ]);

        i++;
      }

      lines.push(table.toString());

      // Trace-only findings (table rewrites, trace-only checks)
      const traceFindings: string[] = [];
      for (const check of traceChecks) {
        if (check.tableRewrite && check.tableName) {
          traceFindings.push(
            `Table rewrite detected on "${check.tableName}" (relfilenode changed)`,
          );
        }
      }
      const traceOnlyChecks = traceChecks.filter((c) => c.verification === 'trace-only');
      for (const check of traceOnlyChecks) {
        traceFindings.push(`${check.message} [${check.ruleId}]`);
      }

      if (traceFindings.length > 0) {
        lines.push('');
        lines.push(chalk.bold('  Trace-Only Findings:'));
        for (const finding of traceFindings) {
          lines.push(chalk.yellow(`  ! ${finding}`));
        }
      }

      // Policy violations
      if (result.policyViolations.length > 0) {
        lines.push('');
        lines.push(chalk.bold('  Policy Violations:'));
        for (const v of result.policyViolations) {
          const sc = v.severity === 'error' ? chalk.red : chalk.yellow;
          lines.push(`  ${sc('x')} ${v.message}`);
          lines.push(chalk.dim(`    -> ${v.suggestion}`));
        }
      }

      // Safe rewrite recipes
      const actualRewrites = traceChecks.filter(
        (c) =>
          c.safeRewrite &&
          (c.adjustedRisk ?? c.risk) !== RiskLevel.LOW &&
          (c.adjustedRisk ?? c.risk) !== RiskLevel.SAFE,
      );

      if (actualRewrites.length > 0) {
        lines.push('');
        lines.push(chalk.bold('  Safe Rewrites:'));
        for (let j = 0; j < actualRewrites.length; j++) {
          const check = actualRewrites[j];
          lines.push(
            chalk.cyan(`  ${j + 1}. ${check.safeRewrite!.description}`),
          );
          for (const step of check.safeRewrite!.steps) {
            lines.push(chalk.dim(`     ${step}`));
          }
        }
      }
    } else {
      lines.push(chalk.green('  No dangerous statements detected.'));
    }

    lines.push('');
  }

  // Coverage summary
  const totalStatements = results.reduce((sum, r) => sum + r.statementCount, 0);
  const allChecks = results.flatMap((r) => r.traceChecks ?? r.checks as TraceCheckResult[]);
  const verified = allChecks.filter(
    (c) => c.verification === 'confirmed' || c.verification === 'mismatch',
  ).length;
  const mismatches = allChecks.filter((c) => c.verification === 'mismatch').length;
  const traceOnly = allChecks.filter((c) => c.verification === 'trace-only').length;

  const dockerImage = 'postgres:' + (results[0]?.pgVersion ?? 17) + '-alpine';
  const containerLifetime = results.reduce((max, r) => Math.max(max, r.containerLifetimeMs ?? 0), 0) / 1000;

  lines.push(chalk.bold('=== Coverage ==='));
  lines.push(
    `Analyzed: ${totalStatements} statements | ` +
      `Verified: ${verified}/${allChecks.length} | ` +
      `Mismatches: ${mismatches} | ` +
      `Trace-only: ${traceOnly}`,
  );
  lines.push(`Docker: ${dockerImage} | Container lifetime: ${containerLifetime.toFixed(1)}s`);
  lines.push('');

  return lines.join('\n');
}
