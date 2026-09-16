/**
 * Pure validation and re-projection for the pgfence telemetry receiver.
 *
 * No Worker APIs are used here, so this file can be imported by a plain unit test.
 *
 * The vocabularies below are DUPLICATED from src/telemetry/types.ts on purpose. The
 * receiver must not depend on the CLI's build, and a server that imports the client's
 * own definition of "acceptable" is not validating anything: it is agreeing with
 * whatever the client happens to believe today. The duplication is the validation.
 *
 * Posture: this endpoint is public and will be probed. Anything that is not exactly
 * the 25-key, closed-vocabulary shape is rejected and never stored. Unknown keys are a
 * rejection, not a silent drop, because an unknown key is the only way a table name, a
 * file path or a SQL fragment could ever reach this database, and a future buggy client
 * that started sending one must fail loudly rather than quietly fill a column.
 */

/** The 25 event keys, sorted. Must match TELEMETRY_EVENT_KEYS in src/telemetry/types.ts. */
export const EVENT_KEYS = [
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
] as const;

const EVENT_KEY_SET = new Set<string>(EVENT_KEYS);

const COMMANDS = ['analyze', 'trace', 'explain', 'snapshot', 'init'] as const;

const OS_VALUES = [
  'darwin', 'linux', 'win32', 'freebsd', 'openbsd', 'netbsd',
  'sunos', 'aix', 'android', 'cygwin', 'other',
] as const;

const CI_PROVIDERS = [
  'none', 'github', 'gitlab', 'circle', 'travis',
  'azure', 'jenkins', 'buildkite', 'teamcity', 'appveyor', 'codebuild',
  'bitbucket', 'drone', 'vercel', 'netlify', 'other',
] as const;

const FORMATS = [
  'sql', 'typeorm', 'prisma', 'knex', 'drizzle',
  'sequelize', 'kysely', 'mixed', 'none',
] as const;

const RULES_MODES = ['default', 'enable', 'disable', 'both'] as const;

export type Command = (typeof COMMANDS)[number];
export type OsName = (typeof OS_VALUES)[number];
export type CiProvider = (typeof CI_PROVIDERS)[number];
export type Format = (typeof FORMATS)[number];
export type RulesMode = (typeof RULES_MODES)[number];

/** randomUUID() output. */
const EVENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** randomBytes(16).toString('hex'). */
const INSTALL_ID_PATTERN = /^[0-9a-f]{32}$/;

/** Semver with an optional prerelease or build suffix, or the literal 'unknown'. */
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]{1,32})?$/;

const MAX_FINDING_COUNT = 9999;
const MAX_PLUGIN_COUNT = 99;
const MAX_DURATION_MS = 600_000;
const MAX_NODE_MAJOR = 999;
const MAX_FILE_COUNT_BUCKET = 5;
const MAX_EVENTS_PER_ENVELOPE = 32;

/** One year of slack in each direction on the client clock. A timestamp outside this
 *  window is a broken clock or a probe, and either way it is not worth storing. */
const CLIENT_TS_SKEW_MS = 400 * 24 * 60 * 60 * 1000;

export interface ValidEvent {
  v: 1;
  eventId: string;
  installId: string;
  freshInstallId: boolean;
  command: Command;
  version: string;
  nodeMajor: number;
  os: OsName;
  ci: boolean;
  ciProvider: CiProvider;
  tty: boolean;
  format: Format;
  rulesMode: RulesMode;
  pluginCount: number;
  fileCountBucket: number;
  findSafe: number;
  findLow: number;
  findMedium: number;
  findHigh: number;
  findCritical: number;
  policyErrors: number;
  policyWarnings: number;
  errored: boolean;
  durationMs: number;
  ts: number;
}

function member<T extends string>(vocabulary: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (vocabulary as readonly string[]).includes(value);
}

/** Returns the value when it is an integer inside [min, max], and null otherwise.
 *  Callers compare against null explicitly, because 0 is legal everywhere here. */
function boundedInt(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    return null;
  }
  return value;
}

/**
 * Re-project an untrusted value onto the 25 known keys. Returns null on anything
 * unexpected, including an unknown key.
 *
 * The returned object is a fresh literal built field by field, never a cast, so a value
 * that was not explicitly copied here cannot be stored.
 */
export function validateEvent(value: unknown, now: number = Date.now()): ValidEvent | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;

  // Unknown keys are a hard rejection. This is the property that makes it impossible
  // for the receiver to store a table name even if a future client sent one.
  for (const key of Object.keys(raw)) {
    if (!EVENT_KEY_SET.has(key)) return null;
  }
  if (Object.keys(raw).length !== EVENT_KEYS.length) return null;

  if (raw.v !== 1) return null;
  if (typeof raw.eventId !== 'string' || !EVENT_ID_PATTERN.test(raw.eventId)) return null;
  if (typeof raw.installId !== 'string' || !INSTALL_ID_PATTERN.test(raw.installId)) return null;
  if (typeof raw.freshInstallId !== 'boolean') return null;
  if (!member(COMMANDS, raw.command)) return null;
  if (typeof raw.version !== 'string') return null;
  if (raw.version !== 'unknown' && !VERSION_PATTERN.test(raw.version)) return null;
  if (!member(OS_VALUES, raw.os)) return null;
  if (typeof raw.ci !== 'boolean') return null;
  if (!member(CI_PROVIDERS, raw.ciProvider)) return null;
  if (typeof raw.tty !== 'boolean') return null;
  if (!member(FORMATS, raw.format)) return null;
  if (!member(RULES_MODES, raw.rulesMode)) return null;
  if (typeof raw.errored !== 'boolean') return null;

  const nodeMajor = boundedInt(raw.nodeMajor, 0, MAX_NODE_MAJOR);
  const pluginCount = boundedInt(raw.pluginCount, 0, MAX_PLUGIN_COUNT);
  const fileCountBucket = boundedInt(raw.fileCountBucket, 0, MAX_FILE_COUNT_BUCKET);
  const findSafe = boundedInt(raw.findSafe, 0, MAX_FINDING_COUNT);
  const findLow = boundedInt(raw.findLow, 0, MAX_FINDING_COUNT);
  const findMedium = boundedInt(raw.findMedium, 0, MAX_FINDING_COUNT);
  const findHigh = boundedInt(raw.findHigh, 0, MAX_FINDING_COUNT);
  const findCritical = boundedInt(raw.findCritical, 0, MAX_FINDING_COUNT);
  const policyErrors = boundedInt(raw.policyErrors, 0, MAX_FINDING_COUNT);
  const policyWarnings = boundedInt(raw.policyWarnings, 0, MAX_FINDING_COUNT);
  const durationMs = boundedInt(raw.durationMs, 0, MAX_DURATION_MS);
  const ts = boundedInt(raw.ts, now - CLIENT_TS_SKEW_MS, now + CLIENT_TS_SKEW_MS);

  if (
    nodeMajor === null || pluginCount === null || fileCountBucket === null ||
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
    fileCountBucket,
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

/**
 * Parse an envelope. Returns [] when the body is not { v: 1, events: [...] } with
 * between 1 and 32 entries, or when any single entry fails validation.
 *
 * One bad event fails the whole envelope rather than being skipped. A partially valid
 * batch means the client is not the client we shipped, and a receiver that accepts
 * half of a malformed batch is a receiver that will eventually store something it
 * should not have.
 */
export function validateEnvelope(value: unknown, now: number = Date.now()): ValidEvent[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  const envelope = value as Record<string, unknown>;

  for (const key of Object.keys(envelope)) {
    if (key !== 'v' && key !== 'events') return [];
  }
  if (envelope.v !== 1) return [];
  if (!Array.isArray(envelope.events)) return [];
  if (envelope.events.length < 1 || envelope.events.length > MAX_EVENTS_PER_ENVELOPE) return [];

  const out: ValidEvent[] = [];
  for (const candidate of envelope.events) {
    const event = validateEvent(candidate, now);
    if (event === null) return [];
    out.push(event);
  }
  return out;
}
