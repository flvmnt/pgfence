import { describe, it, expect } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getHoverContent } from '../../src/lsp/hover.js';
import { analyzeText } from '../../src/lsp/analyze-text.js';
import { LockMode, RiskLevel } from '../../src/types.js';
import type { PgfenceConfig } from '../../src/types.js';
import type { HoverParams } from 'vscode-languageserver';
import type { AnalyzeTextResult } from '../../src/lsp/analyze-text.js';

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

function makeHoverParams(uri: string, line: number, character: number): HoverParams {
  return {
    textDocument: { uri },
    position: { line, character },
  };
}

describe('Hover Provider', () => {
  it('should show lock mode details on hover over flagged statement', async () => {
    const sql = 'CREATE INDEX idx ON users (email);';
    const uri = 'file:///test.sql';
    const doc = makeDoc(uri, sql);
    const analysis = await analyzeText({ content: sql, filePath: '/test.sql', config: defaultConfig });

    const hover = getHoverContent(makeHoverParams(uri, 0, 5), analysis, doc);
    expect(hover).not.toBeNull();
    const value = (hover!.contents as { value: string }).value;
    expect(value).toContain('SHARE');
    expect(value).toContain('Blocks');
    expect(value).toContain('MEDIUM');
  });

  it('should return null for non-flagged positions', async () => {
    const sql = 'SELECT 1;';
    const uri = 'file:///test.sql';
    const doc = makeDoc(uri, sql);
    const analysis = await analyzeText({ content: sql, filePath: '/test.sql', config: defaultConfig });

    const hover = getHoverContent(makeHoverParams(uri, 0, 0), analysis, doc);
    expect(hover).toBeNull();
  });

  it('should show safe alternative in hover', async () => {
    const sql = 'CREATE INDEX idx ON users (email);';
    const uri = 'file:///test.sql';
    const doc = makeDoc(uri, sql);
    const analysis = await analyzeText({ content: sql, filePath: '/test.sql', config: defaultConfig });

    const hover = getHoverContent(makeHoverParams(uri, 0, 10), analysis, doc);
    expect(hover).not.toBeNull();
    const value = (hover!.contents as { value: string }).value;
    expect(value).toContain('Safe alternative');
    expect(value).toContain('CONCURRENTLY');
  });

  it('should show table name in hover', async () => {
    const sql = 'ALTER TABLE users ADD COLUMN name text NOT NULL;';
    const uri = 'file:///test.sql';
    const doc = makeDoc(uri, sql);
    const analysis = await analyzeText({ content: sql, filePath: '/test.sql', config: defaultConfig });

    const hover = getHoverContent(makeHoverParams(uri, 0, 20), analysis, doc);
    expect(hover).not.toBeNull();
    const value = (hover!.contents as { value: string }).value;
    expect(value).toContain('users');
  });

  it('should show rule ID in hover', async () => {
    const sql = 'CREATE INDEX idx ON users (email);';
    const uri = 'file:///test.sql';
    const doc = makeDoc(uri, sql);
    const analysis = await analyzeText({ content: sql, filePath: '/test.sql', config: defaultConfig });

    const hover = getHoverContent(makeHoverParams(uri, 0, 5), analysis, doc);
    const value = (hover!.contents as { value: string }).value;
    expect(value).toContain('create-index-not-concurrent');
  });

  it('should prefer the most severe check when multiple checks share one statement', async () => {
    const sql = `ALTER TABLE orders
  ADD CONSTRAINT fk_orders_user_id
  FOREIGN KEY (user_id)
  REFERENCES users(id);`;
    const uri = 'file:///test.sql';
    const doc = makeDoc(uri, sql);
    const analysis = await analyzeText({ content: sql, filePath: '/test.sql', config: defaultConfig });

    const hover = getHoverContent(makeHoverParams(uri, 1, 10), analysis, doc);
    expect(hover).not.toBeNull();
    const value = (hover!.contents as { value: string }).value;
    expect(value).toContain('HIGH');
    expect(value).toContain('add-constraint-fk-no-not-valid');
  });

  it('should return null when hovering past the end of a statement', async () => {
    const sql = 'SELECT 1;\n\n\n\n\n';
    const uri = 'file:///test.sql';
    const doc = makeDoc(uri, sql);
    const analysis = await analyzeText({ content: sql, filePath: '/test.sql', config: defaultConfig });

    const hover = getHoverContent(makeHoverParams(uri, 3, 0), analysis, doc);
    expect(hover).toBeNull();
  });

  it('should not render literal null for table-less operations (ALTER TYPE)', async () => {
    const sql = "ALTER TYPE mood ADD VALUE 'ecstatic';";
    const uri = 'file:///test.sql';
    const doc = makeDoc(uri, sql);
    const noTimeoutConfig: PgfenceConfig = { ...defaultConfig, requireLockTimeout: false, requireStatementTimeout: false };
    const analysis = await analyzeText({ content: sql, filePath: '/test.sql', config: noTimeoutConfig });

    const hover = getHoverContent(makeHoverParams(uri, 0, 5), analysis, doc);
    expect(hover).not.toBeNull();
    const value = (hover!.contents as { value: string }).value;
    expect(value).not.toContain('`null`');
    expect(value).not.toContain('**Table**:');
  });

  it('should escape markdown-sensitive hover content', () => {
    const sql = 'CREATE INDEX idx ON users (email);';
    const uri = 'file:///test.sql';
    const doc = makeDoc(uri, sql);
    const analysis: AnalyzeTextResult = {
      checks: [
        {
          statement: sql,
          statementPreview: 'CREATE INDEX idx ON users (email)',
          tableName: 'users`|danger',
          lockMode: LockMode.SHARE,
          blocks: { reads: false, writes: true, otherDdl: true },
          risk: RiskLevel.MEDIUM,
          message: 'Avoid **bold** [links](https://example.com) and ```fences```.',
          ruleId: 'create-index-`danger`',
          safeRewrite: {
            description: 'Use `CONCURRENTLY` and avoid ``` fence breaks',
            steps: ['SELECT 1; -- ``` literal fence'],
          },
        },
      ],
      policyViolations: [],
      maxRisk: RiskLevel.MEDIUM,
      statementCount: 1,
      extractionWarnings: [],
      sourceRanges: [{ startOffset: 0, endOffset: sql.length }],
    };

    const hover = getHoverContent(makeHoverParams(uri, 0, 5), analysis, doc);
    expect(hover).not.toBeNull();
    const value = (hover!.contents as { value: string }).value;

    expect(value).toContain('`` create-index-`danger` ``');
    expect(value).toContain('``users`|danger``');
    expect(value).toContain('Avoid \\*\\*bold\\*\\* \\[links\\]\\(https://example\\.com\\) and \\`\\`\\`fences\\`\\`\\`\\.');
    expect(value).toContain('Use \\`CONCURRENTLY\\` and avoid \\`\\`\\` fence breaks');
    expect(value).toContain('````sql');
    expect(value).toContain('SELECT 1; -- ``` literal fence');
    expect(value).toContain('\n````');
  });
});
