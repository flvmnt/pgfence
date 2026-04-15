/**
 * In-memory analysis API for the LSP server.
 *
 * Analyzes SQL content from a string (no file I/O) using the same
 * rule engine as the CLI. Returns results with byte offset source ranges
 * for diagnostic positioning.
 */

import { parseSQL } from '../parser.js';
import type { ParsedStatement } from '../parser.js';
import { applyRules, filterByRulesConfig, adjustRisk, detectFormat, RISK_ORDER } from '../analyzer.js';
import { checkPolicies } from '../rules/policy.js';
import { getStatementTableKey } from '../table-ref.js';
import { loadSnapshot, loadSnapshotFile } from '../schema-snapshot.js';
import { RiskLevel } from '../types.js';
import type {
  CheckResult,
  ExtractionWarning,
  PgfenceConfig,
  PolicyViolation,
  RiskLevel as RiskLevelType,
  TableStats,
} from '../types.js';
import type { SchemaLookup } from '../schema-snapshot.js';

export interface AnalyzeTextOptions {
  /** In-memory file content */
  content: string;
  /** File path (for format detection, not reading) */
  filePath: string;
  /** pgfence config */
  config: PgfenceConfig;
  /** Optional pre-loaded table stats */
  tableStats?: TableStats[];
}

export interface SourceRange {
  /** Byte offset of this result's start in the original content */
  startOffset: number;
  /** Byte offset of this result's end in the original content */
  endOffset: number;
}

export interface AnalyzeTextResult {
  checks: CheckResult[];
  policyViolations: PolicyViolation[];
  extractionWarnings: ExtractionWarning[];
  maxRisk: RiskLevelType;
  statementCount: number;
  /** Set when the SQL could not be parsed */
  parseError?: string;
  /** Byte offset ranges in the original content for each check */
  sourceRanges: SourceRange[];
  /** Byte offset ranges for each policy violation (null for file-level) */
  policySourceRanges: Array<SourceRange | null>;
}

function riskIndex(risk: RiskLevelType): number {
  return RISK_ORDER.indexOf(risk);
}

function maxRiskLevel(a: RiskLevelType, b: RiskLevelType): RiskLevelType {
  return riskIndex(a) >= riskIndex(b) ? a : b;
}

/**
 * Extract SQL from in-memory content based on format.
 * For raw SQL, returns content as-is. For ORM formats, uses extractors.
 */
async function extractSQLFromContent(
  content: string,
  filePath: string,
  format: PgfenceConfig['format'],
): Promise<{ sql: string; warnings: ExtractionWarning[]; autoCommit?: boolean }> {
  if (format === 'sql' || format === 'prisma' || format === 'drizzle') {
    // Strip UTF-8 BOM
    let sql = content;
    if (sql.charCodeAt(0) === 0xfeff) {
      sql = sql.slice(1);
    }
    return { sql, warnings: [] };
  }

  switch (format) {
    case 'typeorm': {
      const { extractTypeORMSQLFromSource } = await import('../extractors/typeorm.js');
      return extractTypeORMSQLFromSource(content, filePath);
    }
    case 'knex': {
      const { extractKnexSQLFromSource } = await import('../extractors/knex.js');
      return extractKnexSQLFromSource(content, filePath);
    }
    case 'sequelize': {
      const { extractSequelizeSQLFromSource } = await import('../extractors/sequelize.js');
      return extractSequelizeSQLFromSource(content, filePath);
    }
    default:
      return { sql: content, warnings: [] };
  }
}

/**
 * Analyze SQL content in-memory and return results with source ranges.
 */
export async function analyzeText(options: AnalyzeTextOptions): Promise<AnalyzeTextResult> {
  const { content, filePath, config, tableStats } = options;

  const result: AnalyzeTextResult = {
    checks: [],
    policyViolations: [],
    extractionWarnings: [],
    maxRisk: RiskLevel.SAFE,
    statementCount: 0,
    sourceRanges: [],
    policySourceRanges: [],
  };

  // Detect format
  let format = config.format;
  if (format === 'auto') {
    try {
      format = detectFormat(filePath, content);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.extractionWarnings.push({
        filePath,
        message: `Format auto-detection failed: ${message}. Treating as raw SQL.`,
        line: 1,
        column: 1,
      });
      format = 'sql';
    }
  }

  // Extract SQL
  let sql: string;
  let autoCommit: boolean | undefined;
  try {
    const extraction = await extractSQLFromContent(content, filePath, format);
    sql = extraction.sql;
    autoCommit = extraction.autoCommit;
    result.extractionWarnings.push(...extraction.warnings);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.extractionWarnings.push({
      message: `SQL extraction error: ${message}`,
      filePath,
      line: 1,
      column: 1,
    });
    return result;
  }

  if (!sql.trim()) return result;

  // Parse SQL
  let stmts: ParsedStatement[];
  try {
    stmts = await parseSQL(sql);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.parseError = message;
    return result;
  }

  result.statementCount = stmts.length;

  const schemaLookup: SchemaLookup | undefined = config.snapshotFile
    ? loadSnapshot(await loadSnapshotFile(config.snapshotFile))
    : undefined;

  // Track tables created in this migration
  const createdTables = new Set<string>();
  const writtenTables = new Set<string>();

  // Apply statement-level rules
  for (const stmt of stmts) {
    const stmtTableKey = getStatementTableKey(stmt);
    if (stmt.nodeType === 'CreateStmt' && stmtTableKey) {
      createdTables.add(stmtTableKey);
    }
    if (stmtTableKey && isDataModifyingStatement(stmt)) {
      writtenTables.add(stmtTableKey);
    }

    // Flag DO blocks/functions as unanalyzable
    if (stmt.nodeType === 'DoStmt' || stmt.nodeType === 'CreateFunctionStmt' || stmt.nodeType === 'CreateProcedureStmt') {
      // Compute actual line from statement offset
      let warnLine = 1;
      for (let j = 0; j < stmt.startOffset && j < sql.length; j++) {
        if (sql.charCodeAt(j) === 10) warnLine++;
      }
      result.extractionWarnings.push({
        message: 'Unanalyzable dynamic SQL block detected, manual review required',
        filePath,
        line: warnLine,
        column: 0,
        unanalyzable: true,
      });
    }

    const rawChecks = filterByRulesConfig(applyRules(stmt, config, schemaLookup), config.rules);
    for (const check of rawChecks) {
      // Inline ignore directives
      if (stmt.ignoredRules?.includes('*') || stmt.ignoredRules?.includes(check.ruleId)) continue;
      // Visibility: skip for newly-created tables
      if (stmtTableKey && createdTables.has(stmtTableKey) && !writtenTables.has(stmtTableKey) && !check.appliesToNewTables) continue;

      result.checks.push(check);
      result.sourceRanges.push({
        startOffset: stmt.startOffset,
        endOffset: stmt.endOffset,
      });
    }
  }

  // Apply policy checks
  const policies = filterByRulesConfig(
    checkPolicies(stmts, config, { autoCommit }),
    config.rules,
  );
  result.policyViolations = policies;
  // Map statement-level policies to their actual statement byte offsets;
  // file-level policies (no statementIndex) get null.
  result.policySourceRanges = policies.map((v) => {
    if (v.statementIndex != null && v.statementIndex >= 0 && v.statementIndex < stmts.length) {
      const s = stmts[v.statementIndex];
      return { startOffset: s.startOffset, endOffset: s.endOffset };
    }
    return null;
  });

  // Adjust risk with table stats
  if (tableStats && tableStats.length > 0) {
    const statsMap = new Map<string, TableStats>();
    for (const s of tableStats) {
      const lower = s.tableName.toLowerCase();
      statsMap.set(lower, s);
      statsMap.set(`${s.schemaName.toLowerCase()}.${lower}`, s);
    }
    for (const check of result.checks) {
      if (check.tableName) {
        const stats = statsMap.get(check.tableName.toLowerCase());
        if (stats) {
          check.adjustedRisk = adjustRisk(check.risk, stats.rowCount);
        }
      }
    }
  }

  // Compute max risk
  let maxRisk: RiskLevelType = RiskLevel.SAFE;
  for (const check of result.checks) {
    const effective = check.adjustedRisk ?? check.risk;
    maxRisk = maxRiskLevel(maxRisk, effective);
  }
  for (const v of result.policyViolations) {
    if (v.severity === 'error') maxRisk = maxRiskLevel(maxRisk, RiskLevel.HIGH);
    else if (v.severity === 'warning') maxRisk = maxRiskLevel(maxRisk, RiskLevel.MEDIUM);
  }
  result.maxRisk = maxRisk;

  return result;
}

function isDataModifyingStatement(stmt: ParsedStatement): boolean {
  switch (stmt.nodeType) {
    case 'CopyStmt':
    case 'DeleteStmt':
    case 'InsertStmt':
    case 'MergeStmt':
    case 'UpdateStmt':
      return true;
    default:
      return false;
  }
}
