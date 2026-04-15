import { describe, it, expect } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getFoldingRanges } from '../../src/lsp/folding-ranges.js';
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

describe('Folding Ranges Provider', () => {
  it('should return a folding range for a multi-line statement', async () => {
    const sql = `ALTER TABLE orders
  ADD CONSTRAINT fk_orders_user_id
  FOREIGN KEY (user_id)
  REFERENCES users(id);`;
    const doc = makeDoc(sql);
    const analysis = await analyzeText({ content: sql, filePath: '/test.sql', config: defaultConfig });

    const ranges = getFoldingRanges(makeParams(), analysis, doc);

    expect(ranges).toHaveLength(1);
    expect(ranges[0].startLine).toBe(0);
    expect(ranges[0].endLine).toBeGreaterThan(0);
  });

  it('should skip single-line statements', async () => {
    const sql = 'CREATE INDEX idx ON users (email);';
    const doc = makeDoc(sql);
    const analysis = await analyzeText({ content: sql, filePath: '/test.sql', config: defaultConfig });

    const ranges = getFoldingRanges(makeParams(), analysis, doc);

    expect(ranges).toHaveLength(0);
  });

  it('should return empty array when no checks', async () => {
    const sql = 'SELECT 1;';
    const doc = makeDoc(sql);
    const analysis = await analyzeText({ content: sql, filePath: '/test.sql', config: defaultConfig });

    const ranges = getFoldingRanges(makeParams(), analysis, doc);

    expect(ranges).toHaveLength(0);
  });

  it('should set startLine < endLine for multi-line ranges', async () => {
    const sql = `ALTER TABLE orders
  ADD CONSTRAINT fk_orders_user_id
  FOREIGN KEY (user_id)
  REFERENCES users(id);`;
    const doc = makeDoc(sql);
    const analysis = await analyzeText({ content: sql, filePath: '/test.sql', config: defaultConfig });

    const ranges = getFoldingRanges(makeParams(), analysis, doc);

    for (const range of ranges) {
      expect(range.startLine).toBeLessThan(range.endLine);
    }
  });
});
