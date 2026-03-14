import { describe, it, expect } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getHoverContent } from '../../src/lsp/hover.js';
import { analyzeText } from '../../src/lsp/analyze-text.js';
import { RiskLevel } from '../../src/types.js';
import type { PgfenceConfig } from '../../src/types.js';
import type { HoverParams } from 'vscode-languageserver';

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

  it('should return null when hovering past the end of a statement', async () => {
    const sql = 'SELECT 1;\n\n\n\n\n';
    const uri = 'file:///test.sql';
    const doc = makeDoc(uri, sql);
    const analysis = await analyzeText({ content: sql, filePath: '/test.sql', config: defaultConfig });

    const hover = getHoverContent(makeHoverParams(uri, 3, 0), analysis, doc);
    expect(hover).toBeNull();
  });
});
