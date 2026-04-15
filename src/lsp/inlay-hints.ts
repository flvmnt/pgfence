/**
 * LSP Inlay Hints provider.
 *
 * Shows the lock mode and risk level inline at the end of each flagged
 * SQL statement. Example: "ALTER TABLE users ..." → "⚠ ACCESS EXCLUSIVE (HIGH)"
 */

import {
  InlayHint,
  InlayHintKind,
  MarkupKind,
} from 'vscode-languageserver';
import type { InlayHintParams } from 'vscode-languageserver';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { AnalyzeTextResult } from './analyze-text.js';
import type { CheckResult } from '../types.js';
import { RiskLevel } from '../types.js';
import { offsetToPosition } from './diagnostics.js';
import { getStatementEntries } from './statement-groups.js';

function riskIcon(risk: RiskLevel): string {
  switch (risk) {
    case RiskLevel.CRITICAL: return '🔴';
    case RiskLevel.HIGH: return '⚠';
    case RiskLevel.MEDIUM: return '🟡';
    case RiskLevel.LOW: return '🟢';
    case RiskLevel.SAFE: return '✓';
  }
}

function hintLabel(check: CheckResult): string {
  const effectiveRisk = check.adjustedRisk ?? check.risk;
  return `${riskIcon(effectiveRisk)} ${check.lockMode} (${effectiveRisk})`;
}

export function getInlayHints(
  params: InlayHintParams,
  analysis: AnalyzeTextResult,
  doc: TextDocument,
): InlayHint[] {
  const text = doc.getText();
  const hints: InlayHint[] = [];
  const { start: rangeStart, end: rangeEnd } = params.range;

  for (const { check, sourceRange } of getStatementEntries(analysis)) {
    const endPos = offsetToPosition(text, sourceRange.endOffset);

    if (endPos.line < rangeStart.line || endPos.line > rangeEnd.line) continue;

    hints.push({
      position: endPos,
      label: hintLabel(check),
      kind: InlayHintKind.Type,
      paddingLeft: true,
      tooltip: {
        kind: MarkupKind.Markdown,
        value: check.message,
      },
    });
  }

  return hints;
}
