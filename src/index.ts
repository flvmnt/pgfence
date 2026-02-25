#!/usr/bin/env node
/**
 * pgfence — Postgres migration safety CLI
 *
 * Analyzes SQL migration files and reports lock modes, risk levels,
 * and safe rewrite recipes before you merge.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Command } from 'commander';
import { analyze, RISK_ORDER } from './analyzer.js';
import { reportCLI } from './reporters/cli.js';
import { reportJSON } from './reporters/json.js';
import { reportGitHub } from './reporters/github-pr.js';
import { reportSARIF } from './reporters/sarif.js';
import { loadConfigFile, mergeConfig } from './config.js';
import { RiskLevel } from './types.js';
import type { PgfenceConfig, TableStats } from './types.js';

function parseRiskLevel(value: string): RiskLevel {
  const upper = value.toUpperCase() as RiskLevel;
  if (!RISK_ORDER.includes(upper)) {
    throw new Error(`Invalid risk level: ${value}. Must be one of: safe, low, medium, high, critical`);
  }
  return upper;
}

const program = new Command();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkgPath = path.resolve(__dirname, '../package.json');
let pkg: { version: string };
try {
  pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
} catch {
  process.stderr.write('pgfence: could not read package.json\n');
  process.exit(2);
}

program
  .name('pgfence')
  .description('Postgres migration safety CLI — lock mode analysis, risk scoring, and safe rewrite recipes')
  .version(pkg.version);

program
  .command('analyze')
  .description('Analyze migration files for safety issues')
  .argument('<files...>', 'Migration files to analyze')
  .option('--format <format>', 'Migration format: sql, typeorm, prisma, knex, auto', 'auto')
  .option('--output <output>', 'Output format: cli, json, github, sarif', 'cli')
  .option('--db-url <url>', 'Database URL for size-aware risk scoring')
  .option('--stats-file <path>', 'Path to pgfence-stats.json for size-aware risk scoring (alternative to --db-url)')
  .option('--min-pg-version <version>', 'Minimum PostgreSQL version to assume', '11')
  .option('--max-risk <risk>', 'Maximum allowed risk level for CI mode', 'high')
  .option('--ci', 'CI mode — exit 1 if max risk exceeded', false)
  .option('--no-lock-timeout', 'Disable lock_timeout requirement')
  .option('--no-statement-timeout', 'Disable statement_timeout requirement')
  .option('--max-lock-timeout <ms>', 'Maximum allowed lock_timeout in ms (default: 5000)')
  .option('--max-statement-timeout <ms>', 'Maximum allowed statement_timeout in ms (default: 600000)')
  .option('--disable-rules <rules...>', 'Disable specific rules by ID')
  .option('--enable-rules <rules...>', 'Enable only specific rules by ID (whitelist)')
  .option('--snapshot <path>', 'Schema snapshot JSON for definitive type analysis')
  .option('--plugin <paths...>', 'Plugin file paths for custom rules')
  .action(async (files: string[], opts) => {
    // Load config file (.pgfence.toml or .pgfence.json)
    const fileConfig = await loadConfigFile(process.cwd());

    // Load stats file if provided (alternative to --db-url)
    let tableStats: TableStats[] | undefined;
    const statsFilePath = opts.statsFile ?? fileConfig?.['stats-file'];
    if (statsFilePath) {
      const raw = await readFile(statsFilePath, 'utf8');
      const parsed = JSON.parse(raw);
      tableStats = Array.isArray(parsed) ? parsed : parsed.tables ?? parsed;
      if (tableStats && tableStats.length > 0) {
        const sample = tableStats[0];
        if (typeof sample.tableName !== 'string' || typeof sample.rowCount !== 'number') {
          throw new Error(
            `Invalid stats file format. Expected objects with {schemaName, tableName, rowCount, totalBytes}. ` +
            `Got: ${JSON.stringify(sample).slice(0, 200)}`,
          );
        }
      }
    }

    // Build CLI overrides
    const cliOverrides: Partial<PgfenceConfig> = {
      format: opts.format as PgfenceConfig['format'],
      output: opts.output as PgfenceConfig['output'],
      dbUrl: opts.dbUrl,
      tableStats,
      minPostgresVersion: Number.isNaN(parseInt(opts.minPgVersion, 10)) ? 11 : parseInt(opts.minPgVersion, 10),
      maxAllowedRisk: parseRiskLevel(opts.maxRisk),
      requireLockTimeout: opts.lockTimeout !== false,
      requireStatementTimeout: opts.statementTimeout !== false,
    };

    if (opts.maxLockTimeout) cliOverrides.maxLockTimeoutMs = parseInt(opts.maxLockTimeout, 10);
    if (opts.maxStatementTimeout) cliOverrides.maxStatementTimeoutMs = parseInt(opts.maxStatementTimeout, 10);
    if (opts.snapshot) cliOverrides.snapshotFile = opts.snapshot;
    if (opts.plugin) cliOverrides.plugins = opts.plugin;
    if (opts.disableRules || opts.enableRules) {
      cliOverrides.rules = {};
      if (opts.disableRules) cliOverrides.rules.disable = opts.disableRules;
      if (opts.enableRules) cliOverrides.rules.enable = opts.enableRules;
    }

    const config = mergeConfig(fileConfig, cliOverrides);

    try {
      const results = await analyze(files, config);

      // Output
      switch (config.output) {
        case 'json':
          process.stdout.write(reportJSON(results) + '\n');
          break;
        case 'github':
          process.stdout.write(reportGitHub(results) + '\n');
          break;
        case 'sarif':
          process.stdout.write(reportSARIF(results) + '\n');
          break;
        case 'cli':
        default:
          process.stdout.write(reportCLI(results, config) + '\n');
          break;
      }

      // CI mode: fail on excessive risk or policy errors
      if (opts.ci) {
        const maxAllowedIdx = RISK_ORDER.indexOf(config.maxAllowedRisk);
        let shouldFail = false;

        for (const result of results) {
          const maxIdx = RISK_ORDER.indexOf(result.maxRisk);
          if (maxIdx > maxAllowedIdx) {
            shouldFail = true;
          }
          // Policy errors also fail CI
          if (result.policyViolations.some((v) => v.severity === 'error')) {
            shouldFail = true;
          }
        }

        if (shouldFail) {
          process.exit(1);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`pgfence error: ${message}\n`);
      process.exit(2);
    }
  });

program
  .command('snapshot')
  .description('Generate schema snapshot from a live database')
  .requiredOption('--db-url <url>', 'Database URL for schema snapshot')
  .option('--output <path>', 'Output file path', 'pgfence-snapshot.json')
  .action(async (opts) => {
    try {
      const { fetchSchemaSnapshot } = await import('./schema-snapshot.js');
      const snapshot = await fetchSchemaSnapshot(opts.dbUrl);
      await writeFile(opts.output, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
      process.stdout.write(`Schema snapshot written to ${opts.output} (${snapshot.tables.length} tables)\n`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`pgfence snapshot error: ${message}\n`);
      process.exit(1);
    }
  });

program
  .command('init')
  .description('Install pgfence git hooks (pre-commit)')
  .action(async () => {
    const { installHooks } = await import('./init.js');
    try {
      await installHooks();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`pgfence init error: ${message}\n`);
      process.exit(1);
    }
  });

program.parse();
