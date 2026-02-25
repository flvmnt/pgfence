/**
 * Load .pgfence.toml (or .pgfence.json) from cwd or ancestor dirs and merge with CLI options.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
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

function findConfigDir(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (; ;) {
    if (existsSync(path.join(dir, '.pgfence.toml'))) return dir;
    if (existsSync(path.join(dir, '.pgfence.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function loadToml(configPath: string): Promise<PgfenceConfigFile> {
  // @ts-expect-error - dynamic import of optional dependency
  const mod = await import('@iarna/toml');
  const parse = mod.parse ?? (mod.default as { parse?: (s: string) => PgfenceConfigFile })?.parse;
  if (typeof parse !== 'function') {
    throw new Error('Cannot load @iarna/toml — install it: pnpm add @iarna/toml');
  }
  const raw = await readFile(configPath, 'utf8');
  return parse(raw) as PgfenceConfigFile;
}

async function loadJson(configPath: string): Promise<PgfenceConfigFile> {
  const raw = await readFile(configPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid config file ${configPath}: expected a JSON object`);
  }
  return parsed as PgfenceConfigFile;
}

/**
 * Load config from .pgfence.toml or .pgfence.json in cwd or any parent.
 * Returns null if no file found.
 */
export async function loadConfigFile(cwd: string): Promise<PgfenceConfigFile | null> {
  const configDir = findConfigDir(cwd);
  if (!configDir) return null;
  const tomlPath = path.join(configDir, '.pgfence.toml');
  const jsonPath = path.join(configDir, '.pgfence.json');
  if (existsSync(tomlPath)) {
    return loadToml(tomlPath);
  }
  if (existsSync(jsonPath)) {
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
    minPostgresVersion: 11,
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
