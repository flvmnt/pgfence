import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connection } from 'vscode-languageserver';
import { createServer, DEBOUNCE_MS } from '../../src/lsp/server.js';
import { analyzeText } from '../../src/lsp/analyze-text.js';
import { RiskLevel } from '../../src/types.js';
import type { PgfenceConfig } from '../../src/types.js';

vi.mock('../../src/lsp/analyze-text.js', () => ({
  analyzeText: vi.fn(),
}));

type HandlerMap = {
  initialize?: Parameters<NonNullable<Connection['onInitialize']>>[0];
  initialized?: Parameters<NonNullable<Connection['onInitialized']>>[0];
  didOpen?: (event: { textDocument: { uri: string; languageId: string; version: number; text: string } }) => void;
  didChange?: (event: unknown) => void;
  willSave?: (event: unknown) => void;
  willSaveWaitUntil?: (event: unknown) => void;
  didSave?: (event: { textDocument: { uri: string } }) => void;
  didClose?: (event: { textDocument: { uri: string } }) => void;
  didChangeConfiguration?: Parameters<NonNullable<Connection['onDidChangeConfiguration']>>[0];
  codeAction?: Parameters<NonNullable<Connection['onCodeAction']>>[0];
  hover?: Parameters<NonNullable<Connection['onHover']>>[0];
  documentSymbol?: Parameters<NonNullable<Connection['onDocumentSymbol']>>[0];
  foldingRanges?: Parameters<NonNullable<Connection['onFoldingRanges']>>[0];
  inlayHint?: Parameters<NonNullable<Connection['onRequest']>>[1];
};

function makeConfig(): PgfenceConfig {
  return {
    format: 'auto',
    output: 'cli',
    minPostgresVersion: 14,
    maxAllowedRisk: RiskLevel.HIGH,
    requireLockTimeout: true,
    requireStatementTimeout: true,
  };
}

function createMockConnection() {
  const handlers: HandlerMap = {};
  const connection = {
    console: {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      log: vi.fn(),
    },
    workspace: {
      getConfiguration: vi.fn().mockResolvedValue(null),
    },
    sendDiagnostics: vi.fn(),
    onInitialize: vi.fn((handler) => {
      handlers.initialize = handler;
    }),
    onInitialized: vi.fn((handler) => {
      handlers.initialized = handler;
    }),
    onDidChangeConfiguration: vi.fn((handler) => {
      handlers.didChangeConfiguration = handler;
    }),
    onDidOpenTextDocument: vi.fn((handler) => {
      handlers.didOpen = handler;
    }),
    onDidChangeTextDocument: vi.fn((handler) => {
      handlers.didChange = handler;
    }),
    onWillSaveTextDocument: vi.fn((handler) => {
      handlers.willSave = handler;
    }),
    onWillSaveTextDocumentWaitUntil: vi.fn((handler) => {
      handlers.willSaveWaitUntil = handler;
    }),
    onDidSaveTextDocument: vi.fn((handler) => {
      handlers.didSave = handler;
    }),
    onDidCloseTextDocument: vi.fn((handler) => {
      handlers.didClose = handler;
    }),
    onCodeAction: vi.fn((handler) => {
      handlers.codeAction = handler;
    }),
    onHover: vi.fn((handler) => {
      handlers.hover = handler;
    }),
    onDocumentSymbol: vi.fn((handler) => {
      handlers.documentSymbol = handler;
    }),
    onFoldingRanges: vi.fn((handler) => {
      handlers.foldingRanges = handler;
    }),
    onRequest: vi.fn((method, handler) => {
      if (method === 'textDocument/inlayHint') {
        handlers.inlayHint = handler;
      }
    }),
  };

  return { connection: connection as unknown as Connection, handlers };
}

describe('LSP cache behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(analyzeText).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears stale analysis cache after a failed reanalysis', async () => {
    const { connection, handlers } = createMockConnection();
    const server = createServer(connection);
    const uri = 'file:///test.sql';
    const content = 'CREATE INDEX idx ON users (email);';

    const actual = await vi.importActual<typeof import('../../src/lsp/analyze-text.js')>(
      '../../src/lsp/analyze-text.js',
    );
    const successResult = await actual.analyzeText({
      content,
      filePath: '/test.sql',
      config: makeConfig(),
    });

    vi.mocked(analyzeText)
      .mockResolvedValueOnce(successResult)
      .mockRejectedValueOnce(new Error('analysis boom'));

    handlers.didOpen?.({
      textDocument: {
        uri,
        languageId: 'sql',
        version: 1,
        text: content,
      },
    });

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(server.analysisCache.get(uri)).toBeDefined();
    expect(handlers.hover?.({
      textDocument: { uri },
      position: { line: 0, character: 10 },
    })).not.toBeNull();

    handlers.didSave?.({
      textDocument: { uri },
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(server.analysisCache.has(uri)).toBe(false);
    expect(handlers.hover?.({
      textDocument: { uri },
      position: { line: 0, character: 10 },
    })).toBeNull();
    expect(connection.sendDiagnostics).toHaveBeenCalledWith({
      uri,
      diagnostics: [],
    });
  });

  it('resets omitted configuration values to defaults on configuration refresh', async () => {
    const { connection, handlers } = createMockConnection();
    createServer(connection);
    const uri = 'file:///test.sql';
    const content = 'CREATE INDEX idx ON users (email);';

    vi.mocked(analyzeText).mockResolvedValue({
      checks: [],
      policyViolations: [],
      extractionWarnings: [],
      maxRisk: RiskLevel.SAFE,
      statementCount: 0,
      sourceRanges: [],
      policySourceRanges: [],
    });

    const initResult = handlers.initialize?.({
      capabilities: {},
      processId: 1,
      rootUri: null,
      initializationOptions: {
        requireLockTimeout: false,
        requireStatementTimeout: false,
        unknown: 'block',
      },
    });
    expect(initResult).toBeDefined();

    handlers.didOpen?.({
      textDocument: {
        uri,
        languageId: 'sql',
        version: 1,
        text: content,
      },
    });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    let firstConfig = vi.mocked(analyzeText).mock.calls[0][0].config;
    expect(firstConfig.requireLockTimeout).toBe(false);
    expect(firstConfig.requireStatementTimeout).toBe(false);
    expect(firstConfig.unknownHandling).toBe('block');

    vi.mocked(connection.workspace.getConfiguration).mockResolvedValue({});
    await handlers.didChangeConfiguration?.({});
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    const lastCall = vi.mocked(analyzeText).mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    firstConfig = lastCall![0].config;
    expect(firstConfig.requireLockTimeout).toBe(true);
    expect(firstConfig.requireStatementTimeout).toBe(true);
    expect(firstConfig.unknownHandling).toBe('warn');
  });
});
