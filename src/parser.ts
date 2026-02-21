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

    results.push({ sql: rawSql, nodeType, node });
  }

  return results;
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
