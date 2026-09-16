/**
 * Telemetry payload contract: the event shape, and every closed vocabulary its
 * string fields are drawn from.
 *
 * This module imports nothing, not even a node: builtin. That is deliberate. The
 * promise pgfence makes about telemetry ("every value on the wire is a number, a
 * boolean, or a member of a list enumerated in one file") has to be auditable by
 * reading that one file, and `parseTelemetryEvent` is the single choke point every
 * event passes through on its way onto the spool and again on its way onto the wire.
 *
 * Nothing derived from a migration, a path, a rule id or an environment variable's
 * value is representable here. See docs/telemetry.md for the full list of what is
 * deliberately not collected.
 */

export type TelemetryCommand = 'analyze' | 'trace' | 'explain' | 'snapshot' | 'init';

export type TelemetryOs =
  | 'darwin' | 'linux' | 'win32' | 'freebsd' | 'openbsd' | 'netbsd'
  | 'sunos' | 'aix' | 'android' | 'cygwin' | 'other';

export type TelemetryCiProvider =
  | 'none' | 'github' | 'gitlab' | 'circle' | 'travis'
  | 'azure' | 'jenkins' | 'buildkite' | 'teamcity' | 'appveyor' | 'codebuild'
  | 'bitbucket' | 'drone' | 'vercel' | 'netlify' | 'other';

export type TelemetryFormat =
  | 'sql' | 'typeorm' | 'prisma' | 'knex' | 'drizzle'
  | 'sequelize' | 'kysely' | 'mixed' | 'none';

export type TelemetryRulesMode = 'default' | 'enable' | 'disable' | 'both';

export const TELEMETRY_COMMANDS: readonly TelemetryCommand[] = [
  'analyze', 'trace', 'explain', 'snapshot', 'init',
];

export const TELEMETRY_OS: readonly TelemetryOs[] = [
  'darwin', 'linux', 'win32', 'freebsd', 'openbsd', 'netbsd',
  'sunos', 'aix', 'android', 'cygwin', 'other',
];

export const TELEMETRY_CI_PROVIDERS: readonly TelemetryCiProvider[] = [
  'none', 'github', 'gitlab', 'circle', 'travis',
  'azure', 'jenkins', 'buildkite', 'teamcity', 'appveyor', 'codebuild',
  'bitbucket', 'drone', 'vercel', 'netlify', 'other',
];

export const TELEMETRY_FORMATS: readonly TelemetryFormat[] = [
  'sql', 'typeorm', 'prisma', 'knex', 'drizzle',
  'sequelize', 'kysely', 'mixed', 'none',
];

export const TELEMETRY_RULES_MODES: readonly TelemetryRulesMode[] = [
  'default', 'enable', 'disable', 'both',
];

/**
 * Every key a telemetry event may carry, sorted. `parseTelemetryEvent` re-projects
 * onto exactly this list, so a record that picked up an extra key (a hand-edited spool
 * file, a future client version, a bug in our own construction) loses it before it can
 * reach the wire.
 */
export const TELEMETRY_EVENT_KEYS: readonly string[] = [
  'ci',
  'ciProvider',
  'command',
  'durationMs',
  'errored',
  'eventId',
  'fileCountBucket',
  'findCritical',
  'findHigh',
  'findLow',
  'findMedium',
  'findSafe',
  'format',
  'freshInstallId',
  'installId',
  'nodeMajor',
  'os',
  'pluginCount',
  'policyErrors',
  'policyWarnings',
  'rulesMode',
  'ts',
  'tty',
  'v',
  'version',
];

/**
 * Default receiver endpoint.
 *
 * Declared in this dependency-free module rather than in post.ts so that
 * `pgfence telemetry status` can print it without pulling node:https into a run that
 * never sends. post.ts re-exports it as DEFAULT_ENDPOINT.
 */
export const TELEMETRY_ENDPOINT = 'https://telemetry.pgfence.com/v1/event';

export interface TelemetryEvent {
  /** Payload schema version. Lets the receiver reject or migrate old clients without guessing. */
  readonly v: 1;

  /** Random uuid per event. The receiver dedupes on it, which is what makes
   *  at-least-once delivery safe when a run exits with the request in flight. */
  readonly eventId: string;

  /** 32 lowercase hex from the per-machine state file. Derived from nothing: not the
   *  hostname, not the MAC, not the cwd, not any hash of any of them. Distinct
   *  installIds with ci=false is the headcount this whole feature exists to produce. */
  readonly installId: string;

  /** True when the id was minted during this run rather than read from disk. A
   *  population that is almost always true is ephemeral containers, not humans. */
  readonly freshInstallId: boolean;

  /** Which command ran. Tells us whether humans use anything beyond `analyze`. */
  readonly command: TelemetryCommand;

  /** pgfence version, semver or the literal 'unknown'. Tells us how fast humans upgrade. */
  readonly version: string;

  /** Node major only, as an integer. Tells us which Node majors we must keep supporting. */
  readonly nodeMajor: number;

  /** OS platform from a closed list. Tells us whether the Windows path is worth maintaining. */
  readonly os: TelemetryOs;

  /** True when CI was detected by the presence of any known CI variable. */
  readonly ci: boolean;

  /** Coarse CI vendor from a closed list, 'none' when ci is false. Separates one
   *  500-job matrix from 500 different teams, which a boolean cannot. */
  readonly ciProvider: TelemetryCiProvider;

  /** process.stdout.isTTY === true. A human at a terminal, as opposed to a hook,
   *  a pipe or a runner. */
  readonly tty: boolean;

  /** Detected migration format across the run, or 'mixed' or 'none'. Which ORM
   *  ecosystems actually run pgfence, which decides extractor investment. */
  readonly format: TelemetryFormat;

  /** Whether the run used the stock ruleset or a customized one. Distinguishes a
   *  configured, adopted install from a drive-by run. */
  readonly rulesMode: TelemetryRulesMode;

  /** Number of plugins loaded, capped at 99. A nonzero value means someone invested
   *  enough to write custom rules. */
  readonly pluginCount: number;

  /** Coarse bucket of input files: 0=0, 1=1, 2=2..5, 3=6..20, 4=21..100, 5=>100.
   *  Bucketed, not exact: a file count of a private repo's migration directory is a
   *  fingerprint bit with no added value. */
  readonly fileCountBucket: number;

  /** Finding counts by effective risk (adjustedRisk ?? risk), each capped at 9999.
   *  Tells us whether humans keep running a tool that finds nothing. */
  readonly findSafe: number;
  readonly findLow: number;
  readonly findMedium: number;
  readonly findHigh: number;
  readonly findCritical: number;

  /** Policy violation counts by severity, each capped at 9999. Split out from the
   *  risk counts because policy checks fire on migrations with no schema findings. */
  readonly policyErrors: number;
  readonly policyWarnings: number;

  /** True when the command's catch block ran, meaning the user got exit code 2. */
  readonly errored: boolean;

  /** Wall clock from handler entry to analysis complete, rounded to 10ms, capped at 600000. */
  readonly durationMs: number;

  /** Client clock, epoch ms. Required because interactive events are delivered by a
   *  LATER run, sometimes days later, so the receive time is not the event time. */
  readonly ts: number;
}

/** randomUUID() output, lowercase hex with dashes. */
const EVENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** randomBytes(16).toString('hex'). */
const INSTALL_ID_PATTERN = /^[0-9a-f]{32}$/;

/** Semver with an optional prerelease or build suffix. Anything else becomes 'unknown'. */
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]{1,32})?$/;

const MAX_FINDING_COUNT = 9999;
const MAX_PLUGIN_COUNT = 99;
const MAX_DURATION_MS = 600_000;
const MAX_NODE_MAJOR = 999;
const MAX_FILE_COUNT_BUCKET = 5;

function member<T extends string>(vocabulary: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (vocabulary as readonly string[]).includes(value);
}

/** Returns the value when it is an integer inside [min, max], and null otherwise.
 *  Callers compare against null explicitly, because 0 is a legal value everywhere. */
function boundedInt(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    return null;
  }
  return value;
}

/** Coerce process.platform to the closed TelemetryOs vocabulary. */
export function toTelemetryOs(platform: string): TelemetryOs {
  return member(TELEMETRY_OS, platform) ? platform : 'other';
}

/**
 * Coerce a version string to semver or the literal 'unknown'.
 *
 * The version comes from our own package.json, but a fork, a patched install or a
 * repackager could put anything there, and it ends up both in the payload and in the
 * user-agent header, so it is validated like any other untrusted string.
 */
export function toTelemetryVersion(version: string): string {
  return VERSION_PATTERN.test(version) ? version : 'unknown';
}

/** Map a raw file count to the closed bucket vocabulary 0..5. */
export function fileCountBucket(count: number): number {
  if (!Number.isFinite(count)) return 0;
  const files = Math.floor(count);
  if (files <= 0) return 0;
  if (files < 2) return 1;
  if (files <= 5) return 2;
  if (files <= 20) return 3;
  if (files <= 100) return 4;
  return MAX_FILE_COUNT_BUCKET;
}

/**
 * Validate and RE-PROJECT onto the known keys. Returns null if anything is off.
 *
 * This builds a fresh object literal rather than casting, so an extra key in the input
 * is dropped instead of carried. It runs on every record read back off the spool and
 * once more inside the send path, which is what makes a hand-edited or future-version
 * spool file structurally unable to smuggle a field onto the wire.
 */
export function parseTelemetryEvent(value: unknown): TelemetryEvent | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;

  if (raw.v !== 1) return null;
  if (typeof raw.eventId !== 'string' || !EVENT_ID_PATTERN.test(raw.eventId)) return null;
  if (typeof raw.installId !== 'string' || !INSTALL_ID_PATTERN.test(raw.installId)) return null;
  if (typeof raw.freshInstallId !== 'boolean') return null;
  if (!member(TELEMETRY_COMMANDS, raw.command)) return null;
  if (typeof raw.version !== 'string' || toTelemetryVersion(raw.version) !== raw.version) return null;
  if (!member(TELEMETRY_OS, raw.os)) return null;
  if (typeof raw.ci !== 'boolean') return null;
  if (!member(TELEMETRY_CI_PROVIDERS, raw.ciProvider)) return null;
  if (typeof raw.tty !== 'boolean') return null;
  if (!member(TELEMETRY_FORMATS, raw.format)) return null;
  if (!member(TELEMETRY_RULES_MODES, raw.rulesMode)) return null;
  if (typeof raw.errored !== 'boolean') return null;

  const nodeMajor = boundedInt(raw.nodeMajor, 0, MAX_NODE_MAJOR);
  const pluginCount = boundedInt(raw.pluginCount, 0, MAX_PLUGIN_COUNT);
  const bucket = boundedInt(raw.fileCountBucket, 0, MAX_FILE_COUNT_BUCKET);
  const findSafe = boundedInt(raw.findSafe, 0, MAX_FINDING_COUNT);
  const findLow = boundedInt(raw.findLow, 0, MAX_FINDING_COUNT);
  const findMedium = boundedInt(raw.findMedium, 0, MAX_FINDING_COUNT);
  const findHigh = boundedInt(raw.findHigh, 0, MAX_FINDING_COUNT);
  const findCritical = boundedInt(raw.findCritical, 0, MAX_FINDING_COUNT);
  const policyErrors = boundedInt(raw.policyErrors, 0, MAX_FINDING_COUNT);
  const policyWarnings = boundedInt(raw.policyWarnings, 0, MAX_FINDING_COUNT);
  const durationMs = boundedInt(raw.durationMs, 0, MAX_DURATION_MS);
  const ts = boundedInt(raw.ts, 0, Number.MAX_SAFE_INTEGER);

  if (
    nodeMajor === null || pluginCount === null || bucket === null ||
    findSafe === null || findLow === null || findMedium === null ||
    findHigh === null || findCritical === null ||
    policyErrors === null || policyWarnings === null ||
    durationMs === null || ts === null
  ) {
    return null;
  }

  return {
    v: 1,
    eventId: raw.eventId,
    installId: raw.installId,
    freshInstallId: raw.freshInstallId,
    command: raw.command,
    version: raw.version,
    nodeMajor,
    os: raw.os,
    ci: raw.ci,
    ciProvider: raw.ciProvider,
    tty: raw.tty,
    format: raw.format,
    rulesMode: raw.rulesMode,
    pluginCount,
    fileCountBucket: bucket,
    findSafe,
    findLow,
    findMedium,
    findHigh,
    findCritical,
    policyErrors,
    policyWarnings,
    errored: raw.errored,
    durationMs,
    ts,
  };
}
