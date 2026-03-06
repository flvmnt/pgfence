import { describe, it, expect } from 'vitest';
import { CodeActionKind, DiagnosticSeverity, Range, Diagnostic } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getCodeActions } from '../../src/lsp/code-actions.js';
import { analyzeText } from '../../src/lsp/analyze-text.js';
import type { AnalyzeTextResult } from '../../src/lsp/analyze-text.js';
import { checkResultToDiagnostic } from '../../src/lsp/diagnostics.js';
import { RiskLevel } from '../../src/types.js';
import type { PgfenceConfig } from '../../src/types.js';
import type { CodeActionParams } from 'vscode-languageserver';

const defaultConfig: PgfenceConfig = {
  format: 'auto',
  output: 'cli',
  minPostgresVersion: 11,
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

  it('should provide safe rewrite for ADD COLUMN NOT NULL', async () => {
    const sql = 'ALTER TABLE users ADD COLUMN name text NOT NULL;';
    const uri = 'file:///test.sql';
    const doc = makeDoc(uri, sql);
    const analysis = await analyzeText({ content: sql, filePath: '/test.sql', config: defaultConfig });
    const diagnostics = makeDiagnosticsFromAnalysis(analysis, sql);

    const params = makeParams(uri, Range.create(0, 0, 0, 47), diagnostics);
    const actions = getCodeActions(params, analysis, doc);

    const safeRewrite = actions.find(a => a.title.startsWith('Safe rewrite:'));
    expect(safeRewrite).toBeDefined();
    const newText = safeRewrite!.edit!.changes![uri][0].newText;
    expect(newText).toContain('ADD COLUMN');
  });
});
