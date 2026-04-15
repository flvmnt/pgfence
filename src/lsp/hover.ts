/**
 * LSP Hover provider.
 *
 * Shows lock mode details, blocked operations, risk level,
 * and safe rewrite recipes on hover over flagged statements.
 */

import {
  MarkupKind,
  Range,
} from 'vscode-languageserver';
import type { Hover, HoverParams } from 'vscode-languageserver';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { CheckResult } from '../types.js';
import type { AnalyzeTextResult } from './analyze-text.js';
import { offsetToPosition } from './diagnostics.js';
import { getStatementEntries } from './statement-groups.js';

/**
 * Get hover content for the position under the cursor.
 */
export function getHoverContent(
  params: HoverParams,
  analysis: AnalyzeTextResult,
  doc: TextDocument,
): Hover | null {
  const text = doc.getText();
  const cursorLine = params.position.line;
  const cursorChar = params.position.character;

  // Find which check result covers this position
  for (const { check, sourceRange } of getStatementEntries(analysis)) {
    const start = offsetToPosition(text, sourceRange.startOffset);
    const end = offsetToPosition(text, sourceRange.endOffset);

    // Check if cursor is within this statement's range
    if (cursorLine < start.line || cursorLine > end.line) continue;
    if (cursorLine === start.line && cursorChar < start.character) continue;
    if (cursorLine === end.line && cursorChar > end.character) continue;

    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: buildHoverMarkdown(check),
      },
      range: Range.create(start, end),
    };
  }

  return null;
}

function buildHoverMarkdown(check: CheckResult): string {
  const effectiveRisk = check.adjustedRisk ?? check.risk;
  const lines: string[] = [];

  lines.push(`**pgfence** | ${inlineCode(check.ruleId)} | ${escapeMarkdownText(effectiveRisk)} risk`);
  lines.push('');
  lines.push(`**Lock**: ${inlineCode(check.lockMode)}`);

  const blockParts: string[] = [];
  if (check.blocks.reads) blockParts.push('reads');
  if (check.blocks.writes) blockParts.push('writes');
  if (check.blocks.otherDdl) blockParts.push('DDL');

  const allowParts: string[] = [];
  if (!check.blocks.reads) allowParts.push('reads');
  if (!check.blocks.writes) allowParts.push('writes');
  if (!check.blocks.otherDdl) allowParts.push('DDL');

  lines.push(
    `**Blocks**: ${escapeMarkdownText(blockParts.join(', ') || 'nothing')} | ` +
    `**Allows**: ${escapeMarkdownText(allowParts.join(', ') || 'nothing')}`,
  );

  if (check.tableName) {
    lines.push(`**Table**: ${inlineCode(check.tableName)}`);
  }

  if (check.adjustedRisk && check.adjustedRisk !== check.risk) {
    lines.push(`**Base risk**: ${escapeMarkdownText(check.risk)} (adjusted by table size)`);
  }

  lines.push('');
  lines.push(escapeMarkdownText(check.message));

  if (check.safeRewrite) {
    lines.push('');
    lines.push(`**Safe alternative**: ${escapeMarkdownText(check.safeRewrite.description)}`);
    lines.push('');
    lines.push(...renderSqlBlock(check.safeRewrite.steps));
  }

  return lines.join('\n');
}

function escapeMarkdownText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/([`*_{}()#+\-.!|>])/g, '\\$1')
    .replace(/\[/g, '\\[')
    .replace(/]/g, '\\]');
}

function inlineCode(text: string): string {
  const backtickRuns = text.match(/`+/g) ?? [];
  const longestRun = Math.max(0, ...backtickRuns.map((run) => run.length));
  const fence = '`'.repeat(Math.max(1, longestRun + 1));
  const paddedText = /(^`)|(`$)/.test(text) ? ` ${text} ` : text;
  return `${fence}${paddedText}${fence}`;
}

function renderSqlBlock(steps: string[]): string[] {
  const longestRun = Math.max(
    0,
    ...steps.flatMap((step) => (step.match(/`+/g) ?? []).map((run) => run.length)),
  );
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return [(`${fence}sql`), ...steps, fence];
}
