import { describe, it, expect } from 'vitest';
import { CodeActionKind, DiagnosticSeverity, Range, Diagnostic } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getCodeActions } from '../../src/lsp/code-actions.js';
import { analyzeText } from '../../src/lsp/analyze-text.js';
import type { AnalyzeTextResult } from '../../src/lsp/analyze-text.js';
import { checkResultToDiagnostic, policyViolationToDiagnostic } from '../../src/lsp/diagnostics.js';
import { RiskLevel } from '../../src/types.js';
import type { PgfenceConfig } from '../../src/types.js';
import type { CodeActionParams } from 'vscode-languageserver';

const defaultConfig: PgfenceConfig = {
  format: 'auto',
  output: 'cli',
  minPostgresVersion: 14,
  maxAllowedRisk: RiskLevel.HIGH,
  requireLockTimeout: true,
  requireStatementTimeout: true,
};

function makeDoc(uri: string, content: string): TextDocument {
  return TextDocument.create(uri, 'sql', 1, content);
}

function makeDiagnosticsFromAnalysis(analysis: AnalyzeTextResult, text: string): Diagnostic[] {
  return analysis.checks.map((check, i) =>
    checkResultToDiagnostic(check, analysis.sourceRanges[i], text),
  );
}

function makeParams(
  uri: string,
  range: Range,
  diagnostics: Diagnostic[],
): CodeActionParams {
  return {
    textDocument: { uri },
    range,
    context: { diagnostics },
  };
}

describe('Code Actions', () => {
  it('should provide safe rewrite for CREATE INDEX without CONCURRENTLY', async () => {
    const sql = 'CREATE INDEX idx ON users (email);';
    const uri = 'file:///test.sql';
    const doc = makeDoc(uri, sql);
    const analysis = await analyzeText({ content: sql, filePath: '/test.sql', config: defaultConfig });
    const diagnostics = makeDiagnosticsFromAnalysis(analysis, sql);

    const params = makeParams(uri, Range.create(0, 0, 0, 33), diagnostics);
    const actions = getCodeActions(params, analysis, doc);

    const safeRewrite = actions.find(a => a.title.startsWith('Safe rewrite:'));
    expect(safeRewrite).toBeDefined();
    expect(safeRewrite!.kind).toBe(CodeActionKind.QuickFix);
    expect(safeRewrite!.isPreferred).toBe(true);

    const edit = safeRewrite!.edit!.changes![uri];
    expect(edit).toBeDefined();
    expect(edit[0].newText).toContain('CONCURRENTLY');
  });

  it('should provide pgfence-ignore action', async () => {
    const sql = 'CREATE INDEX idx ON users (email);';
    const uri = 'file:///test.sql';
    const doc = makeDoc(uri, sql);
    const analysis = await analyzeText({ content: sql, filePath: '/test.sql', config: defaultConfig });
    const diagnostics = makeDiagnosticsFromAnalysis(analysis, sql);

    const params = makeParams(uri, Range.create(0, 0, 0, 33), diagnostics);
    const actions = getCodeActions(params, analysis, doc);

    const ignore = actions.find(a => a.title.startsWith('pgfence-ignore:'));
    expect(ignore).toBeDefined();
    expect(ignore!.kind).toBe(CodeActionKind.QuickFix);

    const edit = ignore!.edit!.changes![uri];
    expect(edit[0].newText).toContain('-- pgfence-ignore:');
  });

  it('should insert policy ignore actions at the violating statement', async () => {
    const sql = `CREATE INDEX idx ON users (email);
SET lock_timeout = 0;
SET statement_timeout = '5min';
SET application_name = 'migrate:test-zero';
SET idle_in_transaction_session_timeout = '30s';`;
    const uri = 'file:///test.sql';
    const doc = makeDoc(uri, sql);
    const analysis = await analyzeText({ content: sql, filePath: '/test.sql', config: defaultConfig });
    const lockTimeout = analysis.policyViolations.find(v => v.ruleId === 'lock-timeout-zero');
    expect(lockTimeout).toBeDefined();
    const lockTimeoutIndex = analysis.policyViolations.findIndex(v => v.ruleId === 'lock-timeout-zero');
    const diagnostic = policyViolationToDiagnostic(lockTimeout!, analysis.policySourceRanges[lockTimeoutIndex], sql);

    const params = makeParams(uri, diagnostic.range, [diagnostic]);
    const actions = getCodeActions(params, analysis, doc);

    const ignore = actions.find(a => a.title.startsWith('pgfence-ignore:'));
    expect(ignore).toBeDefined();
    const edit = ignore!.edit!.changes![uri];
    expect(edit[0].range.start.line).toBe(1);
    expect(edit[0].newText).toContain('lock-timeout-zero');
  });

  it('should not offer a quick fix for placeholder-heavy ADD COLUMN rewrites', async () => {
    const sql = 'ALTER TABLE users ADD COLUMN name text NOT NULL;';
    const uri = 'file:///test.sql';
    const doc = makeDoc(uri, sql);
    const analysis = await analyzeText({ content: sql, filePath: '/test.sql', config: defaultConfig });
    const diagnostics = makeDiagnosticsFromAnalysis(analysis, sql);

    const params = makeParams(uri, Range.create(0, 0, 0, 47), diagnostics);
    const actions = getCodeActions(params, analysis, doc);

    const safeRewrite = actions.find(a => a.title.startsWith('Safe rewrite:'));
    expect(safeRewrite).toBeUndefined();

    const ignore = actions.find(a => a.title.startsWith('pgfence-ignore:'));
    expect(ignore).toBeDefined();
  });

  it('should not offer a quick fix for documentation-only ALTER ENUM rewrites', async () => {
    const sql = "ALTER TYPE mood ADD VALUE 'happy';";
    const uri = 'file:///test.sql';
    const doc = makeDoc(uri, sql);
    const analysis = await analyzeText({ content: sql, filePath: '/test.sql', config: defaultConfig });
    const diagnostics = makeDiagnosticsFromAnalysis(analysis, sql);

    const params = makeParams(uri, Range.create(0, 0, 0, 33), diagnostics);
    const actions = getCodeActions(params, analysis, doc);

    const safeRewrite = actions.find(a => a.title.startsWith('Safe rewrite:'));
    expect(safeRewrite).toBeUndefined();
  });

  it('should still provide ignore action for DROP TABLE', async () => {
    const sql = 'DROP TABLE users;';
    const uri = 'file:///test.sql';
    const doc = makeDoc(uri, sql);
    const analysis = await analyzeText({ content: sql, filePath: '/test.sql', config: defaultConfig });
    const diagnostics = makeDiagnosticsFromAnalysis(analysis, sql);

    const params = makeParams(uri, Range.create(0, 0, 0, 17), diagnostics);
    const actions = getCodeActions(params, analysis, doc);

    const ignore = actions.find(a => a.title.startsWith('pgfence-ignore:'));
    expect(ignore).toBeDefined();
  });

  it('should return empty actions for non-pgfence diagnostics', async () => {
    const sql = 'SELECT 1;';
    const uri = 'file:///test.sql';
    const doc = makeDoc(uri, sql);
    const analysis = await analyzeText({ content: sql, filePath: '/test.sql', config: defaultConfig });

    const externalDiag = Diagnostic.create(
      Range.create(0, 0, 0, 8),
      'Some other lint',
      DiagnosticSeverity.Warning,
      'other-rule',
      'other-linter',
    );

    const params = makeParams(uri, Range.create(0, 0, 0, 8), [externalDiag]);
    const actions = getCodeActions(params, analysis, doc);
    expect(actions).toHaveLength(0);
  });

  it('should not offer a quick fix for ADD COLUMN NOT NULL placeholder rewrites', async () => {
    const sql = 'ALTER TABLE users ADD COLUMN name text NOT NULL;';
    const uri = 'file:///test.sql';
    const doc = makeDoc(uri, sql);
    const analysis = await analyzeText({ content: sql, filePath: '/test.sql', config: defaultConfig });
    const diagnostics = makeDiagnosticsFromAnalysis(analysis, sql);

    const params = makeParams(uri, Range.create(0, 0, 0, 47), diagnostics);
    const actions = getCodeActions(params, analysis, doc);

    const safeRewrite = actions.find(a => a.title.startsWith('Safe rewrite:'));
    expect(safeRewrite).toBeUndefined();
  });

  it('should match code actions only when the request range overlaps the statement', async () => {
    const sql = 'CREATE INDEX idx ON users (email); SELECT 1;';
    const uri = 'file:///test.sql';
    const doc = makeDoc(uri, sql);
    const analysis = await analyzeText({ content: sql, filePath: '/test.sql', config: defaultConfig });
    const diagnostics = makeDiagnosticsFromAnalysis(analysis, sql);

    const params = makeParams(uri, Range.create(0, 35, 0, 43), diagnostics);
    const actions = getCodeActions(params, analysis, doc);

    expect(actions).toHaveLength(0);
  });
});
