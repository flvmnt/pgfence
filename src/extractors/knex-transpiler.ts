/**
 * Knex Schema Builder Transpiler: Gap 13
 *
 * Converts Knex schema builder AST nodes (createTable, alterTable, etc.)
 * into SQL strings that can flow through the normal parse→analyze pipeline.
 */

import type { ExtractionWarning } from '../types.js';

const FK_ACTIONS = new Set(['CASCADE', 'RESTRICT', 'NO ACTION', 'SET NULL', 'SET DEFAULT']);

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
    case 'table':
      return transpileAlterTable(args, filePath);
    case 'dropTable':
    case 'dropTableIfExists':
      return transpileDropTable(args, methodName === 'dropTableIfExists', filePath);
    case 'renameTable':
      return transpileRenameTable(args, filePath);
    case 'raw':
      // raw() is handled by the main extractor, skip here
      return { sql, warnings };
    default:
      warnings.push({
        filePath,
        line: callNode.loc?.start?.line ?? 0,
        column: callNode.loc?.start?.column ?? 0,
        message: `Unsupported Knex schema builder method: ${methodName}`,
        unanalyzable: true,
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

function pushDynamicColumnWarning(
  warnings: ExtractionWarning[],
  filePath: string,
  methodName: string,
  node: TSNode,
): void {
  warnings.push({
    filePath,
    line: node.loc?.start?.line ?? 0,
    column: node.loc?.start?.column ?? 0,
    message: `Dynamic column name in ${methodName}: cannot statically analyze`,
    unanalyzable: true,
  });
}

function transpileCreateTable(
  args: TSNode[],
  filePath: string,
  ifNotExists: boolean,
): TranspileResult {
  const sql: string[] = [];
  const warnings: ExtractionWarning[] = [];

  if (args.length < 2) {
    warnings.push({
      filePath,
      line: args[0]?.loc?.start?.line ?? 0,
      column: args[0]?.loc?.start?.column ?? 0,
      message: `createTable() called with ${args.length} arguments (expected 2): cannot transpile, manual review required`,
      unanalyzable: true,
    });
    return { sql, warnings };
  }

  const tableName = getStringArg(args[0]);
  if (!tableName) {
    warnings.push({
      filePath,
      line: args[0].loc?.start?.line ?? 0,
      column: args[0].loc?.start?.column ?? 0,
      message: 'Dynamic table name in createTable: cannot transpile',
      unanalyzable: true,
    });
    return { sql, warnings };
  }

  const callback = args[1];
  if (callback.type !== 'ArrowFunctionExpression' && callback.type !== 'FunctionExpression') {
    warnings.push({
      filePath,
      line: callback.loc?.start?.line ?? 0,
      column: callback.loc?.start?.column ?? 0,
      message: 'Non-function callback in createTable: cannot transpile',
      unanalyzable: true,
    });
    return { sql, warnings };
  }

  const paramName = getCallbackParamName(callback);
  if (!paramName) {
    warnings.push({
      filePath,
      line: callback.loc?.start?.line ?? 0,
      column: callback.loc?.start?.column ?? 0,
      message: 'Cannot extract callback parameter name in createTable: destructured or unsupported parameter pattern, manual review required',
      unanalyzable: true,
    });
    return { sql, warnings };
  }

  const columns = extractColumnDefs(callback, paramName, filePath, warnings);
  if (warnings.some((warning) => warning.unanalyzable)) {
    return { sql, warnings };
  }
  const ifNE = ifNotExists ? ' IF NOT EXISTS' : '';
  const colDefs = columns.map((c) => `"${c.name}" ${c.type}${c.modifiers}`).join(', ');
  sql.push(`CREATE TABLE${ifNE} "${tableName}" (${colDefs})`);

  return { sql, warnings };
}

function transpileAlterTable(args: TSNode[], filePath: string): TranspileResult {
  const sql: string[] = [];
  const warnings: ExtractionWarning[] = [];

  if (args.length < 2) {
    warnings.push({
      filePath,
      line: args[0]?.loc?.start?.line ?? 0,
      column: args[0]?.loc?.start?.column ?? 0,
      message: `alterTable() called with ${args.length} arguments (expected 2): cannot transpile, manual review required`,
      unanalyzable: true,
    });
    return { sql, warnings };
  }

  const tableName = getStringArg(args[0]);
  if (!tableName) {
    warnings.push({
      filePath,
      line: args[0].loc?.start?.line ?? 0,
      column: args[0].loc?.start?.column ?? 0,
      message: 'Dynamic table name in alterTable: cannot transpile',
      unanalyzable: true,
    });
    return { sql, warnings };
  }

  const callback = args[1];
  if (callback.type !== 'ArrowFunctionExpression' && callback.type !== 'FunctionExpression') {
    warnings.push({
      filePath,
      line: callback.loc?.start?.line ?? 0,
      column: callback.loc?.start?.column ?? 0,
      message: 'Non-function callback in alterTable: cannot transpile',
      unanalyzable: true,
    });
    return { sql, warnings };
  }

  const paramName = getCallbackParamName(callback);
  if (!paramName) {
    warnings.push({
      filePath,
      line: callback.loc?.start?.line ?? 0,
      column: callback.loc?.start?.column ?? 0,
      message: 'Cannot extract callback parameter name in alterTable: destructured or unsupported parameter pattern, manual review required',
      unanalyzable: true,
    });
    return { sql, warnings };
  }

  // Walk the callback body for column definitions and alterations
  const columns = extractColumnDefs(callback, paramName, filePath, warnings);
  if (warnings.some((warning) => warning.unanalyzable)) {
    return { sql, warnings };
  }
  for (const col of columns) {
    if (col.modifiers.includes('__PGFENCE_ALTER__')) {
      // .alter() means modify existing column, not add new one
      const cleanMods = col.modifiers.replace(' __PGFENCE_ALTER__', '');
      sql.push(`ALTER TABLE "${tableName}" ALTER COLUMN "${col.name}" TYPE ${col.type}`);
      if (cleanMods.includes('NOT NULL')) {
        sql.push(`ALTER TABLE "${tableName}" ALTER COLUMN "${col.name}" SET NOT NULL`);
      }
      if (cleanMods.includes('DEFAULT ')) {
        const defMatch = cleanMods.match(/DEFAULT\s+(\S+(?:\([^)]*\))?)/);
        if (defMatch) {
          sql.push(`ALTER TABLE "${tableName}" ALTER COLUMN "${col.name}" SET DEFAULT ${defMatch[1]}`);
        }
      }
    } else {
      sql.push(`ALTER TABLE "${tableName}" ADD COLUMN "${col.name}" ${col.type}${col.modifiers}`);
    }
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
          sql.push(`ALTER TABLE "${tableName}" DROP COLUMN "${colName}"`);
        } else {
          pushDynamicColumnWarning(warnings, filePath, 'dropColumn', callArgs[0]);
        }
      }
    } else if (method === 'dropColumns') {
      const callArgs = node.arguments as TSNode[];
      for (const arg of callArgs) {
        const colName = getStringArg(arg);
        if (colName) {
          sql.push(`ALTER TABLE "${tableName}" DROP COLUMN "${colName}"`);
        } else {
          pushDynamicColumnWarning(warnings, filePath, 'dropColumns', arg);
        }
      }
    } else if (method === 'renameColumn') {
      const callArgs = node.arguments as TSNode[];
      if (callArgs.length >= 2) {
        const from = getStringArg(callArgs[0]);
        const to = getStringArg(callArgs[1]);
        if (from && to) {
          sql.push(`ALTER TABLE "${tableName}" RENAME COLUMN "${from}" TO "${to}"`);
        } else {
          pushDynamicColumnWarning(warnings, filePath, 'renameColumn', from ? callArgs[1] : callArgs[0]);
        }
      }
    } else if (method === 'setNullable') {
      const callArgs = node.arguments as TSNode[];
      if (callArgs.length > 0) {
        const colName = getStringArg(callArgs[0]);
        if (colName) {
          sql.push(`ALTER TABLE "${tableName}" ALTER COLUMN "${colName}" DROP NOT NULL`);
        } else {
          pushDynamicColumnWarning(warnings, filePath, 'setNullable', callArgs[0]);
        }
      }
    } else if (method === 'dropNullable') {
      const callArgs = node.arguments as TSNode[];
      if (callArgs.length > 0) {
        const colName = getStringArg(callArgs[0]);
        if (colName) {
          sql.push(`ALTER TABLE "${tableName}" ALTER COLUMN "${colName}" SET NOT NULL`);
        } else {
          pushDynamicColumnWarning(warnings, filePath, 'dropNullable', callArgs[0]);
        }
      }
    }
  });

  return { sql, warnings };
}

function transpileDropTable(args: TSNode[], ifExists: boolean, filePath: string): TranspileResult {
  const sql: string[] = [];
  const warnings: ExtractionWarning[] = [];

  if (args.length < 1) {
    warnings.push({
      filePath,
      line: 0,
      column: 0,
      message: `dropTable() called with ${args.length} arguments (expected 1): cannot transpile, manual review required`,
      unanalyzable: true,
    });
    return { sql, warnings };
  }
  const tableName = getStringArg(args[0]);
  if (tableName) {
    const ifE = ifExists ? ' IF EXISTS' : '';
    sql.push(`DROP TABLE${ifE} "${tableName}"`);
  } else {
    warnings.push({
      filePath,
      line: args[0].loc?.start?.line ?? 0,
      column: args[0].loc?.start?.column ?? 0,
      message: 'Dynamic table name in dropTable: cannot statically analyze',
      unanalyzable: true,
    });
  }

  return { sql, warnings };
}

function transpileRenameTable(args: TSNode[], filePath: string): TranspileResult {
  const sql: string[] = [];
  const warnings: ExtractionWarning[] = [];

  if (args.length < 2) {
    warnings.push({
      filePath,
      line: args[0]?.loc?.start?.line ?? 0,
      column: args[0]?.loc?.start?.column ?? 0,
      message: `renameTable() called with ${args.length} arguments (expected 2): cannot transpile, manual review required`,
      unanalyzable: true,
    });
    return { sql, warnings };
  }
  const from = getStringArg(args[0]);
  const to = getStringArg(args[1]);
  if (from && to) {
    sql.push(`ALTER TABLE "${from}" RENAME TO "${to}"`);
  } else {
    warnings.push({
      filePath,
      line: args[0].loc?.start?.line ?? 0,
      column: args[0].loc?.start?.column ?? 0,
      message: 'Dynamic table name in renameTable: cannot statically analyze',
      unanalyzable: true,
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

function isTimestampsCall(node: TSNode, paramName: string): boolean {
  if (node.type !== 'CallExpression') return false;
  const callee = node.callee as TSNode;
  if (callee?.type !== 'MemberExpression') return false;
  const obj = callee.object as TSNode;
  const prop = callee.property as TSNode;
  return (
    obj?.type === 'Identifier' &&
    (obj.name as string) === paramName &&
    prop?.type === 'Identifier' &&
    (prop.name as string) === 'timestamps'
  );
}

function extractColumnDefs(
  callback: TSNode,
  paramName: string,
  filePath: string,
  warnings: ExtractionWarning[],
): ColumnDef[] {
  const columns: ColumnDef[] = [];

  walkNode(callback, (node: TSNode) => {
    // Only process ExpressionStatements to avoid parsing the same chain multiple times
    // via nested CallExpression nodes
    if (node.type !== 'ExpressionStatement') return;

    // Find the root call in a chain: t.string('name').notNullable().defaultTo('...')
    const rootCall = findRootColumnCall(node, paramName);
    if (!rootCall) return;

    // Handle timestamps() specially: it creates two columns
    if (isTimestampsCall(rootCall, paramName)) {
      columns.push({ name: 'created_at', type: 'timestamp', modifiers: '' });
      columns.push({ name: 'updated_at', type: 'timestamp', modifiers: '' });
      return;
    }

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
      // The root is in the chain - return the outermost
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

  // Skip methods that aren't column definitions (like dropColumn, renameColumn)
  if (['dropColumn', 'dropColumns', 'renameColumn', 'setNullable', 'dropNullable', 'index', 'unique', 'primary', 'dropUnique', 'dropPrimary', 'dropIndex', 'dropForeign'].includes(knexType)) {
    return null;
  }

  const pgType = KNEX_TYPE_MAP[knexType];

  if (pgType === undefined) {
    warnings.push({
      filePath,
      line: node.loc?.start?.line ?? 0,
      column: node.loc?.start?.column ?? 0,
      message: `Unsupported Knex column builder method ${knexType}(): cannot transpile`,
      unanalyzable: true,
    });
    return null;
  }

  if (typeCall.args.length === 0) {
    warnings.push({
      filePath,
      line: node.loc?.start?.line ?? 0,
      column: node.loc?.start?.column ?? 0,
      message: `Knex column builder ${knexType}() without column name: cannot transpile`,
      unanalyzable: true,
    });
    return null;
  }

  const colName = getStringArg(typeCall.args[0]);
  if (!colName) {
    pushDynamicColumnWarning(warnings, filePath, knexType, typeCall.args[0]);
    return null;
  }

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
  let fkTable: string | null = null;
  let fkColumn: string | null = null;
  let sawReferences = false;
  let sawInTable = false;
  let fkUnresolved = false;
  const fkActions: string[] = [];
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
        // Postgres doesn't have unsigned - skip
        break;
      case 'references':
        sawReferences = true;
        if (call.args.length > 0) {
          const ref = getStringArg(call.args[0]);
          if (ref) {
            const inlineReference = parseInlineReference(ref);
            if (inlineReference) {
              fkTable = inlineReference.table;
              fkColumn = inlineReference.column;
            } else {
              fkColumn = ref;
            }
          } else {
            fkUnresolved = true;
          }
        } else {
          fkUnresolved = true;
        }
        break;
      case 'inTable':
        sawInTable = true;
        if (call.args.length > 0) {
          const tbl = getStringArg(call.args[0]);
          if (tbl) {
            fkTable = tbl;
          } else {
            fkUnresolved = true;
          }
        } else {
          fkUnresolved = true;
        }
        break;
      case 'onDelete':
      case 'onUpdate':
        if (call.args.length > 0) {
          const action = getStringArg(call.args[0]);
          if (action && FK_ACTIONS.has(action.toUpperCase())) {
            const prefix = call.method === 'onDelete' ? 'ON DELETE' : 'ON UPDATE';
            fkActions.push(` ${prefix} ${action.toUpperCase()}`);
          }
        }
        break;
      case 'alter':
        modifiers += ' __PGFENCE_ALTER__';
        break;
      case 'comment':
        // Skip comments in SQL generation
        break;
      case 'index':
        // Index is typically a separate operation
        break;
    }
  }

  if (sawReferences || sawInTable) {
    if (!fkTable || !fkColumn || fkUnresolved) {
      warnings.push({
        filePath,
        line: node.loc?.start?.line ?? 0,
        column: node.loc?.start?.column ?? 0,
        message: `Knex column builder REFERENCES chain for "${colName}" could not be fully resolved: cannot transpile safely`,
        unanalyzable: true,
      });
      return null;
    }
    modifiers += ` REFERENCES "${fkTable}"("${fkColumn}")`;
    modifiers += fkActions.join('');
  }

  return { name: colName, type, modifiers };
}

function parseInlineReference(reference: string): { table: string; column: string } | null {
  const parts = reference.split('.').map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return null;

  return {
    table: parts.slice(0, -1).join('.'),
    column: parts[parts.length - 1],
  };
}

function extractDefaultValue(node: TSNode): string {
  if (node.type === 'Literal') {
    if (typeof node.value === 'string') return `'${node.value.replace(/'/g, "''")}'`;
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
