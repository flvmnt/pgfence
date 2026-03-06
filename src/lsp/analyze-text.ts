/**
 * In-memory analysis API for the LSP server.
 *
 * Analyzes SQL content from a string (no file I/O) using the same
 * rule engine as the CLI. Returns results with byte offset source ranges
 * for diagnostic positioning.
 */

import { parseSQL } from '../parser.js';
import type { ParsedStatement } from '../parser.js';
import { applyRules, filterByRulesConfig, adjustRisk, detectFormat } from '../analyzer.js';
import { checkPolicies } from '../rules/policy.js';
import { RiskLevel } from '../types.js';
import type {
  CheckResult,
  ExtractionWarning,
  PgfenceConfig,
  PolicyViolation,
  RiskLevel as RiskLevelType,
  TableStats,
} from '../types.js';

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

const RISK_ORDER: RiskLevelType[] = [
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

  // For ORM formats, we need the extractors. They currently read from disk,
  // so we use a temp-file-free approach: write the content to the extractor's
  // parse function if it accepts a string, or fall back to the file-based path.
  // For now, use a dynamic import and pass the content through a temp approach.
  // Most ORM extractors read from file, so for LSP we write a lightweight
  // content-based extraction for TypeORM/Knex/Sequelize.

  switch (format) {
    case 'typeorm': {
      const { extractTypeORMSQL } = await import('../extractors/typeorm.js');
      // TypeORM extractor reads from file; for LSP we need to pass content.
      // Fall back to file-based extraction (file must exist on disk for ORM formats).
      return extractTypeORMSQL(filePath);
    }
    case 'knex': {
      const { extractKnexSQL } = await import('../extractors/knex.js');
      return extractKnexSQL(filePath);
    }
    case 'sequelize': {
      const { extractSequelizeSQL } = await import('../extractors/sequelize.js');
      return extractSequelizeSQL(filePath);
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
    } catch {
      // Can't detect format, treat as raw SQL
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
    result.extractionWarnings = extraction.warnings;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.extractionWarnings = [{
      message: `SQL extraction error: ${message}`,
      filePath,
      line: 1,
      column: 1,
    }];
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

  // Track tables created in this migration
  const createdTables = new Set<string>();
  for (const stmt of stmts) {
    if (stmt.nodeType === 'CreateStmt') {
      const createNode = stmt.node as { relation?: { relname?: string } };
      if (createNode.relation?.relname) {
        createdTables.add(createNode.relation.relname.toLowerCase());
      }
    }
  }

  // Apply statement-level rules
  for (const stmt of stmts) {
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
      });
    }

    const rawChecks = filterByRulesConfig(applyRules(stmt, config), config.rules);
    for (const check of rawChecks) {
      // Inline ignore directives
      if (stmt.ignoredRules?.includes('*') || stmt.ignoredRules?.includes(check.ruleId)) continue;
      // Visibility: skip for newly-created tables
      if (check.tableName && createdTables.has(check.tableName.toLowerCase()) && !check.appliesToNewTables) continue;

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
