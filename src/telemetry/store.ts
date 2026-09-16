/**
 * On-disk telemetry state: the per-machine install id, and the spool of events waiting
 * to be delivered by a later run.
 *
 * Every function here degrades to "do nothing" instead of throwing. A read-only config
 * directory, a full disk, a hand-edited state file, a hardened runtime with no CSPRNG
 * and two pgfence processes racing each other are all normal conditions, and none of
 * them is ever a reason to fail the command the user actually asked for. Every catch
 * below says why swallowing is the correct answer there.
 */

import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { stateFilePath } from './env.js';
import { parseTelemetryEvent } from './types.js';
import type { TelemetryEvent } from './types.js';

export interface TelemetryState {
  schemaVersion: 1;
  /** 32 lowercase hex. */
  installId: string;
  /** Set only by `pgfence telemetry enable|disable`. Absent means "no explicit choice",
   *  which is not the same as true and must not be collapsed into it. */
  enabled?: boolean;
  /** ISO 8601, set only when the first-run notice was actually displayed. */
  noticeShownAt?: string;
}

export interface LoadedState {
  state: TelemetryState;
  created: boolean;
}

export interface SpooledItem {
  file: string;
  event: TelemetryEvent;
}

export interface AttemptState {
  nextAt: number;
  fails: number;
}

export const MAX_SPOOL_EVENTS = 32;
export const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Temp files older than this were left behind by a killed run, not by a live one. */
const STALE_TMP_MS = 60_000;

/** Width of the millisecond timestamp prefix, so that lexicographic order is
 *  chronological order for the whole spool. */
const TS_WIDTH = 13;

const ATTEMPT_FILE = '.attempt';
const INSTALL_ID_PATTERN = /^[0-9a-f]{32}$/;

let lastError: string | null = null;

/**
 * Message from the most recent state or spool write failure.
 *
 * Only `pgfence telemetry` reads this, because it is the one surface that is allowed to
 * tell the user that a write failed. Every other caller swallows failures by design.
 */
export function lastStoreError(): string | null {
  return lastError;
}

function recordError(err: unknown): void {
  lastError = err instanceof Error ? err.message : String(err);
}

/**
 * Publish a small file by writing a sibling temp file and renaming over the target.
 * A concurrent pgfence process can therefore never observe a half-written file, and a
 * killed run leaves at most an inert temp file behind.
 */
function writeFileAtomic(target: string, contents: string): boolean {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target).replace(/^\./, '')}.${process.pid}.tmp`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(tmp, contents, { mode: 0o600 });
    renameSync(tmp, target);
    return true;
  } catch (err) {
    recordError(err);
    try {
      unlinkSync(tmp);
    } catch {
      // The temp file may never have been created, which is the common case here.
    }
    // An unwritable, read-only, full or quota-exhausted config directory disables
    // telemetry for this run. It is never a reason to fail the user's command.
    return false;
  }
}

/** 32 lowercase hex, or null when the runtime has no CSPRNG. */
export function newInstallId(): string | null {
  try {
    return randomBytes(16).toString('hex');
  } catch (err) {
    recordError(err);
    // A hardened runtime with no CSPRNG cannot produce an id that is safe to count, and
    // a predictable one would be worse than none. Telemetry disables itself.
    return null;
  }
}

/**
 * Re-project a parsed state file onto the fields this version understands.
 *
 * schemaVersion is read leniently (any number >= 1) so that a state file written by a
 * newer pgfence, including an explicit `enabled: false`, is never discarded by an older
 * one. Writes always emit schemaVersion 1.
 */
function parseState(raw: string): TelemetryState | null {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.schemaVersion !== 'number' || record.schemaVersion < 1) return null;
  if (typeof record.installId !== 'string' || !INSTALL_ID_PATTERN.test(record.installId)) return null;

  const state: TelemetryState = { schemaVersion: 1, installId: record.installId };
  if (typeof record.enabled === 'boolean') state.enabled = record.enabled;
  if (typeof record.noticeShownAt === 'string') state.noticeShownAt = record.noticeShownAt;
  return state;
}

/** Read the state file. Never creates it, and never reports a parse error to the user. */
export function readState(stateDir: string): LoadedState | null {
  try {
    const state = parseState(readFileSync(stateFilePath(stateDir), 'utf8'));
    return state === null ? null : { state, created: false };
  } catch {
    // Missing, unreadable (EACCES), a directory where a file belongs, or corrupt JSON.
    // All of them mean the same thing to every caller: there is no usable state.
    return null;
  }
}

/**
 * Read the state file, or mint and persist a new install id.
 *
 * Returns null when the id cannot be persisted. That is deliberate: minting a per-run id
 * instead would silently inflate the human count on exactly the locked-down machines
 * that matter most, which is worse than reporting nothing at all.
 */
export function loadOrCreateState(stateDir: string): LoadedState | null {
  const existing = readState(stateDir);
  if (existing !== null) return existing;

  const installId = newInstallId();
  if (installId === null) return null;

  const state: TelemetryState = { schemaVersion: 1, installId };
  if (!persistState(stateDir, state)) return null;
  return { state, created: true };
}

export function persistState(stateDir: string, state: TelemetryState): boolean {
  return writeFileAtomic(stateFilePath(stateDir), JSON.stringify(state, null, 2) + '\n');
}

export function deleteState(stateDir: string): boolean {
  try {
    rmSync(stateFilePath(stateDir), { force: true });
    return true;
  } catch (err) {
    recordError(err);
    // `pgfence telemetry reset` is the one caller, and it reports this to the user.
    return false;
  }
}

/**
 * Queue one event for a later run to deliver. Interactive runs only: CI sends inline and
 * never writes to disk.
 */
export function spoolAppend(dir: string, event: TelemetryEvent): void {
  let suffix: string;
  try {
    suffix = randomBytes(5).toString('hex');
  } catch {
    // Without a CSPRNG the file name cannot be made collision-safe against a concurrent
    // run, and one queued event is never worth the risk of clobbering another one.
    return;
  }

  const name = `${String(event.ts).padStart(TS_WIDTH, '0')}-${suffix}`;
  const tmp = path.join(dir, `.${name}.tmp`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(tmp, JSON.stringify(event), { mode: 0o600, flag: 'wx' });
    renameSync(tmp, path.join(dir, `${name}.json`));
  } catch (err) {
    recordError(err);
    try {
      unlinkSync(tmp);
    } catch {
      // The temp file may never have been created.
    }
    // Losing one queued event is invisible in the aggregate. Failing the user's run over
    // it would not be.
  }
}

function unlinkQuietly(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // A racing pgfence process may have committed or pruned the same file already.
  }
}

function listSpool(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    // No spool directory means there is nothing queued. Never create one here: several
    // callers (`status`, a cooldown check) must be able to look without writing.
    return [];
  }
}

/** Drop stale temp files, expired events, and everything past the newest MAX_SPOOL_EVENTS. */
export function pruneSpool(dir: string): void {
  const now = Date.now();
  const events: string[] = [];

  for (const entry of listSpool(dir)) {
    const full = path.join(dir, entry);
    if (entry.endsWith('.tmp')) {
      try {
        if (now - statSync(full).mtimeMs > STALE_TMP_MS) unlinkSync(full);
      } catch {
        // Either the file vanished under us or it cannot be stat'd. Both are fine: a
        // leftover temp file is inert and will be reconsidered on the next prune.
      }
      continue;
    }
    if (!entry.endsWith('.json')) continue;

    const ts = Number.parseInt(entry.slice(0, TS_WIDTH), 10);
    if (Number.isFinite(ts) && now - ts > MAX_EVENT_AGE_MS) {
      unlinkQuietly(full);
      continue;
    }
    events.push(entry);
  }

  if (events.length <= MAX_SPOOL_EVENTS) return;
  events.sort();
  for (const stale of events.slice(0, events.length - MAX_SPOOL_EVENTS)) {
    unlinkQuietly(path.join(dir, stale));
  }
}

/**
 * Read up to `max` queued events in chronological order, dropping anything that fails
 * validation. A corrupt or hand-edited record is unlinked, never forwarded and never
 * retried.
 */
export function readBatch(dir: string, max: number = MAX_SPOOL_EVENTS): SpooledItem[] {
  const items: SpooledItem[] = [];
  const entries = listSpool(dir).filter((entry) => entry.endsWith('.json')).sort();

  for (const entry of entries) {
    if (items.length >= max) break;
    const file = path.join(dir, entry);
    let event: TelemetryEvent | null;
    try {
      event = parseTelemetryEvent(JSON.parse(readFileSync(file, 'utf8')) as unknown);
    } catch {
      // Truncated by a killed write, or edited by hand. Either way it is not something
      // this process is willing to put on the wire.
      event = null;
    }
    if (event === null) {
      unlinkQuietly(file);
      continue;
    }
    items.push({ file, event });
  }

  return items;
}

/** Drop the files whose bytes reached the socket. Safe to call more than once. */
export function commitBatch(items: readonly SpooledItem[]): void {
  for (const item of items) {
    unlinkQuietly(item.file);
  }
}

/** Number of queued events, for `pgfence telemetry status`. Never creates the spool. */
export function countSpool(dir: string): number {
  return listSpool(dir).filter((entry) => entry.endsWith('.json')).length;
}

/**
 * Remove the spool entirely, for `pgfence telemetry disable|reset`. Returns true only when
 * the directory is actually gone afterwards.
 *
 * The result is load bearing for `reset`, whose success message promises that queued events
 * were deleted. Counting what is left cannot make that promise: a directory that survived
 * removal and then could not be read back counts as zero events, exactly like an empty one.
 */
export function clearSpool(dir: string): boolean {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    recordError(err);
    // Never a reason to fail a run: `disable` ignores this and the persisted opt-out still
    // stops anything further from being sent. `reset` reads the result and reports it.
  }
  if (!existsSync(dir)) return true;
  recordError(new Error(`spool directory ${dir} could not be removed`));
  return false;
}

/**
 * Delivery bookkeeping. Missing or unreadable reads back as an expired cooldown, which
 * correctly means a user's first queued event is never stranded behind a file that was
 * never written.
 */
export function readAttempt(dir: string): AttemptState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(dir, ATTEMPT_FILE), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return { nextAt: 0, fails: 0 };
    const record = parsed as Record<string, unknown>;
    const nextAt = typeof record.nextAt === 'number' && Number.isFinite(record.nextAt) ? record.nextAt : 0;
    const fails = typeof record.fails === 'number' && Number.isFinite(record.fails) ? record.fails : 0;
    return { nextAt, fails: Math.max(0, Math.trunc(fails)) };
  } catch {
    // No marker yet, or one that cannot be read or parsed. Treat the cooldown as expired.
    return { nextAt: 0, fails: 0 };
  }
}

export function writeAttempt(dir: string, attempt: AttemptState): void {
  writeFileAtomic(path.join(dir, ATTEMPT_FILE), JSON.stringify(attempt));
}
