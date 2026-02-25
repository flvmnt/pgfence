/**
 * Knex Schema Builder Transpiler — Gap 13
 *
 * Converts Knex schema builder AST nodes (createTable, alterTable, etc.)
 * into SQL strings that can flow through the normal parse→analyze pipeline.
 */

import type { ExtractionWarning } from '../types.js';

interface TSNode {
  type: string;
  loc?: { start: { line: number; column: number }; end: { line: number; column: number } };
  [key: string]: unknown;
}

const KNEX_TYPE_MAP: Record<string, string> = {
  increments: 'serial PRIMARY KEY',
  bigIncrements: 'bigserial PRIMARY KEY',
  integer: 'integer',
  bigInteger: 'bigint',
  tinyint: 'smallint',
  smallint: 'smallint',
  mediumint: 'integer',
  float: 'real',
  double: 'double precision',
  decimal: 'numeric',
  boolean: 'boolean',
  date: 'date',
  dateTime: 'timestamp',
  time: 'time',
  timestamp: 'timestamp',
  timestamps: '', // special case
  binary: 'bytea',
  json: 'json',
  jsonb: 'jsonb',
  uuid: 'uuid',
  text: 'text',
  string: 'varchar(255)',
  enu: 'text', // knex enum → text with CHECK
  enum: 'text',
  specificType: '', // user-specified type
};

export interface TranspileResult {
  sql: string[];
  warnings: ExtractionWarning[];
}

/**
 * Transpile a knex.schema.createTable() call into SQL.
 */
export function transpileKnexSchemaCall(
  callNode: TSNode,
  filePath: string,
): TranspileResult {
  const sql: string[] = [];
  const warnings: ExtractionWarning[] = [];

  const callee = callNode.callee as TSNode;
  if (callee?.type !== 'MemberExpression') return { sql, warnings };

  const prop = callee.property as TSNode;
  if (prop?.type !== 'Identifier') return { sql, warnings };

  const methodName = prop.name as string;
  const args = callNode.arguments as TSNode[];

  switch (methodName) {
    case 'createTable':
    case 'createTableIfNotExists':
      return transpileCreateTable(args, filePath, methodName === 'createTableIfNotExists');
    case 'alterTable':
      return transpileAlterTable(args, filePath);
    case 'dropTable':
    case 'dropTableIfExists':
      return transpileDropTable(args, methodName === 'dropTableIfExists');
    case 'renameTable':
      return transpileRenameTable(args);
    case 'raw':
      // raw() is handled by the main extractor, skip here
      return { sql, warnings };
    default:
      warnings.push({
        filePath,
        line: callNode.loc?.start?.line ?? 0,
        column: callNode.loc?.start?.column ?? 0,
        message: `Unsupported Knex schema builder method: ${methodName}`,
      });
      return { sql, warnings };
  }
}

function getStringArg(node: TSNode): string | null {
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral') {
    const quasis = node.quasis as TSNode[];
    const expressions = node.expressions as TSNode[];
    if (expressions.length === 0) {
      return quasis.map((q) => (q.value as { cooked: string }).cooked).join('');
    }
  }
  return null;
}

function transpileCreateTable(
  args: TSNode[],
  filePath: string,
  ifNotExists: boolean,
): TranspileResult {
  const sql: string[] = [];
  const warnings: ExtractionWarning[] = [];

  if (args.length < 2) return { sql, warnings };

  const tableName = getStringArg(args[0]);
  if (!tableName) {
    warnings.push({
      filePath,
      line: args[0].loc?.start?.line ?? 0,
      column: args[0].loc?.start?.column ?? 0,
      message: 'Dynamic table name in createTable — cannot transpile',
    });
    return { sql, warnings };
  }

  const callback = args[1];
  if (callback.type !== 'ArrowFunctionExpression' && callback.type !== 'FunctionExpression') {
    warnings.push({
      filePath,
      line: callback.loc?.start?.line ?? 0,
      column: callback.loc?.start?.column ?? 0,
      message: 'Non-function callback in createTable — cannot transpile',
    });
    return { sql, warnings };
  }

  const paramName = getCallbackParamName(callback);
  if (!paramName) return { sql, warnings };

  const columns = extractColumnDefs(callback, paramName, filePath, warnings);
  const ifNE = ifNotExists ? ' IF NOT EXISTS' : '';
  const colDefs = columns.map((c) => `${c.name} ${c.type}${c.modifiers}`).join(', ');
  sql.push(`CREATE TABLE${ifNE} ${tableName} (${colDefs})`);

  return { sql, warnings };
}

function transpileAlterTable(args: TSNode[], filePath: string): TranspileResult {
  const sql: string[] = [];
  const warnings: ExtractionWarning[] = [];

  if (args.length < 2) return { sql, warnings };

  const tableName = getStringArg(args[0]);
  if (!tableName) {
    warnings.push({
      filePath,
      line: args[0].loc?.start?.line ?? 0,
      column: args[0].loc?.start?.column ?? 0,
      message: 'Dynamic table name in alterTable — cannot transpile',
    });
    return { sql, warnings };
  }

  const callback = args[1];
  if (callback.type !== 'ArrowFunctionExpression' && callback.type !== 'FunctionExpression') {
    return { sql, warnings };
  }

  const paramName = getCallbackParamName(callback);
  if (!paramName) return { sql, warnings };

  // Walk the callback body for column definitions and alterations
  const columns = extractColumnDefs(callback, paramName, filePath, warnings);
  for (const col of columns) {
    sql.push(`ALTER TABLE ${tableName} ADD COLUMN ${col.name} ${col.type}${col.modifiers}`);
  }

  // Look for dropColumn calls
  walkNode(callback, (node: TSNode) => {
    if (node.type !== 'CallExpression') return;
    const callee = node.callee as TSNode;
    if (callee?.type !== 'MemberExpression') return;
    const obj = callee.object as TSNode;
    const prop = callee.property as TSNode;
    if (obj?.type !== 'Identifier' || (obj.name as string) !== paramName) return;
    if (prop?.type !== 'Identifier') return;

    const method = prop.name as string;
    if (method === 'dropColumn') {
      const callArgs = node.arguments as TSNode[];
      if (callArgs.length > 0) {
        const colName = getStringArg(callArgs[0]);
        if (colName) {
          sql.push(`ALTER TABLE ${tableName} DROP COLUMN ${colName}`);
        }
      }
    } else if (method === 'renameColumn') {
      const callArgs = node.arguments as TSNode[];
      if (callArgs.length >= 2) {
        const from = getStringArg(callArgs[0]);
        const to = getStringArg(callArgs[1]);
        if (from && to) {
          sql.push(`ALTER TABLE ${tableName} RENAME COLUMN ${from} TO ${to}`);
        }
      }
    }
  });

  return { sql, warnings };
}

function transpileDropTable(args: TSNode[], ifExists: boolean): TranspileResult {
  const sql: string[] = [];
  const warnings: ExtractionWarning[] = [];

  if (args.length < 1) return { sql, warnings };
  const tableName = getStringArg(args[0]);
  if (tableName) {
    const ifE = ifExists ? ' IF EXISTS' : '';
    sql.push(`DROP TABLE${ifE} ${tableName}`);
  } else {
    warnings.push({
      filePath: '',
      line: args[0].loc?.start?.line ?? 0,
      column: args[0].loc?.start?.column ?? 0,
      message: 'Dynamic table name in dropTable — cannot statically analyze',
    });
  }

  return { sql, warnings };
}

function transpileRenameTable(args: TSNode[]): TranspileResult {
  const sql: string[] = [];
  const warnings: ExtractionWarning[] = [];

  if (args.length < 2) return { sql, warnings };
  const from = getStringArg(args[0]);
  const to = getStringArg(args[1]);
  if (from && to) {
    sql.push(`ALTER TABLE ${from} RENAME TO ${to}`);
  } else {
    warnings.push({
      filePath: '',
      line: args[0].loc?.start?.line ?? 0,
      column: args[0].loc?.start?.column ?? 0,
      message: 'Dynamic table name in renameTable — cannot statically analyze',
    });
  }

  return { sql, warnings };
}

interface ColumnDef {
  name: string;
  type: string;
  modifiers: string;
}

function getCallbackParamName(callback: TSNode): string | null {
  const params = callback.params as TSNode[] | undefined;
  if (params && params.length > 0 && params[0].type === 'Identifier') {
    return params[0].name as string;
  }
  return null;
}

function extractColumnDefs(
  callback: TSNode,
  paramName: string,
  filePath: string,
  warnings: ExtractionWarning[],
): ColumnDef[] {
  const columns: ColumnDef[] = [];

  walkNode(callback, (node: TSNode) => {
    if (node.type !== 'ExpressionStatement' && node.type !== 'CallExpression') return;

    // Find the root call in a chain: t.string('name').notNullable().defaultTo('...')
    const rootCall = findRootColumnCall(node, paramName);
    if (!rootCall) return;

    const col = parseColumnChain(rootCall, paramName, filePath, warnings);
    if (col) columns.push(col);
  });

  return columns;
}

function findRootColumnCall(node: TSNode, paramName: string): TSNode | null {
  // Walk up chained calls to find the root t.<type>() call
  if (node.type === 'ExpressionStatement') {
    const expr = node.expression as TSNode;
    if (expr) return findRootColumnCall(expr, paramName);
    return null;
  }

  if (node.type === 'CallExpression') {
    const callee = node.callee as TSNode;
    if (callee?.type === 'MemberExpression') {
      const obj = callee.object as TSNode;
      if (obj?.type === 'Identifier' && (obj.name as string) === paramName) {
        return node;
      }
      // Chained call: something().modifier()
      // The root is in the chain — return the outermost
      if (obj?.type === 'CallExpression') {
        const inner = findRootColumnCall(obj, paramName);
        if (inner) return node; // return outermost, we'll parse the chain
      }
    }
  }

  return null;
}

function parseColumnChain(
  node: TSNode,
  paramName: string,
  filePath: string,
  warnings: ExtractionWarning[],
): ColumnDef | null {
  // Collect the chain of method calls
  const chain: Array<{ method: string; args: TSNode[] }> = [];
  let current: TSNode | null = node;

  while (current?.type === 'CallExpression') {
    const callee = current.callee as TSNode;
    if (callee?.type !== 'MemberExpression') break;
    const prop = callee.property as TSNode;
    if (prop?.type === 'Identifier') {
      chain.unshift({ method: prop.name as string, args: current.arguments as TSNode[] });
    }
    current = callee.object as TSNode;
  }

  if (chain.length === 0) return null;

  // First in chain should be the type method: t.string('name'), t.integer('count'), etc.
  const typeCall = chain[0];
  const knexType = typeCall.method;
  const pgType = KNEX_TYPE_MAP[knexType];

  if (pgType === undefined) return null; // Not a column type method

  // Skip methods that aren't column definitions (like dropColumn, renameColumn)
  if (['dropColumn', 'renameColumn', 'index', 'unique', 'primary', 'dropUnique', 'dropPrimary', 'dropIndex', 'dropForeign'].includes(knexType)) {
    return null;
  }

  if (typeCall.args.length === 0) {
    warnings.push({
      filePath,
      line: node.loc?.start?.line ?? 0,
      column: node.loc?.start?.column ?? 0,
      message: `Knex column builder ${knexType}() without column name — cannot transpile`,
    });
    return null;
  }

  const colName = getStringArg(typeCall.args[0]);
  if (!colName) return null;

  // Handle string with custom length: t.string('name', 100) → varchar(100)
  let type = pgType;
  if (knexType === 'string' && typeCall.args.length > 1) {
    const lenArg = typeCall.args[1];
    if (lenArg.type === 'Literal' && typeof lenArg.value === 'number') {
      type = `varchar(${lenArg.value})`;
    }
  }
  if (knexType === 'specificType' && typeCall.args.length > 1) {
    const typeArg = getStringArg(typeCall.args[1]);
    if (typeArg) type = typeArg;
  }

  // Parse modifiers from chain
  let modifiers = '';
  for (let i = 1; i < chain.length; i++) {
    const call = chain[i];
    switch (call.method) {
      case 'notNullable':
        modifiers += ' NOT NULL';
        break;
      case 'nullable':
        // default, nothing to add
        break;
      case 'defaultTo': {
        const defVal = call.args.length > 0 ? extractDefaultValue(call.args[0]) : 'NULL';
        modifiers += ` DEFAULT ${defVal}`;
        break;
      }
      case 'primary':
        modifiers += ' PRIMARY KEY';
        break;
      case 'unique':
        modifiers += ' UNIQUE';
        break;
      case 'unsigned':
        // Postgres doesn't have unsigned — skip
        break;
      case 'references':
        if (call.args.length > 0) {
          const ref = getStringArg(call.args[0]);
          if (ref) modifiers += ` REFERENCES ${ref}`;
        }
        break;
      case 'inTable':
        // Part of references chain
        break;
      case 'onDelete':
      case 'onUpdate':
        if (call.args.length > 0) {
          const action = getStringArg(call.args[0]);
          if (action) {
            const prefix = call.method === 'onDelete' ? 'ON DELETE' : 'ON UPDATE';
            modifiers += ` ${prefix} ${action.toUpperCase()}`;
          }
        }
        break;
      case 'comment':
        // Skip comments in SQL generation
        break;
      case 'index':
        // Index is typically a separate operation
        break;
    }
  }

  return { name: colName, type, modifiers };
}

function extractDefaultValue(node: TSNode): string {
  if (node.type === 'Literal') {
    if (typeof node.value === 'string') return `'${node.value}'`;
    if (typeof node.value === 'number') return String(node.value);
    if (typeof node.value === 'boolean') return String(node.value);
    if (node.value === null) return 'NULL';
  }
  // For complex expressions (e.g. knex.fn.now()), use a volatile marker
  // so the analyzer treats it as a non-constant default
  return 'pgfence_volatile_expr()';
}

function walkNode(node: unknown, visitor: (n: TSNode) => void): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walkNode(child, visitor);
    return;
  }
  const n = node as TSNode;
  if (n.type) visitor(n);
  for (const key of Object.keys(n)) {
    if (key === 'parent') continue;
    const val = n[key];
    if (val && typeof val === 'object') {
      walkNode(val, visitor);
    }
  }
}
