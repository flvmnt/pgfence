#!/usr/bin/env node
/**
 * pgfence Language Server Protocol server.
 *
 * Provides real-time migration safety analysis via LSP:
 * - Diagnostics (lock modes, risk levels)
 * - Code actions (safe rewrite quick fixes, ignore directives)
 * - Hover (lock mode details, blocked operations)
 *
 * Transport: stdio (works with VS Code, Neovim, Helix, Zed)
 */

import {
  TextDocuments,
  TextDocumentSyncKind,
  CodeActionKind,
  type InitializeResult,
  type Diagnostic,
  type Connection,
} from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeText } from './analyze-text.js';
import type { AnalyzeTextResult } from './analyze-text.js';
import {
  checkResultToDiagnostic,
  policyViolationToDiagnostic,
  extractionWarningToDiagnostic,
  parseErrorToDiagnostic,
} from './diagnostics.js';
import { getCodeActions } from './code-actions.js';
import { getHoverContent } from './hover.js';
import { getDocumentSymbols } from './document-symbols.js';
import { getFoldingRanges } from './folding-ranges.js';
import { getInlayHints } from './inlay-hints.js';
import { RiskLevel } from '../types.js';
import type { PgfenceConfig } from '../types.js';

export const DEBOUNCE_MS = 300;

const FORMAT_VALUES = new Set(['sql', 'typeorm', 'prisma', 'knex', 'drizzle', 'sequelize', 'auto']);
const OUTPUT_VALUES = new Set(['cli', 'json', 'github', 'sarif', 'gitlab']);

function defaultLspConfig(): PgfenceConfig {
  return {
    format: 'auto',
    output: 'cli',
    minPostgresVersion: 14,
    maxAllowedRisk: RiskLevel.HIGH,
    requireLockTimeout: true,
    requireStatementTimeout: true,
    unknownHandling: 'warn',
  };
}

function applyLspConfig(target: PgfenceConfig, items: Record<string, unknown>): void {
  if (typeof items.format === 'string' && FORMAT_VALUES.has(items.format)) {
    target.format = items.format as PgfenceConfig['format'];
  }
  if (typeof items.output === 'string' && OUTPUT_VALUES.has(items.output)) {
    target.output = items.output as PgfenceConfig['output'];
  }
  if (typeof items.minPostgresVersion === 'number') target.minPostgresVersion = items.minPostgresVersion;
  if (typeof items.requireLockTimeout === 'boolean') target.requireLockTimeout = items.requireLockTimeout;
  if (typeof items.requireStatementTimeout === 'boolean') target.requireStatementTimeout = items.requireStatementTimeout;
  if (typeof items.maxRisk === 'string') {
    const risk = items.maxRisk.toUpperCase();
    if (Object.values(RiskLevel).includes(risk as RiskLevel)) target.maxAllowedRisk = risk as RiskLevel;
  }
  if (typeof items.unknown === 'string' && (items.unknown === 'warn' || items.unknown === 'block')) {
    target.unknownHandling = items.unknown;
  }
  if (typeof items.snapshot === 'string') target.snapshotFile = items.snapshot;
  if (Array.isArray(items.plugins) && items.plugins.every((plugin) => typeof plugin === 'string')) {
    target.plugins = items.plugins;
  }
  if (Array.isArray(items.disableRules) && items.disableRules.every((rule) => typeof rule === 'string')) {
    target.rules = { ...target.rules, disable: items.disableRules };
  }
  if (Array.isArray(items.enableRules) && items.enableRules.every((rule) => typeof rule === 'string')) {
    target.rules = { ...target.rules, enable: items.enableRules };
  }
}

function configFromLspItems(items: Record<string, unknown> | null | undefined): PgfenceConfig {
  const next = defaultLspConfig();
  if (items) {
    applyLspConfig(next, items);
  }
  return next;
}

/**
 * Create and wire up the LSP server.
 * Accepts a pre-built connection (for testing) or creates one from stdio.
 */
export function createServer(conn: Connection) {
  const connection = conn;
  const documents = new TextDocuments(TextDocument);

  const analysisCache = new Map<string, AnalyzeTextResult>();
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  let serverConfig: PgfenceConfig = defaultLspConfig();

  connection.onInitialize((params): InitializeResult => {
    // Seed config from initializationOptions so the server doesn't use
    // defaults until the first workspace/didChangeConfiguration event.
    const init = params.initializationOptions as Record<string, unknown> | null;
    if (init) {
      serverConfig = configFromLspItems(init);
    }

    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Full,
        codeActionProvider: {
          codeActionKinds: [CodeActionKind.QuickFix],
        },
        hoverProvider: true,
        documentSymbolProvider: true,
        foldingRangeProvider: true,
        inlayHintProvider: { resolveProvider: false },
        workspace: {
          workspaceFolders: { supported: false },
        },
      },
    };
  });

  connection.onInitialized(() => {
    for (const doc of documents.all()) {
      scheduleAnalysis(doc.uri);
    }
  });

  function scheduleAnalysis(uri: string): void {
    const existing = debounceTimers.get(uri);
    if (existing) clearTimeout(existing);

    debounceTimers.set(uri, setTimeout(() => {
      debounceTimers.delete(uri);
      void runAnalysis(uri);
    }, DEBOUNCE_MS));
  }

  async function runAnalysis(uri: string): Promise<void> {
    try {
      const doc = documents.get(uri);
      if (!doc) return;

      const text = doc.getText();
      const version = doc.version;
      const filePath = uriToFilePath(uri);

      const result = await analyzeText({
        content: text,
        filePath,
        config: serverConfig,
      });

      // Bail if document has advanced while we were analyzing
      const currentDoc = documents.get(uri);
      if (!currentDoc || currentDoc.version !== version) return;

      analysisCache.set(uri, result);

      const diagnostics: Diagnostic[] = [];

      if (result.parseError) {
        diagnostics.push(parseErrorToDiagnostic(result.parseError, text));
      }

      for (const warning of result.extractionWarnings) {
        diagnostics.push(extractionWarningToDiagnostic(warning));
      }

      for (let i = 0; i < result.checks.length; i++) {
        diagnostics.push(checkResultToDiagnostic(
          result.checks[i],
          result.sourceRanges[i],
          text,
        ));
      }

      for (let i = 0; i < result.policyViolations.length; i++) {
        diagnostics.push(policyViolationToDiagnostic(
          result.policyViolations[i],
          result.policySourceRanges[i] ?? null,
          text,
        ));
      }

      connection.sendDiagnostics({ uri, diagnostics, version });
    } catch (err) {
      connection.console.error(`pgfence analysis failed for ${uri}: ${err}`);
      analysisCache.delete(uri);
      connection.sendDiagnostics({ uri, diagnostics: [] });
    }
  }

  documents.onDidChangeContent((change) => {
    scheduleAnalysis(change.document.uri);
  });

  documents.onDidSave((change) => {
    const existing = debounceTimers.get(change.document.uri);
    if (existing) clearTimeout(existing);
    debounceTimers.delete(change.document.uri);
    void runAnalysis(change.document.uri);
  });

  documents.onDidClose((change) => {
    analysisCache.delete(change.document.uri);
    const timer = debounceTimers.get(change.document.uri);
    if (timer) clearTimeout(timer);
    debounceTimers.delete(change.document.uri);
    connection.sendDiagnostics({ uri: change.document.uri, diagnostics: [] });
  });

  connection.onCodeAction((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    const cached = analysisCache.get(params.textDocument.uri);
    if (!cached) return [];
    return getCodeActions(params, cached, doc);
  });

  connection.onHover((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;
    const cached = analysisCache.get(params.textDocument.uri);
    if (!cached) return null;
    return getHoverContent(params, cached, doc);
  });

  connection.onDocumentSymbol((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    const cached = analysisCache.get(params.textDocument.uri);
    if (!cached) return [];
    return getDocumentSymbols(params, cached, doc);
  });

  connection.onFoldingRanges((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    const cached = analysisCache.get(params.textDocument.uri);
    if (!cached) return [];
    return getFoldingRanges(params, cached, doc);
  });

  connection.onRequest('textDocument/inlayHint', (params: { textDocument: { uri: string }; range: { start: { line: number; character: number }; end: { line: number; character: number } } }) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    const cached = analysisCache.get(params.textDocument.uri);
    if (!cached) return [];
    return getInlayHints(params, cached, doc);
  });

  connection.onDidChangeConfiguration(async () => {
    try {
      // Pull updated config from the client
      const items = await connection.workspace.getConfiguration({
        section: 'pgfence',
      }) as Record<string, unknown> | null;
      serverConfig = configFromLspItems(items);
    } catch (err) {
      // Client may not support workspace/configuration (e.g. minimal Neovim/Helix LSP configs)
      // Log non-capability errors so they're not completely invisible
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes('not supported') && !message.includes('Unhandled method')) {
        connection.console.warn(`pgfence: failed to read configuration: ${message}`);
      }
    }
    for (const doc of documents.all()) {
      scheduleAnalysis(doc.uri);
    }
  });

  documents.listen(connection);

  return { connection, documents, analysisCache };
}

function uriToFilePath(uri: string): string {
  if (uri.startsWith('file://')) {
    const decoded = decodeURIComponent(uri.slice(7));
    // On Windows, file:///C:/path becomes /C:/path after slice(7);
    // strip the leading slash before the drive letter
    if (/^\/[a-zA-Z]:/.test(decoded)) {
      return decoded.slice(1);
    }
    return decoded;
  }
  return uri;
}

/**
 * Create an LSP connection using stdio transport.
 * Uses createRequire to load the /node subpath which provides stream-based createConnection
 * with auto-detection of --stdio/--node-ipc/--socket from process.argv.
 */
async function createStdioConnection(): Promise<Connection> {
  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.url);
  const mod = req('vscode-languageserver/node') as Record<string, unknown>;
  const createConn = mod.createConnection as (...args: unknown[]) => Connection;
  const proposed = (mod.ProposedFeatures as { all: unknown }).all;
  return createConn(proposed);
}

export async function startStdioServer(): Promise<void> {
  const conn = await createStdioConnection();
  const server = createServer(conn);
  server.connection.listen();
}

function isMainModule(moduleUrl: string): boolean {
  const entryPoint = process.argv[1];
  if (!entryPoint) return false;
  return path.resolve(entryPoint) === fileURLToPath(moduleUrl);
}

if (isMainModule(import.meta.url)) {
  void startStdioServer().catch((err) => {
    process.stderr.write(`pgfence LSP server failed to start: ${err}\n`);
    process.stderr.write('Use --stdio, --node-ipc, or --socket=<port> to specify transport.\n');
    process.exit(1);
  });
}
