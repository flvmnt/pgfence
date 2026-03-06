/**
 * SQL parsing via libpg-query.
 *
 * Uses the actual PostgreSQL parser (via C bindings) for accurate AST generation.
 * This is the same parser Postgres itself uses, no regex guessing.
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
  /** Character offset of this statement's start in the original SQL string */
  startOffset: number;
  /** Character offset of this statement's end in the original SQL string */
  endOffset: number;
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

  // libpg-query returns byte offsets into the UTF-8 representation.
  // Pre-compute the buffer once for byte-to-char conversion.
  const buf = Buffer.from(sql, 'utf8');
  let prevEnd = 0;

  for (let i = 0; i < stmts.length; i++) {
    const entry = stmts[i];
    const nodeType = Object.keys(entry.stmt)[0];
    const node = entry.stmt[nodeType] as Record<string, unknown>;

    const startByte = entry.stmt_location ?? 0;
    let endByte: number;
    if (entry.stmt_len && entry.stmt_len > 0) {
      endByte = startByte + entry.stmt_len;
    } else {
      // Last statement: take rest of input
      endByte = buf.length;
    }
    const start = buf.subarray(0, startByte).toString('utf8').length;
    const end = buf.subarray(0, endByte).toString('utf8').length;

    let rawSql = sql.slice(start, end).trim();
    // Strip trailing semicolon for cleaner display
    if (rawSql.endsWith(';')) {
      rawSql = rawSql.slice(0, -1).trimEnd();
    }

    // Extract inline ignore comments for this statement only.
    // Pass prevEnd so the lookback is bounded to the region after the previous statement.
    const ignoredRules = extractIgnoredRules(rawSql, sql, start, prevEnd);
    prevEnd = end;

    results.push({ sql: rawSql, nodeType, node, startOffset: start, endOffset: end, ...(ignoredRules.length > 0 ? { ignoredRules } : {}) });
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
export function makePreview(sql: string, maxLen = 200): string {
  // Strip SQL comments (block /* */ and line --)
  const noComments = sql.replace(/\/\*[\s\S]*?\*\/|--[^\n]*/g, '');
  const collapsed = noComments.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLen) return collapsed;
  return collapsed.slice(0, maxLen - 3) + '...';
}
