import { describe, it, expect } from 'vitest';
import { reportTraceCLI } from '../../src/reporters/trace-cli.js';
import {
  LockMode,
  RiskLevel,
  type TraceResult,
  type TraceCheckResult,
} from '../../src/types.js';

function makeCheck(overrides: Partial<TraceCheckResult> = {}): TraceCheckResult {
  return {
    statement: 'ALTER TABLE users ADD COLUMN age INTEGER NOT NULL;',
    statementPreview: 'ALTER TABLE users ADD COLUMN age...',
    tableName: 'users',
    lockMode: LockMode.ACCESS_EXCLUSIVE,
    blocks: { reads: true, writes: true, otherDdl: true },
    risk: RiskLevel.HIGH,
    message: 'ADD COLUMN with NOT NULL requires ACCESS EXCLUSIVE lock',
    ruleId: 'add-column-not-null-no-default',
    verification: 'confirmed',
    tracedLockMode: LockMode.ACCESS_EXCLUSIVE,
    durationMs: 2,
    ...overrides,
  };
}

function makeResult(overrides: Partial<TraceResult> = {}): TraceResult {
  return {
    filePath: 'migration.sql',
    checks: [makeCheck()],
    traceChecks: [makeCheck()],
    policyViolations: [],
    maxRisk: RiskLevel.HIGH,
    statementCount: 1,
    extractionWarnings: [],
    pgVersion: 16,
    verified: 1,
    mismatches: 0,
    traceOnly: 0,
    staticOnly: 0,
    errors: 0,
    containerLifetimeMs: 4200,
    ...overrides,
  };
}

describe('Reporter: Trace CLI', () => {
  it('should contain "Trace Report" header with PG version', () => {
    const output = reportTraceCLI([makeResult()]);
    expect(output).toContain('Trace Report');
    expect(output).toContain('PostgreSQL 16');
    expect(output).toContain('Docker');
  });

  it('should show "Confirmed" for a confirmed check', () => {
    const output = reportTraceCLI([makeResult()]);
    expect(output).toContain('Confirmed');
  });

  it('should show ACCESS EXCLUSIVE lock mode', () => {
    const output = reportTraceCLI([makeResult()]);
    expect(output).toContain('ACCESS EXCLUSIVE');
  });

  it('should show coverage line with Verified count', () => {
    const output = reportTraceCLI([makeResult()]);
    expect(output).toContain('Verified: 1/1');
    expect(output).toContain('Mismatches: 0');
    expect(output).toContain('Trace-only: 0');
  });

  it('should show "(predicted: ...)" for mismatch checks', () => {
    const mismatchCheck = makeCheck({
      verification: 'mismatch',
      lockMode: LockMode.SHARE_UPDATE_EXCLUSIVE,
      tracedLockMode: LockMode.ACCESS_EXCLUSIVE,
    });
    const result = makeResult({ checks: [mismatchCheck], traceChecks: [mismatchCheck] });
    const output = reportTraceCLI([result]);
    expect(output).toContain('predicted: SHARE UPDATE EXCLUSIVE');
    expect(output).toContain('Mismatch');
  });

  it('should display duration for checks', () => {
    const output = reportTraceCLI([makeResult()]);
    expect(output).toContain('2ms');
  });

  it('should display blocks as R + W format', () => {
    const output = reportTraceCLI([makeResult()]);
    expect(output).toContain('R + W');
  });

  it('should show trace-only findings for table rewrites', () => {
    const rewriteCheck = makeCheck({
      tableRewrite: true,
      tableName: 'users',
    });
    const result = makeResult({ checks: [rewriteCheck], traceChecks: [rewriteCheck] });
    const output = reportTraceCLI([result]);
    expect(output).toContain('Table rewrite detected on "users"');
    expect(output).toContain('relfilenode changed');
  });

  it('should show policy violations', () => {
    const result = makeResult({
      policyViolations: [
        {
          ruleId: 'missing-lock-timeout',
          severity: 'error',
          message: 'Missing SET lock_timeout',
          suggestion: "Add SET lock_timeout = '2s';",
        },
      ],
    });
    const output = reportTraceCLI([result]);
    expect(output).toContain('Policy Violations:');
    expect(output).toContain('Missing SET lock_timeout');
  });

  it('should show safe rewrite recipes for non-low-risk checks', () => {
    const check = makeCheck({
      safeRewrite: {
        description: 'ADD COLUMN with NOT NULL + DEFAULT -> split into expand/backfill/contract',
        steps: ['ALTER TABLE t ADD COLUMN col type;', 'Backfill in batches'],
      },
    });
    const result = makeResult({ checks: [check], traceChecks: [check] });
    const output = reportTraceCLI([result]);
    expect(output).toContain('Safe Rewrites:');
    expect(output).toContain('expand/backfill/contract');
  });

  it('should show Docker image and container lifetime in coverage', () => {
    const output = reportTraceCLI([makeResult()]);
    expect(output).toContain('Docker: postgres:16-alpine');
    expect(output).toContain('Container lifetime: 4.2s');
  });

  it('should handle multiple results and aggregate coverage', () => {
    const result1 = makeResult({ statementCount: 2 });
    const checks2 = [
      makeCheck({ verification: 'trace-only' }),
      makeCheck({
        statement: 'CREATE INDEX idx ON users(age);',
        statementPreview: 'CREATE INDEX idx ON users(age)',
        verification: 'confirmed',
      }),
    ];
    const result2 = makeResult({
      filePath: 'migration2.sql',
      statementCount: 3,
      checks: checks2,
      traceChecks: checks2,
    });
    const output = reportTraceCLI([result1, result2]);
    expect(output).toContain('Analyzed: 5 statements');
    expect(output).toContain('Verified: 2/3');
    expect(output).toContain('Trace-only: 1');
  });

  it('should show no dangerous statements for empty checks', () => {
    const result = makeResult({ checks: [], traceChecks: [], maxRisk: RiskLevel.SAFE });
    const output = reportTraceCLI([result]);
    expect(output).toContain('No dangerous statements detected.');
  });

  it('should handle trace-only verification status', () => {
    const check = makeCheck({ verification: 'trace-only' });
    const result = makeResult({ checks: [check], traceChecks: [check] });
    const output = reportTraceCLI([result]);
    expect(output).toContain('Trace-only');
  });
});
