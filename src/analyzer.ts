/**
 * Core analyzer — maps parsed SQL statements to lock modes and risk levels.
 *
 * Pipeline per file:
 * 1. Select extractor by config.format (or auto-detect)
 * 2. Extract SQL string (with warnings)
 * 3. Parse via parser.ts
 * 4. Apply statement-level rules
 * 5. Apply policy checks
 * 6. If DB URL provided, fetch table stats and adjust risk levels
 * 7. Compute maxRisk
 */

import { readFile } from 'node:fs/promises';
import { parseSQL } from './parser.js';
import type { ParsedStatement } from './parser.js';
import { checkAddColumn } from './rules/add-column.js';
import { checkCreateIndex } from './rules/create-index.js';
import { checkAlterColumn } from './rules/alter-column.js';
import { checkAddConstraint } from './rules/add-constraint.js';
import { checkDestructive } from './rules/destructive.js';
import { checkRenameColumn } from './rules/rename-column.js';
import { checkBestPractices } from './rules/best-practices.js';
import { checkPreferRobustStmts } from './rules/prefer-robust-stmts.js';
import { checkPolicies } from './rules/policy.js';
import { fetchTableStats } from './db-stats.js';
import { getCloudHooks } from './cloud-hooks.js';
import type {
  AnalysisResult,
  CheckResult,
  ExtractionResult,
  PgfenceConfig,
  RiskLevel as RiskLevelType,
  TableStats,
} from './types.js';
import { RiskLevel } from './types.js';

// Risk levels ordered for comparison — exported for CLI exit code logic
export const RISK_ORDER: RiskLevelType[] = [
  RiskLevel.SAFE,
  RiskLevel.LOW,
  RiskLevel.MEDIUM,
  RiskLevel.HIGH,
  RiskLevel.CRITICAL,
];

function riskIndex(risk: RiskLevelType): number {
  return RISK_ORDER.indexOf(risk);
}

function maxRiskLevel(a: RiskLevelType, b: RiskLevelType): RiskLevelType {
  return riskIndex(a) >= riskIndex(b) ? a : b;
}

/**
 * Adjust risk based on table row count.
 * Exported for testing.
 */
export function adjustRisk(baseRisk: RiskLevelType, rowCount: number): RiskLevelType {
  if (rowCount >= 10_000_000) return RiskLevel.CRITICAL;

  let bump = 0;
  if (rowCount >= 1_000_000) bump = 2;
  else if (rowCount >= 10_000) bump = 1;

  if (bump === 0) return baseRisk;

  const idx = riskIndex(baseRisk);
  const newIdx = Math.min(idx + bump, RISK_ORDER.length - 1);
  return RISK_ORDER[newIdx];
}

/**
 * Analyze migration files and return results.
 */
export async function analyze(
  filePaths: string[],
  config: PgfenceConfig,
): Promise<AnalysisResult[]> {
  const hooks = await getCloudHooks();
  if (hooks.onAnalysisStart) {
    await hooks.onAnalysisStart(filePaths, config);
  }

  // Fetch DB stats once if needed (--db-url takes precedence, then --stats-file)
  let tableStatsMap: Map<string, TableStats> | null = null;
  let allTableStats: TableStats[] | undefined;
  const rawStats = config.dbUrl
    ? await fetchTableStats(config.dbUrl)
    : config.tableStats ?? null;
  if (rawStats) {
    allTableStats = rawStats;
    tableStatsMap = new Map();
    for (const s of rawStats) {
      // Normalize to lowercase — Postgres identifiers are case-insensitive unless quoted
      const lower = s.tableName.toLowerCase();
      tableStatsMap.set(lower, s);
      tableStatsMap.set(`${s.schemaName.toLowerCase()}.${lower}`, s);
    }
  }

  const results: AnalysisResult[] = [];

  for (const filePath of filePaths) {
    const extraction = await extractSQL(filePath, config);
    const stmts = extraction.sql.trim()
      ? await parseSQL(extraction.sql)
      : [];

    // Track tables created in this migration for visibility logic (Eugene's pattern).
    // Operations on newly-created tables don't need safety warnings since
    // the table has no existing data or concurrent readers.
    const createdTables = new Set<string>();
    for (const stmt of stmts) {
      if (stmt.nodeType === 'CreateStmt') {
        const createNode = stmt.node as { relation?: { relname?: string } };
        if (createNode.relation?.relname) {
          createdTables.add(createNode.relation.relname.toLowerCase());
        }
      }
    }

    // Apply statement-level rules (respecting inline ignore directives + visibility logic)
    const checks: CheckResult[] = [];
    for (const stmt of stmts) {
      const rawChecks = applyRules(stmt, config);
      for (const check of rawChecks) {
        // Filter: inline ignore directives (-- pgfence: ignore <ruleId>)
        if (stmt.ignoredRules?.includes(check.ruleId)) continue;
        // Filter: visibility logic — skip warnings for tables created in this migration
        // (but best-practice checks with appliesToNewTables still fire)
        if (check.tableName && createdTables.has(check.tableName.toLowerCase()) && !check.appliesToNewTables) continue;
        checks.push(check);
      }
    }

    // Apply policy checks
    const policyViolations = checkPolicies(stmts, config);

    // Adjust risk if DB stats available
    if (tableStatsMap) {
      for (const check of checks) {
        if (check.tableName) {
          const stats = tableStatsMap.get(check.tableName.toLowerCase());
          if (stats) {
            check.adjustedRisk = adjustRisk(check.risk, stats.rowCount);
          }
        }
      }
    }

    // Compute max risk (use adjustedRisk when available)
    let maxRisk: RiskLevelType = RiskLevel.SAFE;
    for (const check of checks) {
      const effective = check.adjustedRisk ?? check.risk;
      maxRisk = maxRiskLevel(maxRisk, effective);
    }

    results.push({
      filePath,
      checks,
      policyViolations,
      maxRisk,
      statementCount: stmts.length,
      extractionWarnings: extraction.warnings.length > 0 ? extraction.warnings : undefined,
      tableStats: allTableStats,
    });
  }

  if (hooks.onAnalysisComplete) {
    await hooks.onAnalysisComplete(results, config);
  }

  return results;
}

function applyRules(stmt: ParsedStatement, config: PgfenceConfig): CheckResult[] {
  const results: CheckResult[] = [];
  results.push(...checkAddColumn(stmt, config));
  results.push(...checkCreateIndex(stmt));
  results.push(...checkAlterColumn(stmt, config));
  results.push(...checkAddConstraint(stmt));
  results.push(...checkDestructive(stmt));
  results.push(...checkRenameColumn(stmt, config));
  results.push(...checkBestPractices(stmt));
  results.push(...checkPreferRobustStmts(stmt));
  return results;
}

/**
 * Auto-detect migration format from file path and content.
 */
export function detectFormat(filePath: string, content: string): PgfenceConfig['format'] {
  if (filePath.endsWith('.sql')) {
    // Check if it's inside a prisma/migrations directory
    if (filePath.includes('prisma/migrations') || filePath.includes('prisma\\migrations')) {
      return 'prisma';
    }
    // Check if it's inside a drizzle directory
    if (filePath.includes('drizzle') || filePath.includes('drizzle')) {
      return 'drizzle';
    }
    return 'sql';
  }

  if (filePath.endsWith('.ts') || filePath.endsWith('.js')) {
    // Check for strong TypeORM markers
    if (content.includes('MigrationInterface') || content.includes('queryRunner.query')) {
      return 'typeorm';
    }
    // Check for strong Knex markers — require knex/trx reference alongside exports.up
    const hasKnexRef = content.includes('knex.raw') || content.includes('trx.raw') || content.includes('knex.schema');
    const hasKnexExport = content.includes('exports.up') && (content.includes('knex') || content.includes('Knex'));
    if (hasKnexRef || hasKnexExport) {
      return 'knex';
    }
    // Check for Sequelize markers
    if (content.includes('queryInterface')) {
      return 'sequelize';
    }
    throw new Error(
      `Cannot auto-detect migration format for ${filePath}. ` +
      `No TypeORM (MigrationInterface, queryRunner), Knex (knex.raw), or Sequelize (queryInterface) markers found. ` +
      `Use --format to specify explicitly.`,
    );
  }

  throw new Error(
    `Unsupported file extension for ${filePath}. Expected .sql, .ts, or .js`,
  );
}

async function extractSQL(
  filePath: string,
  config: PgfenceConfig,
): Promise<ExtractionResult> {
  let format = config.format;

  if (format === 'auto') {
    // Need to read file for content-based detection
    const content = await readFile(filePath, 'utf8');
    format = detectFormat(filePath, content);
  }

  switch (format) {
    case 'sql': {
      const { extractRawSQL } = await import('./extractors/raw-sql.js');
      return extractRawSQL(filePath);
    }
    case 'prisma': {
      const { extractPrismaSQL } = await import('./extractors/prisma.js');
      return extractPrismaSQL(filePath);
    }
    case 'typeorm': {
      const { extractTypeORMSQL } = await import('./extractors/typeorm.js');
      return extractTypeORMSQL(filePath);
    }
    case 'knex': {
      const { extractKnexSQL } = await import('./extractors/knex.js');
      return extractKnexSQL(filePath);
    }
    case 'drizzle': {
      const { extractDrizzleSQL } = await import('./extractors/drizzle.js');
      return extractDrizzleSQL(filePath);
    }
    case 'sequelize': {
      const { extractSequelizeSQL } = await import('./extractors/sequelize.js');
      return extractSequelizeSQL(filePath);
    }
    default:
      throw new Error(`Unknown format: ${format}`);
  }
}
