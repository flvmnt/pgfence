/**
 * Telemetry orchestration: the two calls src/index.ts makes around a command, plus the
 * `pgfence telemetry` subcommand.
 *
 * This is the only telemetry module the CLI imports, and it imports only node: builtins
 * and its three siblings. post.ts is loaded dynamically, and only on a run that is
 * actually going to send, so node:https never enters the hot path.
 *
 * Four invariants hold for everything below:
 *   1. Telemetry never changes an exit code.
 *   2. Telemetry never writes to stdout, except from the `pgfence telemetry` subcommand,
 *      whose whole purpose is to report to the user.
 *   3. No exported function throws, including when the bug is ours.
 *   4. At most CONNECT_BUDGET_MS of wall clock is added to a run, at most once per
 *      cooldown window.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import {
  ciProvider,
  isCI,
  isTelemetryDebug,
  isTelemetryForcedOn,
  resolveEnvOptOut,
  spoolDir,
  stateFilePath,
  telemetryStateDir,
} from './env.js';
import type { OptOutReason } from './env.js';
import {
  MAX_SPOOL_EVENTS,
  clearSpool,
  commitBatch,
  countSpool,
  deleteState,
  lastStoreError,
  loadOrCreateState,
  newInstallId,
  persistState,
  pruneSpool,
  readAttempt,
  readBatch,
  readState,
  spoolAppend,
  writeAttempt,
} from './store.js';
import {
  TELEMETRY_ENDPOINT,
  fileCountBucket,
  parseTelemetryEvent,
  toTelemetryOs,
  toTelemetryVersion,
} from './types.js';
import type {
  TelemetryCiProvider,
  TelemetryCommand,
  TelemetryEvent,
  TelemetryFormat,
  TelemetryRulesMode,
} from './types.js';

/** At most one interactive network attempt per window, however many runs happen in it. */
const SUCCESS_COOLDOWN_MS = 5 * 60_000;

/** Indexed by min(fails, 3) - 1: one hour, six hours, then a day, forever. */
const BACKOFF_MS = [3_600_000, 21_600_000, 86_400_000];

const MAX_PLUGIN_COUNT = 99;
const MAX_FINDING_COUNT = 9999;
const MAX_DURATION_MS = 600_000;
const DURATION_ROUNDING_MS = 10;
const MAX_NODE_MAJOR = 999;

/**
 * The first-run notice, printed once per machine, on stderr, on a TTY only.
 *
 * stderr because stdout carries --output json, sarif, gitlab and github, all of which
 * are piped into parsers, and because in `pgfence lsp` stdout is the JSON-RPC transport
 * where one stray byte corrupts a protocol frame. A notice on stdout would break a CI
 * parser invisibly, since it prints exactly once per machine.
 */
const NOTICE = [
  'pgfence collects anonymous usage counts so we can tell how many people use it.',
  'Sent: a random install id, the command, pgfence/Node/OS versions, CI or not, how long the run took, and counts of findings by severity.',
  'Never sent: SQL, file names or paths, table, column or rule names, or anything read from a database.',
  'Opt out: PGFENCE_TELEMETRY=0, DO_NOT_TRACK=1, "pgfence telemetry disable", or telemetry = false in .pgfence.toml',
  'Nothing was sent during this run. Full list: https://pgfence.com/telemetry',
].join('\n');

const DETAILS_URL = 'https://pgfence.com/telemetry';

const DISABLED_REASONS: Record<Exclude<OptOutReason, 'none'>, string> = {
  'env-pgfence': 'PGFENCE_TELEMETRY is set to an off value',
  'env-do-not-track': 'DO_NOT_TRACK is set',
  'test-runner': 'test runner detected (NODE_ENV=test or VITEST)',
  'project-config': "telemetry = false in this project's .pgfence.toml or .pgfence.json",
  'user-choice': 'pgfence telemetry disable',
  'no-state-dir': 'no writable config directory on this machine',
};

export interface TelemetryOutcome {
  errored: boolean;
  format?: TelemetryFormat;
  rulesMode?: TelemetryRulesMode;
  pluginCount?: number;
  fileCount?: number;
  findings?: {
    safe: number;
    low: number;
    medium: number;
    high: number;
    critical: number;
    policyErrors: number;
    policyWarnings: number;
  };
}

interface Session {
  command: TelemetryCommand;
  /** performance.now() at handler entry. */
  startedAt: number;
  /** Spool directory, or null in CI, which never writes to disk. */
  spool: string | null;
  installId: string;
  freshInstallId: boolean;
  ci: boolean;
  ciProvider: TelemetryCiProvider;
}

/**
 * The live session, or null when telemetry is off for this run. Holding it in module
 * scope is what lets finishTelemetry be a one-line call from a catch block, and what
 * makes a second call a no-op instead of a duplicate event.
 */
let session: Session | null = null;

let cachedVersion: string | null = null;

/**
 * pgfence's own version, validated like any other untrusted string.
 *
 * Read from package.json rather than imported from the CLI, because src/telemetry may
 * not import anything outside itself. dist/telemetry/session.js and
 * src/telemetry/session.ts both sit two levels below the package root, so one path
 * works for the published build and for `tsx src/index.ts` alike.
 */
function pgfenceVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  cachedVersion = 'unknown';
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const parsed: unknown = JSON.parse(readFileSync(path.resolve(here, '../../package.json'), 'utf8'));
    if (typeof parsed === 'object' && parsed !== null) {
      const version = (parsed as { version?: unknown }).version;
      if (typeof version === 'string') cachedVersion = toTelemetryVersion(version);
    }
  } catch {
    // A pruned, repackaged or partially installed tree still has to analyze migrations.
    // 'unknown' is a documented value in the payload vocabulary, not an error.
  }
  return cachedVersion;
}

function nodeMajor(): number {
  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
  return Number.isInteger(major) && major >= 0 && major <= MAX_NODE_MAJOR ? major : 0;
}

function capped(value: number | undefined, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.trunc(value), 0), max);
}

/**
 * Deliver the backlog left by earlier runs.
 *
 * Fired at handler entry rather than at the end of the run, which is load bearing: a
 * send fired at the end has been measured to deliver zero out of ten times while still
 * adding wall clock, because a pending connect pins the loop while the process exits
 * before the handshake completes.
 */
function flushBacklog(dir: string, env: NodeJS.ProcessEnv): void {
  const attempt = readAttempt(dir);
  if (Date.now() < attempt.nextAt) return;

  // Before the batch is read, not only at the end of a run. A queue that went stale while
  // the machine sat idle would otherwise be read and sent by the next run before anything
  // pruned it, which is not what "anything older than 7 days is deleted unsent" promises.
  pruneSpool(dir);

  const batch = readBatch(dir, MAX_SPOOL_EVENTS);
  if (batch.length === 0) return;

  // Written BEFORE firing, so a run killed mid-flight can never produce a connect loop.
  // Skipped in debug mode, which sends nothing: advancing the cooldown there would make an
  // immediate second PGFENCE_TELEMETRY_DEBUG=1 run print nothing, and the docs promise
  // that verifying leaves the retry state alone.
  if (!isTelemetryDebug(env)) {
    writeAttempt(dir, { nextAt: Date.now() + SUCCESS_COOLDOWN_MS, fails: attempt.fails });
  }

  // Deliberately not awaited: builtin module resolution settles in a microtask, and
  // microtasks always drain before the event loop can exit, so the request is still
  // reliably issued on a short run.
  void import('./post.js')
    .then(({ sendEvents }) => {
      sendEvents(
        batch.map((item) => item.event),
        {
          onWritten: () => {
            commitBatch(batch);
            writeAttempt(dir, { nextAt: Date.now() + SUCCESS_COOLDOWN_MS, fails: 0 });
          },
          onFailed: () => {
            const fails = attempt.fails + 1;
            writeAttempt(dir, {
              nextAt: Date.now() + BACKOFF_MS[Math.min(fails, BACKOFF_MS.length) - 1],
              fails,
            });
          },
        },
        env,
      );
    })
    .catch(() => {
      // A patched runtime or a restricted loader leaves the batch spooled for a later
      // run. This catch is not optional: an unhandled rejection can change the exit code.
    });
}

/**
 * Call once, at handler entry, right after the project config is available.
 *
 * Starts the timer, resolves every gate, prints the first-run notice when it is due,
 * and, on an interactive run past its cooldown, fires the backlog from previous runs.
 */
export function beginTelemetry(command: TelemetryCommand, projectSetting: boolean | undefined): void {
  session = null;
  try {
    const startedAt = performance.now();
    const env = process.env;

    if (resolveEnvOptOut(projectSetting, env) !== 'none') return;

    const stateDir = telemetryStateDir(env);
    const forcedOn = isTelemetryForcedOn(env);

    if (isCI(env)) {
      // CI never writes. Two effects, both deliberate: pgfence leaves no file behind
      // inside a customer's runner, and an ephemeral container mints a fresh id every
      // run, which is exactly the signal that separates machinery from humans. A
      // self-hosted runner with a persistent home reads a stable id and reports
      // freshInstallId: false, which usefully distinguishes the two.
      const loaded = stateDir === null ? null : readState(stateDir);
      // A persisted opt-out in a baked image or on a self-hosted runner is still honored,
      // because the read happens before the send.
      if (loaded?.state.enabled === false && !forcedOn) return;

      const installId = loaded?.state.installId ?? newInstallId();
      if (installId === null) return;

      session = {
        command,
        startedAt,
        spool: null,
        installId,
        freshInstallId: loaded === null,
        ci: true,
        ciProvider: ciProvider(env),
      };
      return;
    }

    if (stateDir === null) return;

    const loaded = loadOrCreateState(stateDir);
    if (loaded === null) return;
    if (loaded.state.enabled === false && !forcedOn) return;

    if (loaded.state.noticeShownAt === undefined) {
      // The notice run collects nothing: no event is built, no spool file is written and
      // no request is made. That is what makes the last line of the notice literally
      // true, and it is the difference between disclosing before collecting and
      // disclosing after.
      if (process.stderr.isTTY === true) {
        process.stderr.write(NOTICE + '\n');
        // A failed write means the notice prints again next run. That is the correct
        // failure direction: a repeated notice, never silent collection.
        persistState(stateDir, { ...loaded.state, noticeShownAt: new Date().toISOString() });
      }
      // Not shown (piped stderr, a git hook, a CI log) means not disclosed, so the notice
      // stays due and this run still records nothing.
      return;
    }

    const spool = spoolDir(stateDir);
    session = {
      command,
      startedAt,
      spool,
      installId: loaded.state.installId,
      freshInstallId: loaded.created,
      ci: false,
      ciProvider: 'none',
    };

    flushBacklog(spool, env);
  } catch {
    // Telemetry is never allowed to fail a run, including when the bug is ours. Leaving
    // the session null makes finishTelemetry a no-op for the rest of this process.
    session = null;
  }
}

function buildEvent(active: Session, outcome: TelemetryOutcome): TelemetryEvent | null {
  const findings = outcome.findings;
  const elapsed = Math.max(0, performance.now() - active.startedAt);

  const candidate = {
    v: 1,
    eventId: randomUUID(),
    installId: active.installId,
    freshInstallId: active.freshInstallId,
    command: active.command,
    version: pgfenceVersion(),
    nodeMajor: nodeMajor(),
    os: toTelemetryOs(process.platform),
    ci: active.ci,
    ciProvider: active.ciProvider,
    tty: process.stdout.isTTY === true,
    format: outcome.format ?? 'none',
    rulesMode: outcome.rulesMode ?? 'default',
    pluginCount: capped(outcome.pluginCount, MAX_PLUGIN_COUNT),
    fileCountBucket: fileCountBucket(outcome.fileCount ?? 0),
    findSafe: capped(findings?.safe, MAX_FINDING_COUNT),
    findLow: capped(findings?.low, MAX_FINDING_COUNT),
    findMedium: capped(findings?.medium, MAX_FINDING_COUNT),
    findHigh: capped(findings?.high, MAX_FINDING_COUNT),
    findCritical: capped(findings?.critical, MAX_FINDING_COUNT),
    policyErrors: capped(findings?.policyErrors, MAX_FINDING_COUNT),
    policyWarnings: capped(findings?.policyWarnings, MAX_FINDING_COUNT),
    errored: outcome.errored,
    durationMs: Math.min(
      Math.round(elapsed / DURATION_ROUNDING_MS) * DURATION_ROUNDING_MS,
      MAX_DURATION_MS,
    ),
    ts: Date.now(),
  };

  // Validate our own construction, not just what comes back off disk. The spool must
  // only ever hold records that are already legal on the wire, so that a bug here is
  // caught at the source instead of being discovered by the receiver.
  return parseTelemetryEvent(candidate);
}

/**
 * Call once, when analysis results are final and before any reporter output.
 *
 * Interactive runs write one small file and open no socket; delivery happens on a later
 * run. CI runs send inline, bounded by the connect budget, because there is no later run
 * to deliver from. No-op when beginTelemetry never ran or when the gates disabled
 * telemetry, and no-op on a second call, which is what lets a catch block call it
 * unconditionally.
 */
export async function finishTelemetry(outcome: TelemetryOutcome): Promise<void> {
  const active = session;
  session = null;
  if (active === null) return;

  try {
    const event = buildEvent(active, outcome);
    if (event === null) return;

    if (active.ci) {
      // A failed CI send loses the event, which is correct: CI numbers are a run count,
      // not a headcount, and losing a fraction of them changes no conclusion.
      const { sendEventsAwaitable } = await import('./post.js');
      await sendEventsAwaitable([event], process.env);
      return;
    }

    if (active.spool === null) return;
    spoolAppend(active.spool, event);
    pruneSpool(active.spool);

    if (isTelemetryDebug(process.env)) {
      // The interactive path opens no socket for the event it just built, so without this
      // the one command the docs give a skeptical reviewer prints only a backlog from
      // earlier runs, which on a fresh machine is empty. Debug mode is a verification aid
      // and not an opt-out, so the event is still recorded above exactly as it would be;
      // this only prints it.
      const { debugDumpEvents } = await import('./post.js');
      debugDumpEvents([event], process.env);
    }
  } catch {
    // Same contract as beginTelemetry: a bug here, a restricted module loader or a full
    // disk must never change what the command printed or the code it exited with.
  }
}

function row(label: string, value: string): string {
  return `  ${`${label}:`.padEnd(14)}${value}`;
}

function stateWriteError(target: string | null): number {
  const detail = lastStoreError() ?? 'no writable config directory on this machine';
  process.stderr.write(
    `pgfence telemetry error: could not write ${target ?? '(no config directory)'}: ${detail}\n`,
  );
  process.stderr.write(
    'Set PGFENCE_TELEMETRY=0 in your environment to disable telemetry without a state file.\n',
  );
  return 2;
}

/**
 * `pgfence telemetry status`.
 *
 * Reports every layer of the precedence chain, including the project config, which the
 * caller resolves and passes in because this module may not import the config loader.
 * Always exits 0, including when there is no state directory: reporting "disabled" is a
 * successful answer. Never creates the state file and never creates the spool.
 */
function telemetryStatus(projectSetting: boolean | undefined): number {
  const env = process.env;
  const stateDir = telemetryStateDir(env);
  const ci = isCI(env);
  let reason: OptOutReason = resolveEnvOptOut(projectSetting, env);
  let installId: string | null = null;

  if (reason === 'none') {
    if (stateDir === null) {
      // Interactive runs only, exactly as beginTelemetry applies it. A CI run with no
      // writable home still mints an ephemeral id and sends inline, so reporting
      // "disabled" here would be wrong on precisely the machines where a pipeline owner
      // runs this command to check.
      if (!ci) reason = 'no-state-dir';
    } else {
      const loaded = readState(stateDir);
      if (loaded !== null) {
        installId = loaded.state.installId;
        if (loaded.state.enabled === false && !isTelemetryForcedOn(env)) reason = 'user-choice';
      }
    }
  } else if (stateDir !== null) {
    const loaded = readState(stateDir);
    if (loaded !== null) installId = loaded.state.installId;
  }

  const queued = stateDir === null ? 0 : countSpool(spoolDir(stateDir));
  const lines: string[] = [`pgfence telemetry: ${reason === 'none' ? 'enabled' : 'disabled'}`];
  if (reason !== 'none') lines.push(row('reason', DISABLED_REASONS[reason]));
  if (reason === 'none' && ci) {
    lines.push(row('ci run', 'sent inline at the end of the run, nothing is written to disk'));
  }
  lines.push(row('install id', installId ?? '(not created yet)'));
  lines.push(row('state file', stateDir === null ? '(unavailable)' : stateFilePath(stateDir)));
  lines.push(row('queued', `${queued} events waiting to send`));
  lines.push(row('endpoint', env.PGFENCE_TELEMETRY_ENDPOINT ?? TELEMETRY_ENDPOINT));
  lines.push(row('details', DETAILS_URL));

  process.stdout.write(lines.join('\n') + '\n\n');
  return 0;
}

function telemetrySetEnabled(enabled: boolean): number {
  const env = process.env;
  const stateDir = telemetryStateDir(env);
  if (stateDir === null) return stateWriteError(null);

  // The env layer, resolved before anything is written. The project layer is deliberately
  // not consulted here: a repo cannot be allowed to decide what gets persisted for a
  // machine, and it already suppresses collection on its own.
  const envReason = resolveEnvOptOut(undefined, env);

  if (!enabled && envReason !== 'none' && readState(stateDir) === null) {
    // Nothing to record a choice into, and minting an id to record it in would create a
    // persistent identifier as a side effect of opting out, which is the one thing the
    // person running this command is trying to avoid. Anything already queued is still
    // removed, and a missing spool is never created.
    clearSpool(spoolDir(stateDir));
    process.stdout.write(
      `pgfence telemetry: already disabled (${DISABLED_REASONS[envReason]}). ` +
      'Nothing further will be sent from this machine, and no install id was created.\n',
    );
    return 0;
  }

  const loaded = loadOrCreateState(stateDir);
  if (loaded === null) return stateWriteError(stateFilePath(stateDir));
  if (!persistState(stateDir, { ...loaded.state, enabled })) {
    return stateWriteError(stateFilePath(stateDir));
  }

  if (!enabled) {
    // Anything recorded before the opt-out is never delivered.
    clearSpool(spoolDir(stateDir));
  }

  process.stdout.write(
    enabled
      ? 'pgfence telemetry: enabled. Run "pgfence telemetry status" to see what is sent.\n'
      : 'pgfence telemetry: disabled. Nothing further will be sent from this machine.\n',
  );
  if (enabled && envReason !== 'none') {
    // Otherwise this command and `pgfence telemetry status` would contradict each other in
    // the same shell: the choice is persisted, and the environment still outranks it.
    process.stdout.write(
      row('note', `${DISABLED_REASONS[envReason]}, which still overrides this setting.`) + '\n',
    );
  }
  return 0;
}

function telemetryReset(): number {
  const stateDir = telemetryStateDir(process.env);
  if (stateDir === null) return stateWriteError(null);

  const deleted = deleteState(stateDir);
  // clearSpool reports whether the directory is actually gone. Counting what is left
  // cannot: countSpool reads back 0 both for an empty spool and for one that could not be
  // read at all, so a reset that failed to remove anything would still have printed
  // success while the queued events sat on disk.
  const cleared = clearSpool(spoolDir(stateDir));
  if (!deleted || !cleared) return stateWriteError(stateFilePath(stateDir));

  process.stdout.write('pgfence telemetry: reset. The install id and any queued events were deleted.\n');
  return 0;
}

/**
 * `pgfence telemetry <status|enable|disable|reset>`. Returns the exit code.
 *
 * `projectSetting` is the repository's `telemetry` key, resolved by the caller because
 * this module may not import the config loader. Without it `status` could not report the
 * project-config reason at all.
 *
 * This command never emits a telemetry event and never prints the first-run notice: it
 * prints its own, fuller output instead.
 */
export function runTelemetryCommand(action: string, projectSetting?: boolean): number {
  try {
    switch (action) {
      case '':
      case 'status':
        return telemetryStatus(projectSetting);
      case 'enable':
        return telemetrySetEnabled(true);
      case 'disable':
        return telemetrySetEnabled(false);
      case 'reset':
        return telemetryReset();
      default:
        process.stderr.write(
          `pgfence telemetry: unknown action "${action}". Valid actions: status, enable, disable, reset.\n`,
        );
        return 2;
    }
  } catch (err) {
    // Reported rather than swallowed: unlike the collection path, this command exists to
    // tell the user what the state of telemetry on their machine is, so failing silently
    // would be the one genuinely wrong answer.
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`pgfence telemetry error: ${message}\n`);
    return 2;
  }
}
