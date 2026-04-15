/**
 * Load .pgfence.toml (or .pgfence.json) from the current working directory
 * and merge with CLI options.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import type { PgfenceConfig } from './types.js';
import { RiskLevel } from './types.js';

export interface PgfenceConfigFile {
  format?: string;
  output?: string;
  'db-url'?: string;
  'stats-file'?: string;
  'min-pg-version'?: number;
  'max-risk'?: string;
  'require-lock-timeout'?: boolean;
  'require-statement-timeout'?: boolean;
  'max-lock-timeout'?: number;
  'max-statement-timeout'?: number;
  'disable-rules'?: string[];
  'enable-rules'?: string[];
  snapshot?: string;
  plugins?: string[];
}

const VALID_FORMATS = new Set(['sql', 'typeorm', 'prisma', 'knex', 'drizzle', 'sequelize', 'auto']);
const VALID_OUTPUTS = new Set(['cli', 'json', 'github', 'sarif', 'gitlab']);
const VALID_RISKS = new Set(Object.values(RiskLevel));

function expectString(value: unknown, key: string, configPath: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid config file ${configPath}: "${key}" must be a string`);
  }
  return value;
}

function expectBoolean(value: unknown, key: string, configPath: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid config file ${configPath}: "${key}" must be a boolean`);
  }
  return value;
}

function expectNumber(value: unknown, key: string, configPath: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid config file ${configPath}: "${key}" must be a finite number`);
  }
  return value;
}

function expectStringArray(value: unknown, key: string, configPath: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    throw new Error(`Invalid config file ${configPath}: "${key}" must be an array of non-empty strings`);
  }
  return value;
}

function validateConfigFile(configPath: string, parsed: PgfenceConfigFile): PgfenceConfigFile {
  if (parsed.format != null) {
    const format = expectString(parsed.format, 'format', configPath);
    if (!VALID_FORMATS.has(format)) {
      throw new Error(
        `Invalid config file ${configPath}: "format" must be one of ${[...VALID_FORMATS].join(', ')}`,
      );
    }
  }

  if (parsed.output != null) {
    const output = expectString(parsed.output, 'output', configPath);
    if (!VALID_OUTPUTS.has(output)) {
      throw new Error(
        `Invalid config file ${configPath}: "output" must be one of ${[...VALID_OUTPUTS].join(', ')}`,
      );
    }
  }

  if (parsed['db-url'] != null) expectString(parsed['db-url'], 'db-url', configPath);
  if (parsed['stats-file'] != null) expectString(parsed['stats-file'], 'stats-file', configPath);
  if (parsed.snapshot != null) expectString(parsed.snapshot, 'snapshot', configPath);

  if (parsed['min-pg-version'] != null) {
    const minPgVersion = expectNumber(parsed['min-pg-version'], 'min-pg-version', configPath);
    if (!Number.isInteger(minPgVersion) || minPgVersion < 1) {
      throw new Error(`Invalid config file ${configPath}: "min-pg-version" must be a positive integer`);
    }
  }

  if (parsed['max-risk'] != null) {
    const maxRisk = expectString(parsed['max-risk'], 'max-risk', configPath).toUpperCase();
    if (!VALID_RISKS.has(maxRisk as RiskLevel)) {
      throw new Error(
        `Invalid config file ${configPath}: "max-risk" must be one of ${[...VALID_RISKS].join(', ')}`,
      );
    }
  }

  if (parsed['require-lock-timeout'] != null) {
    expectBoolean(parsed['require-lock-timeout'], 'require-lock-timeout', configPath);
  }
  if (parsed['require-statement-timeout'] != null) {
    expectBoolean(parsed['require-statement-timeout'], 'require-statement-timeout', configPath);
  }

  if (parsed['max-lock-timeout'] != null) {
    const maxLockTimeout = expectNumber(parsed['max-lock-timeout'], 'max-lock-timeout', configPath);
    if (maxLockTimeout < 0) {
      throw new Error(`Invalid config file ${configPath}: "max-lock-timeout" must be non-negative`);
    }
  }

  if (parsed['max-statement-timeout'] != null) {
    const maxStatementTimeout = expectNumber(parsed['max-statement-timeout'], 'max-statement-timeout', configPath);
    if (maxStatementTimeout < 0) {
      throw new Error(`Invalid config file ${configPath}: "max-statement-timeout" must be non-negative`);
    }
  }

  if (parsed['disable-rules'] != null) expectStringArray(parsed['disable-rules'], 'disable-rules', configPath);
  if (parsed['enable-rules'] != null) expectStringArray(parsed['enable-rules'], 'enable-rules', configPath);
  if (parsed.plugins != null) expectStringArray(parsed.plugins, 'plugins', configPath);

  return parsed;
}

async function loadToml(configPath: string): Promise<PgfenceConfigFile> {
  const mod = await import('@iarna/toml');
  const parse = mod.parse ?? (mod.default as { parse?: (s: string) => PgfenceConfigFile })?.parse;
  if (typeof parse !== 'function') {
    throw new Error('Cannot load @iarna/toml, install it: pnpm add @iarna/toml');
  }
  const raw = await readFile(configPath, 'utf8');
  return validateConfigFile(configPath, parse(raw) as PgfenceConfigFile);
}

async function loadJson(configPath: string): Promise<PgfenceConfigFile> {
  const raw = await readFile(configPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid config file ${configPath}: expected a JSON object`);
  }
  return validateConfigFile(configPath, parsed as PgfenceConfigFile);
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Load config from .pgfence.toml or .pgfence.json in cwd only.
 * Returns null if no file found.
 */
export async function loadConfigFile(cwd: string): Promise<PgfenceConfigFile | null> {
  const configDir = await realpath(path.resolve(cwd));
  const tomlPath = path.join(configDir, '.pgfence.toml');
  const jsonPath = path.join(configDir, '.pgfence.json');
  if (existsSync(tomlPath)) {
    const realTomlPath = await realpath(tomlPath);
    if (!isWithinRoot(configDir, realTomlPath)) {
      throw new Error(`Config file "${tomlPath}" resolves outside the current directory`);
    }
    return loadToml(tomlPath);
  }
  if (existsSync(jsonPath)) {
    const realJsonPath = await realpath(jsonPath);
    if (!isWithinRoot(configDir, realJsonPath)) {
      throw new Error(`Config file "${jsonPath}" resolves outside the current directory`);
    }
    return loadJson(jsonPath);
  }
  return null;
}

/**
 * Merge file config into base; CLI opts (passed as overrides) take precedence.
 */
export function mergeConfig(
  fileConfig: PgfenceConfigFile | null,
  overrides: Partial<PgfenceConfig>,
): PgfenceConfig {
  const base: PgfenceConfig = {
    format: 'auto',
    output: 'cli',
    minPostgresVersion: 14,
    maxAllowedRisk: RiskLevel.HIGH,
    requireLockTimeout: true,
    requireStatementTimeout: true,
  };

  if (fileConfig) {
    if (fileConfig.format != null) base.format = fileConfig.format as PgfenceConfig['format'];
    if (fileConfig.output != null) base.output = fileConfig.output as PgfenceConfig['output'];
    if (fileConfig['db-url'] != null) base.dbUrl = fileConfig['db-url'];
    if (fileConfig['min-pg-version'] != null) base.minPostgresVersion = fileConfig['min-pg-version'];
    if (fileConfig['max-risk'] != null) {
      const r = fileConfig['max-risk'].toUpperCase() as RiskLevel;
      if (['SAFE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(r)) base.maxAllowedRisk = r;
    }
    if (fileConfig['require-lock-timeout'] != null) base.requireLockTimeout = fileConfig['require-lock-timeout'];
    if (fileConfig['require-statement-timeout'] != null) base.requireStatementTimeout = fileConfig['require-statement-timeout'];
    if (fileConfig['max-lock-timeout'] != null) base.maxLockTimeoutMs = fileConfig['max-lock-timeout'];
    if (fileConfig['max-statement-timeout'] != null) base.maxStatementTimeoutMs = fileConfig['max-statement-timeout'];
    if (fileConfig['disable-rules'] != null) {
      base.rules = { ...base.rules, disable: fileConfig['disable-rules'] };
    }
    if (fileConfig['enable-rules'] != null) {
      base.rules = { ...base.rules, enable: fileConfig['enable-rules'] };
    }
    if (fileConfig.snapshot != null) base.snapshotFile = fileConfig.snapshot;
    if (fileConfig.plugins != null) base.plugins = fileConfig.plugins;
  }

  return { ...base, ...overrides };
}
