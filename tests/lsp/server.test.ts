/**
 * LSP server integration tests.
 *
 * Spawns the actual server as a child process and communicates
 * via JSON-RPC over stdio, verifying the full request/response cycle.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

const SERVER_PATH = path.resolve(process.cwd(), 'dist/lsp/server.js');

interface JsonRpcMessage {
  jsonrpc: string;
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
}

interface LspDiagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  message: string;
  severity: number;
  code?: string;
  source?: string;
}

function sendMessage(child: ChildProcess, msg: JsonRpcMessage): void {
  const body = JSON.stringify(msg);
  const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
  child.stdin!.write(header + body);
}

function collectMessages(child: ChildProcess): { messages: JsonRpcMessage[]; waitFor: (pred: (m: JsonRpcMessage) => boolean, timeoutMs?: number) => Promise<JsonRpcMessage> } {
  const messages: JsonRpcMessage[] = [];
  let buf = '';
  const waiters: Array<{ pred: (m: JsonRpcMessage) => boolean; resolve: (m: JsonRpcMessage) => void; reject: (e: Error) => void }> = [];

  child.stdout!.on('data', (data: Buffer) => {
    buf += data.toString();
    // Parse complete messages
    while (buf.includes('Content-Length:')) {
      const headerEnd = buf.indexOf('\r\n\r\n');
      if (headerEnd < 0) break;
      const lenMatch = buf.match(/Content-Length: (\d+)/);
      if (!lenMatch) break;
      const len = parseInt(lenMatch[1], 10);
      const bodyStart = headerEnd + 4;
      if (buf.length < bodyStart + len) break; // incomplete body
      const body = buf.substring(bodyStart, bodyStart + len);
      buf = buf.substring(bodyStart + len);
      try {
        const msg = JSON.parse(body) as JsonRpcMessage;
        messages.push(msg);
        // Resolve any matching waiters
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i].pred(msg)) {
            waiters[i].resolve(msg);
            waiters.splice(i, 1);
          }
        }
      } catch { /* ignore parse errors */ }
    }
  });

  function waitFor(pred: (m: JsonRpcMessage) => boolean, timeoutMs = 10000): Promise<JsonRpcMessage> {
    // Check already received messages
    const existing = messages.find(pred);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for message. Got ${messages.length} messages: ${JSON.stringify(messages.map(m => m.method ?? m.id))}`));
      }, timeoutMs);
      waiters.push({
        pred,
        resolve: (m) => { clearTimeout(timer); resolve(m); },
        reject,
      });
    });
  }

  return { messages, waitFor };
}

describe('LSP Server Integration', { timeout: 15000 }, () => {
  let child: ChildProcess | undefined;

  afterEach(() => {
    if (child) {
      child.kill();
      child = undefined;
    }
  });

  async function startServer(): Promise<{ child: ChildProcess; waitFor: (pred: (m: JsonRpcMessage) => boolean) => Promise<JsonRpcMessage> }> {
    child = spawn('node', [SERVER_PATH, '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const { waitFor } = collectMessages(child);

    // Initialize
    sendMessage(child, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { capabilities: {}, rootUri: null, processId: 1 } as unknown as Record<string, unknown>,
    });

    const initResponse = await waitFor(m => m.id === 1);
    expect(initResponse.result).toBeDefined();

    // Send initialized notification
    sendMessage(child, {
      jsonrpc: '2.0',
      method: 'initialized',
      params: {},
    });

    return { child, waitFor };
  }

  it('should respond to initialize with correct capabilities', async () => {
    child = spawn('node', [SERVER_PATH, '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const { waitFor } = collectMessages(child);

    sendMessage(child, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { capabilities: {}, rootUri: null, processId: 1 } as unknown as Record<string, unknown>,
    });

    const response = await waitFor(m => m.id === 1);
    const caps = response.result as Record<string, unknown>;
    expect(caps.capabilities).toBeDefined();
    const capabilities = caps.capabilities as Record<string, unknown>;
    expect(capabilities.textDocumentSync).toBe(1); // Full
    expect(capabilities.codeActionProvider).toBeDefined();
    expect(capabilities.hoverProvider).toBe(true);
  });

  it('should publish diagnostics on textDocument/didOpen', async () => {
    const { child: c, waitFor } = await startServer();

    sendMessage(c, {
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: {
        textDocument: {
          uri: 'file:///test.sql',
          languageId: 'sql',
          version: 1,
          text: 'ALTER TABLE users ADD COLUMN name text NOT NULL;',
        },
      },
    });

    const diagMsg = await waitFor(m => m.method === 'textDocument/publishDiagnostics');
    const params = diagMsg.params as { uri: string; diagnostics: LspDiagnostic[] };
    expect(params.uri).toBe('file:///test.sql');
    expect(params.diagnostics.length).toBeGreaterThan(0);

    const notNullDiag = params.diagnostics.find(d => d.code === 'add-column-not-null-no-default');
    expect(notNullDiag).toBeDefined();
    expect(notNullDiag!.source).toBe('pgfence');
    expect(notNullDiag!.severity).toBe(2); // Warning (HIGH risk)
  });

  it('should map CRITICAL risk to Error severity', async () => {
    const { child: c, waitFor } = await startServer();

    sendMessage(c, {
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: {
        textDocument: {
          uri: 'file:///test.sql',
          languageId: 'sql',
          version: 1,
          text: 'DROP TABLE users;',
        },
      },
    });

    const diagMsg = await waitFor(m => m.method === 'textDocument/publishDiagnostics');
    const params = diagMsg.params as { diagnostics: LspDiagnostic[] };
    const dropDiag = params.diagnostics.find(d => d.code === 'drop-table');
    expect(dropDiag).toBeDefined();
    expect(dropDiag!.severity).toBe(1); // Error (CRITICAL risk)
  });

  it('should clear diagnostics on textDocument/didClose', async () => {
    const { child: c, waitFor } = await startServer();

    // Open
    sendMessage(c, {
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: {
        textDocument: {
          uri: 'file:///test.sql',
          languageId: 'sql',
          version: 1,
          text: 'DROP TABLE users;',
        },
      },
    });

    await waitFor(m => m.method === 'textDocument/publishDiagnostics');

    // Close
    sendMessage(c, {
      jsonrpc: '2.0',
      method: 'textDocument/didClose',
      params: {
        textDocument: { uri: 'file:///test.sql' },
      },
    });

    // Wait for the cleared diagnostics (empty array)
    const clearMsg = await waitFor(m =>
      m.method === 'textDocument/publishDiagnostics' &&
      (m.params as { diagnostics: unknown[] }).diagnostics.length === 0,
    );
    expect((clearMsg.params as { diagnostics: unknown[] }).diagnostics).toHaveLength(0);
  });

  it('should return code actions with safe rewrite', async () => {
    const { child: c, waitFor } = await startServer();

    // Open file with non-concurrent index
    sendMessage(c, {
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: {
        textDocument: {
          uri: 'file:///test.sql',
          languageId: 'sql',
          version: 1,
          text: 'CREATE INDEX idx ON users (email);',
        },
      },
    });

    // Wait for diagnostics first
    const diagMsg = await waitFor(m => m.method === 'textDocument/publishDiagnostics');
    const diagnostics = (diagMsg.params as { diagnostics: LspDiagnostic[] }).diagnostics;
    const indexDiag = diagnostics.find(d => d.code === 'create-index-not-concurrent');
    expect(indexDiag).toBeDefined();

    // Request code actions
    sendMessage(c, {
      jsonrpc: '2.0',
      id: 2,
      method: 'textDocument/codeAction',
      params: {
        textDocument: { uri: 'file:///test.sql' },
        range: indexDiag!.range,
        context: { diagnostics: [indexDiag] },
      },
    });

    const actionResponse = await waitFor(m => m.id === 2);
    const actions = actionResponse.result as unknown as Array<{ title: string; kind: string }>;
    expect(actions.length).toBeGreaterThan(0);

    const safeRewrite = actions.find(a => a.title.startsWith('Safe rewrite:'));
    expect(safeRewrite).toBeDefined();
    expect(safeRewrite!.kind).toBe('quickfix');
  });

  it('should return hover content for flagged statement', async () => {
    const { child: c, waitFor } = await startServer();

    sendMessage(c, {
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: {
        textDocument: {
          uri: 'file:///test.sql',
          languageId: 'sql',
          version: 1,
          text: 'CREATE INDEX idx ON users (email);',
        },
      },
    });

    // Wait for analysis to complete
    await waitFor(m => m.method === 'textDocument/publishDiagnostics');

    // Request hover
    sendMessage(c, {
      jsonrpc: '2.0',
      id: 3,
      method: 'textDocument/hover',
      params: {
        textDocument: { uri: 'file:///test.sql' },
        position: { line: 0, character: 10 },
      },
    });

    const hoverResponse = await waitFor(m => m.id === 3);
    const hover = hoverResponse.result as { contents: { value: string } } | null;
    expect(hover).not.toBeNull();
    expect(hover!.contents.value).toContain('SHARE');
    expect(hover!.contents.value).toContain('pgfence');
  });
});
