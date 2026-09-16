/**
 * Everything telemetry reads from the environment or the platform: opt-out
 * resolution, CI detection, CI vendor, test-runner detection, and where the state
 * file lives.
 *
 * Nothing here touches the filesystem, and no environment variable's VALUE ever
 * leaves this module. Only the derived boolean and the closed provider enum do.
 */

import { homedir } from 'node:os';
import path from 'node:path';
import type { TelemetryCiProvider } from './types.js';

export type OptOutReason =
  | 'env-pgfence'
  | 'env-do-not-track'
  | 'test-runner'
  | 'project-config'
  | 'user-choice'
  | 'no-state-dir'
  | 'none';

const DIR_NAME = 'pgfence';
const STATE_FILE = 'telemetry.json';
const SPOOL_DIR = 'spool';

/** PGFENCE_TELEMETRY values that mean "on". Everything else that is set means "off". */
const ON_VALUES = new Set(['1', 'true', 'on', 'yes']);

/**
 * CI markers that only identify a vendor when they appear together. Checked before the
 * single-variable table because the singles would otherwise misattribute them: BUILD_ID
 * alone is set by several unrelated systems.
 */
const CI_PAIRS: ReadonlyArray<readonly [string, string, TelemetryCiProvider]> = [
  ['CODEBUILD_BUILD_ID', 'AWS_REGION', 'codebuild'],
  ['BUILD_ID', 'BUILD_URL', 'jenkins'],
  // Google Cloud Build has no closed-vocabulary entry of its own, so it lands in 'other'.
  ['BUILD_ID', 'PROJECT_ID', 'other'],
];

/** Single-variable CI markers, first match wins. */
const CI_SINGLES: ReadonlyArray<readonly [string, TelemetryCiProvider]> = [
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
  // Generic last: a bare CI=true says "a runner", and nothing about which one.
  ['CI', 'other'],
];

/**
 * A variable counts as present when it is set to something that is not empty, 'false'
 * or '0'. Plenty of tooling exports CI=false to mean "not CI", and honoring that is the
 * difference between counting a developer laptop as a build server or not.
 */
function present(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name];
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== '' && normalized !== 'false' && normalized !== '0';
}

function isOnValue(value: string): boolean {
  return ON_VALUES.has(value.trim().toLowerCase());
}

/** Coarse CI vendor, or 'none' when no known CI marker is set. */
export function ciProvider(env: NodeJS.ProcessEnv = process.env): TelemetryCiProvider {
  for (const [first, second, provider] of CI_PAIRS) {
    if (present(env, first) && present(env, second)) return provider;
  }
  for (const [name, provider] of CI_SINGLES) {
    if (present(env, name)) return provider;
  }
  return 'none';
}

export function isCI(env: NodeJS.ProcessEnv = process.env): boolean {
  return ciProvider(env) !== 'none';
}

/**
 * True under a test runner. The repo's own suite therefore emits nothing by default,
 * including from tests that shell out, because vitest sets VITEST in the parent
 * environment and the CLI tests spread process.env into the child.
 */
export function isTestRunner(env: NodeJS.ProcessEnv = process.env): boolean {
  if (typeof env.VITEST === 'string' && env.VITEST.length > 0) return true;
  return env.NODE_ENV === 'test';
}

/**
 * True when PGFENCE_TELEMETRY is explicitly set to an on-value. An explicit opt-in
 * outranks a project config and a persisted `pgfence telemetry disable`, but never
 * outranks DO_NOT_TRACK or the test-runner gate.
 */
export function isTelemetryForcedOn(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.PGFENCE_TELEMETRY;
  return typeof value === 'string' && isOnValue(value);
}

/**
 * True under PGFENCE_TELEMETRY_DEBUG=1, which prints the exact request to stderr and sends
 * nothing. Defined here, with the rest of the environment reading, so the send path and the
 * session path can never disagree about what debug mode is.
 *
 * It is a verification aid, not an opt-out: the run still records its own event locally,
 * exactly as it otherwise would.
 */
export function isTelemetryDebug(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PGFENCE_TELEMETRY_DEBUG === '1';
}

/**
 * Resolve the env and project layers of the opt-out precedence chain. Never touches the
 * filesystem: an opted-out run must not cause a state file to be created OR read, so the
 * two filesystem-backed layers (a persisted user choice, a missing state directory) are
 * resolved by the caller, after this returns 'none'.
 */
export function resolveEnvOptOut(
  projectSetting: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env,
): OptOutReason {
  const pgfenceValue = env.PGFENCE_TELEMETRY;
  // Fail closed: any value that is not a recognized on-value disables, including an
  // empty one. A typo in an opt-out must never silently re-enable collection.
  if (typeof pgfenceValue === 'string' && !isOnValue(pgfenceValue)) return 'env-pgfence';

  const doNotTrack = env.DO_NOT_TRACK;
  if (typeof doNotTrack === 'string') {
    const normalized = doNotTrack.trim().toLowerCase();
    if (normalized !== '' && normalized !== '0' && normalized !== 'false') return 'env-do-not-track';
  }

  if (isTestRunner(env)) return 'test-runner';
  if (typeof pgfenceValue === 'string') return 'none';
  if (projectSetting === false) return 'project-config';
  return 'none';
}

/**
 * Directory that holds the install id and the spool, or null when there is nowhere on
 * this machine to persist state.
 *
 * macOS uses ~/.config, not ~/Library/Application Support. The criterion is a path that
 * can be printed verbatim in the docs and removed with one command: `rm -rf
 * ~/.config/pgfence` works identically on macOS and Linux with no shell escaping. Apple
 * scopes Application Support to bundled applications; pgfence is a shell-invoked CLI.
 */
export function telemetryStateDir(env: NodeJS.ProcessEnv = process.env): string | null {
  if (process.platform === 'win32') {
    const appData = env.APPDATA;
    if (typeof appData === 'string' && appData.length > 0) return path.join(appData, DIR_NAME);
    return null;
  }

  const xdg = env.XDG_CONFIG_HOME;
  // The absolute check is load bearing. The XDG spec requires an absolute path, and
  // honoring a relative one would write the install id and the spool inside whatever
  // repository is being analyzed, which is the one place this data must never land.
  if (typeof xdg === 'string' && xdg.length > 0 && path.isAbsolute(xdg)) {
    return path.join(xdg, DIR_NAME);
  }

  let home: string;
  try {
    home = homedir();
  } catch {
    // homedir() throws ERR_SYSTEM_ERROR when HOME is unset and the uid has no passwd
    // entry, which is the normal state in distroless images and under
    // `docker run --user 1001`. There is nowhere to persist an install id, so telemetry
    // disables itself rather than failing the run.
    return null;
  }
  if (home.length === 0) return null;
  return path.join(home, '.config', DIR_NAME);
}

export function spoolDir(stateDir: string): string {
  return path.join(stateDir, SPOOL_DIR);
}

export function stateFilePath(stateDir: string): string {
  return path.join(stateDir, STATE_FILE);
}
