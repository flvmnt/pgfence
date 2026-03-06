import { describe, it, expect } from 'vitest';
import { DiagnosticSeverity } from 'vscode-languageserver';
import {
  offsetToPosition,
  riskToSeverity,
  checkResultToDiagnostic,
  policyViolationToDiagnostic,
  parseErrorToDiagnostic,
} from '../../src/lsp/diagnostics.js';
import { RiskLevel, LockMode } from '../../src/types.js';
import type { CheckResult, PolicyViolation } from '../../src/types.js';

describe('offsetToPosition', () => {
  it('should convert offset 0 to line 0, char 0', () => {
    const pos = offsetToPosition('hello', 0);
    expect(pos.line).toBe(0);
    expect(pos.character).toBe(0);
  });

  it('should convert offset at end of first line', () => {
    const pos = offsetToPosition('hello\nworld', 5);
    expect(pos.line).toBe(0);
    expect(pos.character).toBe(5);
  });

  it('should convert offset on second line', () => {
    const pos = offsetToPosition('hello\nworld', 8);
    expect(pos.line).toBe(1);
    expect(pos.character).toBe(2);
  });

  it('should handle multi-line text', () => {
    const text = 'line1\nline2\nline3';
    const pos = offsetToPosition(text, 12);
    expect(pos.line).toBe(2);
    expect(pos.character).toBe(0);
  });

  it('should clamp offset to text length', () => {
    const pos = offsetToPosition('hi', 100);
    expect(pos.line).toBe(0);
    expect(pos.character).toBe(2);
  });
});

describe('riskToSeverity', () => {
  it('should map CRITICAL to Error', () => {
    expect(riskToSeverity(RiskLevel.CRITICAL)).toBe(DiagnosticSeverity.Error);
  });

  it('should map HIGH to Warning', () => {
    expect(riskToSeverity(RiskLevel.HIGH)).toBe(DiagnosticSeverity.Warning);
  });

  it('should map MEDIUM to Warning', () => {
    expect(riskToSeverity(RiskLevel.MEDIUM)).toBe(DiagnosticSeverity.Warning);
  });

  it('should map LOW to Information', () => {
    expect(riskToSeverity(RiskLevel.LOW)).toBe(DiagnosticSeverity.Information);
  });

  it('should map SAFE to Hint', () => {
    expect(riskToSeverity(RiskLevel.SAFE)).toBe(DiagnosticSeverity.Hint);
  });
});

describe('checkResultToDiagnostic', () => {
  const baseCheck: CheckResult = {
    statement: 'ALTER TABLE users ADD COLUMN name text NOT NULL',
    statementPreview: 'ALTER TABLE users ADD COLUMN name text NOT NULL',
    tableName: 'users',
    lockMode: LockMode.ACCESS_EXCLUSIVE,
    blocks: { reads: true, writes: true, otherDdl: true },
    risk: RiskLevel.HIGH,
    message: 'ADD COLUMN with NOT NULL without DEFAULT requires ACCESS EXCLUSIVE lock',
    ruleId: 'add-column-not-null-no-default',
  };

  it('should set source to pgfence', () => {
    const diag = checkResultToDiagnostic(baseCheck, { startOffset: 0, endOffset: 47 }, baseCheck.statement);
    expect(diag.source).toBe('pgfence');
  });

  it('should set code to ruleId', () => {
    const diag = checkResultToDiagnostic(baseCheck, { startOffset: 0, endOffset: 47 }, baseCheck.statement);
    expect(diag.code).toBe('add-column-not-null-no-default');
  });

  it('should set correct range from offsets', () => {
    const text = 'SELECT 1;\nALTER TABLE users ADD COLUMN name text NOT NULL;';
    const diag = checkResultToDiagnostic(baseCheck, { startOffset: 10, endOffset: 57 }, text);
    expect(diag.range.start.line).toBe(1);
    expect(diag.range.start.character).toBe(0);
  });

  it('should use adjustedRisk severity when present', () => {
    const check = { ...baseCheck, adjustedRisk: RiskLevel.CRITICAL };
    const diag = checkResultToDiagnostic(check, { startOffset: 0, endOffset: 47 }, baseCheck.statement);
    expect(diag.severity).toBe(DiagnosticSeverity.Error);
  });
});

describe('policyViolationToDiagnostic', () => {
  const sampleText = 'SET lock_timeout = 0;\nALTER TABLE users ADD COLUMN x int;';

  it('should span entire first line for file-level policies', () => {
    const violation: PolicyViolation = {
      ruleId: 'missing-lock-timeout',
      message: 'Migration does not SET lock_timeout',
      suggestion: 'Add SET lock_timeout = \'2s\' at the start',
      severity: 'error',
    };
    const diag = policyViolationToDiagnostic(violation, null, sampleText);
    expect(diag.range.start.line).toBe(0);
    expect(diag.range.start.character).toBe(0);
    expect(diag.range.end.line).toBe(0);
    expect(diag.range.end.character).toBe(21); // length of first line "SET lock_timeout = 0;"
    expect(diag.source).toBe('pgfence');
    expect(diag.code).toBe('missing-lock-timeout');
  });

  it('should highlight specific statement for statement-level policies', () => {
    const violation: PolicyViolation = {
      ruleId: 'lock-timeout-zero',
      message: 'lock_timeout is set to 0',
      suggestion: 'Set to a positive value',
      severity: 'warning',
      statementIndex: 0,
    };
    const diag = policyViolationToDiagnostic(violation, { startOffset: 0, endOffset: 20 }, sampleText);
    expect(diag.range.start.line).toBe(0);
    expect(diag.range.start.character).toBe(0);
    expect(diag.range.end.line).toBe(0);
    expect(diag.range.end.character).toBe(20);
  });

  it('should map error severity to Error', () => {
    const violation: PolicyViolation = {
      ruleId: 'test',
      message: 'test',
      suggestion: 'test',
      severity: 'error',
    };
    expect(policyViolationToDiagnostic(violation, null, sampleText).severity).toBe(DiagnosticSeverity.Error);
  });

  it('should map warning severity to Warning', () => {
    const violation: PolicyViolation = {
      ruleId: 'test',
      message: 'test',
      suggestion: 'test',
      severity: 'warning',
    };
    expect(policyViolationToDiagnostic(violation, null, sampleText).severity).toBe(DiagnosticSeverity.Warning);
  });
});

describe('parseErrorToDiagnostic', () => {
  it('should extract position from error message', () => {
    const diag = parseErrorToDiagnostic(
      'syntax error at or near "INVALID" at position 20',
      'ALTER TABLE users INVALID SYNTAX;',
    );
    expect(diag.severity).toBe(DiagnosticSeverity.Error);
    expect(diag.source).toBe('pgfence');
    expect(diag.code).toBe('parse-error');
    expect(diag.range.start.character).toBe(19); // libpg-query positions are 1-based, converted to 0-based
  });

  it('should default to position 0 if no position in message', () => {
    const diag = parseErrorToDiagnostic('some error', 'bad sql');
    expect(diag.range.start.line).toBe(0);
    expect(diag.range.start.character).toBe(0);
  });
});
