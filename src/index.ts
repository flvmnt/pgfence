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
import { isEntryPoint, launchedAs, refuseSilentExit } from './entry-point.js';
import { reportCLI } from './reporters/cli.js';
import { reportJSON } from './reporters/json.js';
import { reportGitHub } from './reporters/github-pr.js';
import { reportSARIF } from './reporters/sarif.js';
import { reportGitLab } from './reporters/gitlab.js';
import {
  summarizeCoverage,
  formatNothingAnalyzed,
  formatPartialNoStatements,
} from './reporters/coverage.js';
import { loadConfigFile, mergeConfig, resolveProjectTelemetry } from './config.js';
import { LockMode, RiskLevel } from './types.js';
import type { AnalysisResult, PgfenceConfig, TableStats, TraceResult } from './types.js';
import type { FileFixReport } from './fix/index.js';
import type { TelemetryOutcome } from './telemetry/session.js';
import type { TelemetryCommand, TelemetryFormat, TelemetryRulesMode } from './telemetry/types.js';

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

function parseUnknownHandling(value: string): PgfenceConfig['unknownHandling'] {
  if (value !== 'warn' && value !== 'block') {
    throw new Error(`Invalid --unknown value: "${value}" (must be warn or block)`);
  }
  return value;
}

function optionFromCli(command: Command, name: string): boolean {
  return command.getOptionValueSource(name) === 'cli';
}

function parsePositiveIntOption(value: string, optionName: string): number {
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${optionName} value: "${value}" (must be a positive integer)`);
  }
  return parsed;
}

function applyAnalyzeOptionOverrides(
  command: Command,
  opts: {
    format?: string;
    output?: string;
    dbUrl?: string;
    minPgVersion?: string;
    maxRisk?: string;
    lockTimeout?: boolean;
    statementTimeout?: boolean;
    maxLockTimeout?: string;
    maxStatementTimeout?: string;
    snapshot?: string;
    plugin?: string[];
    disableRules?: string[];
    enableRules?: string[];
    unknown?: string;
  },
  overrides: Partial<PgfenceConfig>,
): void {
  if (optionFromCli(command, 'format') && opts.format) overrides.format = opts.format as PgfenceConfig['format'];
  if (optionFromCli(command, 'output') && opts.output) overrides.output = opts.output as PgfenceConfig['output'];
  if (optionFromCli(command, 'dbUrl')) overrides.dbUrl = opts.dbUrl;
  if (optionFromCli(command, 'minPgVersion') && opts.minPgVersion) {
    overrides.minPostgresVersion = parsePositiveIntOption(opts.minPgVersion, '--min-pg-version');
  }
  if (optionFromCli(command, 'maxRisk') && opts.maxRisk) overrides.maxAllowedRisk = parseRiskLevel(opts.maxRisk);
  if (optionFromCli(command, 'lockTimeout')) overrides.requireLockTimeout = opts.lockTimeout !== false;
  if (optionFromCli(command, 'statementTimeout')) overrides.requireStatementTimeout = opts.statementTimeout !== false;
  if (optionFromCli(command, 'unknown') && opts.unknown) overrides.unknownHandling = parseUnknownHandling(opts.unknown);
  if (optionFromCli(command, 'maxLockTimeout') && opts.maxLockTimeout) {
    overrides.maxLockTimeoutMs = parsePositiveIntOption(opts.maxLockTimeout, '--max-lock-timeout');
  }
  if (optionFromCli(command, 'maxStatementTimeout') && opts.maxStatementTimeout) {
    overrides.maxStatementTimeoutMs = parsePositiveIntOption(opts.maxStatementTimeout, '--max-statement-timeout');
  }
  if (optionFromCli(command, 'snapshot')) overrides.snapshotFile = opts.snapshot;
  if (optionFromCli(command, 'plugin')) overrides.plugins = opts.plugin;
  if (optionFromCli(command, 'disableRules') || optionFromCli(command, 'enableRules')) {
    overrides.rules = {};
    if (optionFromCli(command, 'disableRules')) overrides.rules.disable = opts.disableRules ?? [];
    if (optionFromCli(command, 'enableRules')) overrides.rules.enable = opts.enableRules ?? [];
  }
}

function hasUnanalyzableStatements(results: Awaited<ReturnType<typeof analyze>>): boolean {
  return results.some((result) => result.extractionWarnings?.some((warning) => warning.unanalyzable));
}

function shouldFailCI(results: Awaited<ReturnType<typeof analyze>>, config: PgfenceConfig): boolean {
  const maxAllowedIdx = RISK_ORDER.indexOf(config.maxAllowedRisk);
  for (const result of results) {
    const maxIdx = RISK_ORDER.indexOf(result.maxRisk);
    if (maxIdx > maxAllowedIdx) return true;
    if (result.policyViolations.some((v) => v.severity === 'error')) return true;
  }
  return config.unknownHandling === 'block' && hasUnanalyzableStatements(results);
}

/**
 * The two telemetry calls a command handler makes.
 *
 * Loaded lazily, and behind a catch, because telemetry must never be able to fail a run:
 * an import that rejects inside a command handler would do exactly that. session.ts
 * itself imports only node: builtins, so this costs a few hundred microseconds even on
 * an opted-out run, and node:https is loaded deeper still, only when a run actually
 * sends something.
 */
interface TelemetryApi {
  beginTelemetry(command: TelemetryCommand, projectSetting: boolean | undefined): void;
  finishTelemetry(outcome: TelemetryOutcome): Promise<void>;
}

async function loadTelemetry(): Promise<TelemetryApi> {
  try {
    return await import('./telemetry/session.js');
  } catch {
    // A pruned, patched or otherwise unloadable telemetry module changes nothing about
    // the command the user actually asked for.
    return {
      beginTelemetry: () => { /* telemetry unavailable */ },
      finishTelemetry: () => Promise.resolve(),
    };
  }
}

/** Whether the run used the stock ruleset or a customized one. A count, never rule ids. */
function telemetryRulesMode(config: PgfenceConfig): TelemetryRulesMode {
  const enabled = config.rules?.enable?.length ?? 0;
  const disabled = config.rules?.disable?.length ?? 0;
  if (enabled > 0 && disabled > 0) return 'both';
  if (enabled > 0) return 'enable';
  if (disabled > 0) return 'disable';
  return 'default';
}

/**
 * Finding counts for telemetry.
 *
 * Effective risk is always `adjustedRisk ?? risk`, never `risk` alone: --db-url and
 * --stats-file escalate risk, and the escalated value is the one the user saw.
 */
function telemetryFindings(
  checks: Array<{ risk: RiskLevel; adjustedRisk?: RiskLevel }>,
  violations: Array<{ severity: 'error' | 'warning' }>,
): NonNullable<TelemetryOutcome['findings']> {
  const countAt = (level: RiskLevel): number =>
    checks.filter((check) => (check.adjustedRisk ?? check.risk) === level).length;
  const policyErrors = violations.filter((violation) => violation.severity === 'error').length;
  return {
    safe: countAt(RiskLevel.SAFE),
    low: countAt(RiskLevel.LOW),
    medium: countAt(RiskLevel.MEDIUM),
    high: countAt(RiskLevel.HIGH),
    critical: countAt(RiskLevel.CRITICAL),
    policyErrors,
    policyWarnings: violations.length - policyErrors,
  };
}

/**
 * Telemetry outcome for a completed analyze or trace run.
 *
 * Everything here is a count or a value from a closed list. A file path, a file name, a
 * rule id, a table name and a SQL fragment are all unrepresentable in a TelemetryOutcome,
 * so the privacy boundary is enforced by the type system at the call site rather than by
 * review. See docs/telemetry.md.
 */
function telemetryOutcome(
  results: Awaited<ReturnType<typeof analyze>>,
  config: PgfenceConfig,
): TelemetryOutcome {
  const formats = new Set<TelemetryFormat>();
  for (const result of results) {
    if (result.detectedFormat != null) formats.add(result.detectedFormat);
  }
  return {
    errored: false,
    format: formats.size === 0 ? 'none' : formats.size === 1 ? [...formats][0] : 'mixed',
    rulesMode: telemetryRulesMode(config),
    pluginCount: config.plugins?.length ?? 0,
    fileCount: results.length,
    findings: telemetryFindings(
      results.flatMap((result) => result.checks),
      results.flatMap((result) => result.policyViolations),
    ),
  };
}

function maxRiskFromChecks(checks: Array<{ risk: RiskLevel; adjustedRisk?: RiskLevel }>): RiskLevel {
  let maxRisk = RiskLevel.SAFE;
  for (const check of checks) {
    const effective = check.adjustedRisk ?? check.risk;
    if (RISK_ORDER.indexOf(effective) > RISK_ORDER.indexOf(maxRisk)) {
      maxRisk = effective;
    }
  }
  return maxRisk;
}

function higherRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER.indexOf(a) >= RISK_ORDER.indexOf(b) ? a : b;
}

function emptyTrace(sql: string, executionError: string): TraceResult['traceChecks'][number] {
  return {
    statement: sql,
    statementPreview: sql.replace(/\s+/g, ' ').trim().slice(0, 200),
    tableName: null,
    lockMode: LockMode.ACCESS_SHARE,
    blocks: { reads: false, writes: false, otherDdl: false },
    risk: RiskLevel.MEDIUM,
    message: `Statement execution failed: ${executionError}`,
    ruleId: 'trace-error',
    verification: 'error',
    executionError,
  };
}

function hasExplicitTransactionStatement(parsedStatements: Array<{ nodeType: string }>): boolean {
  return parsedStatements.some((stmt) => stmt.nodeType === 'TransactionStmt');
}

const program = new Command();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isMainModule = isEntryPoint(import.meta);
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
  .option('--format <format>', 'Migration format: sql, typeorm, prisma, knex, drizzle, sequelize, kysely, auto', 'auto')
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
  .option('--unknown <mode>', 'How CI handles unanalyzable SQL: warn or block', 'warn')
  .option(
    '--fix',
    'Auto-fix a small, explicit allowlist of safe single-statement findings in place ' +
    '(CREATE/DROP INDEX CONCURRENTLY, missing lock_timeout/statement_timeout/idle timeout). ' +
    'Only rewrites files that resolve to the raw "sql" format. Everything else is reported, never guessed. ' +
    'With --ci, fixed files are re-analyzed from disk before CI gating, so --ci can never pass on stale ' +
    'pre-fix findings and still fails on anything --fix could not or did not resolve.',
    false,
  )
  .option(
    '--split',
    'With --fix: also scaffold new sibling *.sql files for the multi-migration safe-rewrite ' +
    'recipes (ADD COLUMN NOT NULL, ADD FOREIGN KEY, ADD UNIQUE) instead of leaving them manual. ' +
    'Never edits the original file. Has no effect without --fix.',
    false,
  )
  .action(async (files: string[], opts, command: Command) => {
    // Loaded above the try so the catch below can still reach finishTelemetry.
    const { beginTelemetry, finishTelemetry } = await loadTelemetry();
    try {
      // Load config file (.pgfence.toml or .pgfence.json)
      const fileConfig = await loadConfigFile(process.cwd());
      // The timer starts here, not after mergeConfig, so that a failure while loading
      // --stats-file is still recorded as an errored run. The project opt-out is resolved
      // from the whole repository, not just this directory, so a committed
      // `telemetry = false` still applies when pgfence runs from a subdirectory.
      beginTelemetry('analyze', await resolveProjectTelemetry(process.cwd(), fileConfig));

      // Load stats file if provided (alternative to --db-url)
      let tableStats: TableStats[] | undefined;
      const cliDbUrl = optionFromCli(command, 'dbUrl') ? opts.dbUrl : undefined;
      const cliStatsFilePath = optionFromCli(command, 'statsFile') ? opts.statsFile : undefined;
      const dbUrl = cliDbUrl ?? (cliStatsFilePath ? undefined : fileConfig?.['db-url']);
      const statsFilePath = dbUrl
        ? undefined
        : cliStatsFilePath ?? fileConfig?.['stats-file'];
      if (statsFilePath) {
        try {
          const raw = await readFile(statsFilePath, 'utf8');
          const parsed = JSON.parse(raw);
          const candidate = Array.isArray(parsed) ? parsed : parsed?.tables;
          if (!Array.isArray(candidate)) {
            throw new Error(
              `Invalid stats file format. Expected a JSON array of ` +
              `{schemaName, tableName, rowCount, totalBytes} objects (or { "tables": [ ... ] }).`,
            );
          }
          // Validate EVERY row, not just the first: a later row with a missing
          // or non-finite rowCount would otherwise slip through and (because
          // NaN >= threshold is false) silently leave a large table at base risk
          // instead of escalating it. Reject, do not coerce.
          candidate.forEach((row, i) => {
            const r = row as Partial<TableStats>;
            if (
              !r ||
              typeof r !== 'object' ||
              typeof r.tableName !== 'string' ||
              typeof r.rowCount !== 'number' ||
              !Number.isFinite(r.rowCount) ||
              r.rowCount < 0
            ) {
              const shape = row && typeof row === 'object' ? `keys: ${Object.keys(row).join(', ')}` : typeof row;
              throw new Error(
                `Invalid stats file format at row ${i}: each entry needs a string tableName and a ` +
                `finite non-negative numeric rowCount (${shape}).`,
              );
            }
          });
          tableStats = candidate as TableStats[];
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(`Failed to load stats file "${statsFilePath}": ${message}`);
        }
      }

      const cliOverrides: Partial<PgfenceConfig> = {};
      applyAnalyzeOptionOverrides(command, opts, cliOverrides);
      if (cliStatsFilePath && !cliDbUrl) cliOverrides.dbUrl = undefined;
      if (tableStats) cliOverrides.tableStats = tableStats;

      const config = mergeConfig(fileConfig, cliOverrides);

      const results = await analyze(files, config);

      // --fix / --split: apply Tier 1 in-place fixes and (with --split) generate
      // Tier 2 multi-file scaffolds. See src/fix/ for the exact allowlist and the
      // reasoning behind every included/excluded ruleId.
      //
      // --fix + --ci decision (documented here, not just in code): fixes are
      // applied FIRST, then the touched files are re-analyzed from disk before
      // CI gating and reporting use their result. This is deliberate: it means
      // --ci can never pass on stale pre-fix findings, and it doubles as a
      // sanity check on the fixer itself (a fix that failed to actually clear
      // its finding, or introduced a new one, shows up immediately instead of
      // being silently trusted). If unfixable findings remain above
      // --max-risk (or an error-severity policy violation remains), --ci still
      // fails, exactly as if --fix had not been passed.
      let finalResults = results;
      let fixReports: FileFixReport[] | undefined;
      if (opts.split && !opts.fix) {
        process.stderr.write('pgfence: --split has no effect without --fix; ignoring.\n');
      }
      if (opts.fix) {
        const { applyFixesToFile } = await import('./fix/index.js');
        fixReports = [];
        for (let i = 0; i < files.length; i++) {
          fixReports.push(await applyFixesToFile(files[i], results[i], config, { split: Boolean(opts.split) }));
        }
        if (fixReports.some((r) => r.modified)) {
          finalResults = await analyze(files, config);
        }
      }

      // Coverage is computed here, above telemetry, only so telemetry can see whether
      // this run is about to fail the zero-analysis gate. The gate itself stays where it
      // has to be, after the report is written. See the comment on it below.
      const runCoverage = summarizeCoverage(finalResults);

      // Telemetry: recorded once, before any reporter output, so that a single call site
      // covers every terminal path out of this handler (natural fall-through, the
      // zero-analysis gate and the --ci exit alike). Counts come from finalResults,
      // which under --fix is the post-fix analysis the reporters and the CI gate use.
      //
      // errored is forced true on the zero-analysis path. That run exits 2, and recording
      // it as a clean analyze would give the maintainers' own numbers exactly the false
      // safety this release exists to remove: a run that checked nothing would be
      // indistinguishable from a run that checked five files and found them clean.
      await finishTelemetry({
        ...telemetryOutcome(finalResults, config),
        errored: runCoverage.analyzedNothing,
      });

      // Output
      switch (config.output) {
        case 'json':
          process.stdout.write(reportJSON(finalResults) + '\n');
          break;
        case 'github':
          process.stdout.write(reportGitHub(finalResults) + '\n');
          break;
        case 'sarif':
          process.stdout.write(reportSARIF(finalResults) + '\n');
          break;
        case 'gitlab':
          process.stdout.write(reportGitLab(finalResults) + '\n');
          break;
        case 'cli':
        default:
          process.stdout.write(reportCLI(finalResults, config) + '\n');
          break;
      }

      if (fixReports) {
        const { formatFixSummary } = await import('./fix/report.js');
        const summary = formatFixSummary(fixReports);
        // Machine-readable formats must stay parseable on stdout; the fix
        // summary goes to stderr for those, and to stdout (alongside the
        // human-facing report) for cli/github.
        if (config.output === 'json' || config.output === 'sarif' || config.output === 'gitlab') {
          process.stderr.write(summary);
        } else {
          process.stdout.write(summary);
        }
      }

      // Trust Contract: a run that analyzed zero SQL statements has not checked
      // anything, and exiting 0 would report "your migrations are safe" about
      // migrations that were never read. This runs after any --fix re-analysis and
      // before the --ci gate, and it is not conditional on --ci: two documented CI
      // jobs (SARIF upload, GitLab Code Quality) deliberately run without it.
      // process.exitCode plus a return, never process.exit: on macOS a pipe is an
      // asynchronous stdout, and process.exit() right after writing truncates at the
      // 64KB pipe buffer (measured). `> pgfence.sarif` and `> gl-code-quality-report.json`
      // are documented jobs, and a half-written artifact fails their parser with an error
      // that has nothing to do with pgfence. Returning lets the report flush, and the
      // exit code is identical.
      if (runCoverage.analyzedNothing) {
        process.stderr.write(formatNothingAnalyzed(finalResults.map((r) => r.filePath)));
        process.exitCode = 2;
        return;
      }
      if (runCoverage.filesWithNoStatements.length > 0 &&
          (config.output === 'json' || config.output === 'sarif' || config.output === 'gitlab')) {
        // cli and github carry this per file inside the report body on stdout; the
        // machine formats must keep stdout byte-clean, so it goes to stderr there.
        process.stderr.write(
          formatPartialNoStatements(runCoverage.filesWithNoStatements, finalResults.length),
        );
      }

      // process.exitCode plus a return, for the same reason as the gate above: the
      // documented `--output sarif > pgfence.sarif` and `--output gitlab > report.json`
      // jobs pass --ci, and on macOS a piped stdout is asynchronous, so process.exit()
      // immediately after writing the report truncates it at the 64KB pipe buffer. The
      // success path already terminates by returning, so this changes only the code.
      if (opts.ci && shouldFailCI(finalResults, config)) {
        process.exitCode = 1;
        return;
      }
    } catch (err) {
      await finishTelemetry({ errored: true });
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`pgfence error: ${sanitizeError(message)}\n`);
      process.exit(2);
    }
  });

program
  .command('trace')
  .description('Trace migration files against a disposable Docker Postgres container')
  .argument('<files...>', 'Migration files to trace')
  .option('--format <format>', 'Migration format: sql, typeorm, prisma, knex, drizzle, sequelize, kysely, auto', 'auto')
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
  .option('--unknown <mode>', 'How CI handles unanalyzable SQL: warn or block', 'warn')
  .option('--pg-version <version>', 'PostgreSQL version for the Docker container', '17')
  .option('--docker-image <image>', 'Custom Docker image (overrides --pg-version)')
  .action(async (files: string[], opts, command: Command) => {
    const { beginTelemetry, finishTelemetry } = await loadTelemetry();
    try {
      // 1. Check Docker availability (fail fast)
      const { checkDockerAvailable, startContainer, waitForReady, stopContainer, traceStatement } = await import('./tracer.js');
      if (!checkDockerAvailable()) {
        process.stderr.write('pgfence trace: Docker is required. Install Docker or use "pgfence analyze" for static-only analysis.\n');
        process.exit(2);
      }

      // 2. Load config (same as analyze, minus db-url/stats-file)
      const fileConfig = await loadConfigFile(process.cwd());
      // After the Docker check on purpose: a missing Docker daemon exits before this and
      // is not a pgfence run worth counting.
      beginTelemetry('trace', await resolveProjectTelemetry(process.cwd(), fileConfig));

      const cliOverrides: Partial<PgfenceConfig> = {};
      applyAnalyzeOptionOverrides(command, opts, cliOverrides);

      const config = mergeConfig(fileConfig, cliOverrides);

      // 3. Run static analysis first (reuse existing analyze())
      const staticResults = await analyze(files, config);

      // 4. Start Docker container
      const pgVersion = parseInt(opts.pgVersion, 10) || 17;
      const container = await startContainer({
        pgVersion,
        dockerImage: opts.dockerImage,
      });

      // Declare DB clients outside try so they're accessible in finally for cleanup.
      // connect() returns Promise<Client> in pg 8.20+ (was Promise<void>); accept either via unknown.
      type PgClient = {
        end(): Promise<void>;
        connect(): Promise<unknown>;
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
          connect(): Promise<unknown>;
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
        const { extractSQL, parseExtractedStatements } = await import('./analyzer.js');

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
          const parsedStatements = await parseExtractedStatements(extraction, filePath);
          const statements = parsedStatements.map(s => s.sql);

          // Trace each statement
          const traces = [];
          const trackedOids: number[] = [];
          const observer = { client: observerClient, targetPid: traceClientPid };
          let traceChecks;
          if (hasExplicitTransactionStatement(parsedStatements)) {
            const executionError = 'trace mode cannot replay explicit transaction blocks faithfully; use analyze mode or remove BEGIN, COMMIT, ROLLBACK, and SAVEPOINT from the traced file';
            traceChecks = [
              ...staticResult.checks.map((check) => ({
                ...check,
                verification: 'static-only' as const,
              })),
              ...statements.map((sql) => emptyTrace(sql, executionError)),
            ];
          } else {
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
            traceChecks = mergeTraceWithStatic(staticResult.checks, traces, statements);
          }

          const traceMaxRisk = maxRiskFromChecks(traceChecks);
          const resultMaxRisk = higherRisk(staticResult.maxRisk, traceMaxRisk);

          // Count verification outcomes
          const verified = traceChecks.filter(c => c.verification === 'confirmed' || c.verification === 'mismatch').length;
          const mismatches = traceChecks.filter(c => c.verification === 'mismatch').length;
          const traceOnly = traceChecks.filter(c => c.verification === 'trace-only').length;
          const staticOnly = traceChecks.filter(c => c.verification === 'static-only').length;
          const errors = traceChecks.filter(c => c.verification === 'error').length;

          traceResults.push({
            ...staticResult,
            checks: traceChecks,
            maxRisk: resultMaxRisk,
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
        observerClient = undefined;
        await traceClient.end();
        traceClient = undefined;
        const containerLifetimeMs = Date.now() - containerStart;
        // Update all results with final container lifetime
        for (const r of traceResults) {
          r.containerLifetimeMs = containerLifetimeMs;
        }

        // Coverage first, so telemetry can see whether this run is about to fail the
        // zero-analysis gate below; the gate itself still runs after the report.
        const traceCoverage = summarizeCoverage(traceResults as unknown as AnalysisResult[]);

        // Telemetry before output, and never after the CI gate below: process.exit(1)
        // does not unwind the stack, so the finally that stops the container never runs
        // on that path and anything placed there would be dead code. errored is forced
        // true on the zero-analysis path for the same reason as in analyze: that run
        // exits 2, and counting it as a clean trace hides exactly the population worth
        // watching after shipping an always-on gate.
        await finishTelemetry({
          ...telemetryOutcome(traceResults, config),
          errored: traceCoverage.analyzedNothing,
        });

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

        // Trust Contract: same zero-analysis gate as `analyze`. process.exitCode plus a
        // return, never process.exit, so the enclosing finally still stops the container
        // and closes both clients. Leaking a Docker Postgres is not an acceptable price
        // for a correct exit code.
        if (traceCoverage.analyzedNothing) {
          process.stderr.write(formatNothingAnalyzed(traceResults.map((r) => r.filePath)));
          process.exitCode = 2;
          return;
        }

        // 9. CI mode
        if (opts.ci) {
          let shouldFail = false;
          for (const result of traceResults) {
            if (result.mismatches > 0) shouldFail = true;
            if (result.errors > 0) shouldFail = true;
          }
          if (shouldFailCI(traceResults, config)) shouldFail = true;
          if (shouldFail) process.exit(1);
        }
      } finally {
        // 10. Always clean up DB connections and the container
        try { await observerClient?.end(); } catch { /* cleanup */ }
        try { await traceClient?.end(); } catch { /* cleanup */ }
        stopContainer(container.name);
      }
    } catch (err) {
      await finishTelemetry({ errored: true });
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
    const { beginTelemetry, finishTelemetry } = await loadTelemetry();
    try {
      // snapshot does not otherwise read a project config, and reading one here must not
      // be able to change this command's exit code.
      let projectTelemetry: boolean | undefined;
      try {
        projectTelemetry = await resolveProjectTelemetry(process.cwd());
      } catch {
        // resolveProjectTelemetry already fails closed on its own, so this is defense in
        // depth: a malformed project config must not change this command's exit code, and
        // an unknown project setting is never read as consent.
        projectTelemetry = false;
      }
      beginTelemetry('snapshot', projectTelemetry);

      const { fetchSchemaSnapshot } = await import('./schema-snapshot.js');
      const snapshot = await fetchSchemaSnapshot(opts.dbUrl);
      await writeFile(opts.output, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
      process.stdout.write(`Schema snapshot written to ${opts.output} (${snapshot.tables.length} tables)\n`);
      await finishTelemetry({ errored: false });
    } catch (err) {
      await finishTelemetry({ errored: true });
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`pgfence snapshot error: ${sanitizeError(message)}\n`);
      process.exit(2);
    }
  });

program
  .command('init')
  .description('Install pgfence local hooks or CI workflow templates')
  .option('--prisma-github-action', 'Write a GitHub Actions workflow for Prisma migrations')
  .action(async (opts) => {
    const { installHooks, installPrismaGitHubAction } = await import('./init.js');
    const { beginTelemetry, finishTelemetry } = await loadTelemetry();
    try {
      // Same shape as snapshot: init does not otherwise read a project config, and
      // reading one here must not be able to change this command's exit code.
      let projectTelemetry: boolean | undefined;
      try {
        projectTelemetry = await resolveProjectTelemetry(process.cwd());
      } catch {
        // resolveProjectTelemetry already fails closed on its own, so this is defense in
        // depth: a malformed project config must not change this command's exit code, and
        // an unknown project setting is never read as consent.
        projectTelemetry = false;
      }
      beginTelemetry('init', projectTelemetry);

      if (opts.prismaGithubAction) {
        await installPrismaGitHubAction();
      } else {
        await installHooks();
      }
      await finishTelemetry({ errored: false });
    } catch (err) {
      await finishTelemetry({ errored: true });
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`pgfence init error: ${message}\n`);
      process.exit(2);
    }
  });

program
  .command('telemetry')
  .description('Show or change anonymous usage telemetry (status, enable, disable, reset)')
  .argument('[action]', 'status, enable, disable, or reset', 'status')
  .action(async (action: string) => {
    // This command emits no telemetry event of its own and never prints the first-run
    // notice: it prints its own, fuller report instead.
    try {
      const { runTelemetryCommand } = await import('./telemetry/session.js');
      // Resolved here rather than inside session.ts, which may not import the config
      // loader. Without it `status` could never report the project-config reason, so a
      // repo that committed `telemetry = false` would be told telemetry is enabled.
      const code = runTelemetryCommand(action, await resolveProjectTelemetry(process.cwd()));
      if (code !== 0) process.exit(code);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`pgfence telemetry error: ${message}\n`);
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

program
  .command('explain')
  .description('Explain the lock mode, risk, and safe rewrite for a single SQL statement (paste-and-run)')
  .argument('[sql...]', 'SQL statement (omit to read from stdin)')
  .option('--min-pg-version <version>', 'Minimum PostgreSQL version to assume')
  .option('--output <output>', 'Output format: cli, json', 'cli')
  .action(async (sqlParts: string[], opts, command: Command) => {
    const { beginTelemetry, finishTelemetry } = await loadTelemetry();
    try {
      if (opts.output !== 'cli' && opts.output !== 'json') {
        throw new Error(`Invalid --output value: "${opts.output}" (must be cli or json)`);
      }
      let sql = (sqlParts ?? []).join(' ').trim();
      if (!sql) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
        sql = Buffer.concat(chunks).toString('utf8').trim();
      }
      if (!sql) {
        process.stderr.write(
          'pgfence explain: no SQL provided. Pass as argument or pipe via stdin.\n' +
          '  pgfence explain "ALTER TABLE t ADD COLUMN x text NOT NULL"\n' +
          '  echo "CLUSTER big_table USING idx" | pgfence explain\n',
        );
        process.exit(2);
      }
      // Trailing semicolon optional in input. Normalize.
      if (!sql.endsWith(';')) sql = sql + ';';

      const { analyzeText } = await import('./lsp/analyze-text.js');
      const fileConfig = await loadConfigFile(process.cwd());
      beginTelemetry('explain', await resolveProjectTelemetry(process.cwd(), fileConfig));
      const cliOverrides: Partial<PgfenceConfig> = {
        requireLockTimeout: false,
        requireStatementTimeout: false,
        format: 'sql',
      };
      if (optionFromCli(command, 'minPgVersion') && opts.minPgVersion) {
        cliOverrides.minPostgresVersion = parsePositiveIntOption(opts.minPgVersion, '--min-pg-version');
      }
      const config = mergeConfig(fileConfig, cliOverrides);
      const result = await analyzeText({
        content: sql,
        filePath: 'explain.sql',
        config,
      });
      result.policyViolations = [];
      result.maxRisk = result.checks.reduce<RiskLevel>((max, check) => {
        const risk = check.adjustedRisk ?? check.risk;
        return RISK_ORDER.indexOf(risk) > RISK_ORDER.indexOf(max) ? risk : max;
      }, RiskLevel.SAFE);

      // One call site covers all four terminal paths below: the JSON return, the
      // parse-error exit(1), the no-issues return, and the final write.
      await finishTelemetry({
        errored: false,
        format: 'sql',
        fileCount: 0,
        pluginCount: 0,
        rulesMode: telemetryRulesMode(config),
        findings: telemetryFindings(result.checks, result.policyViolations),
      });

      if (opts.output === 'json') {
        process.stdout.write(JSON.stringify({
          statement: sql,
          maxRisk: result.maxRisk,
          checks: result.checks,
          policyViolations: result.policyViolations,
          extractionWarnings: result.extractionWarnings,
        }, null, 2) + '\n');
        return;
      }

      // CLI output: focused single-statement explainer
      const { default: chalk } = await import('chalk');
      const riskColor = (r: RiskLevel): (s: string) => string => {
        switch (r) {
          case RiskLevel.CRITICAL: return chalk.red.bold;
          case RiskLevel.HIGH: return chalk.red;
          case RiskLevel.MEDIUM: return chalk.yellow;
          case RiskLevel.LOW: return chalk.cyan;
          case RiskLevel.SAFE:
          default: return chalk.green;
        }
      };

      const lines: string[] = [];
      lines.push(chalk.bold('Statement:'));
      lines.push('  ' + sql);
      lines.push('');

      if (result.parseError) {
        lines.push(chalk.red('Parse error: ') + result.parseError);
        process.stdout.write(lines.join('\n') + '\n');
        process.exit(1);
      }

      if (result.checks.length === 0 && result.policyViolations.length === 0) {
        lines.push(chalk.green('No issues found.') + ' This statement is safe at the analyzer\'s level of detail.');
        lines.push('');
        lines.push(chalk.dim('Note: pgfence policy rules (lock_timeout, statement_timeout, etc.) are not surfaced for a single bare statement. Use `pgfence analyze` on a full migration file to see them.'));
        process.stdout.write(lines.join('\n') + '\n');
        return;
      }

      for (const check of result.checks) {
        const risk = check.adjustedRisk ?? check.risk;
        lines.push(riskColor(risk)(`[${risk}]`) + ' ' + chalk.bold(check.ruleId));
        lines.push('  ' + check.message);
        lines.push(chalk.dim(`  Lock: ${check.lockMode}`));
        const blocks: string[] = [];
        if (check.blocks.reads) blocks.push('reads');
        if (check.blocks.writes) blocks.push('writes');
        if (check.blocks.otherDdl) blocks.push('other DDL');
        if (blocks.length) {
          lines.push(chalk.dim(`  Blocks: ${blocks.join(', ')}`));
        }
        if (check.safeRewrite) {
          lines.push('');
          lines.push(chalk.bold('  Safe rewrite:'));
          lines.push(chalk.dim('  ' + check.safeRewrite.description));
          for (const step of check.safeRewrite.steps) {
            lines.push('    ' + step);
          }
        }
        lines.push('');
      }

      for (const v of result.policyViolations) {
        const sev = v.severity === 'error' ? chalk.red('[ERROR]') : chalk.yellow('[WARN]');
        lines.push(`${sev} ${chalk.bold(v.ruleId)}`);
        lines.push('  ' + v.message);
        lines.push(chalk.dim('  ' + v.suggestion));
        lines.push('');
      }

      process.stdout.write(lines.join('\n'));
    } catch (err) {
      await finishTelemetry({ errored: true });
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`pgfence explain error: ${sanitizeError(message)}\n`);
      process.exit(2);
    }
  });

if (isMainModule) {
  program.parse();
} else if (launchedAs('pgfence')) {
  refuseSilentExit(import.meta, 'pgfence');
}
