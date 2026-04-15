import { describe, it, expect } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getInlayHints } from '../../src/lsp/inlay-hints.js';
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

function makeParams(startLine = 0, endLine = 100) {
  return {
    textDocument: { uri },
    range: {
      start: { line: startLine, character: 0 },
      end: { line: endLine, character: 0 },
    },
  };
}

describe('Inlay Hints Provider', () => {
  it('should return a hint for each flagged statement', async () => {
    const sql = `ALTER TABLE orders
  ADD CONSTRAINT fk_orders_user_id
  FOREIGN KEY (user_id)
  REFERENCES users(id);`;
    const doc = makeDoc(sql);
    const analysis = await analyzeText({ content: sql, filePath: '/test.sql', config: defaultConfig });

    const hints = getInlayHints(makeParams(), analysis, doc);

    expect(hints).toHaveLength(1);
  });

  it('should include the lock mode in the hint label', async () => {
    const sql = `ALTER TABLE orders
  ADD CONSTRAINT fk_orders_user_id
  FOREIGN KEY (user_id)
  REFERENCES users(id);`;
    const doc = makeDoc(sql);
    const analysis = await analyzeText({ content: sql, filePath: '/test.sql', config: defaultConfig });

    const hints = getInlayHints(makeParams(), analysis, doc);

    expect(hints[0].label).toContain('SHARE ROW EXCLUSIVE');
  });

  it('should include the risk level in the hint label', async () => {
    const sql = `ALTER TABLE orders
  ADD CONSTRAINT fk_orders_user_id
  FOREIGN KEY (user_id)
  REFERENCES users(id);`;
    const doc = makeDoc(sql);
    const analysis = await analyzeText({ content: sql, filePath: '/test.sql', config: defaultConfig });

    const hints = getInlayHints(makeParams(), analysis, doc);

    expect(hints[0].label).toContain('HIGH');
  });

  it('should include a risk icon in the hint label', async () => {
    const sql = `ALTER TABLE orders
  ADD CONSTRAINT fk_orders_user_id
  FOREIGN KEY (user_id)
  REFERENCES users(id);`;
    const doc = makeDoc(sql);
    const analysis = await analyzeText({ content: sql, filePath: '/test.sql', config: defaultConfig });

    const hints = getInlayHints(makeParams(), analysis, doc);

    const highHint = hints.find(h => String(h.label).includes('HIGH'));
    expect(highHint).toBeDefined();
    expect(highHint!.label).toContain('⚠');
  });

  it('should filter hints to the requested range', async () => {
    const sql = 'CREATE INDEX idx ON users (email);\nSELECT 1;';
    const doc = makeDoc(sql);
    const analysis = await analyzeText({ content: sql, filePath: '/test.sql', config: defaultConfig });

    // Request only line 5+ (beyond the statement)
    const hints = getInlayHints(makeParams(5, 100), analysis, doc);

    expect(hints).toHaveLength(0);
  });

  it('should return empty array when no checks', async () => {
    const sql = 'SELECT 1;';
    const doc = makeDoc(sql);
    const analysis = await analyzeText({ content: sql, filePath: '/test.sql', config: defaultConfig });

    const hints = getInlayHints(makeParams(), analysis, doc);

    expect(hints).toHaveLength(0);
  });

  it('should have paddingLeft set to true', async () => {
    const sql = `ALTER TABLE orders
  ADD CONSTRAINT fk_orders_user_id
  FOREIGN KEY (user_id)
  REFERENCES users(id);`;
    const doc = makeDoc(sql);
    const analysis = await analyzeText({ content: sql, filePath: '/test.sql', config: defaultConfig });

    const hints = getInlayHints(makeParams(), analysis, doc);

    expect(hints[0].paddingLeft).toBe(true);
  });
});
