/**
 * End-to-end tests: run the LSP server against real fixture files.
 * Covers every rule category and policy check.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const SERVER_PATH = path.resolve(process.cwd(), 'dist/lsp/server.js');
const FIXTURES = path.resolve(process.cwd(), 'tests/fixtures');

interface JsonRpcMessage {
  jsonrpc: string;
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
}

interface LspDiagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  message: string;
  severity: number;
  code?: string;
  source?: string;
}

function sendMsg(child: ChildProcess, msg: JsonRpcMessage): void {
  const body = JSON.stringify(msg);
  child.stdin!.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function listen(child: ChildProcess) {
  const msgs: JsonRpcMessage[] = [];
  let buf = '';
  const waiters: Array<{ pred: (m: JsonRpcMessage) => boolean; resolve: (m: JsonRpcMessage) => void; timer: ReturnType<typeof setTimeout> }> = [];

  child.stdout!.on('data', (d: Buffer) => {
    buf += d.toString();
    while (buf.includes('Content-Length:')) {
      const hEnd = buf.indexOf('\r\n\r\n');
      if (hEnd < 0) break;
      const len = parseInt(buf.match(/Content-Length: (\d+)/)![1], 10);
      const bStart = hEnd + 4;
      if (buf.length < bStart + len) break;
      try {
        const m = JSON.parse(buf.substring(bStart, bStart + len)) as JsonRpcMessage;
        msgs.push(m);
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i].pred(m)) { clearTimeout(waiters[i].timer); waiters[i].resolve(m); waiters.splice(i, 1); }
        }
      } catch { /* skip */ }
      buf = buf.substring(bStart + len);
    }
  });

  function waitFor(pred: (m: JsonRpcMessage) => boolean, ms = 5000): Promise<JsonRpcMessage> {
    const existing = msgs.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), ms);
      waiters.push({ pred, resolve, timer });
    });
  }

  return { msgs, waitFor };
}

type WaitFn = (pred: (m: JsonRpcMessage) => boolean, ms?: number) => Promise<JsonRpcMessage>;

describe('LSP E2E on fixtures', () => {
  let child: ChildProcess | undefined;

  afterEach(() => { child?.kill(); child = undefined; });

  async function init(): Promise<{ child: ChildProcess; waitFor: WaitFn }> {
    child = spawn('node', [SERVER_PATH, '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const { waitFor } = listen(child);
    sendMsg(child, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {}, rootUri: null, processId: 1 } as unknown as Record<string, unknown> });
    await waitFor(m => m.id === 1);
    sendMsg(child, { jsonrpc: '2.0', method: 'initialized', params: {} });
    return { child, waitFor };
  }

  async function openAndGetDiags(c: ChildProcess, waitFor: WaitFn, fixture: string): Promise<{ uri: string; diags: LspDiagnostic[] }> {
    const content = await readFile(path.join(FIXTURES, fixture), 'utf8');
    const uri = `file://${path.join(FIXTURES, fixture)}`;
    sendMsg(c, {
      jsonrpc: '2.0', method: 'textDocument/didOpen',
      params: { textDocument: { uri, languageId: 'sql', version: 1, text: content } },
    });
    const msg = await waitFor(m => m.method === 'textDocument/publishDiagnostics' && (m.params as { uri: string }).uri === uri);
    return { uri, diags: (msg.params as { diagnostics: LspDiagnostic[] }).diagnostics };
  }

  function hasRule(diags: LspDiagnostic[], ruleId: string): LspDiagnostic | undefined {
    return diags.find(d => d.code === ruleId);
  }

  // ── ADD COLUMN rules ──────────────────────────────────────────

  it('add-column: NOT NULL without DEFAULT', async () => {
    const { child: c, waitFor } = await init();
    const { diags } = await openAndGetDiags(c, waitFor, 'dangerous-add-column.sql');
    expect(hasRule(diags, 'add-column-not-null-no-default')).toBeDefined();
  });

  it('add-column: serial type', async () => {
    const { child: c, waitFor } = await init();
    const { diags } = await openAndGetDiags(c, waitFor, 'add-column-serial.sql');
    expect(hasRule(diags, 'add-column-serial')).toBeDefined();
  });

  it('add-column: json type', async () => {
    const { child: c, waitFor } = await init();
    const { diags } = await openAndGetDiags(c, waitFor, 'add-column-json.sql');
    expect(hasRule(diags, 'add-column-json')).toBeDefined();
  });

  it('add-column: stored generated', async () => {
    const { child: c, waitFor } = await init();
    const { diags } = await openAndGetDiags(c, waitFor, 'add-column-stored-generated.sql');
    expect(hasRule(diags, 'add-column-stored-generated')).toBeDefined();
  });

  // ── CREATE/DROP INDEX rules ───────────────────────────────────

  it('create-index: without CONCURRENTLY', async () => {
    const { child: c, waitFor } = await init();
    const { diags } = await openAndGetDiags(c, waitFor, 'dangerous-index.sql');
    expect(hasRule(diags, 'create-index-not-concurrent')).toBeDefined();
  });

  it('drop-index: CONCURRENTLY is safe', async () => {
    const { child: c, waitFor } = await init();
    const { diags } = await openAndGetDiags(c, waitFor, 'drop-index-concurrent.sql');
    expect(hasRule(diags, 'drop-index-not-concurrent')).toBeUndefined();
  });

  // ── ALTER COLUMN rules ────────────────────────────────────────

  it('alter-column: TYPE change', async () => {
    const { child: c, waitFor } = await init();
    const { diags } = await openAndGetDiags(c, waitFor, 'dangerous-alter-column.sql');
    expect(hasRule(diags, 'alter-column-type')).toBeDefined();
  });

  it('alter-column: SET NOT NULL', async () => {
    const { child: c, waitFor } = await init();
    const { diags } = await openAndGetDiags(c, waitFor, 'dangerous-alter-column.sql');
    expect(hasRule(diags, 'alter-column-set-not-null')).toBeDefined();
  });

  // ── ADD CONSTRAINT rules ──────────────────────────────────────

  it('add-constraint: FK without NOT VALID', async () => {
    const { child: c, waitFor } = await init();
    const { diags } = await openAndGetDiags(c, waitFor, 'dangerous-constraint.sql');
    expect(hasRule(diags, 'add-constraint-fk-no-not-valid')).toBeDefined();
  });

  it('add-constraint: CHECK without NOT VALID', async () => {
    const { child: c, waitFor } = await init();
    const { diags } = await openAndGetDiags(c, waitFor, 'dangerous-constraint.sql');
    expect(hasRule(diags, 'add-constraint-check-no-not-valid')).toBeDefined();
  });

  it('add-constraint: UNIQUE without USING INDEX', async () => {
    const { child: c, waitFor } = await init();
    const { diags } = await openAndGetDiags(c, waitFor, 'dangerous-constraint.sql');
    expect(hasRule(diags, 'add-constraint-unique')).toBeDefined();
  });

  it('add-constraint: EXCLUDE', async () => {
    const { child: c, waitFor } = await init();
    const { diags } = await openAndGetDiags(c, waitFor, 'dangerous-constraint.sql');
    expect(hasRule(diags, 'add-constraint-exclude')).toBeDefined();
  });

  it('add-constraint: UNIQUE USING INDEX is safe', async () => {
    const { child: c, waitFor } = await init();
    const { diags } = await openAndGetDiags(c, waitFor, 'safe-constraint-using-index.sql');
    expect(hasRule(diags, 'add-constraint-unique')).toBeUndefined();
  });

  // ── DESTRUCTIVE rules ────────────────────────────────────────

  it('destructive: DROP TABLE (CRITICAL)', async () => {
    const { child: c, waitFor } = await init();
    const { diags } = await openAndGetDiags(c, waitFor, 'dangerous-destructive.sql');
    const d = hasRule(diags, 'drop-table');
    expect(d).toBeDefined();
    expect(d!.severity).toBe(1); // Error = CRITICAL
  });

  it('destructive: DROP COLUMN', async () => {
    const { child: c, waitFor } = await init();
    const { diags } = await openAndGetDiags(c, waitFor, 'dangerous-drop-column.sql');
    expect(hasRule(diags, 'drop-column')).toBeDefined();
  });

  it('destructive: TRUNCATE CASCADE', async () => {
    const { child: c, waitFor } = await init();
    const { diags } = await openAndGetDiags(c, waitFor, 'truncate-cascade.sql');
    expect(hasRule(diags, 'truncate-cascade')).toBeDefined();
  });

  it('destructive: SET LOGGED/UNLOGGED', async () => {
    const { child: c, waitFor } = await init();
    const { diags } = await openAndGetDiags(c, waitFor, 'set-logged-unlogged.sql');
    expect(hasRule(diags, 'set-logged-unlogged')).toBeDefined();
  });

  // ── RENAME rules ─────────────────────────────────────────────

  it('rename: RENAME COLUMN', async () => {
    const { child: c, waitFor } = await init();
    const { diags } = await openAndGetDiags(c, waitFor, 'dangerous-rename-column.sql');
    expect(hasRule(diags, 'rename-column')).toBeDefined();
  });

  // ── ALTER ENUM rules ─────────────────────────────────────────

  it('alter-enum: ADD VALUE', async () => {
    const { child: c, waitFor } = await init();
    const { diags } = await openAndGetDiags(c, waitFor, 'alter-enum-add-value.sql');
    expect(hasRule(diags, 'alter-enum-add-value')).toBeDefined();
  });

  // ── TRIGGER rules ────────────────────────────────────────────

  it('trigger: CREATE TRIGGER', async () => {
    const { child: c, waitFor } = await init();
    const { diags } = await openAndGetDiags(c, waitFor, 'trigger.sql');
    expect(hasRule(diags, 'create-trigger')).toBeDefined();
  });

  it('trigger: DROP TRIGGER', async () => {
    const { child: c, waitFor } = await init();
    const { diags } = await openAndGetDiags(c, waitFor, 'trigger.sql');
    expect(hasRule(diags, 'drop-trigger')).toBeDefined();
  });

  it('trigger: ENABLE/DISABLE TRIGGER', async () => {
    const { child: c, waitFor } = await init();
    const { diags } = await openAndGetDiags(c, waitFor, 'trigger.sql');
    expect(hasRule(diags, 'enable-disable-trigger')).toBeDefined();
  });

  // ── PARTITION rules ──────────────────────────────────────────

  it('partition: ATTACH PARTITION', async () => {
    const { child: c, waitFor } = await init();
    const { diags } = await openAndGetDiags(c, waitFor, 'partition.sql');
    expect(hasRule(diags, 'attach-partition')).toBeDefined();
  });

  it('partition: DETACH PARTITION', async () => {
    const { child: c, waitFor } = await init();
    const { diags } = await openAndGetDiags(c, waitFor, 'partition.sql');
    expect(hasRule(diags, 'detach-partition')).toBeDefined();
  });

  // ── REFRESH MATERIALIZED VIEW rules ──────────────────────────

  it('refresh-matview: non-concurrent', async () => {
    const { child: c, waitFor } = await init();
    const { diags } = await openAndGetDiags(c, waitFor, 'refresh-matview.sql');
    expect(hasRule(diags, 'refresh-matview-blocking')).toBeDefined();
  });

  it('refresh-matview: concurrent', async () => {
    const { child: c, waitFor } = await init();
    const { diags } = await openAndGetDiags(c, waitFor, 'refresh-matview.sql');
    expect(hasRule(diags, 'refresh-matview-concurrent')).toBeDefined();
  });

  // ── REINDEX rules ────────────────────────────────────────────

  it('reindex: non-concurrent', async () => {
    const { child: c, waitFor } = await init();
    const { diags } = await openAndGetDiags(c, waitFor, 'reindex.sql');
    expect(hasRule(diags, 'reindex-non-concurrent')).toBeDefined();
  });

  // ── BEST PRACTICES rules ─────────────────────────────────────

  it('best-practices: prefer bigint over int', async () => {
    const { child: c, waitFor } = await init();
    const { diags } = await openAndGetDiags(c, waitFor, 'best-practices-types.sql');
    expect(hasRule(diags, 'prefer-bigint-over-int')).toBeDefined();
  });

  it('best-practices: prefer text over varchar(N)', async () => {
    const { child: c, waitFor } = await init();
    const { diags } = await openAndGetDiags(c, waitFor, 'best-practices-types.sql');
    expect(hasRule(diags, 'prefer-text-field')).toBeDefined();
  });

  it('best-practices: prefer timestamptz', async () => {
    const { child: c, waitFor } = await init();
    const { diags } = await openAndGetDiags(c, waitFor, 'best-practices-types.sql');
    expect(hasRule(diags, 'prefer-timestamptz')).toBeDefined();
  });

  // ── POLICY checks ────────────────────────────────────────────

  it('policy: missing lock_timeout', async () => {
    const { child: c, waitFor } = await init();
    const { diags } = await openAndGetDiags(c, waitFor, 'missing-policy.sql');
    expect(hasRule(diags, 'missing-lock-timeout')).toBeDefined();
  });

  it('policy: lock_timeout = 0 (disabled)', async () => {
    const { child: c, waitFor } = await init();
    const { diags } = await openAndGetDiags(c, waitFor, 'lock-timeout-zero.sql');
    expect(hasRule(diags, 'lock-timeout-zero')).toBeDefined();
  });

  it('policy: CONCURRENTLY inside transaction', async () => {
    const { child: c, waitFor } = await init();
    const { diags } = await openAndGetDiags(c, waitFor, 'concurrent-in-tx.sql');
    expect(hasRule(diags, 'concurrent-in-transaction')).toBeDefined();
  });

  it('policy: UPDATE in migration', async () => {
    const { child: c, waitFor } = await init();
    const { diags } = await openAndGetDiags(c, waitFor, 'bulk-update.sql');
    expect(hasRule(diags, 'update-in-migration')).toBeDefined();
  });

  it('policy: NOT VALID + VALIDATE in same transaction', async () => {
    const { child: c, waitFor } = await init();
    const { diags } = await openAndGetDiags(c, waitFor, 'not-valid-validate-same-tx.sql');
    expect(hasRule(diags, 'not-valid-validate-same-tx')).toBeDefined();
  });

  it('policy: wide lock window (multiple ACCESS EXCLUSIVE in one tx)', async () => {
    const { child: c, waitFor } = await init();
    const { diags } = await openAndGetDiags(c, waitFor, 'wide-lock-window.sql');
    expect(hasRule(diags, 'wide-lock-window')).toBeDefined();
  });

  // ── VISIBILITY + SUPPRESSION ─────────────────────────────────

  it('new-table-visibility: suppress on newly created tables', async () => {
    const { child: c, waitFor } = await init();
    const { diags } = await openAndGetDiags(c, waitFor, 'new-table-visibility.sql');
    // These rules would normally fire but are suppressed for fresh_table (just created)
    expect(hasRule(diags, 'create-index-not-concurrent')).toBeUndefined();
    expect(hasRule(diags, 'add-constraint-unique')).toBeUndefined();
  });

  it('inline-ignore: suppresses ignored rules', async () => {
    const { child: c, waitFor } = await init();
    const { diags } = await openAndGetDiags(c, waitFor, 'inline-ignore.sql');
    expect(hasRule(diags, 'drop-table')).toBeUndefined();
    expect(hasRule(diags, 'create-index-not-concurrent')).toBeDefined();
  });

  it('safe-migration: no dangerous diagnostics', async () => {
    const { child: c, waitFor } = await init();
    const { diags } = await openAndGetDiags(c, waitFor, 'safe-migration.sql');
    const dangerous = diags.filter(d =>
      d.severity <= 2 &&
      !d.code?.startsWith('missing-') &&
      d.code !== 'prefer-robust-create-index',
    );
    expect(dangerous).toHaveLength(0);
  });

  // ── CODE ACTIONS ─────────────────────────────────────────────

  it('code-action: safe rewrite for CREATE INDEX', async () => {
    const { child: c, waitFor } = await init();
    const { uri, diags } = await openAndGetDiags(c, waitFor, 'dangerous-index.sql');
    const indexDiag = hasRule(diags, 'create-index-not-concurrent')!;

    sendMsg(c, {
      jsonrpc: '2.0', id: 10, method: 'textDocument/codeAction',
      params: { textDocument: { uri }, range: indexDiag.range, context: { diagnostics: [indexDiag] } },
    });
    const resp = await waitFor(m => m.id === 10);
    const actions = resp.result as Array<{ title: string; edit?: { changes: Record<string, Array<{ newText: string }>> } }>;
    const rewrite = actions.find(a => a.title.startsWith('Safe rewrite:'));
    expect(rewrite).toBeDefined();
    expect(rewrite!.edit!.changes[uri][0].newText).toContain('CONCURRENTLY');
  });

  it('code-action: pgfence-ignore insertion', async () => {
    const { child: c, waitFor } = await init();
    const { uri, diags } = await openAndGetDiags(c, waitFor, 'dangerous-destructive.sql');
    const dropDiag = hasRule(diags, 'drop-table')!;

    sendMsg(c, {
      jsonrpc: '2.0', id: 11, method: 'textDocument/codeAction',
      params: { textDocument: { uri }, range: dropDiag.range, context: { diagnostics: [dropDiag] } },
    });
    const resp = await waitFor(m => m.id === 11);
    const actions = resp.result as Array<{ title: string; edit?: { changes: Record<string, Array<{ newText: string }>> } }>;
    const ignore = actions.find(a => a.title.startsWith('pgfence-ignore:'));
    expect(ignore).toBeDefined();
    expect(ignore!.edit!.changes[uri][0].newText).toContain('-- pgfence-ignore: drop-table');
  });

  // ── ADD PRIMARY KEY rules ──────────────────────────────────

  it('add-pk: without USING INDEX', async () => {
    const { child: c, waitFor } = await init();
    const { diags } = await openAndGetDiags(c, waitFor, 'dangerous-pk-no-using-index.sql');
    expect(hasRule(diags, 'add-pk-without-using-index')).toBeDefined();
  });

  // ── RENAME TABLE rules ────────────────────────────────────

  it('rename-table: ACCESS EXCLUSIVE', async () => {
    const { child: c, waitFor } = await init();
    const { diags } = await openAndGetDiags(c, waitFor, 'rename-table.sql');
    expect(hasRule(diags, 'rename-table')).toBeDefined();
  });

  // ── ADD COLUMN volatile default ───────────────────────────

  it('add-column: volatile default (now())', async () => {
    const { child: c, waitFor } = await init();
    const { diags } = await openAndGetDiags(c, waitFor, 'dangerous-add-column-function.sql');
    expect(hasRule(diags, 'add-column-non-constant-default')).toBeDefined();
  });

  // ── ALTER COLUMN varchar widening ─────────────────────────

  it('alter-column: varchar widening noted as safe-if-widening', async () => {
    const { child: c, waitFor } = await init();
    const { diags } = await openAndGetDiags(c, waitFor, 'alter-column-varchar-widening.sql');
    const typeChanges = diags.filter(d => d.code === 'alter-column-type');
    // Widening is flagged with "safe if widening" note (can't verify without schema)
    const wideningDiag = typeChanges.find(d => d.message.includes('safe if widening'));
    expect(wideningDiag).toBeDefined();
    // Cross-type change (status TYPE integer) is also flagged as a full rewrite
    const crossTypeDiag = typeChanges.find(d => d.message.includes('rewrites the entire table'));
    expect(crossTypeDiag).toBeDefined();
  });

  // ── POLICY: missing idle timeout ──────────────────────────

  it('policy: missing idle_in_transaction_session_timeout', async () => {
    const { child: c, waitFor } = await init();
    const { diags } = await openAndGetDiags(c, waitFor, 'missing-idle-timeout.sql');
    expect(hasRule(diags, 'missing-idle-timeout')).toBeDefined();
  });

  // ── POLICY: timeout too long ──────────────────────────────

  it('policy: lock_timeout too permissive', async () => {
    const { child: c, waitFor } = await init();
    const { diags } = await openAndGetDiags(c, waitFor, 'lock-timeout-too-long.sql');
    expect(hasRule(diags, 'lock-timeout-too-long')).toBeDefined();
  });

  // ── INLINE-IGNORE: bare (suppress all) ────────────────────

  it('inline-ignore: bare pgfence-ignore suppresses all checks on statement', async () => {
    const { child: c, waitFor } = await init();
    const { diags } = await openAndGetDiags(c, waitFor, 'inline-ignore-all.sql');
    // DROP TABLE should be suppressed by bare -- pgfence-ignore
    expect(hasRule(diags, 'drop-table')).toBeUndefined();
    // CREATE INDEX (no ignore above it) should still fire
    expect(hasRule(diags, 'create-index-not-concurrent')).toBeDefined();
  });

  // ── NEW RULES ─────────────────────────────────────────────

  it('new-rules: ban-char-field', async () => {
    const { child: c, waitFor } = await init();
    const { diags } = await openAndGetDiags(c, waitFor, 'new-rules.sql');
    expect(hasRule(diags, 'ban-char-field')).toBeDefined();
  });

  it('new-rules: prefer-identity over serial', async () => {
    const { child: c, waitFor } = await init();
    const { diags } = await openAndGetDiags(c, waitFor, 'new-rules.sql');
    expect(hasRule(diags, 'prefer-identity')).toBeDefined();
  });

  it('new-rules: DROP DATABASE', async () => {
    const { child: c, waitFor } = await init();
    const { diags } = await openAndGetDiags(c, waitFor, 'new-rules.sql');
    const d = hasRule(diags, 'drop-database');
    expect(d).toBeDefined();
    expect(d!.severity).toBe(1); // Error = CRITICAL
  });

  it('new-rules: ALTER DOMAIN ADD CONSTRAINT', async () => {
    const { child: c, waitFor } = await init();
    const { diags } = await openAndGetDiags(c, waitFor, 'new-rules.sql');
    expect(hasRule(diags, 'ban-alter-domain-add-constraint')).toBeDefined();
  });

  it('new-rules: CREATE DOMAIN with constraint', async () => {
    const { child: c, waitFor } = await init();
    const { diags } = await openAndGetDiags(c, waitFor, 'new-rules.sql');
    expect(hasRule(diags, 'ban-create-domain-with-constraint')).toBeDefined();
  });

  // ── DOCUMENT UPDATE ───────────────────────────────────────

  it('didChange: re-analyzes on document update', async () => {
    const { child: c, waitFor } = await init();
    const uri = `file://${path.join(FIXTURES, 'dynamic-update.sql')}`;

    // Open with safe SQL
    sendMsg(c, {
      jsonrpc: '2.0', method: 'textDocument/didOpen',
      params: { textDocument: { uri, languageId: 'sql', version: 1, text: 'SELECT 1;' } },
    });
    const msg1 = await waitFor(m => m.method === 'textDocument/publishDiagnostics' && (m.params as { uri: string }).uri === uri);
    const diags1 = (msg1.params as { diagnostics: LspDiagnostic[] }).diagnostics;
    const dangerous1 = diags1.filter(d => d.severity <= 2 && !d.code?.startsWith('missing-'));
    expect(dangerous1).toHaveLength(0);

    // Update with dangerous SQL
    sendMsg(c, {
      jsonrpc: '2.0', method: 'textDocument/didChange',
      params: {
        textDocument: { uri, version: 2 },
        contentChanges: [{ text: 'DROP TABLE users;' }],
      },
    });
    const msg2 = await waitFor(
      m => m.method === 'textDocument/publishDiagnostics' &&
        (m.params as { uri: string }).uri === uri &&
        (m.params as { diagnostics: LspDiagnostic[] }).diagnostics.some(d => d.code === 'drop-table'),
    );
    const diags2 = (msg2.params as { diagnostics: LspDiagnostic[] }).diagnostics;
    expect(diags2.find(d => d.code === 'drop-table')).toBeDefined();
  });

  // ── HOVER ────────────────────────────────────────────────────

  it('hover: shows lock mode and blocks info', async () => {
    const { child: c, waitFor } = await init();
    await openAndGetDiags(c, waitFor, 'dangerous-add-column.sql');
    const uri = `file://${path.join(FIXTURES, 'dangerous-add-column.sql')}`;

    sendMsg(c, {
      jsonrpc: '2.0', id: 20, method: 'textDocument/hover',
      params: { textDocument: { uri }, position: { line: 4, character: 10 } },
    });
    const resp = await waitFor(m => m.id === 20);
    const hover = resp.result as { contents: { value: string } } | null;
    expect(hover).not.toBeNull();
    expect(hover!.contents.value).toContain('ACCESS EXCLUSIVE');
    expect(hover!.contents.value).toContain('Blocks');
    expect(hover!.contents.value).toContain('Safe alternative');
  });

  it('hover: returns null for unflagged position', async () => {
    const { child: c, waitFor } = await init();
    await openAndGetDiags(c, waitFor, 'safe-migration.sql');
    const uri = `file://${path.join(FIXTURES, 'safe-migration.sql')}`;

    sendMsg(c, {
      jsonrpc: '2.0', id: 21, method: 'textDocument/hover',
      params: { textDocument: { uri }, position: { line: 0, character: 0 } },
    });
    const resp = await waitFor(m => m.id === 21);
    expect(resp.result).toBeNull();
  });
});
