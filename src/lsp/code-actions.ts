/**
 * LSP Code Action provider.
 *
 * Provides:
 * 1. Safe rewrite quick fixes (pgfence's unique differentiator)
 * 2. pgfence-ignore comment insertion
 */

import {
  CodeAction,
  CodeActionKind,
  TextEdit,
  Range,
  Position,
} from 'vscode-languageserver';
import type { CodeActionParams } from 'vscode-languageserver';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { AnalyzeTextResult } from './analyze-text.js';
import { offsetToPosition } from './diagnostics.js';
import type { SafeRewrite } from '../types.js';

function rangeOverlaps(
  startA: { line: number; character: number },
  endA: { line: number; character: number },
  startB: { line: number; character: number },
  endB: { line: number; character: number },
): boolean {
  if (endA.line < startB.line || endB.line < startA.line) return false;
  if (endA.line === startB.line && endA.character <= startB.character) return false;
  if (endB.line === startA.line && endB.character <= startA.character) return false;
  return true;
}

function isExecutableSafeRewrite(safeRewrite: SafeRewrite): boolean {
  let hasExecutableStep = false;

  for (const step of safeRewrite.steps) {
    for (const line of step.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Placeholder-heavy steps are guidance, not runnable edits.
      if (/[<][^>]+[>]/.test(trimmed)) return false;
      if (/\.\.\./.test(trimmed)) return false;

      // Comment-only lines are fine in hover text, but they should not be
      // turned into executable quick fixes unless there is at least one real
      // SQL/edit line in the rewrite.
      if (trimmed.startsWith('--')) continue;

      hasExecutableStep = true;
    }
  }

  return hasExecutableStep;
}

function statementStartInsertPos(text: string, startOffset: number): Position {
  const startPos = offsetToPosition(text, startOffset);
  const startChar = text.charCodeAt(startOffset);
  if (startChar === 10 || startChar === 13) {
    return Position.create(startPos.line + 1, 0);
  }
  return Position.create(startPos.line, 0);
}

function rangesEqual(
  left: { start: { line: number; character: number }; end: { line: number; character: number } },
  right: { start: { line: number; character: number }; end: { line: number; character: number } },
): boolean {
  return (
    left.start.line === right.start.line &&
    left.start.character === right.start.character &&
    left.end.line === right.end.line &&
    left.end.character === right.end.character
  );
}

function getPolicyIgnoreInsertPos(
  analysis: AnalyzeTextResult,
  diagnostic: CodeActionParams['context']['diagnostics'][number],
  text: string,
): Position {
  for (let i = 0; i < analysis.policyViolations.length; i++) {
    const violation = analysis.policyViolations[i];
    if (violation.ruleId !== diagnostic.code) continue;

    const sourceRange = analysis.policySourceRanges[i];
    if (!sourceRange) {
      return Position.create(0, 0);
    }

    const startPos = offsetToPosition(text, sourceRange.startOffset);
    const endPos = offsetToPosition(text, sourceRange.endOffset);
    if (!rangesEqual({ start: startPos, end: endPos }, diagnostic.range)) continue;

    return statementStartInsertPos(text, sourceRange.startOffset);
  }

  return Position.create(0, 0);
}

/**
 * Generate code actions for diagnostics in the requested range.
 */
export function getCodeActions(
  params: CodeActionParams,
  analysis: AnalyzeTextResult,
  doc: TextDocument,
): CodeAction[] {
  const actions: CodeAction[] = [];
  const text = doc.getText();
  const requestRange = params.range;

  // Match diagnostics in the request to our cached checks
  for (const diagnostic of params.context.diagnostics) {
    if (diagnostic.source !== 'pgfence') continue;

    const ruleId = diagnostic.code as string | undefined;
    if (!ruleId) continue;

    // Find matching check result
    let matchedCheck = false;
    for (let i = 0; i < analysis.checks.length; i++) {
      const check = analysis.checks[i];
      if (check.ruleId !== ruleId) continue;

      const range = analysis.sourceRanges[i];
      const startPos = offsetToPosition(text, range.startOffset);
      const endPos = offsetToPosition(text, range.endOffset);

      // Check if this check overlaps the request range
      if (!rangeOverlaps(startPos, endPos, requestRange.start, requestRange.end)) continue;

      // 1. Safe rewrite quick fix
      if (check.safeRewrite && isExecutableSafeRewrite(check.safeRewrite)) {
        const safeRewriteSteps = check.safeRewrite.steps.join('\n') + '\n';
        const editRange = Range.create(startPos, endPos);

        actions.push({
          title: `Safe rewrite: ${check.safeRewrite.description}`,
          kind: CodeActionKind.QuickFix,
          diagnostics: [diagnostic],
          isPreferred: true,
          edit: {
            changes: {
              [params.textDocument.uri]: [
                TextEdit.replace(editRange, safeRewriteSteps),
              ],
            },
          },
        });
      }

      // 2. Ignore this rule for this statement
      const ignoreInsertPos = statementStartInsertPos(text, range.startOffset);
      actions.push({
        title: `pgfence-ignore: ${check.ruleId}`,
        kind: CodeActionKind.QuickFix,
        diagnostics: [diagnostic],
        edit: {
          changes: {
            [params.textDocument.uri]: [
              TextEdit.insert(ignoreInsertPos, `-- pgfence-ignore: ${check.ruleId}\n`),
            ],
          },
        },
      });

      matchedCheck = true;
      break; // Only match the first check per diagnostic
    }

    // Policy violation ignore actions (only if no check matched)
    if (!matchedCheck) {
      for (const violation of analysis.policyViolations) {
        if (violation.ruleId !== ruleId) continue;
        const ignoreInsertPos = getPolicyIgnoreInsertPos(analysis, diagnostic, text);

        actions.push({
          title: `pgfence-ignore: ${violation.ruleId}`,
          kind: CodeActionKind.QuickFix,
          diagnostics: [diagnostic],
          edit: {
            changes: {
              [params.textDocument.uri]: [
                TextEdit.insert(ignoreInsertPos, `-- pgfence-ignore: ${violation.ruleId}\n`),
              ],
            },
          },
        });

        break;
      }
    }
  }

  return actions;
}
