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
  for (let i = 0; i < analysis.checks.length; i++) {
    const sourceRange = analysis.sourceRanges[i];
    const start = offsetToPosition(text, sourceRange.startOffset);
    const end = offsetToPosition(text, sourceRange.endOffset);

    // Check if cursor is within this statement's range
    if (cursorLine < start.line || cursorLine > end.line) continue;
    if (cursorLine === start.line && cursorChar < start.character) continue;
    if (cursorLine === end.line && cursorChar > end.character) continue;

    const check = analysis.checks[i];
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

  lines.push(`**pgfence** | \`${check.ruleId}\` | ${effectiveRisk} risk`);
  lines.push('');
  lines.push(`**Lock**: \`${check.lockMode}\``);

  const blockParts: string[] = [];
  if (check.blocks.reads) blockParts.push('reads');
  if (check.blocks.writes) blockParts.push('writes');
  if (check.blocks.otherDdl) blockParts.push('DDL');

  const allowParts: string[] = [];
  if (!check.blocks.reads) allowParts.push('reads');
  if (!check.blocks.writes) allowParts.push('writes');
  if (!check.blocks.otherDdl) allowParts.push('DDL');

  lines.push(`**Blocks**: ${blockParts.join(', ') || 'nothing'} | **Allows**: ${allowParts.join(', ') || 'nothing'}`);

  if (check.tableName) {
    lines.push(`**Table**: \`${check.tableName}\``);
  }

  if (check.adjustedRisk && check.adjustedRisk !== check.risk) {
    lines.push(`**Base risk**: ${check.risk} (adjusted by table size)`);
  }

  lines.push('');
  lines.push(check.message);

  if (check.safeRewrite) {
    lines.push('');
    lines.push(`**Safe alternative**: ${check.safeRewrite.description}`);
    lines.push('');
    lines.push('```sql');
    for (const step of check.safeRewrite.steps) {
      lines.push(step);
    }
    lines.push('```');
  }

  return lines.join('\n');
}
