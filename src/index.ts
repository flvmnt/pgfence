#!/usr/bin/env node
/**
 * pgfence — Postgres migration safety CLI
 *
 * Analyzes SQL migration files and reports lock modes, risk levels,
 * and safe rewrite recipes before you merge.
 */

import { readFile } from 'node:fs/promises';
import { Command } from 'commander';
import { RISK_ORDER } from './analyzer.js';
import { reportCLI } from './reporters/cli.js';
import { reportJSON } from './reporters/json.js';
import { reportGitHub } from './reporters/github-pr.js';
import { RiskLevel } from './types.js';
import type { PgfenceConfig, TableStats } from './types.js';
import type { PgfenceCloudConfig } from './cloud/types.js';
import { analyzeWithCloud } from './cloud/hooks.js';

function parseRiskLevel(value: string): RiskLevel {
  const upper = value.toUpperCase() as RiskLevel;
  if (!RISK_ORDER.includes(upper)) {
    throw new Error(`Invalid risk level: ${value}. Must be one of: safe, low, medium, high, critical`);
  }
  return upper;
}

const program = new Command();

program
  .name('pgfence')
  .description('Postgres migration safety CLI — lock mode analysis, risk scoring, and safe rewrite recipes')
  .version('0.1.0');

program
  .command('analyze')
  .description('Analyze migration files for safety issues')
  .argument('<files...>', 'Migration files to analyze')
  .option('--format <format>', 'Migration format: sql, typeorm, prisma, knex, auto', 'auto')
  .option('--output <output>', 'Output format: cli, json, github', 'cli')
  .option('--db-url <url>', 'Database URL for size-aware risk scoring')
  .option('--stats-file <path>', 'Path to pgfence-stats.json for size-aware risk scoring (alternative to --db-url)')
  .option('--min-pg-version <version>', 'Minimum PostgreSQL version to assume', '11')
  .option('--max-risk <risk>', 'Maximum allowed risk level for CI mode', 'high')
  .option('--ci', 'CI mode — exit 1 if max risk exceeded', false)
  .option('--no-lock-timeout', 'Disable lock_timeout requirement')
  .option('--no-statement-timeout', 'Disable statement_timeout requirement')
  .option('--api-key <key>', 'pgfence Cloud API key (or PGFENCE_API_KEY env)')
  .option('--api-url <url>', 'pgfence Cloud API URL', 'https://api.pgfence.dev')
  .option('--sync', 'Sync results to pgfence Cloud')
  .option('--fetch-policies', 'Fetch org policies from cloud')
  .option('--require-approval', 'Require cloud approval for HIGH+ risk')
  .option('--force', 'Bypass approval requirement (logged as bypass)')
  .action(async (files: string[], opts) => {
    // Load stats file if provided (alternative to --db-url)
    let tableStats: TableStats[] | undefined;
    if (opts.statsFile) {
      const raw = await readFile(opts.statsFile, 'utf8');
      const parsed = JSON.parse(raw);
      tableStats = Array.isArray(parsed) ? parsed : parsed.tables ?? parsed;
    }

    const config: PgfenceCloudConfig = {
      format: opts.format as PgfenceConfig['format'],
      output: opts.output as PgfenceConfig['output'],
      dbUrl: opts.dbUrl,
      tableStats,
      minPostgresVersion: Number.isNaN(parseInt(opts.minPgVersion, 10)) ? 11 : parseInt(opts.minPgVersion, 10),
      maxAllowedRisk: parseRiskLevel(opts.maxRisk),
      requireLockTimeout: opts.lockTimeout !== false,
      requireStatementTimeout: opts.statementTimeout !== false,
      ...(opts.apiKey || opts.sync || opts.fetchPolicies || opts.requireApproval
        ? {
            auth: { apiKey: opts.apiKey },
            cloud: {
              apiUrl: opts.apiUrl ?? 'https://api.pgfence.dev',
              syncResults: opts.sync ?? false,
              fetchPolicies: opts.fetchPolicies ?? false,
              requireApproval: opts.requireApproval ?? false,
              force: opts.force ?? false,
            },
          }
        : {}),
    };

    try {
      const { results } = await analyzeWithCloud(files, config);

      // Output
      switch (config.output) {
        case 'json':
          process.stdout.write(reportJSON(results) + '\n');
          break;
        case 'github':
          process.stdout.write(reportGitHub(results) + '\n');
          break;
        case 'cli':
        default:
          process.stdout.write(reportCLI(results) + '\n');
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

program.parse();
