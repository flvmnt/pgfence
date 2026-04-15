/**
 * GitHub PR comment reporter: Markdown output.
 *
 * Generates a markdown table suitable for posting as a PR comment.
 */

import type { AnalysisResult, CheckResult } from '../types.js';
import { RiskLevel } from '../types.js';

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
    const emoji = riskEmoji(result.maxRisk);
    lines.push(`### ${renderInline(result.filePath)} ${emoji} ${result.maxRisk}`);
    lines.push('');

    // Extraction warnings
    if (result.extractionWarnings && result.extractionWarnings.length > 0) {
      for (const w of result.extractionWarnings) {
        lines.push(`> :warning: ${renderInline(w.message)} ${renderInline(`(${w.filePath}:${w.line}:${w.column})`)}`);
      }
      lines.push('');
    }

    // Statement checks
    if (result.checks.length > 0) {
      lines.push('| # | Statement | Lock Mode | Blocks | Risk | Message |');
      lines.push('|---|-----------|-----------|--------|------|---------|');
      for (let i = 0; i < result.checks.length; i++) {
        const c = result.checks[i];
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
      const rewrites = result.checks.filter((c) => c.safeRewrite && (c.adjustedRisk ?? c.risk) !== RiskLevel.LOW && (c.adjustedRisk ?? c.risk) !== RiskLevel.SAFE);
      const safeNotes = result.checks.filter((c) => c.safeRewrite && ((c.adjustedRisk ?? c.risk) === RiskLevel.LOW || (c.adjustedRisk ?? c.risk) === RiskLevel.SAFE));
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

  // Coverage summary (Trust Contract requirement)
  const totalStatements = results.reduce((sum, r) => sum + r.statementCount, 0);
  const dynamicWarnings = results.reduce(
    (sum, r) => sum + (r.extractionWarnings?.filter(w => w.unanalyzable).length ?? 0),
    0,
  );
  const coveragePct = totalStatements > 0
    ? Math.max(0, Math.round(((totalStatements - dynamicWarnings) / totalStatements) * 100))
    : dynamicWarnings > 0 ? 0 : 100;
  lines.push('### Coverage');
  lines.push('');
  lines.push(
    `Analyzed **${totalStatements}** SQL statements. ` +
    `**${dynamicWarnings}** dynamic statements not analyzable. ` +
    `Coverage: **${coveragePct}%**`,
  );
  lines.push('');

  lines.push('---');
  lines.push('*Generated by [pgfence](https://pgfence.com)*');

  return lines.join('\n');
}
