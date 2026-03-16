/**
 * Maps pgfence CheckResult and PolicyViolation to LSP Diagnostic objects.
 */

import {
  Diagnostic,
  DiagnosticSeverity,
  Range,
  Position,
} from 'vscode-languageserver';
import type { CheckResult, PolicyViolation, ExtractionWarning, RiskLevel as RiskLevelType } from '../types.js';
import { RiskLevel } from '../types.js';
import type { SourceRange } from './analyze-text.js';

/**
 * Convert a character offset in a text string to a line/character Position.
 * The parser converts libpg-query byte offsets to character indices,
 * so this function works directly with character offsets.
 *
 * This distinction matters for files containing multi-byte UTF-8 characters
 * (e.g., table/column names with accented characters).
 */
export function offsetToPosition(text: string, offset: number): Position {
  const clampedOffset = Math.min(offset, text.length);
  let line = 0;
  let lastLineStart = 0;
  for (let i = 0; i < clampedOffset; i++) {
    if (text.charCodeAt(i) === 10) { // \n
      line++;
      lastLineStart = i + 1;
    }
  }
  return Position.create(line, clampedOffset - lastLineStart);
}

/**
 * Map a risk level to an LSP DiagnosticSeverity.
 */
export function riskToSeverity(risk: RiskLevelType): DiagnosticSeverity {
  switch (risk) {
    case RiskLevel.CRITICAL:
      return DiagnosticSeverity.Error;
    case RiskLevel.HIGH:
      return DiagnosticSeverity.Warning;
    case RiskLevel.MEDIUM:
      return DiagnosticSeverity.Warning;
    case RiskLevel.LOW:
      return DiagnosticSeverity.Information;
    case RiskLevel.SAFE:
      return DiagnosticSeverity.Hint;
    default:
      return DiagnosticSeverity.Warning;
  }
}

/**
 * Convert a CheckResult + source range to an LSP Diagnostic.
 */
export function checkResultToDiagnostic(
  check: CheckResult,
  sourceRange: SourceRange,
  text: string,
): Diagnostic {
  const effectiveRisk = check.adjustedRisk ?? check.risk;
  const start = offsetToPosition(text, sourceRange.startOffset);
  const end = offsetToPosition(text, sourceRange.endOffset);

  return Diagnostic.create(
    Range.create(start, end),
    check.message,
    riskToSeverity(effectiveRisk),
    check.ruleId,
    'pgfence',
  );
}

/**
 * Convert a PolicyViolation to an LSP Diagnostic.
 *
 * Statement-level policies (with a sourceRange) highlight the offending statement.
 * File-level policies (no sourceRange) span the entire first line.
 */
export function policyViolationToDiagnostic(
  violation: PolicyViolation,
  sourceRange: SourceRange | null,
  text: string,
): Diagnostic {
  let range: Range;
  if (sourceRange) {
    // Statement-level: highlight the specific statement
    const start = offsetToPosition(text, sourceRange.startOffset);
    const end = offsetToPosition(text, sourceRange.endOffset);
    range = Range.create(start, end);
  } else {
    // File-level: span the entire first line
    const firstNewline = text.indexOf('\n');
    const endCol = firstNewline >= 0 ? firstNewline : text.length;
    range = Range.create(Position.create(0, 0), Position.create(0, endCol));
  }
  return Diagnostic.create(
    range,
    `${violation.message}. ${violation.suggestion}`,
    violation.severity === 'error'
      ? DiagnosticSeverity.Error
      : DiagnosticSeverity.Warning,
    violation.ruleId,
    'pgfence',
  );
}

/**
 * Convert an ExtractionWarning to an LSP Diagnostic.
 */
export function extractionWarningToDiagnostic(
  warning: ExtractionWarning,
): Diagnostic {
  const line = Math.max(0, (warning.line ?? 1) - 1); // LSP is 0-indexed; line is 1-based
  const col = Math.max(0, warning.column ?? 0); // column is already 0-based from AST
  const range = Range.create(
    Position.create(line, col),
    Position.create(line, col),
  );
  return Diagnostic.create(
    range,
    warning.message,
    DiagnosticSeverity.Warning,
    undefined,
    'pgfence',
  );
}

/**
 * Convert a parse error to an LSP Diagnostic.
 */
export function parseErrorToDiagnostic(
  message: string,
  text: string,
): Diagnostic {
  // Try to extract position from libpg-query error: "... at or near ... at position N"
  const posMatch = message.match(/at position (\d+)/i);
  let range: Range;
  if (posMatch) {
    // libpg-query positions are 1-based byte offsets; convert to 0-based character index
    const byteOffset = Math.max(0, parseInt(posMatch[1], 10) - 1);
    const buf = Buffer.from(text, 'utf8');
    const charOffset = buf.subarray(0, Math.min(byteOffset, buf.length)).toString('utf8').length;
    const pos = offsetToPosition(text, charOffset);
    range = Range.create(pos, pos);
  } else {
    range = Range.create(Position.create(0, 0), Position.create(0, 0));
  }
  return Diagnostic.create(
    range,
    `SQL parse error: ${message}`,
    DiagnosticSeverity.Error,
    'parse-error',
    'pgfence',
  );
}
