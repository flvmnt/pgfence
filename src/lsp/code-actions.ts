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
      if (endPos.line < requestRange.start.line || startPos.line > requestRange.end.line) continue;

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
      const ignoreLine = startPos.line;
      const ignoreInsertPos = Position.create(ignoreLine, 0);
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

        actions.push({
          title: `pgfence-ignore: ${violation.ruleId}`,
          kind: CodeActionKind.QuickFix,
          diagnostics: [diagnostic],
          edit: {
            changes: {
              [params.textDocument.uri]: [
                TextEdit.insert(Position.create(0, 0), `-- pgfence-ignore: ${violation.ruleId}\n`),
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
