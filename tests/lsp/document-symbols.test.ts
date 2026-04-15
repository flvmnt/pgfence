import { describe, it, expect } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { SymbolKind } from 'vscode-languageserver';
import { getDocumentSymbols } from '../../src/lsp/document-symbols.js';
import { analyzeText } from '../../src/lsp/analyze-text.js';
import { RiskLevel } from '../../src/types.js';
import type { PgfenceConfig } from '../../src/types.js';

const defaultConfig: PgfenceConfig = {
  format: 'auto',
  output: 'cli',
  minPostgresVersion: 14,
  maxAllowedRisk: RiskLevel.HIGH,
  requireLockTimeout: false,
  requireStatementTimeout: false,
};

const uri = 'file:///test.sql';

function makeDoc(content: string): TextDocument {
  return TextDocument.create(uri, 'sql', 1, content);
}

function makeParams() {
  return { textDocument: { uri } };
}

describe('Document Symbols Provider', () => {
  it('should return a symbol for each flagged statement', async () => {
    const sql = `ALTER TABLE orders
  ADD CONSTRAINT fk_orders_user_id
  FOREIGN KEY (user_id)
  REFERENCES users(id);`;
    const doc = makeDoc(sql);
    const analysis = await analyzeText({ content: sql, filePath: '/test.sql', config: defaultConfig });

    const symbols = getDocumentSymbols(makeParams(), analysis, doc);

    expect(symbols).toHaveLength(1);
  });

  it('should use statementPreview as the symbol name', async () => {
    const sql = `ALTER TABLE orders
  ADD CONSTRAINT fk_orders_user_id
  FOREIGN KEY (user_id)
  REFERENCES users(id);`;
    const doc = makeDoc(sql);
    const analysis = await analyzeText({ content: sql, filePath: '/test.sql', config: defaultConfig });

    const symbols = getDocumentSymbols(makeParams(), analysis, doc);

    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toContain('ALTER TABLE orders');
  });

  it('should use tableName as symbol detail', async () => {
    const sql = `ALTER TABLE orders
  ADD CONSTRAINT fk_orders_user_id
  FOREIGN KEY (user_id)
  REFERENCES users(id);`;
    const doc = makeDoc(sql);
    const analysis = await analyzeText({ content: sql, filePath: '/test.sql', config: defaultConfig });

    const symbols = getDocumentSymbols(makeParams(), analysis, doc);

    expect(symbols).toHaveLength(1);
    expect(symbols[0].detail).toBe('orders');
  });

  it('should use SymbolKind.Module for all statements', async () => {
    const sql = 'CREATE INDEX idx ON users (email);';
    const doc = makeDoc(sql);
    const analysis = await analyzeText({ content: sql, filePath: '/test.sql', config: defaultConfig });

    const symbols = getDocumentSymbols(makeParams(), analysis, doc);

    expect(symbols[0].kind).toBe(SymbolKind.Module);
  });

  it('should return empty array when no checks', async () => {
    const sql = 'SELECT 1;';
    const doc = makeDoc(sql);
    const analysis = await analyzeText({ content: sql, filePath: '/test.sql', config: defaultConfig });

    const symbols = getDocumentSymbols(makeParams(), analysis, doc);

    expect(symbols).toHaveLength(0);
  });

  it('should provide correct range positions', async () => {
    const sql = `ALTER TABLE orders
  ADD CONSTRAINT fk_orders_user_id
  FOREIGN KEY (user_id)
  REFERENCES users(id);`;
    const doc = makeDoc(sql);
    const analysis = await analyzeText({ content: sql, filePath: '/test.sql', config: defaultConfig });

    const symbols = getDocumentSymbols(makeParams(), analysis, doc);

    expect(symbols[0].range.start.line).toBe(0);
    expect(symbols[0].range.end.line).toBeGreaterThan(0);
    expect(symbols[0].selectionRange).toEqual(symbols[0].range);
  });
});
