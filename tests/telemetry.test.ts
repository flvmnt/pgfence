import { describe, it, expect } from 'vitest';
import { exec } from 'node:child_process';
import util from 'node:util';
import path from 'node:path';
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { AddressInfo, Socket } from 'node:net';

import { analyze } from '../src/analyzer.js';
import { loadConfigFile, mergeConfig, resolveProjectTelemetry } from '../src/config.js';
import { RiskLevel } from '../src/types.js';
import type { AnalysisResult, PgfenceConfig } from '../src/types.js';

import {
  TELEMETRY_CI_PROVIDERS,
  TELEMETRY_COMMANDS,
  TELEMETRY_EVENT_KEYS,
  TELEMETRY_FORMATS,
  TELEMETRY_OS,
  TELEMETRY_RULES_MODES,
  fileCountBucket,
  parseTelemetryEvent,
  toTelemetryOs,
  toTelemetryVersion,
} from '../src/telemetry/types.js';
import type { TelemetryEvent, TelemetryFormat } from '../src/telemetry/types.js';
import {
  ciProvider,
  isCI,
  isTestRunner,
  resolveEnvOptOut,
  spoolDir,
  stateFilePath,
  telemetryStateDir,
} from '../src/telemetry/env.js';
import type { OptOutReason } from '../src/telemetry/env.js';
import { loadOrCreateState, readAttempt } from '../src/telemetry/store.js';
import { beginTelemetry, finishTelemetry, runTelemetryCommand } from '../src/telemetry/session.js';
import type { TelemetryOutcome } from '../src/telemetry/session.js';
import { CONNECT_BUDGET_MS, sendEventsAwaitable } from '../src/telemetry/post.js';

const execPromise = util.promisify(exec);

const cliPath = path.join(process.cwd(), 'src', 'index.ts');
const distCliPath = path.join(process.cwd(), 'dist', 'index.js');
const distTelemetryPath = path.join(process.cwd(), 'dist', 'telemetry', 'session.js');
const tsxBin = path.join(process.cwd(), 'node_modules', '.bin', 'tsx');
const fixturesDir = path.join(process.cwd(), 'tests', 'fixtures');
const telemetrySrcDir = path.join(process.cwd(), 'src', 'telemetry');
const lspSrcDir = path.join(process.cwd(), 'src', 'lsp');

/**
 * Run the CLI the way tests/cli.test.ts does, with one addition: a dist/ that predates
 * telemetry is never used. A stale build carries no telemetry code at all, which would
 * turn every assertion in this file into a tautology that passes for the wrong reason.
 */
const useDist = existsSync(distCliPath) && existsSync(distTelemetryPath);
const cliEntry = useDist ? distCliPath : cliPath;

function runnerPrefix(): string {
  if (useDist) return 'node';
  return existsSync(tsxBin) ? `"${tsxBin}"` : 'npx tsx';
}

function cliCommand(args: string): string {
  return `${runnerPrefix()} "${cliEntry}" ${args}`;
}

/**
 * A child process cannot be given a TTY without a pty, and the first-run notice is
 * deliberately gated on one. This wrapper sets the flag the gate reads and then hands
 * control to the real entrypoint, so the notice path can be exercised against the actual
 * CLI rather than approximated. It is a test harness, never a production switch: there is
 * no environment variable that forces the notice.
 */
const FORCE_TTY_WRAPPER = [
  "Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true, writable: true });",
  'const entry = process.env.PGFENCE_TEST_ENTRY;',
  'process.argv[1] = entry;',
  'await import(entry);',
  '',
].join('\n');

/** Matches the runner: tsx reads .mts, plain node reads .mjs. */
const WRAPPER_EXT = useDist ? '.mjs' : '.mts';

const defaultConfig: PgfenceConfig = {
  format: 'auto',
  output: 'cli',
  minPostgresVersion: 14,
  maxAllowedRisk: RiskLevel.HIGH,
  requireLockTimeout: true,
  requireStatementTimeout: true,
};

/**
 * RFC 5737 TEST-NET-1. Reserved for documentation and never routed, so a connect attempt
 * leaves this machine as at most a dropped SYN and can never reach a real service. A
 * refused loopback port is not a substitute for the timeout assertions: it fails in about
 * a millisecond and would pass against an implementation that does not bound connect at
 * all. It must be https, because the endpoint resolver refuses non-loopback http.
 */
const BLACKHOLE_ENDPOINT = 'https://192.0.2.1/v1/event';

/** Closed loopback port: guaranteed local, guaranteed refused, guaranteed instant. */
const REFUSED_ENDPOINT = 'http://127.0.0.1:1/v1/event';

/** The disclosure, verbatim. Pinned here so a silent edit to it fails a test. */
const NOTICE_LINES = [
  'pgfence collects anonymous usage counts so we can tell how many people use it.',
  'Sent: a random install id, the command, pgfence/Node/OS versions, CI or not, how long the run took, and counts of findings by severity.',
  'Never sent: SQL, file names or paths, table, column or rule names, or anything read from a database.',
  'Opt out: PGFENCE_TELEMETRY=0, DO_NOT_TRACK=1, "pgfence telemetry disable", or telemetry = false in .pgfence.toml',
  'Nothing was sent during this run. Full list: https://pgfence.com/telemetry',
];
const NOTICE = NOTICE_LINES.join('\n') + '\n';

/** Every variable the CI detector looks at, including both halves of each pair. */
const CI_VARS = [
  'CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'CIRCLECI', 'TRAVIS', 'TF_BUILD', 'JENKINS_URL',
  'BUILDKITE', 'TEAMCITY_VERSION', 'APPVEYOR', 'BITBUCKET_BUILD_NUMBER', 'DRONE', 'VERCEL',
  'NETLIFY', 'JB_SPACE_API_URL', 'HUDSON_URL', 'CODEBUILD_BUILD_ID', 'AWS_REGION',
  'BUILD_ID', 'BUILD_URL', 'PROJECT_ID',
];

const TELEMETRY_VARS = [
  'PGFENCE_TELEMETRY', 'PGFENCE_TELEMETRY_ENDPOINT', 'PGFENCE_TELEMETRY_DEBUG', 'DO_NOT_TRACK',
];

/**
 * Environment for a run that SHOULD do telemetry work: a private config root, no
 * test-runner auto-disable, and CI detection off unless the caller turns it on.
 *
 * The config root is the isolation seam for this whole file. XDG_CONFIG_HOME covers Linux
 * and macOS and APPDATA covers Windows, and telemetryStateDir reads exactly one of them
 * per platform, so nothing here can read or write a real ~/.config/pgfence. The seam
 * itself is asserted in "telemetry state directory".
 */
function telemetryEnvPatch(root: string, extra: Record<string, string> = {}): Record<string, string | undefined> {
  const patch: Record<string, string | undefined> = {};
  for (const key of [...CI_VARS, ...TELEMETRY_VARS, 'VITEST', 'NODE_ENV']) {
    patch[key] = undefined;
  }
  patch.XDG_CONFIG_HOME = root;
  patch.APPDATA = root;
  return { ...patch, ...extra };
}

/** Apply a patch to process.env for an in-process test. Returns the undo. */
function applyEnv(patch: Record<string, string | undefined>): () => void {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(patch)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/** Environment for a child process. Always spreads process.env so PATH and HOME survive. */
function childEnv(root: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(telemetryEnvPatch(root, extra))) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

interface Capture {
  chunks: string[];
  text(): string;
  restore(): void;
}

function captureStream(stream: NodeJS.WriteStream): Capture {
  const chunks: string[] = [];
  const original = stream.write;
  stream.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof stream.write;
  return {
    chunks,
    text: () => chunks.join(''),
    restore: () => {
      stream.write = original;
    },
  };
}

/** Force a stream's isTTY, because the notice gate and the `tty` field both read it. */
function forceTTY(stream: NodeJS.WriteStream, value: boolean): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(stream, 'isTTY');
  Object.defineProperty(stream, 'isTTY', { value, configurable: true, writable: true, enumerable: true });
  return () => {
    if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
    else delete (stream as unknown as Record<string, unknown>).isTTY;
  };
}

const SEED_INSTALL_ID = '8f14e45fceea167a5a36dedd4bea2543';

function stateDirOf(root: string): string {
  return path.join(root, 'pgfence');
}

function stateFileOf(root: string): string {
  return path.join(root, 'pgfence', 'telemetry.json');
}

function spoolDirOf(root: string): string {
  return path.join(root, 'pgfence', 'spool');
}

/**
 * Write a state file that already carries noticeShownAt, which is what makes a run
 * collect anything at all: the run that would print the notice deliberately records
 * nothing.
 */
async function seedState(root: string, extra: Record<string, unknown> = {}): Promise<void> {
  await mkdir(stateDirOf(root), { recursive: true });
  await writeFile(
    stateFileOf(root),
    JSON.stringify({
      schemaVersion: 1,
      installId: SEED_INSTALL_ID,
      noticeShownAt: '2026-01-01T00:00:00.000Z',
      ...extra,
    }, null, 2) + '\n',
    'utf8',
  );
}

function readStateFile(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(stateFileOf(root), 'utf8')) as Record<string, unknown>;
}

/**
 * Park the delivery cooldown far in the future so a run records without ever opening a
 * socket. Used by the tests that only want to inspect the event that was built.
 */
function freezeDelivery(root: string): void {
  const dir = spoolDirOf(root);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(dir, '.attempt'),
    JSON.stringify({ nextAt: Date.now() + 3_600_000, fails: 0 }),
    { mode: 0o600 },
  );
}

function spoolEvents(root: string): Array<Record<string, unknown>> {
  const dir = spoolDirOf(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith('.json'))
    .sort()
    .map((entry) => JSON.parse(readFileSync(path.join(dir, entry), 'utf8')) as Record<string, unknown>);
}

/** True when telemetry left any trace at all under the private config root. */
function wroteAnything(root: string): boolean {
  return existsSync(stateDirOf(root));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 10);
    });
  }
  return predicate();
}

interface WireEnvelope {
  v: number;
  events: Array<Record<string, unknown>>;
}

interface Receiver {
  endpoint: string;
  envelopes: WireEnvelope[];
  events(): Array<Record<string, unknown>>;
  waitFor(count: number, timeoutMs?: number): Promise<boolean>;
  close(): Promise<void>;
}

/** A loopback receiver. Nothing in this file is ever allowed to reach a real endpoint. */
async function startReceiver(): Promise<Receiver> {
  const envelopes: WireEnvelope[] = [];
  const sockets = new Set<Socket>();

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        envelopes.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as WireEnvelope);
      } catch {
        // A body that is not JSON is itself a failure, and every assertion reads the
        // envelope list, so recording nothing is the right way to surface it.
      }
      res.writeHead(204).end();
    });
  });
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  return {
    endpoint: `http://127.0.0.1:${port}/v1/event`,
    envelopes,
    events: () => envelopes.flatMap((envelope) => envelope.events ?? []),
    waitFor: (count, timeoutMs = 5000) => waitUntil(() => envelopes.length >= count, timeoutMs),
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}

/** Mirror of telemetryOutcome in src/index.ts, so the events under test are real ones. */
function outcomeFor(results: AnalysisResult[], config: PgfenceConfig): TelemetryOutcome {
  const formats = new Set<TelemetryFormat>();
  for (const result of results) {
    if (result.detectedFormat != null) formats.add(result.detectedFormat);
  }
  const checks = results.flatMap((result) => result.checks);
  const violations = results.flatMap((result) => result.policyViolations);
  const policyErrors = violations.filter((violation) => violation.severity === 'error').length;
  const countAt = (level: RiskLevel): number =>
    checks.filter((check) => (check.adjustedRisk ?? check.risk) === level).length;

  return {
    errored: false,
    format: formats.size === 0 ? 'none' : formats.size === 1 ? [...formats][0] : 'mixed',
    rulesMode: 'default',
    pluginCount: config.plugins?.length ?? 0,
    fileCount: results.length,
    findings: {
      safe: countAt(RiskLevel.SAFE),
      low: countAt(RiskLevel.LOW),
      medium: countAt(RiskLevel.MEDIUM),
      high: countAt(RiskLevel.HIGH),
      critical: countAt(RiskLevel.CRITICAL),
      policyErrors,
      policyWarnings: violations.length - policyErrors,
    },
  };
}

const sampleOutcome: TelemetryOutcome = {
  errored: false,
  format: 'sql',
  rulesMode: 'default',
  pluginCount: 0,
  fileCount: 3,
  findings: { safe: 1, low: 2, medium: 3, high: 4, critical: 5, policyErrors: 6, policyWarnings: 7 },
};

/** A fully valid event record, for the parser and the send path. */
function validEventRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    eventId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    installId: SEED_INSTALL_ID,
    freshInstallId: false,
    command: 'analyze',
    version: '0.8.0',
    nodeMajor: 20,
    os: 'linux',
    ci: false,
    ciProvider: 'none',
    tty: true,
    format: 'sql',
    rulesMode: 'default',
    pluginCount: 0,
    fileCountBucket: 1,
    findSafe: 0,
    findLow: 0,
    findMedium: 0,
    findHigh: 0,
    findCritical: 0,
    policyErrors: 0,
    policyWarnings: 0,
    errored: false,
    durationMs: 10,
    ts: 1_700_000_000_000,
    ...overrides,
  };
}

/** The same record, through the real parser. Throws if the fixture ever stops being valid. */
function validEvent(overrides: Record<string, unknown> = {}): TelemetryEvent {
  const event = parseTelemetryEvent(validEventRecord(overrides));
  if (event === null) throw new Error('telemetry test fixture is not a valid event');
  return event;
}

/**
 * Record one real event into `root`'s spool, through the real begin/finish pair.
 *
 * Leaves no .attempt file behind, because the flush over an empty spool returns before it
 * writes one. A later run therefore finds a backlog and an expired cooldown, which is
 * exactly the state the delivery tests need.
 */
async function recordSpooledEvent(root: string): Promise<void> {
  await seedState(root);
  const restore = applyEnv(telemetryEnvPatch(root, { PGFENCE_TELEMETRY_ENDPOINT: REFUSED_ENDPOINT }));
  try {
    beginTelemetry('analyze', undefined);
    await finishTelemetry(sampleOutcome);
  } finally {
    restore();
  }
}

/** Build one event through the real code path and return it as the spool serialized it. */
async function buildEventVia(
  root: string,
  command: Parameters<typeof beginTelemetry>[0],
  projectSetting: boolean | undefined,
  outcome: TelemetryOutcome,
  extra: Record<string, string> = {},
): Promise<Record<string, unknown> | undefined> {
  const restore = applyEnv(telemetryEnvPatch(root, extra));
  try {
    beginTelemetry(command, projectSetting);
    await finishTelemetry(outcome);
  } finally {
    restore();
  }
  const events = spoolEvents(root);
  return events[events.length - 1];
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTALL_ID_PATTERN = /^[0-9a-f]{32}$/;

/** Assert the closed-vocabulary invariant against a record that came off disk or the wire. */
function expectClosedVocabulary(event: Record<string, unknown>): void {
  expect([...Object.keys(event)].sort()).toEqual([...TELEMETRY_EVENT_KEYS]);
  expect(event.v).toBe(1);
  expect(TELEMETRY_COMMANDS).toContain(event.command);
  expect(TELEMETRY_OS).toContain(event.os);
  expect(TELEMETRY_CI_PROVIDERS).toContain(event.ciProvider);
  expect(TELEMETRY_FORMATS).toContain(event.format);
  expect(TELEMETRY_RULES_MODES).toContain(event.rulesMode);
  expect(event.installId).toMatch(INSTALL_ID_PATTERN);
  expect(event.eventId).toMatch(UUID_PATTERN);
  expect(typeof event.version).toBe('string');
  expect(event.version === 'unknown' || /^\d+\.\d+\.\d+/.test(String(event.version))).toBe(true);

  const stringFields = new Set([
    'command', 'os', 'ciProvider', 'format', 'rulesMode', 'installId', 'eventId', 'version',
  ]);
  for (const [key, value] of Object.entries(event)) {
    if (stringFields.has(key)) {
      expect(typeof value, `${key} must be a string`).toBe('string');
      continue;
    }
    expect(['number', 'boolean'], `${key} must be a number or a boolean`).toContain(typeof value);
  }
}

describe('telemetry payload contract', () => {
  it('builds an event with exactly the 25 documented keys, all from closed vocabularies', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pgfence-telemetry-keys-'));
    try {
      await seedState(root);
      freezeDelivery(root);

      const event = await buildEventVia(root, 'analyze', undefined, sampleOutcome);
      expect(event).toBeDefined();
      if (!event) return;

      expect(TELEMETRY_EVENT_KEYS).toHaveLength(25);
      expectClosedVocabulary(event);
      expect(event.command).toBe('analyze');
      expect(event.format).toBe('sql');
      expect(event.rulesMode).toBe('default');
      expect(event.installId).toBe(SEED_INSTALL_ID);
      expect(event.freshInstallId).toBe(false);
      expect(event.ci).toBe(false);
      expect(event.ciProvider).toBe('none');
      // fileCount 3 lands in the 2..5 bucket. The exact count never leaves the machine.
      expect(event.fileCountBucket).toBe(2);
      expect(event.findSafe).toBe(1);
      expect(event.findCritical).toBe(5);
      expect(event.policyErrors).toBe(6);
      expect(event.policyWarnings).toBe(7);
      expect(event.errored).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('re-projects onto the known keys and drops anything else', () => {
    const smuggled = parseTelemetryEvent(validEventRecord({
      sql: 'ALTER TABLE users ADD COLUMN email text',
      filePath: '/Users/someone/repo/migrations/001.sql',
      tableName: 'users',
      ruleId: 'add-column-not-null',
    }));

    expect(smuggled).not.toBeNull();
    if (!smuggled) return;
    expect([...Object.keys(smuggled)].sort()).toEqual([...TELEMETRY_EVENT_KEYS]);
    const serialized = JSON.stringify(smuggled);
    expect(serialized).not.toContain('ALTER TABLE');
    expect(serialized).not.toContain('/Users/');
    expect(serialized).not.toContain('users');
    expect(serialized).not.toContain('add-column-not-null');
  });

  it('rejects values outside the closed vocabularies', () => {
    expect(parseTelemetryEvent(validEventRecord())).not.toBeNull();

    const rejected: Array<Record<string, unknown>> = [
      { command: 'lsp' },
      { os: 'beos' },
      { format: '../etc/passwd' },
      { ciProvider: 'my-internal-runner' },
      { rulesMode: 'custom' },
      { installId: 'nope' },
      { eventId: 'not-a-uuid' },
      { version: '/Users/me/pgfence' },
      { v: 2 },
      { nodeMajor: -1 },
      { pluginCount: 100 },
      { durationMs: 600_001 },
      { errored: 'yes' },
    ];
    for (const override of rejected) {
      expect(parseTelemetryEvent(validEventRecord(override)), JSON.stringify(override)).toBeNull();
    }
  });

  it('sanitizes the version and buckets the file count', () => {
    expect(toTelemetryVersion('0.8.0')).toBe('0.8.0');
    expect(toTelemetryVersion('1.2.3-beta.1')).toBe('1.2.3-beta.1');
    expect(toTelemetryVersion('/Users/me/pgfence')).toBe('unknown');
    // The version also lands in a request header, so a newline in it must not survive.
    expect(toTelemetryVersion('0.8.0\nx-injected: 1')).toBe('unknown');
    expect(toTelemetryOs('darwin')).toBe('darwin');
    expect(toTelemetryOs('haiku')).toBe('other');
    expect([0, 1, 2, 5, 6, 20, 21, 100, 101, 5000].map(fileCountBucket)).toEqual([0, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
  });
});

describe('telemetry state directory', () => {
  it('resolves from the env var this file uses for isolation, and never from a relative one', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pgfence-telemetry-statedir-'));
    try {
      if (process.platform === 'win32') {
        expect(telemetryStateDir({ APPDATA: root })).toBe(stateDirOf(root));
        expect(telemetryStateDir({})).toBeNull();
      } else {
        expect(telemetryStateDir({ XDG_CONFIG_HOME: root })).toBe(stateDirOf(root));

        // A relative XDG_CONFIG_HOME is ignored in favor of the home fallback. Honoring
        // one would write the install id and the spool inside whatever repository is
        // being analyzed, which is the one place this data must never land.
        const relative = telemetryStateDir({ XDG_CONFIG_HOME: 'relative/config' });
        expect(relative).not.toBeNull();
        expect(relative).toBe(telemetryStateDir({}));
        expect(path.isAbsolute(relative ?? '')).toBe(true);
      }

      // The helpers in this file compose the same paths the implementation does.
      expect(stateFilePath(stateDirOf(root))).toBe(stateFileOf(root));
      expect(spoolDir(stateDirOf(root))).toBe(spoolDirOf(root));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('telemetry opt-out', () => {
  it('disables everything for every documented PGFENCE_TELEMETRY off-value', async () => {
    const receiver = await startReceiver();
    try {
      for (const value of ['0', 'false', 'off', 'no', 'FALSE', 'Off', ' off ', 'maybe', '']) {
        const root = await mkdtemp(path.join(tmpdir(), 'pgfence-telemetry-off-'));
        try {
          expect(resolveEnvOptOut(undefined, { PGFENCE_TELEMETRY: value }), value).toBe('env-pgfence');
          const event = await buildEventVia(root, 'analyze', undefined, sampleOutcome, {
            PGFENCE_TELEMETRY: value,
            PGFENCE_TELEMETRY_ENDPOINT: receiver.endpoint,
          });
          expect(event, value).toBeUndefined();
          // Not one byte: an opted-out run must not even create the state directory.
          expect(wroteAnything(root), value).toBe(false);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
      expect(receiver.envelopes).toHaveLength(0);
    } finally {
      await receiver.close();
    }
  });

  it('keeps telemetry on for every documented PGFENCE_TELEMETRY on-value', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pgfence-telemetry-on-'));
    try {
      await seedState(root);
      freezeDelivery(root);
      const onValues = ['1', 'true', 'on', 'yes', 'YES', ' On '];
      for (const [index, value] of onValues.entries()) {
        expect(resolveEnvOptOut(undefined, { PGFENCE_TELEMETRY: value }), value).toBe('none');
        await buildEventVia(root, 'analyze', undefined, sampleOutcome, { PGFENCE_TELEMETRY: value });
        expect(spoolEvents(root), value).toHaveLength(index + 1);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('lets an explicit PGFENCE_TELEMETRY on-value override a persisted disable, but never DO_NOT_TRACK', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pgfence-telemetry-forced-'));
    try {
      await seedState(root, { enabled: false });
      freezeDelivery(root);

      expect(await buildEventVia(root, 'analyze', undefined, sampleOutcome)).toBeUndefined();
      expect(await buildEventVia(root, 'analyze', undefined, sampleOutcome, { PGFENCE_TELEMETRY: '1' })).toBeDefined();
      expect(spoolEvents(root)).toHaveLength(1);

      expect(resolveEnvOptOut(undefined, { PGFENCE_TELEMETRY: '1', DO_NOT_TRACK: '1' })).toBe('env-do-not-track');
      await buildEventVia(root, 'analyze', undefined, sampleOutcome, { PGFENCE_TELEMETRY: '1', DO_NOT_TRACK: '1' });
      expect(spoolEvents(root)).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('disables everything when DO_NOT_TRACK is set, and only when it is set', async () => {
    const receiver = await startReceiver();
    const root = await mkdtemp(path.join(tmpdir(), 'pgfence-telemetry-dnt-'));
    try {
      await seedState(root);
      freezeDelivery(root);

      for (const value of ['1', 'true', 'yes', 'on', 'anything']) {
        expect(resolveEnvOptOut(undefined, { DO_NOT_TRACK: value }), value).toBe('env-do-not-track');
        const event = await buildEventVia(root, 'analyze', undefined, sampleOutcome, {
          DO_NOT_TRACK: value,
          PGFENCE_TELEMETRY_ENDPOINT: receiver.endpoint,
        });
        expect(event, value).toBeUndefined();
        expect(spoolEvents(root), value).toHaveLength(0);
      }

      // The cross-vendor convention: empty, 0 and false do NOT opt out.
      for (const value of ['', '0', 'false', 'FALSE']) {
        expect(resolveEnvOptOut(undefined, { DO_NOT_TRACK: value }), value).toBe('none');
      }
      await buildEventVia(root, 'analyze', undefined, sampleOutcome, { DO_NOT_TRACK: '0' });
      expect(spoolEvents(root)).toHaveLength(1);

      expect(receiver.envelopes).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
      await receiver.close();
    }
  });

  it('disables everything when a project sets telemetry = false in .pgfence.toml', async () => {
    const receiver = await startReceiver();
    const root = await mkdtemp(path.join(tmpdir(), 'pgfence-telemetry-toml-'));
    const project = await mkdtemp(path.join(tmpdir(), 'pgfence-telemetry-project-'));
    try {
      await writeFile(path.join(project, '.pgfence.toml'), 'telemetry = false\n', 'utf8');

      const fileConfig = await loadConfigFile(project);
      expect(fileConfig?.telemetry).toBe(false);
      expect(mergeConfig(fileConfig, {}).telemetry).toBe(false);

      expect(resolveEnvOptOut(false, {})).toBe('project-config');
      const event = await buildEventVia(root, 'analyze', fileConfig?.telemetry, sampleOutcome, {
        PGFENCE_TELEMETRY_ENDPOINT: receiver.endpoint,
      });
      expect(event).toBeUndefined();
      expect(wroteAnything(root)).toBe(false);
      expect(receiver.envelopes).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
      await receiver.close();
    }
  });

  it('disables everything when a project sets "telemetry": false in .pgfence.json', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pgfence-telemetry-json-'));
    const project = await mkdtemp(path.join(tmpdir(), 'pgfence-telemetry-project-json-'));
    try {
      await writeFile(path.join(project, '.pgfence.json'), JSON.stringify({ telemetry: false }), 'utf8');
      const fileConfig = await loadConfigFile(project);
      expect(fileConfig?.telemetry).toBe(false);

      const event = await buildEventVia(root, 'analyze', fileConfig?.telemetry, sampleOutcome);
      expect(event).toBeUndefined();
      expect(wroteAnything(root)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    }
  });

  it('honors a committed opt-out from a subdirectory, which is the only way it can cover a team', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pgfence-telemetry-walk-'));
    const repo = path.join(root, 'repo');
    const pkg = path.join(repo, 'packages', 'api');
    try {
      await mkdir(pkg, { recursive: true });
      await mkdir(path.join(repo, '.git'), { recursive: true });
      await writeFile(path.join(repo, '.pgfence.toml'), 'telemetry = false\n', 'utf8');

      // The bug this covers: loadConfigFile reads one directory, so the committed opt-out
      // is invisible from a package subdirectory and the run would have collected.
      expect(await loadConfigFile(pkg)).toBeNull();
      expect(await resolveProjectTelemetry(pkg)).toBe(false);
      expect(resolveEnvOptOut(await resolveProjectTelemetry(pkg), {})).toBe('project-config');

      // A package config that does not mention telemetry does not override the root.
      await writeFile(path.join(pkg, '.pgfence.toml'), 'max-risk = "medium"\n', 'utf8');
      expect(await resolveProjectTelemetry(pkg, await loadConfigFile(pkg))).toBe(false);

      // The nearest file that actually sets the key wins.
      await writeFile(path.join(pkg, '.pgfence.toml'), 'telemetry = true\n', 'utf8');
      expect(await resolveProjectTelemetry(pkg, await loadConfigFile(pkg))).toBe(true);

      // The walk stops at the repository root, so a stray config in a parent of the repo
      // is never read.
      await writeFile(path.join(root, '.pgfence.toml'), 'telemetry = false\n', 'utf8');
      const bare = path.join(root, 'bare', 'deep');
      await mkdir(bare, { recursive: true });
      await mkdir(path.join(root, 'bare', '.git'), { recursive: true });
      expect(await resolveProjectTelemetry(bare)).toBeUndefined();

      // And a malformed config anywhere up the tree fails closed rather than throwing.
      const broken = path.join(root, 'broken', 'sub');
      await mkdir(broken, { recursive: true });
      await mkdir(path.join(root, 'broken', '.git'), { recursive: true });
      await writeFile(path.join(root, 'broken', '.pgfence.toml'), 'telemetry = "no"\n', 'utf8');
      expect(await resolveProjectTelemetry(broken)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the telemetry config key tri-state, rejects a non-boolean, and still ignores unknown keys', async () => {
    const bad = await mkdtemp(path.join(tmpdir(), 'pgfence-telemetry-tristate-'));
    const forward = await mkdtemp(path.join(tmpdir(), 'pgfence-telemetry-forward-'));
    try {
      // Undefined must keep meaning "this project did not configure it", otherwise an
      // explicit telemetry = true cannot be told apart from the default.
      expect(mergeConfig({}, {}).telemetry).toBeUndefined();
      expect(mergeConfig({ telemetry: true }, {}).telemetry).toBe(true);
      expect(mergeConfig({ telemetry: false }, {}).telemetry).toBe(false);

      await writeFile(path.join(bad, '.pgfence.toml'), 'telemetry = "no"\n', 'utf8');
      await expect(loadConfigFile(bad)).rejects.toThrow(/"telemetry" must be a boolean/);

      // Forward compatibility was not tightened: telemetry = false can sit in a repo
      // shared with people still running an older pgfence.
      await writeFile(path.join(forward, '.pgfence.toml'), 'future-key = 1\ntelemetry = false\n', 'utf8');
      expect((await loadConfigFile(forward))?.telemetry).toBe(false);
    } finally {
      await rm(bad, { recursive: true, force: true });
      await rm(forward, { recursive: true, force: true });
    }
  });

  it('disables everything under a test runner, which is why this suite is silent by default', () => {
    expect(isTestRunner({ VITEST: 'true' })).toBe(true);
    expect(isTestRunner({ NODE_ENV: 'test' })).toBe(true);
    expect(isTestRunner({ VITEST: '' })).toBe(false);
    expect(isTestRunner({})).toBe(false);
    expect(resolveEnvOptOut(undefined, { VITEST: 'true' })).toBe('test-runner');
    expect(resolveEnvOptOut(undefined, { NODE_ENV: 'test' })).toBe('test-runner');
    // The test-runner gate outranks an explicit opt-in.
    expect(resolveEnvOptOut(undefined, { PGFENCE_TELEMETRY: '1', VITEST: 'true' })).toBe('test-runner');
  });

  it('resolves the documented precedence chain, first match wins', () => {
    const rows: Array<[Record<string, string>, boolean | undefined, OptOutReason]> = [
      [{ PGFENCE_TELEMETRY: '0', DO_NOT_TRACK: '1' }, undefined, 'env-pgfence'],
      [{ DO_NOT_TRACK: '1', VITEST: 'true' }, undefined, 'env-do-not-track'],
      [{ VITEST: 'true' }, false, 'test-runner'],
      [{ PGFENCE_TELEMETRY: 'yes' }, false, 'none'],
      [{}, false, 'project-config'],
      [{}, true, 'none'],
      [{}, undefined, 'none'],
    ];
    for (const [env, projectSetting, expected] of rows) {
      expect(resolveEnvOptOut(projectSetting, env), JSON.stringify(env)).toBe(expected);
    }
  });

  it('persists a disable through "pgfence telemetry disable" and honors it on later runs', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pgfence-telemetry-disable-'));
    try {
      await seedState(root);
      freezeDelivery(root);

      // Something is queued before the opt-out, and must never be delivered afterwards.
      expect(await buildEventVia(root, 'analyze', undefined, sampleOutcome)).toBeDefined();
      expect(spoolEvents(root)).toHaveLength(1);

      const restore = applyEnv(telemetryEnvPatch(root));
      const stdout = captureStream(process.stdout);
      let code: number;
      try {
        code = runTelemetryCommand('disable');
      } finally {
        stdout.restore();
        restore();
      }
      expect(code).toBe(0);
      expect(stdout.text()).toContain('pgfence telemetry: disabled');
      expect(readStateFile(root).enabled).toBe(false);
      expect(existsSync(spoolDirOf(root))).toBe(false);

      // Two further runs, standing in for later processes reading the same state file.
      expect(await buildEventVia(root, 'analyze', undefined, sampleOutcome)).toBeUndefined();
      expect(await buildEventVia(root, 'trace', undefined, sampleOutcome)).toBeUndefined();
      expect(spoolEvents(root)).toHaveLength(0);

      // And "enable" puts it back.
      const restoreEnable = applyEnv(telemetryEnvPatch(root));
      const stdoutEnable = captureStream(process.stdout);
      let enableCode: number;
      try {
        enableCode = runTelemetryCommand('enable');
      } finally {
        stdoutEnable.restore();
        restoreEnable();
      }
      expect(enableCode).toBe(0);
      expect(stdoutEnable.text()).toContain('pgfence telemetry: enabled');
      expect(readStateFile(root).enabled).toBe(true);

      freezeDelivery(root);
      expect(await buildEventVia(root, 'analyze', undefined, sampleOutcome)).toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports status on stdout without creating anything, and rejects an unknown action', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pgfence-telemetry-status-'));
    try {
      const restore = applyEnv(telemetryEnvPatch(root));
      const stdout = captureStream(process.stdout);
      const stderr = captureStream(process.stderr);
      let statusCode: number;
      let unknownCode: number;
      try {
        statusCode = runTelemetryCommand('status');
        unknownCode = runTelemetryCommand('bogus');
      } finally {
        stdout.restore();
        stderr.restore();
        restore();
      }

      expect(statusCode).toBe(0);
      expect(unknownCode).toBe(2);
      expect(stdout.text()).toContain('pgfence telemetry: enabled');
      expect(stdout.text()).toContain('(not created yet)');
      expect(stdout.text()).toContain('https://pgfence.com/telemetry');
      expect(stderr.text()).toContain('unknown action "bogus"');
      expect(stderr.text()).toContain('status, enable, disable, reset');
      // status never creates the state file and never creates the spool.
      expect(wroteAnything(root)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails honestly and exits 2 when the config directory cannot be written', async () => {
    // Mode bits mean nothing on Windows, and root ignores them everywhere else.
    if (process.platform === 'win32' || process.getuid?.() === 0) return;

    const root = await mkdtemp(path.join(tmpdir(), 'pgfence-telemetry-readonly-'));
    const dir = stateDirOf(root);
    await mkdir(dir, { recursive: true });
    try {
      await chmod(dir, 0o500);

      // The collection path degrades to "no telemetry this run" rather than throwing.
      expect(loadOrCreateState(dir)).toBeNull();

      const restore = applyEnv(telemetryEnvPatch(root));
      const stdout = captureStream(process.stdout);
      const stderr = captureStream(process.stderr);
      let code: number;
      try {
        code = runTelemetryCommand('disable');
      } finally {
        stdout.restore();
        stderr.restore();
        restore();
      }

      // This is the one command that must never report a success it did not achieve: a
      // user told "disabled" on a machine where the choice was not persisted would be
      // collected from again on the very next run.
      expect(code).toBe(2);
      expect(stdout.text()).toBe('');
      expect(stderr.text()).toContain('could not write');
      expect(stderr.text()).toContain('PGFENCE_TELEMETRY=0');
      expect(existsSync(stateFileOf(root))).toBe(false);
    } finally {
      // Restored before the cleanup, which cannot remove a directory it cannot write to.
      await chmod(dir, 0o700).catch(() => { /* already gone, or never created */ });
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('telemetry CI detection', () => {
  it('produces a materially different event in CI than on an interactive run', async () => {
    const receiver = await startReceiver();
    const interactiveRoot = await mkdtemp(path.join(tmpdir(), 'pgfence-telemetry-human-'));
    const ciRoot = await mkdtemp(path.join(tmpdir(), 'pgfence-telemetry-ci-'));
    try {
      // Interactive: a known install id read from disk, queued for a later run, no socket.
      await seedState(interactiveRoot);
      freezeDelivery(interactiveRoot);
      const interactive = await buildEventVia(interactiveRoot, 'analyze', undefined, sampleOutcome, {
        PGFENCE_TELEMETRY_ENDPOINT: receiver.endpoint,
      });
      expect(interactive).toBeDefined();
      if (!interactive) return;
      expect(receiver.envelopes).toHaveLength(0);

      // CI: no state file is read or written, the id is minted for this run, and the
      // event goes out inline because there is no later run to deliver it.
      const restore = applyEnv(telemetryEnvPatch(ciRoot, {
        CI: '1',
        GITHUB_ACTIONS: 'true',
        PGFENCE_TELEMETRY_ENDPOINT: receiver.endpoint,
      }));
      try {
        beginTelemetry('analyze', undefined);
        await finishTelemetry(sampleOutcome);
      } finally {
        restore();
      }
      expect(await receiver.waitFor(1)).toBe(true);

      const ciEvents = receiver.events();
      expect(ciEvents).toHaveLength(1);
      const ciEvent = ciEvents[0];
      expectClosedVocabulary(ciEvent);

      // The three signals the whole feature turns on.
      expect(ciEvent.ci).toBe(true);
      expect(interactive.ci).toBe(false);
      expect(ciEvent.ciProvider).toBe('github');
      expect(interactive.ciProvider).toBe('none');
      expect(ciEvent.freshInstallId).toBe(true);
      expect(interactive.freshInstallId).toBe(false);
      expect(ciEvent.installId).not.toBe(interactive.installId);
      expect(interactive.installId).toBe(SEED_INSTALL_ID);

      // CI leaves nothing behind inside the runner, and never spools.
      expect(wroteAnything(ciRoot)).toBe(false);
      expect(spoolEvents(ciRoot)).toHaveLength(0);
      // The interactive run queued instead of sending.
      expect(spoolEvents(interactiveRoot)).toHaveLength(1);
      expect(receiver.envelopes[0].v).toBe(1);
    } finally {
      await rm(interactiveRoot, { recursive: true, force: true });
      await rm(ciRoot, { recursive: true, force: true });
      await receiver.close();
    }
  }, 30_000);

  it('honors a persisted disable on a self-hosted runner with a stable home', async () => {
    const receiver = await startReceiver();
    const root = await mkdtemp(path.join(tmpdir(), 'pgfence-telemetry-ci-disabled-'));
    try {
      await seedState(root, { enabled: false });
      const restore = applyEnv(telemetryEnvPatch(root, {
        CI: '1',
        GITLAB_CI: 'true',
        PGFENCE_TELEMETRY_ENDPOINT: receiver.endpoint,
      }));
      try {
        beginTelemetry('analyze', undefined);
        await finishTelemetry(sampleOutcome);
      } finally {
        restore();
      }
      expect(receiver.envelopes).toHaveLength(0);
      expect(spoolEvents(root)).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
      await receiver.close();
    }
  });

  it('maps every known CI variable to its closed-vocabulary provider', () => {
    const singles: Array<[string, string]> = [
      ['GITHUB_ACTIONS', 'github'],
      ['GITLAB_CI', 'gitlab'],
      ['CIRCLECI', 'circle'],
      ['TRAVIS', 'travis'],
      ['TF_BUILD', 'azure'],
      ['JENKINS_URL', 'jenkins'],
      ['BUILDKITE', 'buildkite'],
      ['TEAMCITY_VERSION', 'teamcity'],
      ['APPVEYOR', 'appveyor'],
      ['BITBUCKET_BUILD_NUMBER', 'bitbucket'],
      ['DRONE', 'drone'],
      ['VERCEL', 'vercel'],
      ['NETLIFY', 'netlify'],
      ['JB_SPACE_API_URL', 'other'],
      ['HUDSON_URL', 'jenkins'],
      ['CI', 'other'],
    ];
    for (const [variable, provider] of singles) {
      expect(ciProvider({ [variable]: 'true' }), variable).toBe(provider);
      expect(isCI({ [variable]: 'true' }), variable).toBe(true);
      expect(TELEMETRY_CI_PROVIDERS, variable).toContain(provider);
    }

    // Pairs are checked before singles, because BUILD_ID alone means nothing.
    expect(ciProvider({ CODEBUILD_BUILD_ID: 'x', AWS_REGION: 'eu-west-1' })).toBe('codebuild');
    expect(ciProvider({ BUILD_ID: 'x', BUILD_URL: 'https://ci.example/1' })).toBe('jenkins');
    expect(ciProvider({ BUILD_ID: 'x', PROJECT_ID: 'p' })).toBe('other');
    expect(ciProvider({ BUILD_ID: 'x' })).toBe('none');

    // A developer laptop that exports CI=false is not a build server.
    for (const value of ['false', '0', '', ' FALSE ']) {
      expect(ciProvider({ CI: value }), JSON.stringify(value)).toBe('none');
      expect(isCI({ CI: value }), JSON.stringify(value)).toBe(false);
    }
    expect(isCI({})).toBe(false);
    expect(ciProvider({})).toBe('none');
  });
});

describe('telemetry never leaks anything derived from a migration', () => {
  it('carries neither the file name, the table name, the SQL nor any path separator', async () => {
    const project = await mkdtemp(path.join(tmpdir(), 'pgfence-telemetry-leak-'));
    const root = await mkdtemp(path.join(tmpdir(), 'pgfence-telemetry-leak-state-'));
    try {
      const migration = path.join(project, 'zzsecretzz.sql');
      await writeFile(migration, [
        '-- zzsecretzz: distinctive on purpose',
        "SET lock_timeout = '2s';",
        'ALTER TABLE qqsecretqq ADD COLUMN qqsecretcol text;',
        'CREATE INDEX idx_qqsecretqq ON qqsecretqq (qqsecretcol);',
        'DROP TABLE qqsecretqq_old;',
      ].join('\n') + '\n', 'utf8');

      const results = await analyze([migration], defaultConfig);
      const outcome = outcomeFor(results, defaultConfig);

      await seedState(root);
      freezeDelivery(root);
      const event = await buildEventVia(root, 'analyze', undefined, outcome);
      expect(event).toBeDefined();
      if (!event) return;

      expectClosedVocabulary(event);
      // The run really did find things, so this is not passing on an empty payload.
      const findingTotal = ['findSafe', 'findLow', 'findMedium', 'findHigh', 'findCritical', 'policyErrors', 'policyWarnings']
        .reduce((total, key) => total + Number(event[key]), 0);
      expect(findingTotal).toBeGreaterThan(0);
      expect(event.format).toBe('sql');
      expect(event.fileCountBucket).toBe(1);

      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain('zzsecretzz');
      expect(serialized).not.toContain('qqsecretqq');
      expect(serialized).not.toContain('qqsecretcol');
      expect(serialized).not.toContain(project);
      expect(serialized).not.toMatch(/migration|\.sql|\/Users\/|ALTER TABLE|DROP TABLE|CREATE INDEX|add-column|drop-table|lock_timeout/i);

      for (const [key, value] of Object.entries(event)) {
        if (typeof value !== 'string') continue;
        expect(value, `${key} must not carry a path separator`).not.toContain('/');
        expect(value, `${key} must not carry a path separator`).not.toContain('\\');
      }
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('telemetry import boundary', () => {
  it('imports only node: builtins and its own siblings', async () => {
    const files = (await readdir(telemetrySrcDir)).filter((entry) => entry.endsWith('.ts')).sort();
    expect(files).toEqual(['env.ts', 'post.ts', 'session.ts', 'store.ts', 'types.ts']);

    const siblings = new Set(['./types.js', './env.js', './store.js', './post.js']);
    for (const file of files) {
      const source = await readFile(path.join(telemetrySrcDir, file), 'utf8');
      const specifiers = [
        // Matches multi-line imports too, whose `from` sits on its own closing line.
        ...[...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]),
        ...[...source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]),
      ];
      for (const specifier of specifiers) {
        expect(
          specifier.startsWith('node:') || siblings.has(specifier),
          `${file} imports ${specifier}`,
        ).toBe(true);
      }
    }
  });

  it('is never referenced from the LSP server, whose stdout is the JSON-RPC transport', async () => {
    const files = (await readdir(lspSrcDir)).filter((entry) => entry.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = await readFile(path.join(lspSrcDir, file), 'utf8');
      expect(source.toLowerCase(), `src/lsp/${file} must not mention telemetry`).not.toContain('telemetry');
    }
  });
});

describe('telemetry first-run notice', () => {
  it('prints the notice on stderr, never on stdout, and records nothing on that run', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pgfence-telemetry-notice-'));
    try {
      const restoreEnv = applyEnv(telemetryEnvPatch(root, { PGFENCE_TELEMETRY_ENDPOINT: REFUSED_ENDPOINT }));
      const restoreTTY = forceTTY(process.stderr, true);
      const stdout = captureStream(process.stdout);
      const stderr = captureStream(process.stderr);
      try {
        beginTelemetry('analyze', undefined);
      } finally {
        stderr.restore();
        stdout.restore();
        restoreTTY();
        restoreEnv();
      }

      // Exactly one write, five lines, stderr only, verbatim.
      expect(stderr.chunks).toHaveLength(1);
      expect(stderr.text()).toBe(NOTICE);
      expect(stdout.text()).toBe('');

      // The notice run collects nothing, which is what makes that last line true.
      await finishTelemetry(sampleOutcome);
      expect(spoolEvents(root)).toHaveLength(0);
      const state = readStateFile(root);
      expect(typeof state.noticeShownAt).toBe('string');
      expect(state.installId).toMatch(INSTALL_ID_PATTERN);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('prints the notice exactly once per machine, and collects from the next run on', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pgfence-telemetry-notice-once-'));
    try {
      const restoreEnv = applyEnv(telemetryEnvPatch(root));
      const restoreTTY = forceTTY(process.stderr, true);
      const stderr = captureStream(process.stderr);
      try {
        beginTelemetry('analyze', undefined);
        await finishTelemetry(sampleOutcome);
        freezeDelivery(root);
        beginTelemetry('analyze', undefined);
      } finally {
        stderr.restore();
        restoreTTY();
        restoreEnv();
      }
      await finishTelemetry(sampleOutcome);

      expect(stderr.chunks).toHaveLength(1);
      expect(spoolEvents(root)).toHaveLength(1);
      // The id was minted on the notice run, so the run that reports it is not fresh.
      expect(spoolEvents(root)[0].freshInstallId).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('prints nothing when stderr is not a TTY, and that run still records nothing', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pgfence-telemetry-notice-pipe-'));
    try {
      const restoreEnv = applyEnv(telemetryEnvPatch(root));
      const restoreTTY = forceTTY(process.stderr, false);
      const stdout = captureStream(process.stdout);
      const stderr = captureStream(process.stderr);
      try {
        beginTelemetry('analyze', undefined);
      } finally {
        stderr.restore();
        stdout.restore();
        restoreTTY();
        restoreEnv();
      }
      await finishTelemetry(sampleOutcome);

      expect(stderr.text()).toBe('');
      expect(stdout.text()).toBe('');
      expect(spoolEvents(root)).toHaveLength(0);
      // Not shown means not disclosed, so the notice stays due for the next run.
      expect(readStateFile(root).noticeShownAt).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('telemetry delivery and network failure', () => {
  it('delivers a spooled backlog on a later run and drains the spool', async () => {
    const receiver = await startReceiver();
    const root = await mkdtemp(path.join(tmpdir(), 'pgfence-telemetry-drain-'));
    try {
      await seedState(root);
      const restore = applyEnv(telemetryEnvPatch(root, { PGFENCE_TELEMETRY_ENDPOINT: receiver.endpoint }));
      try {
        // Run 1 queues, and opens no socket.
        beginTelemetry('analyze', undefined);
        await finishTelemetry(sampleOutcome);
        expect(spoolEvents(root)).toHaveLength(1);
        expect(receiver.envelopes).toHaveLength(0);

        // Run 2 flushes the backlog at handler entry.
        beginTelemetry('analyze', undefined);
        expect(await receiver.waitFor(1)).toBe(true);
        await finishTelemetry(sampleOutcome);
      } finally {
        restore();
      }

      const delivered = receiver.events();
      expect(delivered).toHaveLength(1);
      expectClosedVocabulary(delivered[0]);
      expect(receiver.envelopes[0].v).toBe(1);

      // The delivered batch is committed, so only run 2's own event is left queued.
      expect(await waitUntil(() => spoolEvents(root).length === 1)).toBe(true);
      const attempt = readAttempt(spoolDirOf(root));
      expect(attempt.fails).toBe(0);
      expect(attempt.nextAt).toBeGreaterThan(Date.now());
    } finally {
      await rm(root, { recursive: true, force: true });
      await receiver.close();
    }
  }, 30_000);

  it('never blocks the caller and never throws when the endpoint is unreachable', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pgfence-telemetry-refused-'));
    try {
      await recordSpooledEvent(root);
      expect(spoolEvents(root)).toHaveLength(1);

      const restore = applyEnv(telemetryEnvPatch(root, { PGFENCE_TELEMETRY_ENDPOINT: REFUSED_ENDPOINT }));
      let elapsed: number;
      try {
        const started = Date.now();
        beginTelemetry('analyze', undefined);
        elapsed = Date.now() - started;
        await finishTelemetry(sampleOutcome);
      } finally {
        restore();
      }

      // The interactive flush is fire and forget: it must not wait for a socket.
      expect(elapsed).toBeLessThan(150);

      // The failure is recorded as backoff, and the undelivered event stays queued.
      expect(await waitUntil(() => readAttempt(spoolDirOf(root)).fails === 1)).toBe(true);
      const attempt = readAttempt(spoolDirOf(root));
      expect(attempt.fails).toBe(1);
      expect(attempt.nextAt).toBeGreaterThanOrEqual(Date.now() + 3_500_000);
      expect(spoolEvents(root).length).toBeGreaterThanOrEqual(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('bounds the send at the connect budget against an address that never answers', async () => {
    const started = Date.now();
    const written = await sendEventsAwaitable([validEvent()], {
      PGFENCE_TELEMETRY_ENDPOINT: BLACKHOLE_ENDPOINT,
    });
    const elapsed = Date.now() - started;

    expect(written).toBe(false);
    expect(CONNECT_BUDGET_MS).toBe(250);
    // The budget is 250ms plus a 50ms safety net. The bound below is deliberately loose
    // so a loaded machine cannot make it flaky, and still tight enough to catch a client
    // that does not bound connect at all, which takes tens of seconds.
    expect(elapsed).toBeLessThan(3000);
  }, 30_000);

  it('refuses a non-loopback http endpoint and a malformed one, rather than guessing', async () => {
    for (const endpoint of ['http://telemetry.example.com/v1/event', 'not a url', 'ftp://127.0.0.1/v1/event']) {
      const written = await sendEventsAwaitable([validEvent()], {
        PGFENCE_TELEMETRY_ENDPOINT: endpoint,
      });
      expect(written, endpoint).toBe(false);
    }
  });

  it('sends nothing in debug mode, and leaves the queued batch undelivered', async () => {
    const receiver = await startReceiver();
    const root = await mkdtemp(path.join(tmpdir(), 'pgfence-telemetry-debug-'));
    try {
      await recordSpooledEvent(root);

      const restore = applyEnv(telemetryEnvPatch(root, {
        PGFENCE_TELEMETRY_ENDPOINT: receiver.endpoint,
        PGFENCE_TELEMETRY_DEBUG: '1',
      }));
      const stderr = captureStream(process.stderr);
      const stdout = captureStream(process.stdout);
      try {
        beginTelemetry('analyze', undefined);
        await waitUntil(() => stderr.text().includes('[pgfence telemetry]'), 2000);
        await finishTelemetry(sampleOutcome);
      } finally {
        stdout.restore();
        stderr.restore();
        restore();
      }

      expect(receiver.envelopes).toHaveLength(0);
      expect(stderr.text()).toContain('[pgfence telemetry] POST');
      expect(stdout.text()).not.toContain('[pgfence telemetry]');
      // Debug mode is a verification aid, not an opt-out: the batch is still queued and
      // the failure counter never moved.
      expect(spoolEvents(root).length).toBeGreaterThanOrEqual(2);
      expect(readAttempt(spoolDirOf(root)).fails).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
      await receiver.close();
    }
  }, 30_000);
});

describe('telemetry end to end through the CLI', () => {
  it('keeps --output json parseable on a first run and on a collecting run', async () => {
    const receiver = await startReceiver();
    const root = await mkdtemp(path.join(tmpdir(), 'pgfence-telemetry-cli-json-'));
    const cwd = await mkdtemp(path.join(tmpdir(), 'pgfence-telemetry-cli-cwd-'));
    try {
      const fixture = path.join(fixturesDir, 'safe-migration.sql');
      const env = childEnv(root, { PGFENCE_TELEMETRY_ENDPOINT: receiver.endpoint });

      // Run 1: nothing on this machine yet. stdout must still be pure JSON.
      const first = await execPromise(cliCommand(`analyze --output json "${fixture}"`), { env, cwd });
      const parsedFirst = JSON.parse(first.stdout) as { version: string; results: unknown[] };
      expect(parsedFirst.version).toBe('1.1');
      expect(first.stderr).toBe('');

      // The first run is the notice run, so it records nothing. Mark the notice as shown
      // the way a terminal run would, and the next run collects.
      const state = JSON.parse(await readFile(stateFileOf(root), 'utf8')) as Record<string, unknown>;
      expect(state.installId).toMatch(INSTALL_ID_PATTERN);
      expect(spoolEvents(root)).toHaveLength(0);
      await writeFile(stateFileOf(root), JSON.stringify({ ...state, noticeShownAt: new Date().toISOString() }), 'utf8');

      // Run 2: telemetry fully active. stdout must still be pure JSON.
      const second = await execPromise(cliCommand(`analyze --output json "${fixture}"`), { env, cwd });
      const parsedSecond = JSON.parse(second.stdout) as { version: string };
      expect(parsedSecond.version).toBe('1.1');
      expect(second.stderr).toBe('');
      expect(spoolEvents(root)).toHaveLength(1);

      // Run 3: delivers the backlog. stdout is still JSON, and the wire payload carries
      // exactly the documented keys and nothing that came out of the migration.
      const third = await execPromise(cliCommand(`analyze --output json "${fixture}"`), { env, cwd });
      expect(() => JSON.parse(third.stdout)).not.toThrow();
      expect(third.stderr).toBe('');

      expect(await receiver.waitFor(1)).toBe(true);
      const delivered = receiver.events();
      expect(delivered.length).toBeGreaterThanOrEqual(1);
      expectClosedVocabulary(delivered[0]);
      expect(delivered[0].command).toBe('analyze');
      expect(delivered[0].ci).toBe(false);
      expect(delivered[0].format).toBe('sql');
      const wire = JSON.stringify(receiver.envelopes);
      expect(wire).not.toContain('safe-migration');
      expect(wire).not.toContain('appointments');
      expect(wire).not.toMatch(/\.sql|\/Users\/|ALTER TABLE|lock_timeout/i);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
      await receiver.close();
    }
  }, 90_000);

  it('puts the first-run notice on stderr while stdout stays parseable JSON', async () => {
    const receiver = await startReceiver();
    const root = await mkdtemp(path.join(tmpdir(), 'pgfence-telemetry-cli-notice-'));
    const cwd = await mkdtemp(path.join(tmpdir(), 'pgfence-telemetry-cli-notice-cwd-'));
    try {
      const wrapper = path.join(cwd, `force-tty${WRAPPER_EXT}`);
      await writeFile(wrapper, FORCE_TTY_WRAPPER, 'utf8');
      const fixture = path.join(fixturesDir, 'safe-migration.sql');
      const env = childEnv(root, {
        PGFENCE_TELEMETRY_ENDPOINT: receiver.endpoint,
        PGFENCE_TEST_ENTRY: cliEntry,
      });

      const { stdout, stderr } = await execPromise(
        `${runnerPrefix()} "${wrapper}" analyze --output json "${fixture}"`,
        { env, cwd },
      );

      // This is the regression that would silently break every CI consumer: one stray
      // byte of notice on stdout and every --output json pipeline fails to parse.
      const parsed = JSON.parse(stdout) as { version: string };
      expect(parsed.version).toBe('1.1');
      expect(stdout).not.toContain('pgfence collects');

      expect(stderr).toBe(NOTICE);
      // The notice run collects nothing, which is what makes its last line true.
      expect(spoolEvents(root)).toHaveLength(0);
      expect(receiver.envelopes).toHaveLength(0);
      expect(typeof readStateFile(root).noticeShownAt).toBe('string');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
      await receiver.close();
    }
  }, 90_000);

  it('changes neither exit code nor output when the endpoint is unreachable', async () => {
    const safeRoot = await mkdtemp(path.join(tmpdir(), 'pgfence-telemetry-exit0-'));
    const ciRoot = await mkdtemp(path.join(tmpdir(), 'pgfence-telemetry-exit1-'));
    const errRoot = await mkdtemp(path.join(tmpdir(), 'pgfence-telemetry-exit2-'));
    const project = await mkdtemp(path.join(tmpdir(), 'pgfence-telemetry-badconfig-'));
    const cwd = await mkdtemp(path.join(tmpdir(), 'pgfence-telemetry-exit-cwd-'));
    try {
      // Each root starts with a queued event, so each run really does attempt a send.
      await recordSpooledEvent(safeRoot);
      await recordSpooledEvent(ciRoot);
      await recordSpooledEvent(errRoot);

      // Exit 0 on a safe fixture, with the documented stdout and an empty stderr.
      const safe = await execPromise(cliCommand(`analyze "${path.join(fixturesDir, 'safe-migration.sql')}"`), {
        env: childEnv(safeRoot, { PGFENCE_TELEMETRY_ENDPOINT: BLACKHOLE_ENDPOINT }),
        cwd,
      });
      expect(safe.stdout).toContain('=== Coverage ===');
      expect(safe.stdout).toMatch(/Coverage: \d+%/);
      expect(safe.stderr).toBe('');

      // Exit 1 when --ci and --max-risk are exceeded.
      await expect(
        execPromise(cliCommand(`analyze --ci --max-risk medium "${path.join(fixturesDir, 'dangerous-add-column.sql')}"`), {
          env: childEnv(ciRoot, { PGFENCE_TELEMETRY_ENDPOINT: BLACKHOLE_ENDPOINT }),
          cwd,
        }),
      ).rejects.toMatchObject({ code: 1 });

      // Exit 2 on a broken project config, with the same sanitized message as ever.
      await writeFile(path.join(project, '.pgfence.toml'), 'output = [\n', 'utf8');
      await writeFile(path.join(project, 'migration.sql'), 'SELECT 1;\n', 'utf8');
      try {
        await execPromise(cliCommand('analyze migration.sql'), {
          env: childEnv(errRoot, { PGFENCE_TELEMETRY_ENDPOINT: BLACKHOLE_ENDPOINT }),
          cwd: project,
        });
        throw new Error('expected analyze to fail');
      } catch (err: unknown) {
        const error = err as { code?: number; stderr?: string; stdout?: string };
        expect(error.code).toBe(2);
        expect(error.stderr).toContain('pgfence error:');
        expect(error.stdout).toBe('');
      }
    } finally {
      for (const dir of [safeRoot, ciRoot, errRoot, project, cwd]) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  }, 90_000);

  it('adds no perceptible wall clock even when the endpoint never answers', async () => {
    const baselineRoot = await mkdtemp(path.join(tmpdir(), 'pgfence-telemetry-baseline-'));
    const telemetryRoot = await mkdtemp(path.join(tmpdir(), 'pgfence-telemetry-timing-'));
    const cwd = await mkdtemp(path.join(tmpdir(), 'pgfence-telemetry-timing-cwd-'));
    try {
      const fixture = path.join(fixturesDir, 'safe-migration.sql');
      await recordSpooledEvent(telemetryRoot);

      const baselineStart = Date.now();
      const baseline = await execPromise(cliCommand(`analyze "${fixture}"`), {
        env: childEnv(baselineRoot, { PGFENCE_TELEMETRY: '0' }),
        cwd,
      });
      const baselineMs = Date.now() - baselineStart;

      const telemetryStart = Date.now();
      const withTelemetry = await execPromise(cliCommand(`analyze "${fixture}"`), {
        env: childEnv(telemetryRoot, { PGFENCE_TELEMETRY_ENDPOINT: BLACKHOLE_ENDPOINT }),
        cwd,
      });
      const telemetryMs = Date.now() - telemetryStart;

      expect(withTelemetry.stdout).toBe(baseline.stdout);
      expect(withTelemetry.stderr).toBe('');
      // The connect budget is 250ms and it is paid at most once per cooldown window. The
      // margin below absorbs process-start noise on a loaded machine while still catching
      // a regression that waits on the socket instead of firing and forgetting.
      expect(telemetryMs).toBeLessThan(baselineMs + 2500);
      // The opted-out run must not have left a single byte behind.
      expect(wroteAnything(baselineRoot)).toBe(false);
    } finally {
      for (const dir of [baselineRoot, telemetryRoot, cwd]) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  }, 90_000);

  it('writes and sends nothing when the project config opts out', async () => {
    const receiver = await startReceiver();
    const root = await mkdtemp(path.join(tmpdir(), 'pgfence-telemetry-cli-toml-'));
    const project = await mkdtemp(path.join(tmpdir(), 'pgfence-telemetry-cli-project-'));
    try {
      await writeFile(path.join(project, '.pgfence.toml'), 'telemetry = false\n', 'utf8');
      await writeFile(path.join(project, 'migration.sql'), "SET lock_timeout = '2s';\nSELECT 1;\n", 'utf8');

      const { stdout } = await execPromise(cliCommand('analyze migration.sql'), {
        env: childEnv(root, { PGFENCE_TELEMETRY_ENDPOINT: receiver.endpoint }),
        cwd: project,
      });
      expect(stdout).toContain('=== Coverage ===');
      expect(wroteAnything(root)).toBe(false);
      expect(receiver.envelopes).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
      await receiver.close();
    }
  }, 90_000);

  it('persists "pgfence telemetry disable" across processes', async () => {
    const receiver = await startReceiver();
    const root = await mkdtemp(path.join(tmpdir(), 'pgfence-telemetry-cli-disable-'));
    const cwd = await mkdtemp(path.join(tmpdir(), 'pgfence-telemetry-cli-disable-cwd-'));
    try {
      const env = childEnv(root, { PGFENCE_TELEMETRY_ENDPOINT: receiver.endpoint });

      const status = await execPromise(cliCommand('telemetry status'), { env, cwd });
      expect(status.stdout).toContain('pgfence telemetry:');
      expect(status.stderr).toBe('');
      expect(wroteAnything(root)).toBe(false);

      const disabled = await execPromise(cliCommand('telemetry disable'), { env, cwd });
      expect(disabled.stdout).toContain('pgfence telemetry: disabled');
      expect(readStateFile(root).enabled).toBe(false);

      const { stdout } = await execPromise(
        cliCommand(`analyze "${path.join(fixturesDir, 'safe-migration.sql')}"`),
        { env, cwd },
      );
      expect(stdout).toContain('=== Coverage ===');
      expect(spoolEvents(root)).toHaveLength(0);
      expect(existsSync(spoolDirOf(root))).toBe(false);
      expect(receiver.envelopes).toHaveLength(0);

      await expect(execPromise(cliCommand('telemetry bogus'), { env, cwd })).rejects.toMatchObject({ code: 2 });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
      await receiver.close();
    }
  }, 90_000);
});
