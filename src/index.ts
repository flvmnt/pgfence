#!/usr/bin/env node
/**
 * pgfence: Postgres migration safety CLI
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
import { reportGitLab } from './reporters/gitlab.js';
import { loadConfigFile, mergeConfig } from './config.js';
import { RiskLevel } from './types.js';
import type { PgfenceConfig, TableStats, TraceResult } from './types.js';

/** Strip credentials from postgres:// URLs in error messages. */
function sanitizeError(msg: string): string {
  return msg.replace(/postgre(?:s|sql):\/\/[^@\s]*@/gi, 'postgres://***@');
}

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
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`pgfence: could not read package.json at ${pkgPath}: ${message}\n`);
  process.exit(2);
}

program
  .name('pgfence')
  .description('Postgres migration safety CLI: lock mode analysis, risk scoring, and safe rewrite recipes')
  .version(pkg.version);

program
  .command('analyze')
  .description('Analyze migration files for safety issues')
  .argument('<files...>', 'Migration files to analyze')
  .option('--format <format>', 'Migration format: sql, typeorm, prisma, knex, drizzle, sequelize, auto', 'auto')
  .option('--output <output>', 'Output format: cli, json, github, sarif, gitlab', 'cli')
  .option('--db-url <url>', 'Database URL for size-aware risk scoring')
  .option('--stats-file <path>', 'Path to pgfence-stats.json for size-aware risk scoring (alternative to --db-url)')
  .option('--min-pg-version <version>', 'Minimum PostgreSQL version to assume', '14')
  .option('--max-risk <risk>', 'Maximum allowed risk level for CI mode', 'high')
  .option('--ci', 'CI mode: exit 1 if max risk exceeded', false)
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
      try {
        const raw = await readFile(statsFilePath, 'utf8');
        const parsed = JSON.parse(raw);
        tableStats = Array.isArray(parsed) ? parsed : parsed.tables ?? parsed;
        if (tableStats && tableStats.length > 0) {
          const sample = tableStats[0];
          if (typeof sample.tableName !== 'string' || typeof sample.rowCount !== 'number') {
            throw new Error(
              `Invalid stats file format. Expected objects with {schemaName, tableName, rowCount, totalBytes}. ` +
              `Got keys: ${Object.keys(sample).join(', ')}`,
            );
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to load stats file "${statsFilePath}": ${message}`);
      }
    }

    // Build CLI overrides
    const cliOverrides: Partial<PgfenceConfig> = {
      format: opts.format as PgfenceConfig['format'],
      output: opts.output as PgfenceConfig['output'],
      dbUrl: opts.dbUrl,
      tableStats,
      minPostgresVersion: Number.isNaN(parseInt(opts.minPgVersion, 10)) ? 14 : parseInt(opts.minPgVersion, 10),
      maxAllowedRisk: parseRiskLevel(opts.maxRisk),
      requireLockTimeout: opts.lockTimeout !== false,
      requireStatementTimeout: opts.statementTimeout !== false,
    };

    if (opts.maxLockTimeout) {
      const parsed = parseInt(opts.maxLockTimeout, 10);
      if (Number.isNaN(parsed) || parsed <= 0) throw new Error(`Invalid --max-lock-timeout value: "${opts.maxLockTimeout}" (must be a positive integer)`);
      cliOverrides.maxLockTimeoutMs = parsed;
    }
    if (opts.maxStatementTimeout) {
      const parsed = parseInt(opts.maxStatementTimeout, 10);
      if (Number.isNaN(parsed) || parsed <= 0) throw new Error(`Invalid --max-statement-timeout value: "${opts.maxStatementTimeout}" (must be a positive integer)`);
      cliOverrides.maxStatementTimeoutMs = parsed;
    }
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
        case 'gitlab':
          process.stdout.write(reportGitLab(results) + '\n');
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
      process.stderr.write(`pgfence error: ${sanitizeError(message)}\n`);
      process.exit(2);
    }
  });

program
  .command('trace')
  .description('Trace migration files against a disposable Docker Postgres container')
  .argument('<files...>', 'Migration files to trace')
  .option('--format <format>', 'Migration format: sql, typeorm, prisma, knex, drizzle, sequelize, auto', 'auto')
  .option('--output <output>', 'Output format: cli, json, github, sarif, gitlab', 'cli')
  .option('--min-pg-version <version>', 'Minimum PostgreSQL version to assume for static analysis', '14')
  .option('--max-risk <risk>', 'Maximum allowed risk level for CI mode', 'high')
  .option('--ci', 'CI mode: exit 1 if max risk exceeded or mismatches detected', false)
  .option('--no-lock-timeout', 'Disable lock_timeout requirement')
  .option('--no-statement-timeout', 'Disable statement_timeout requirement')
  .option('--max-lock-timeout <ms>', 'Maximum allowed lock_timeout in ms (default: 5000)')
  .option('--max-statement-timeout <ms>', 'Maximum allowed statement_timeout in ms (default: 600000)')
  .option('--disable-rules <rules...>', 'Disable specific rules by ID')
  .option('--enable-rules <rules...>', 'Enable only specific rules by ID (whitelist)')
  .option('--snapshot <path>', 'Schema snapshot JSON for definitive type analysis')
  .option('--plugin <paths...>', 'Plugin file paths for custom rules')
  .option('--pg-version <version>', 'PostgreSQL version for the Docker container', '17')
  .option('--docker-image <image>', 'Custom Docker image (overrides --pg-version)')
  .action(async (files: string[], opts) => {
    // 1. Check Docker availability (fail fast)
    const { checkDockerAvailable, startContainer, waitForReady, stopContainer, traceStatement } = await import('./tracer.js');
    if (!checkDockerAvailable()) {
      process.stderr.write('pgfence trace: Docker is required. Install Docker or use "pgfence analyze" for static-only analysis.\n');
      process.exit(2);
    }

    // 2. Load config (same as analyze, minus db-url/stats-file)
    const fileConfig = await loadConfigFile(process.cwd());

    const cliOverrides: Partial<PgfenceConfig> = {
      format: opts.format as PgfenceConfig['format'],
      output: opts.output as PgfenceConfig['output'],
      minPostgresVersion: Number.isNaN(parseInt(opts.minPgVersion, 10)) ? 14 : parseInt(opts.minPgVersion, 10),
      maxAllowedRisk: parseRiskLevel(opts.maxRisk),
      requireLockTimeout: opts.lockTimeout !== false,
      requireStatementTimeout: opts.statementTimeout !== false,
    };

    if (opts.maxLockTimeout) {
      const parsed = parseInt(opts.maxLockTimeout, 10);
      if (Number.isNaN(parsed) || parsed <= 0) throw new Error(`Invalid --max-lock-timeout value: "${opts.maxLockTimeout}" (must be a positive integer)`);
      cliOverrides.maxLockTimeoutMs = parsed;
    }
    if (opts.maxStatementTimeout) {
      const parsed = parseInt(opts.maxStatementTimeout, 10);
      if (Number.isNaN(parsed) || parsed <= 0) throw new Error(`Invalid --max-statement-timeout value: "${opts.maxStatementTimeout}" (must be a positive integer)`);
      cliOverrides.maxStatementTimeoutMs = parsed;
    }
    if (opts.snapshot) cliOverrides.snapshotFile = opts.snapshot;
    if (opts.plugin) cliOverrides.plugins = opts.plugin;
    if (opts.disableRules || opts.enableRules) {
      cliOverrides.rules = {};
      if (opts.disableRules) cliOverrides.rules.disable = opts.disableRules;
      if (opts.enableRules) cliOverrides.rules.enable = opts.enableRules;
    }

    const config = mergeConfig(fileConfig, cliOverrides);

    try {
      // 3. Run static analysis first (reuse existing analyze())
      const staticResults = await analyze(files, config);

      // 4. Start Docker container
      const pgVersion = parseInt(opts.pgVersion, 10) || 17;
      const container = await startContainer({
        pgVersion,
        dockerImage: opts.dockerImage,
      });

      // Declare DB clients outside try so they're accessible in finally for cleanup
      type PgClient = {
        end(): Promise<void>;
        connect(): Promise<void>;
        query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
      };
      let traceClient: PgClient | undefined;
      let observerClient: PgClient | undefined;

      try {
        // 5. Wait for container to be ready
        await waitForReady(container);
        const containerStart = Date.now();

        // 6. Connect to the container's default database
        const pg = await import('pg');
        const ClientClass = (pg.default?.Client ?? pg.Client) as new (config: {
          host: string;
          port: number;
          user: string;
          password: string;
          database: string;
        }) => {
          connect(): Promise<void>;
          query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
          end(): Promise<void>;
        };
        const client = new ClientClass({
          host: '127.0.0.1',
          port: container.port,
          user: 'postgres',
          password: container.password,
          database: 'postgres',
        });
        await client.connect();

        // Create a dedicated database for tracing
        await client.query('CREATE DATABASE pgfence_trace');
        await client.end();

        // Reconnect to the trace database
        traceClient = new ClientClass({
          host: '127.0.0.1',
          port: container.port,
          user: 'postgres',
          password: container.password,
          database: 'pgfence_trace',
        });
        await traceClient.connect();

        // Create observer connection for CONCURRENTLY lock polling
        observerClient = new ClientClass({
          host: '127.0.0.1',
          port: container.port,
          user: 'postgres',
          password: container.password,
          database: 'pgfence_trace',
        });
        await observerClient.connect();

        // Get the traceClient's PID for observer polling
        const pidResult = await traceClient.query('SELECT pg_backend_pid() AS pid');
        const traceClientPid = Number(pidResult.rows[0].pid);

        // 7. For each file's static result, trace each statement
        const { mergeTraceWithStatic } = await import('./trace-merge.js');
        const { reportTraceCLI } = await import('./reporters/trace-cli.js');
        const { parseSQL } = await import('./parser.js');
        const { extractSQL } = await import('./analyzer.js');

        const traceResults: TraceResult[] = [];

        for (let fileIdx = 0; fileIdx < staticResults.length; fileIdx++) {
          const staticResult = staticResults[fileIdx];

          // Reset session state between files to prevent leakage (search_path, timeouts, etc.)
          if (fileIdx > 0) {
            await traceClient.query('RESET ALL');
          }

          // Create isolated schema per file (safe: fileIdx is an integer)
          const schemaName = `pgfence_file_${fileIdx}`;
          await traceClient.query(`CREATE SCHEMA "${schemaName}"`);
          await traceClient.query(
            `SELECT pg_catalog.set_config('search_path', $1 || ', public', false)`,
            [schemaName],
          );

          // Re-read and extract SQL from the file (handles ORM formats)
          const filePath = files[fileIdx];
          const extraction = await extractSQL(filePath, config);
          let statements: string[] = [];
          if (extraction.sql.trim()) {
            const parsed = await parseSQL(extraction.sql);
            statements = parsed.map(s => s.sql);
          }

          // Trace each statement
          const traces = [];
          const trackedOids: number[] = [];
          const observer = { client: observerClient, targetPid: traceClientPid };
          for (const sql of statements) {
            const isConcurrent = /\bCONCURRENTLY\b/i.test(sql);
            const trace = await traceStatement(
              traceClient, sql, trackedOids, isConcurrent,
              isConcurrent ? observer : undefined,
            );
            traces.push(trace);
            // Add new objects to tracked OIDs for subsequent statements
            for (const obj of trace.newObjects) {
              trackedOids.push(obj.oid);
            }
          }

          // Merge static checks with traces
          const traceChecks = mergeTraceWithStatic(staticResult.checks, traces, statements);

          // Count verification outcomes
          const verified = traceChecks.filter(c => c.verification === 'confirmed' || c.verification === 'mismatch').length;
          const mismatches = traceChecks.filter(c => c.verification === 'mismatch').length;
          const traceOnly = traceChecks.filter(c => c.verification === 'trace-only').length;
          const staticOnly = traceChecks.filter(c => c.verification === 'static-only').length;
          const errors = traceChecks.filter(c => c.verification === 'error').length;

          traceResults.push({
            ...staticResult,
            traceChecks,
            verified,
            mismatches,
            traceOnly,
            staticOnly,
            errors,
            pgVersion,
            containerLifetimeMs: Date.now() - containerStart,
          });
        }

        await observerClient.end();
        await traceClient.end();
        const containerLifetimeMs = Date.now() - containerStart;
        // Update all results with final container lifetime
        for (const r of traceResults) {
          r.containerLifetimeMs = containerLifetimeMs;
        }

        // 8. Output
        switch (config.output) {
          case 'json':
            process.stdout.write(reportJSON(traceResults) + '\n');
            break;
          case 'github':
            process.stdout.write(reportGitHub(traceResults) + '\n');
            break;
          case 'sarif':
            process.stdout.write(reportSARIF(traceResults) + '\n');
            break;
          case 'gitlab':
            process.stdout.write(reportGitLab(traceResults) + '\n');
            break;
          case 'cli':
          default:
            process.stdout.write(reportTraceCLI(traceResults) + '\n');
            break;
        }

        // 9. CI mode
        if (opts.ci) {
          const maxAllowedIdx = RISK_ORDER.indexOf(config.maxAllowedRisk);
          let shouldFail = false;
          for (const result of traceResults) {
            if (RISK_ORDER.indexOf(result.maxRisk) > maxAllowedIdx) shouldFail = true;
            if (result.policyViolations.some(v => v.severity === 'error')) shouldFail = true;
            if (result.mismatches > 0) shouldFail = true;
            if (result.errors > 0) shouldFail = true;
          }
          if (shouldFail) process.exit(1);
        }
      } finally {
        // 10. Always clean up DB connections and the container
        try { await observerClient?.end(); } catch { /* cleanup */ }
        try { await traceClient?.end(); } catch { /* cleanup */ }
        stopContainer(container.name);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`pgfence trace error: ${sanitizeError(message)}\n`);
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
      process.stderr.write(`pgfence snapshot error: ${sanitizeError(message)}\n`);
      process.exit(2);
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
      process.exit(2);
    }
  });

program
  .command('lsp')
  .description('Start the pgfence Language Server Protocol server (stdio)')
  .action(async () => {
    try {
      const { startStdioServer } = await import('./lsp/server.js');
      await startStdioServer();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`pgfence lsp error: ${message}\n`);
      process.exit(2);
    }
  });

program.parse();
