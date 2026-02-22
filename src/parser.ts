/**
 * SQL parsing via libpg-query.
 *
 * Uses the actual PostgreSQL parser (via C bindings) for accurate AST generation.
 * This is the same parser Postgres itself uses — no regex guessing.
 */

export interface ParsedStatement {
  /** Raw SQL text */
  sql: string;
  /** AST node type (e.g., 'AlterTableStmt', 'CreateStmt', 'IndexStmt') */
  nodeType: string;
  /** Parsed AST node from libpg-query */
  node: Record<string, unknown>;
  /** Rule IDs to ignore for this statement (from inline ignore comments).
   *  '*' means suppress all checks (bare -- pgfence-ignore).
   */
  ignoredRules?: string[];
}

interface LibPgStmt {
  stmt: Record<string, unknown>;
  stmt_location?: number;
  stmt_len?: number;
}

/**
 * Parse SQL text into individual statements with AST nodes.
 */
export async function parseSQL(sql: string): Promise<ParsedStatement[]> {
  const mod = await import('libpg-query');
  const parseFn = mod.parse ?? (mod.default as Record<string, unknown>)?.parse;
  if (typeof parseFn !== 'function') {
    throw new Error('Cannot find parse function in libpg-query');
  }
  const result = (await parseFn(sql)) as { stmts: LibPgStmt[] };
  const stmts = result.stmts ?? [];
  const results: ParsedStatement[] = [];

  let prevEnd = 0;

  for (let i = 0; i < stmts.length; i++) {
    const entry = stmts[i];
    const nodeType = Object.keys(entry.stmt)[0];
    const node = entry.stmt[nodeType] as Record<string, unknown>;

    // Extract raw SQL via byte offsets
    const start = entry.stmt_location ?? 0;
    let end: number;
    if (entry.stmt_len && entry.stmt_len > 0) {
      end = start + entry.stmt_len;
    } else {
      // Last statement: take rest of input
      end = sql.length;
    }

    let rawSql = sql.slice(start, end).trim();
    // Strip trailing semicolon for cleaner display
    if (rawSql.endsWith(';')) {
      rawSql = rawSql.slice(0, -1).trimEnd();
    }

    // Extract inline ignore comments for this statement only.
    // Pass prevEnd so the lookback is bounded to the region after the previous statement.
    const ignoredRules = extractIgnoredRules(rawSql, sql, start, prevEnd);
    prevEnd = end;

    results.push({ sql: rawSql, nodeType, node, ...(ignoredRules.length > 0 ? { ignoredRules } : {}) });
  }

  return results;
}

/**
 * Extract rule IDs from inline ignore comments.
 *
 * Supported syntax:
 *   -- pgfence-ignore                          suppress ALL checks for this statement
 *   -- pgfence-ignore: <ruleId>[, <ruleId>]   suppress specific rule(s)
 *   -- pgfence: ignore <ruleId>[, <ruleId>]   legacy syntax (still supported)
 *
 * Checks both the statement's own text and the region immediately before it
 * (libpg-query may or may not include preceding comments in stmt_location).
 */
function extractIgnoredRules(rawSql: string, fullSql: string, stmtStart: number, prevEnd = 0): string[] {
  const rules: string[] = [];

  // New syntax: -- pgfence-ignore (bare) or -- pgfence-ignore: <ruleId>[, ...]
  const newPattern = /--\s*pgfence-ignore(?:\s*:\s*([^\n]+))?/gi;
  // Legacy syntax: -- pgfence: ignore <ruleId>[, ...]
  const legacyPattern = /--\s*pgfence:\s*ignore\s+([^\n]+)/gi;

  function applyPattern(text: string, pattern: RegExp, isNew: boolean) {
    pattern.lastIndex = 0;
    let m = pattern.exec(text);
    while (m !== null) {
      if (isNew && m[1] === undefined) {
        // Bare -- pgfence-ignore: suppress all
        rules.push('*');
      } else {
        const ruleList = (m[1] ?? '').trim();
        for (const rule of ruleList.split(',')) {
          const trimmed = rule.trim();
          if (trimmed) rules.push(trimmed);
        }
      }
      m = pattern.exec(text);
    }
  }

  // Check the statement's own text first
  applyPattern(rawSql, newPattern, true);
  applyPattern(rawSql, legacyPattern, false);

  // If nothing found, also check the region between the previous statement and this one.
  // prevEnd bounds the lookback so we don't bleed a comment into the next statement.
  if (rules.length === 0) {
    const region = fullSql.slice(prevEnd, stmtStart);
    applyPattern(region, newPattern, true);
    applyPattern(region, legacyPattern, false);
  }

  return rules;
}

/**
 * Create a truncated preview of a SQL statement for display.
 * Collapses whitespace and truncates at maxLen.
 */
export function makePreview(sql: string, maxLen = 80): string {
  // Strip SQL comments (block /* */ and line --)
  const noComments = sql.replace(/\/\*[\s\S]*?\*\/|--[^\n]*/g, '');
  const collapsed = noComments.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLen) return collapsed;
  return collapsed.slice(0, maxLen - 3) + '...';
}
