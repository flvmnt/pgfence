/**
 * GitHub PR comment reporter: Markdown output.
 *
 * Generates a markdown table suitable for posting as a PR comment.
 */

import type { AnalysisResult, CheckResult } from '../types.js';
import { RiskLevel } from '../types.js';
import { summarizeCoverage, formatCoverageLine } from './coverage.js';
import { checksForReport } from './checks.js';

const GITHUB_COMMENT_MAX_LENGTH = 65000;
const TRUNCATION_NOTICE = '\n\n> :warning: Report truncated to stay below the GitHub PR comment size limit. Run `pgfence analyze --output json` locally for the full result.\n';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeTableText(text: string): string {
  return escapeHtml(text).replace(/\|/g, '&#124;').replace(/\r?\n/g, '<br>');
}

function renderInline(text: string): string {
  return `<code>${escapeHtml(text)}</code>`;
}

function renderTableCell(text: string): string {
  return `<code>${escapeTableText(text)}</code>`;
}

function riskEmoji(risk: RiskLevel): string {
  switch (risk) {
    case RiskLevel.SAFE: return ':white_check_mark:';
    case RiskLevel.LOW: return ':large_blue_circle:';
    case RiskLevel.MEDIUM: return ':warning:';
    case RiskLevel.HIGH: return ':red_circle:';
    case RiskLevel.CRITICAL: return ':rotating_light:';
  }
}

function blocksStr(check: CheckResult): string {
  const parts: string[] = [];
  if (check.blocks.reads) parts.push('reads');
  if (check.blocks.writes) parts.push('writes');
  if (check.blocks.otherDdl) parts.push('DDL');
  return parts.join(', ') || 'none';
}

export function reportGitHub(results: AnalysisResult[]): string {
  const lines: string[] = [];
  lines.push('## pgfence Migration Safety Report');
  lines.push('');

  for (const result of results) {
    const checks = checksForReport(result);
    const hasUnanalyzable = result.extractionWarnings?.some((warning) => warning.unanalyzable) ?? false;
    const displayRisk = hasUnanalyzable ? 'UNANALYZABLE' : result.maxRisk;
    const emoji = displayRisk === 'UNANALYZABLE' ? ':warning:' : riskEmoji(result.maxRisk);
    lines.push(`### ${renderInline(result.filePath)} ${emoji} ${displayRisk}`);
    lines.push('');

    // Extraction warnings
    if (result.extractionWarnings && result.extractionWarnings.length > 0) {
      for (const w of result.extractionWarnings) {
        lines.push(`> :warning: ${renderInline(w.message)} ${renderInline(`(${w.filePath}:${w.line}:${w.column})`)}`);
      }
      lines.push('');
    }

    // Statement checks
    if (checks.length > 0) {
      lines.push('| # | Statement | Lock Mode | Blocks | Risk | Message |');
      lines.push('|---|-----------|-----------|--------|------|---------|');
      for (let i = 0; i < checks.length; i++) {
        const c = checks[i];
        const effectiveRisk = c.adjustedRisk ?? c.risk;
        const riskStr = c.adjustedRisk
          ? `${riskEmoji(effectiveRisk)} ${effectiveRisk} (was ${c.risk})`
          : `${riskEmoji(effectiveRisk)} ${effectiveRisk}`;
        const preview = renderTableCell(c.statementPreview);
        const msg = renderTableCell(c.message);
        lines.push(`| ${i + 1} | ${preview} | ${renderTableCell(c.lockMode)} | ${renderTableCell(blocksStr(c))} | ${riskStr} | ${msg} |`);
      }
      lines.push('');

      // Safe rewrite recipes (MEDIUM+ risk only, matching CLI reporter behavior)
      const rewrites = checks.filter((c) => c.safeRewrite && (c.adjustedRisk ?? c.risk) !== RiskLevel.LOW && (c.adjustedRisk ?? c.risk) !== RiskLevel.SAFE);
      const safeNotes = checks.filter((c) => c.safeRewrite && ((c.adjustedRisk ?? c.risk) === RiskLevel.LOW || (c.adjustedRisk ?? c.risk) === RiskLevel.SAFE));
      if (rewrites.length > 0) {
        lines.push('<details>');
        lines.push('<summary>Safe Rewrite Recipes</summary>');
        lines.push('');
        for (const c of rewrites) {
          lines.push(`#### ${renderInline(c.ruleId)} ${renderInline(c.safeRewrite!.description)}`);
          lines.push('<pre><code class="language-sql">');
          for (const step of c.safeRewrite!.steps) {
            lines.push(escapeHtml(step));
          }
          lines.push('</code></pre>');
          lines.push('');
        }
        lines.push('</details>');
        lines.push('');
      }
      if (safeNotes.length > 0) {
        lines.push('<details>');
        lines.push('<summary>Notes / Why this is safe</summary>');
        lines.push('');
        for (const c of safeNotes) {
          lines.push(`#### ${renderInline(c.ruleId)} ${renderInline(c.safeRewrite!.description)}`);
          lines.push('<pre><code class="language-sql">');
          for (const step of c.safeRewrite!.steps) {
            lines.push(escapeHtml(step));
          }
          lines.push('</code></pre>');
          lines.push('');
        }
        lines.push('</details>');
        lines.push('');
      }
    } else if (hasUnanalyzable) {
      lines.push(':warning: File contains unanalyzable statements requiring manual review.');
      lines.push('');
    } else {
      lines.push(':white_check_mark: No dangerous statements detected.');
      lines.push('');
    }

    // Policy violations
    if (result.policyViolations.length > 0) {
      lines.push('**Policy Violations:**');
      lines.push('');
      lines.push('| Severity | Rule | Message | Suggestion |');
      lines.push('|----------|------|---------|------------|');
      for (const v of result.policyViolations) {
        const sev = v.severity === 'error' ? ':red_circle: error' : ':warning: warning';
        const msg = renderTableCell(v.message);
        const sug = renderTableCell(v.suggestion);
        lines.push(`| ${sev} | ${renderTableCell(v.ruleId)} | ${msg} | ${sug} |`);
      }
      lines.push('');
    }
  }

  const coverage = summarizeCoverage(results);
  const footerLines = [
    '### Coverage',
    '',
    formatCoverageLine(coverage),
    '',
    '---',
    '*[pgfence](https://pgfence.com) migration safety report*',
  ];
  const body = lines.join('\n');
  const footer = footerLines.join('\n');
  const output = `${body}\n${footer}`;
  if (output.length <= GITHUB_COMMENT_MAX_LENGTH) return output;
  const reservedFooter = `${TRUNCATION_NOTICE}${footer}`;
  const budget = GITHUB_COMMENT_MAX_LENGTH - reservedFooter.length;
  return body.slice(0, Math.max(0, budget)).trimEnd() + reservedFooter;
}
