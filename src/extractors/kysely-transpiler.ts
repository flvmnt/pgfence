/**
 * Kysely Schema Builder Transpiler
 *
 * Converts a Kysely `db.schema.<method>()...execute()` method-call chain
 * (already collected by the extractor into an ordered array of
 * { method, args, node } steps) into SQL strings that can flow through the
 * normal parse -> analyze pipeline.
 *
 * Scope mirrors knex-transpiler.ts: createTable, alterTable (addColumn,
 * dropColumn, renameColumn, alterColumn, renameTo), dropTable, createIndex,
 * dropIndex, and the constraint-adding methods used by createTable/alterTable
 * (addUniqueConstraint, addPrimaryKeyConstraint, addForeignKeyConstraint,
 * addCheckConstraint). Anything outside that subset fails closed with an
 * ExtractionWarning rather than emitting a guess.
 */

import type { ExtractionWarning } from '../types.js';

const FK_ACTIONS = new Set(['CASCADE', 'RESTRICT', 'NO ACTION', 'SET NULL', 'SET DEFAULT']);

/**
 * Methods `AlterTableBuilder.addForeignKeyConstraint()` returns a chainable
 * builder for (kysely-org/kysely alter-table-add-foreign-key-constraint-builder.ts:
 * onDelete, onUpdate, deferrable, notDeferrable, initiallyDeferred,
 * initiallyImmediate). Unlike CreateTableBuilder's version, which takes these
 * as an optional 5th callback argument, AlterTableBuilder's addForeignKeyConstraint
 * returns this builder directly, so the actual chain looks like
 * `.addForeignKeyConstraint(...).onDelete('cascade').execute()` with onDelete
 * as its OWN top-level chain step, not nested in a callback. Used to recognize
 * and consume those trailing steps in transpileAlterTable instead of letting
 * them hit the generic "unsupported alterTable builder method" fallback.
 */
const FK_TRAILING_CHAIN_METHODS = new Set([
  'onDelete', 'onUpdate', 'deferrable', 'notDeferrable', 'initiallyDeferred', 'initiallyImmediate',
]);

interface TSNode {
  type: string;
  loc?: { start: { line: number; column: number }; end: { line: number; column: number } };
  [key: string]: unknown;
}

export interface ChainStep {
  method: string;
  args: TSNode[];
  node: TSNode;
}

export interface TranspileResult {
  sql: string[];
  warnings: ExtractionWarning[];
}

interface ColumnDef {
  name: string;
  type: string;
  modifiers: string;
  notNull: boolean;
  defaultSql?: string;
}

/**
 * Transpile a `db.schema.<rootMethod>(...)....execute()` chain (root call
 * first, `execute()` already stripped) into SQL.
 */
export function transpileKyselySchemaChain(chain: ChainStep[], filePath: string): TranspileResult {
  const warnings: ExtractionWarning[] = [];
  if (chain.length === 0) return { sql: [], warnings };

  const [root, ...rest] = chain;
  switch (root.method) {
    case 'createTable':
      return transpileCreateTable(root, rest, filePath);
    case 'alterTable':
      return transpileAlterTable(root, rest, filePath);
    case 'dropTable':
      return transpileDropTable(root, rest, filePath);
    case 'createIndex':
      return transpileCreateIndex(root, rest, filePath);
    case 'dropIndex':
      return transpileDropIndex(root, rest, filePath);
    default:
      warnings.push(warning(filePath, root.node, `Unsupported Kysely schema builder method: ${root.method}`));
      return { sql: [], warnings };
  }
}

function warning(filePath: string, node: TSNode, message: string): ExtractionWarning {
  return {
    filePath,
    line: node.loc?.start?.line ?? 0,
    column: node.loc?.start?.column ?? 0,
    message,
    unanalyzable: true,
  };
}

function getStringArg(node: TSNode | undefined): string | null {
  if (!node) return null;
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

/** `sql\`...\`` tagged templates with no interpolation, used for raw type/default/check expressions. */
function getSqlTemplateLiteral(node: TSNode | undefined): string | null {
  if (!node || node.type !== 'TaggedTemplateExpression') return null;
  const tag = node.tag as TSNode;
  if (tag?.type !== 'Identifier' || (tag.name as string) !== 'sql') return null;
  const quasi = node.quasi as TSNode;
  const quasis = quasi.quasis as TSNode[];
  const expressions = quasi.expressions as TSNode[];
  if (expressions.length > 0) return null;
  return quasis.map((q) => (q.value as { cooked: string }).cooked).join('');
}

function resolveDataType(
  node: TSNode | undefined,
  filePath: string,
  warnings: ExtractionWarning[],
  contextNode: TSNode,
): string | null {
  const literal = getStringArg(node);
  if (literal !== null) return literal;
  const raw = node ? getSqlTemplateLiteral(node) : null;
  if (raw !== null) return raw;
  warnings.push(warning(filePath, node ?? contextNode, 'Dynamic column data type: cannot statically analyze'));
  return null;
}

function resolveDefaultValue(node: TSNode | undefined): string {
  if (node?.type === 'Literal') {
    if (typeof node.value === 'string') return `'${node.value.replace(/'/g, "''")}'`;
    if (typeof node.value === 'number') return String(node.value);
    if (typeof node.value === 'boolean') return String(node.value);
    if (node.value === null) return 'NULL';
  }
  const raw = getSqlTemplateLiteral(node);
  if (raw !== null) return raw;
  // Any other expression (function calls, identifiers, interpolated sql``) is
  // treated as a non-constant default so the normal analyzer flags it like
  // any other volatile default, rather than silently emitting a wrong constant.
  return 'pgfence_volatile_expr()';
}

function parseInlineReference(reference: string): { table: string; column: string } | null {
  const parts = reference.split('.').map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  return { table: parts.slice(0, -1).join('.'), column: parts[parts.length - 1] };
}

function getColumnList(node: TSNode | undefined): string[] | null {
  if (!node || node.type !== 'ArrayExpression') return null;
  const elements = (node.elements as Array<TSNode | null> | undefined) ?? [];
  const columns = elements.map((el) => (el ? getStringArg(el) : null));
  if (columns.length === 0 || columns.some((c) => c === null)) return null;
  return columns as string[];
}

function quoteColumns(columns: string[]): string {
  return columns.map((c) => `"${c}"`).join(', ');
}

function parseOrderedColumnName(node: TSNode | undefined): string | null {
  const raw = getStringArg(node);
  if (!raw) return null;
  const parts = raw.trim().split(/\s+/);
  const colName = parts[0];
  if (!colName) return null;
  const rest = parts.slice(1).join(' ').toUpperCase();
  return rest ? `"${colName}" ${rest}` : `"${colName}"`;
}

function getOrderedColumnList(node: TSNode | undefined): string[] | null {
  if (!node || node.type !== 'ArrayExpression') return null;
  const elements = (node.elements as Array<TSNode | null> | undefined) ?? [];
  const columns = elements.map((el) => (el ? parseOrderedColumnName(el) : null));
  if (columns.length === 0 || columns.some((c) => c === null)) return null;
  return columns as string[];
}

function getCallbackParamName(fn: TSNode): string | null {
  const params = fn.params as TSNode[] | undefined;
  if (params && params.length > 0 && params[0].type === 'Identifier') {
    return params[0].name as string;
  }
  return null;
}

/** Resolves an arrow/function expression body to the single expression it evaluates to. */
function getBuilderChainRoot(fn: TSNode): TSNode | null {
  const body = fn.body as TSNode;
  if (!body) return null;
  if (body.type !== 'BlockStatement') return body;
  const statements = (body.body as TSNode[] | undefined) ?? [];
  for (const stmt of statements) {
    if (stmt.type === 'ReturnStatement' && stmt.argument) return stmt.argument as TSNode;
  }
  return null;
}

/** Collects a chain of `.method(args)` calls rooted at an identifier named `paramName`. */
function collectMethodChain(exprNode: TSNode, paramName: string): ChainStep[] | null {
  const chain: ChainStep[] = [];
  let current: TSNode | null = exprNode;
  while (current?.type === 'CallExpression') {
    const callee = current.callee as TSNode;
    if (callee?.type !== 'MemberExpression') return null;
    const prop = callee.property as TSNode;
    if (prop?.type !== 'Identifier') return null;
    chain.unshift({ method: prop.name as string, args: (current.arguments as TSNode[]) ?? [], node: current });
    current = callee.object as TSNode;
  }
  if (current?.type !== 'Identifier' || (current.name as string) !== paramName) return null;
  return chain;
}

function parseColumnBuilderCallback(
  build: TSNode,
  filePath: string,
  warnings: ExtractionWarning[],
): { modifiers: string; notNull: boolean; defaultSql?: string } | null {
  const paramName = getCallbackParamName(build);
  if (!paramName) {
    warnings.push(warning(filePath, build, 'Cannot extract column builder callback parameter name: manual review required'));
    return null;
  }
  const chainRoot = getBuilderChainRoot(build);
  if (!chainRoot) {
    warnings.push(warning(filePath, build, 'Cannot resolve column builder callback body: cannot transpile safely'));
    return null;
  }
  const chain = collectMethodChain(chainRoot, paramName);
  if (!chain) {
    warnings.push(warning(filePath, build, 'Cannot resolve column builder chain: cannot transpile safely'));
    return null;
  }

  let modifiers = '';
  let notNull = false;
  let defaultSql: string | undefined;

  for (const call of chain) {
    switch (call.method) {
      case 'primaryKey':
        modifiers += ' PRIMARY KEY';
        break;
      case 'notNull':
        modifiers += ' NOT NULL';
        notNull = true;
        break;
      case 'unique':
        modifiers += ' UNIQUE';
        break;
      case 'defaultTo': {
        const val = resolveDefaultValue(call.args[0]);
        modifiers += ` DEFAULT ${val}`;
        defaultSql = val;
        break;
      }
      case 'references': {
        const ref = getStringArg(call.args[0]);
        if (!ref) {
          warnings.push(warning(filePath, call.args[0] ?? call.node, 'Dynamic references() target: cannot transpile safely'));
          return null;
        }
        const parsed = parseInlineReference(ref);
        if (!parsed) {
          warnings.push(warning(filePath, call.node, `references("${ref}") is not in "table.column" form: cannot transpile safely`));
          return null;
        }
        modifiers += ` REFERENCES "${parsed.table}"("${parsed.column}")`;
        break;
      }
      case 'onDelete':
      case 'onUpdate': {
        const action = getStringArg(call.args[0]);
        if (action && FK_ACTIONS.has(action.toUpperCase())) {
          modifiers += ` ${call.method === 'onDelete' ? 'ON DELETE' : 'ON UPDATE'} ${action.toUpperCase()}`;
        }
        break;
      }
      case 'generatedAlwaysAsIdentity':
        modifiers += ' GENERATED ALWAYS AS IDENTITY';
        break;
      case 'generatedByDefaultAsIdentity':
        modifiers += ' GENERATED BY DEFAULT AS IDENTITY';
        break;
      case 'autoIncrement':
      case 'identity':
      case 'unsigned':
        // Dialect-agnostic no-ops for Postgres: these don't change the emitted
        // column definition's locking/risk profile.
        break;
      default:
        // Unlike Knex's lenient default (silently ignore unknown modifiers),
        // fail closed here: Kysely's column builder API is compact enough that
        // an unrecognized method (check(), modifyEnd(), stored(), ...) is more
        // likely to carry real semantic weight we'd otherwise silently drop.
        warnings.push(warning(filePath, call.node, `Unsupported Kysely column builder method ${call.method}(): cannot transpile safely`));
        return null;
    }
  }

  return { modifiers, notNull, defaultSql };
}

function parseAddColumnCall(
  step: ChainStep,
  filePath: string,
  warnings: ExtractionWarning[],
): ColumnDef | null {
  if (step.args.length < 2) {
    warnings.push(warning(filePath, step.node, `${step.method}() called with ${step.args.length} argument(s) (expected 2 or 3): cannot transpile, manual review required`));
    return null;
  }
  const colName = getStringArg(step.args[0]);
  if (!colName) {
    warnings.push(warning(filePath, step.args[0], `Dynamic column name in ${step.method}: cannot transpile`));
    return null;
  }
  const type = resolveDataType(step.args[1], filePath, warnings, step.node);
  if (type === null) return null;

  let modifiers = '';
  let notNull = false;
  let defaultSql: string | undefined;

  if (step.args.length >= 3) {
    const build = step.args[2];
    if (build.type !== 'ArrowFunctionExpression' && build.type !== 'FunctionExpression') {
      warnings.push(warning(filePath, build, `Non-function column builder callback in ${step.method}: cannot transpile`));
      return null;
    }
    const parsed = parseColumnBuilderCallback(build, filePath, warnings);
    if (!parsed) return null;
    modifiers = parsed.modifiers;
    notNull = parsed.notNull;
    defaultSql = parsed.defaultSql;
  }

  return { name: colName, type, modifiers, notNull, defaultSql };
}

/**
 * Postgres table-constraint grammar (postgresql.org/docs/current/sql-createtable.html):
 * `UNIQUE [ NULLS [ NOT ] DISTINCT ] ( columns )` for the constraint keyword
 * itself, and `[ DEFERRABLE | NOT DEFERRABLE ] [ INITIALLY DEFERRED | INITIALLY
 * IMMEDIATE ]` trailing the whole constraint - applies to UNIQUE and PRIMARY
 * KEY alike (PRIMARY KEY just has no NULLS NOT DISTINCT option, since primary
 * key columns are already NOT NULL).
 */
function buildConstraintColumnsClause(
  step: ChainStep,
  kind: 'PRIMARY KEY' | 'UNIQUE',
  filePath: string,
  warnings: ExtractionWarning[],
): string | null {
  if (step.args.length < 2) {
    warnings.push(warning(filePath, step.node, `${step.method}() called with ${step.args.length} argument(s) (expected 2 or 3): cannot transpile, manual review required`));
    return null;
  }
  const name = getStringArg(step.args[0]);
  if (!name) {
    warnings.push(warning(filePath, step.args[0], `Dynamic constraint name in ${step.method}: cannot transpile`));
    return null;
  }
  const columns = getColumnList(step.args[1]);
  if (!columns) {
    warnings.push(warning(filePath, step.args[1] ?? step.node, `Dynamic or unresolved column list in ${step.method}: cannot transpile safely`));
    return null;
  }

  let nullsNotDistinct = false;
  let deferrable: 'DEFERRABLE' | 'NOT DEFERRABLE' | null = null;
  let initially: 'INITIALLY DEFERRED' | 'INITIALLY IMMEDIATE' | null = null;

  if (step.args.length >= 3) {
    const build = step.args[2];
    if (build.type !== 'ArrowFunctionExpression' && build.type !== 'FunctionExpression') {
      warnings.push(warning(filePath, build, `Non-function builder callback in ${step.method}: cannot transpile`));
      return null;
    }
    const paramName = getCallbackParamName(build);
    const chainRoot = paramName ? getBuilderChainRoot(build) : null;
    const chain = chainRoot && paramName ? collectMethodChain(chainRoot, paramName) : null;
    if (!paramName || !chainRoot || !chain) {
      warnings.push(warning(filePath, build, `Cannot resolve ${step.method}() builder callback: cannot transpile safely`));
      return null;
    }
    for (const call of chain) {
      switch (call.method) {
        case 'nullsNotDistinct':
          if (kind !== 'UNIQUE') {
            warnings.push(warning(filePath, call.node, `nullsNotDistinct() is only valid on UNIQUE constraints, not ${kind}: cannot transpile safely`));
            return null;
          }
          nullsNotDistinct = true;
          break;
        case 'deferrable':
          deferrable = 'DEFERRABLE';
          break;
        case 'notDeferrable':
          deferrable = 'NOT DEFERRABLE';
          break;
        case 'initiallyDeferred':
          initially = 'INITIALLY DEFERRED';
          break;
        case 'initiallyImmediate':
          initially = 'INITIALLY IMMEDIATE';
          break;
        default:
          warnings.push(warning(filePath, call.node, `Unsupported Kysely ${step.method} builder method ${call.method}(): cannot transpile safely`));
          return null;
      }
    }
  }

  const nnd = nullsNotDistinct ? ' NULLS NOT DISTINCT' : '';
  const trailer = [deferrable, initially].filter((v) => v !== null).map((v) => ` ${v}`).join('');
  return `CONSTRAINT "${name}" ${kind}${nnd} (${quoteColumns(columns)})${trailer}`;
}

/**
 * Shared by both places a chain of FK builder methods (onDelete/onUpdate) can
 * appear: CreateTableBuilder's 5th-argument callback form, and
 * AlterTableBuilder's own chained-builder form (see FK_TRAILING_CHAIN_METHODS
 * above). Fails closed (returns null, having already pushed a warning) on any
 * other real Kysely FK builder method (deferrable, notDeferrable,
 * initiallyDeferred, initiallyImmediate) rather than silently dropping it.
 */
function buildForeignKeyActions(
  chain: ChainStep[],
  filePath: string,
  warnings: ExtractionWarning[],
): string | null {
  let actions = '';
  for (const call of chain) {
    if (call.method === 'onDelete' || call.method === 'onUpdate') {
      const action = getStringArg(call.args[0]);
      if (action && FK_ACTIONS.has(action.toUpperCase())) {
        actions += ` ${call.method === 'onDelete' ? 'ON DELETE' : 'ON UPDATE'} ${action.toUpperCase()}`;
      }
    } else {
      warnings.push(warning(filePath, call.node, `Unsupported Kysely foreign key builder method ${call.method}(): cannot transpile safely`));
      return null;
    }
  }
  return actions;
}

function buildForeignKeyClause(
  step: ChainStep,
  filePath: string,
  warnings: ExtractionWarning[],
): string | null {
  if (step.args.length < 4) {
    warnings.push(warning(filePath, step.node, `addForeignKeyConstraint() called with ${step.args.length} argument(s) (expected 4 or 5): cannot transpile, manual review required`));
    return null;
  }
  const name = getStringArg(step.args[0]);
  const columns = getColumnList(step.args[1]);
  const targetTable = getStringArg(step.args[2]);
  const targetColumns = getColumnList(step.args[3]);
  if (!name || !columns || !targetTable || !targetColumns) {
    warnings.push(warning(filePath, step.node, 'Dynamic or unresolved addForeignKeyConstraint() arguments: cannot transpile safely'));
    return null;
  }

  let actions = '';
  if (step.args.length >= 5) {
    const build = step.args[4];
    if (build.type !== 'ArrowFunctionExpression' && build.type !== 'FunctionExpression') {
      warnings.push(warning(filePath, build, 'Non-function build callback in addForeignKeyConstraint: cannot transpile'));
      return null;
    }
    const paramName = getCallbackParamName(build);
    const chainRoot = paramName ? getBuilderChainRoot(build) : null;
    const chain = chainRoot && paramName ? collectMethodChain(chainRoot, paramName) : null;
    if (!paramName || !chainRoot || !chain) {
      warnings.push(warning(filePath, build, 'Cannot resolve addForeignKeyConstraint() build callback: cannot transpile safely'));
      return null;
    }
    const built = buildForeignKeyActions(chain, filePath, warnings);
    if (built === null) return null;
    actions = built;
  }

  return `CONSTRAINT "${name}" FOREIGN KEY (${quoteColumns(columns)}) REFERENCES "${targetTable}" (${quoteColumns(targetColumns)})${actions}`;
}

function buildCheckClause(
  step: ChainStep,
  filePath: string,
  warnings: ExtractionWarning[],
): string | null {
  if (step.args.length < 2) {
    warnings.push(warning(filePath, step.node, `addCheckConstraint() called with ${step.args.length} argument(s) (expected 2): cannot transpile, manual review required`));
    return null;
  }
  const name = getStringArg(step.args[0]);
  if (!name) {
    warnings.push(warning(filePath, step.args[0], 'Dynamic constraint name in addCheckConstraint: cannot transpile'));
    return null;
  }
  const expr = getSqlTemplateLiteral(step.args[1]);
  if (expr === null) {
    warnings.push(warning(filePath, step.args[1] ?? step.node, 'Dynamic or unsupported CHECK expression in addCheckConstraint: cannot transpile safely'));
    return null;
  }
  return `CONSTRAINT "${name}" CHECK (${expr})`;
}

function transpileCreateTable(root: ChainStep, rest: ChainStep[], filePath: string): TranspileResult {
  const warnings: ExtractionWarning[] = [];
  if (root.args.length < 1) {
    warnings.push(warning(filePath, root.node, 'createTable() called with 0 arguments (expected 1): cannot transpile, manual review required'));
    return { sql: [], warnings };
  }
  const tableName = getStringArg(root.args[0]);
  if (!tableName) {
    warnings.push(warning(filePath, root.args[0], 'Dynamic table name in createTable: cannot transpile'));
    return { sql: [], warnings };
  }

  let ifNotExists = false;
  let temporary = false;
  const parts: string[] = [];

  for (const step of rest) {
    switch (step.method) {
      case 'ifNotExists':
        ifNotExists = true;
        break;
      case 'temporary':
        temporary = true;
        break;
      case 'addColumn': {
        const col = parseAddColumnCall(step, filePath, warnings);
        if (col) parts.push(`"${col.name}" ${col.type}${col.modifiers}`);
        break;
      }
      case 'addPrimaryKeyConstraint': {
        const clause = buildConstraintColumnsClause(step, 'PRIMARY KEY', filePath, warnings);
        if (clause) parts.push(clause);
        break;
      }
      case 'addUniqueConstraint': {
        const clause = buildConstraintColumnsClause(step, 'UNIQUE', filePath, warnings);
        if (clause) parts.push(clause);
        break;
      }
      case 'addForeignKeyConstraint': {
        const clause = buildForeignKeyClause(step, filePath, warnings);
        if (clause) parts.push(clause);
        break;
      }
      case 'addCheckConstraint': {
        const clause = buildCheckClause(step, filePath, warnings);
        if (clause) parts.push(clause);
        break;
      }
      default:
        warnings.push(warning(filePath, step.node, `Unsupported Kysely createTable builder method: ${step.method}`));
        break;
    }
  }

  if (warnings.some((w) => w.unanalyzable) || parts.length === 0) {
    return { sql: [], warnings };
  }

  const temp = temporary ? ' TEMPORARY' : '';
  const ifNE = ifNotExists ? ' IF NOT EXISTS' : '';
  return { sql: [`CREATE${temp} TABLE${ifNE} "${tableName}" (${parts.join(', ')})`], warnings };
}

function transpileAlterTable(root: ChainStep, rest: ChainStep[], filePath: string): TranspileResult {
  const warnings: ExtractionWarning[] = [];
  if (root.args.length < 1) {
    warnings.push(warning(filePath, root.node, 'alterTable() called with 0 arguments (expected 1): cannot transpile, manual review required'));
    return { sql: [], warnings };
  }
  const tableName = getStringArg(root.args[0]);
  if (!tableName) {
    warnings.push(warning(filePath, root.args[0], 'Dynamic table name in alterTable: cannot transpile'));
    return { sql: [], warnings };
  }

  const sql: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const step = rest[i];
    switch (step.method) {
      case 'addColumn': {
        const col = parseAddColumnCall(step, filePath, warnings);
        if (col) sql.push(`ALTER TABLE "${tableName}" ADD COLUMN "${col.name}" ${col.type}${col.modifiers}`);
        break;
      }
      case 'modifyColumn': {
        // Kysely's own JSDoc on this method: "The `modify column` statement is
        // only implemeted [sic] by MySQL and oracle AFAIK. On other databases
        // you should use the `alterColumn` method." PostgresQueryCompiler does
        // not override visitModifyColumn, so it inherits DefaultQueryCompiler's
        // literal `modify column ...` output - not valid Postgres syntax
        // (Postgres has no ALTER TABLE ... MODIFY COLUMN form). There is no
        // working Kysely-on-Postgres migration that calls .modifyColumn(), so
        // translating it into TYPE/SET NOT NULL/SET DEFAULT statements would
        // analyze semantics that do not exist and would never actually run:
        // the real migration errors out at this call instead. Fail closed.
        warnings.push(warning(
          filePath,
          step.node,
          "modifyColumn() is not implemented for Postgres by Kysely (MySQL/Oracle only, per Kysely's own docs) " +
          'and will fail at runtime; use alterColumn() instead. Cannot transpile.',
        ));
        break;
      }
      case 'dropColumn': {
        if (step.args.length > 1) {
          warnings.push(warning(filePath, step.node, 'dropColumn() with a builder callback is not supported: cannot transpile safely'));
          break;
        }
        const colName = getStringArg(step.args[0]);
        if (colName) sql.push(`ALTER TABLE "${tableName}" DROP COLUMN "${colName}"`);
        else warnings.push(warning(filePath, step.args[0] ?? step.node, 'Dynamic column name in dropColumn: cannot transpile'));
        break;
      }
      case 'renameColumn': {
        const from = getStringArg(step.args[0]);
        const to = getStringArg(step.args[1]);
        if (from && to) sql.push(`ALTER TABLE "${tableName}" RENAME COLUMN "${from}" TO "${to}"`);
        else warnings.push(warning(filePath, (from ? step.args[1] : step.args[0]) ?? step.node, 'Dynamic column name in renameColumn: cannot transpile'));
        break;
      }
      case 'alterColumn': {
        const stmts = parseAlterColumnCall(step, tableName, filePath, warnings);
        if (stmts) sql.push(...stmts);
        break;
      }
      case 'renameTo': {
        const newName = getStringArg(step.args[0]);
        if (newName) sql.push(`ALTER TABLE "${tableName}" RENAME TO "${newName}"`);
        else warnings.push(warning(filePath, step.args[0] ?? step.node, 'Dynamic table name in renameTo: cannot transpile'));
        break;
      }
      case 'addUniqueConstraint': {
        const clause = buildConstraintColumnsClause(step, 'UNIQUE', filePath, warnings);
        if (clause) sql.push(`ALTER TABLE "${tableName}" ADD ${clause}`);
        break;
      }
      case 'addPrimaryKeyConstraint': {
        const clause = buildConstraintColumnsClause(step, 'PRIMARY KEY', filePath, warnings);
        if (clause) sql.push(`ALTER TABLE "${tableName}" ADD ${clause}`);
        break;
      }
      case 'addForeignKeyConstraint': {
        const clause = buildForeignKeyClause(step, filePath, warnings);
        if (clause === null) break;
        // Unlike createTable's addForeignKeyConstraint (a 4-arg call with an
        // optional 5th callback argument), AlterTableBuilder's version returns
        // AlterTableAddForeignKeyConstraintBuilder, so .onDelete()/.onUpdate()/
        // etc. show up as their OWN top-level chain steps right after this one,
        // not nested inside a callback. Consume them here before the outer loop
        // can hit them as unrecognized alterTable methods.
        let j = i + 1;
        const trailing: ChainStep[] = [];
        while (j < rest.length && FK_TRAILING_CHAIN_METHODS.has(rest[j].method)) {
          trailing.push(rest[j]);
          j++;
        }
        if (trailing.length === 0) {
          sql.push(`ALTER TABLE "${tableName}" ADD ${clause}`);
          break;
        }
        const actions = buildForeignKeyActions(trailing, filePath, warnings);
        if (actions === null) break;
        sql.push(`ALTER TABLE "${tableName}" ADD ${clause}${actions}`);
        i = j - 1;
        break;
      }
      case 'addCheckConstraint': {
        const clause = buildCheckClause(step, filePath, warnings);
        if (clause) sql.push(`ALTER TABLE "${tableName}" ADD ${clause}`);
        break;
      }
      case 'dropConstraint': {
        const name = getStringArg(step.args[0]);
        if (name) sql.push(`ALTER TABLE "${tableName}" DROP CONSTRAINT "${name}"`);
        else warnings.push(warning(filePath, step.args[0] ?? step.node, 'Dynamic constraint name in dropConstraint: cannot transpile'));
        break;
      }
      case 'dropIndex': {
        const name = getStringArg(step.args[0]);
        if (name) sql.push(`DROP INDEX "${name}"`);
        else warnings.push(warning(filePath, step.args[0] ?? step.node, 'Dynamic index name in dropIndex: cannot transpile'));
        break;
      }
      default:
        warnings.push(warning(filePath, step.node, `Unsupported Kysely alterTable builder method: ${step.method}`));
        break;
    }
  }

  if (warnings.some((w) => w.unanalyzable)) {
    return { sql: [], warnings };
  }
  return { sql, warnings };
}

function parseAlterColumnCall(
  step: ChainStep,
  tableName: string,
  filePath: string,
  warnings: ExtractionWarning[],
): string[] | null {
  if (step.args.length < 2) {
    warnings.push(warning(filePath, step.node, `alterColumn() called with ${step.args.length} argument(s) (expected 2): cannot transpile, manual review required`));
    return null;
  }
  const colName = getStringArg(step.args[0]);
  if (!colName) {
    warnings.push(warning(filePath, step.args[0], 'Dynamic column name in alterColumn: cannot transpile'));
    return null;
  }
  const build = step.args[1];
  if (build.type !== 'ArrowFunctionExpression' && build.type !== 'FunctionExpression') {
    warnings.push(warning(filePath, build, 'Non-function alteration callback in alterColumn: cannot transpile'));
    return null;
  }
  const paramName = getCallbackParamName(build);
  if (!paramName) {
    warnings.push(warning(filePath, build, 'Cannot extract alterColumn callback parameter name: manual review required'));
    return null;
  }
  const chainRoot = getBuilderChainRoot(build);
  if (!chainRoot) {
    warnings.push(warning(filePath, build, 'Cannot resolve alterColumn callback body: cannot transpile safely'));
    return null;
  }
  const chain = collectMethodChain(chainRoot, paramName);
  if (!chain || chain.length === 0) {
    warnings.push(warning(filePath, build, 'Cannot resolve alterColumn() alteration: cannot transpile safely'));
    return null;
  }
  if (chain.length > 1) {
    warnings.push(warning(filePath, build, 'Multiple chained alterations in a single alterColumn() call are not supported: cannot transpile safely'));
    return null;
  }

  const alteration = chain[0];
  switch (alteration.method) {
    case 'setDataType': {
      const type = resolveDataType(alteration.args[0], filePath, warnings, step.node);
      if (type === null) return null;
      return [`ALTER TABLE "${tableName}" ALTER COLUMN "${colName}" TYPE ${type}`];
    }
    case 'setDefault':
      return [`ALTER TABLE "${tableName}" ALTER COLUMN "${colName}" SET DEFAULT ${resolveDefaultValue(alteration.args[0])}`];
    case 'dropDefault':
      return [`ALTER TABLE "${tableName}" ALTER COLUMN "${colName}" DROP DEFAULT`];
    case 'setNotNull':
      return [`ALTER TABLE "${tableName}" ALTER COLUMN "${colName}" SET NOT NULL`];
    case 'dropNotNull':
      return [`ALTER TABLE "${tableName}" ALTER COLUMN "${colName}" DROP NOT NULL`];
    default:
      warnings.push(warning(filePath, alteration.node, `Unsupported Kysely alterColumn alteration: ${alteration.method}()`));
      return null;
  }
}

function transpileDropTable(root: ChainStep, rest: ChainStep[], filePath: string): TranspileResult {
  const warnings: ExtractionWarning[] = [];
  if (root.args.length < 1) {
    warnings.push(warning(filePath, root.node, 'dropTable() called with 0 arguments (expected 1): cannot transpile, manual review required'));
    return { sql: [], warnings };
  }
  const tableName = getStringArg(root.args[0]);
  if (!tableName) {
    warnings.push(warning(filePath, root.args[0], 'Dynamic table name in dropTable: cannot transpile'));
    return { sql: [], warnings };
  }

  let ifExists = false;
  let cascade = false;
  for (const step of rest) {
    switch (step.method) {
      case 'ifExists':
        ifExists = true;
        break;
      case 'cascade':
        cascade = true;
        break;
      case 'temporary':
        break;
      default:
        warnings.push(warning(filePath, step.node, `Unsupported Kysely dropTable builder method: ${step.method}`));
        break;
    }
  }
  if (warnings.some((w) => w.unanalyzable)) return { sql: [], warnings };

  const ifE = ifExists ? ' IF EXISTS' : '';
  const casc = cascade ? ' CASCADE' : '';
  return { sql: [`DROP TABLE${ifE} "${tableName}"${casc}`], warnings };
}

function transpileCreateIndex(root: ChainStep, rest: ChainStep[], filePath: string): TranspileResult {
  const warnings: ExtractionWarning[] = [];
  if (root.args.length < 1) {
    warnings.push(warning(filePath, root.node, 'createIndex() called with 0 arguments (expected 1): cannot transpile, manual review required'));
    return { sql: [], warnings };
  }
  const indexName = getStringArg(root.args[0]);
  if (!indexName) {
    warnings.push(warning(filePath, root.args[0], 'Dynamic index name in createIndex: cannot transpile'));
    return { sql: [], warnings };
  }

  let table: string | null = null;
  let columns: string[] = [];
  let unique = false;
  let ifNotExists = false;
  let using: string | null = null;
  let nullsNotDistinct = false;

  for (const step of rest) {
    switch (step.method) {
      case 'on': {
        const t = getStringArg(step.args[0]);
        if (!t) {
          warnings.push(warning(filePath, step.args[0] ?? step.node, 'Dynamic table name in createIndex().on(): cannot transpile'));
          break;
        }
        table = t;
        break;
      }
      case 'column': {
        const col = parseOrderedColumnName(step.args[0]);
        if (!col) {
          warnings.push(warning(filePath, step.args[0] ?? step.node, 'Dynamic column name in createIndex().column(): cannot transpile'));
          break;
        }
        columns.push(col);
        break;
      }
      case 'columns': {
        const cols = getOrderedColumnList(step.args[0]);
        if (!cols) {
          warnings.push(warning(filePath, step.args[0] ?? step.node, 'Dynamic or unresolved column list in createIndex().columns(): cannot transpile safely'));
          break;
        }
        columns = columns.concat(cols);
        break;
      }
      case 'unique':
        unique = true;
        break;
      case 'ifNotExists':
        ifNotExists = true;
        break;
      case 'nullsNotDistinct':
        nullsNotDistinct = true;
        break;
      case 'using': {
        const u = getStringArg(step.args[0]);
        if (!u) {
          warnings.push(warning(filePath, step.args[0] ?? step.node, 'Dynamic index type in createIndex().using(): cannot transpile'));
          break;
        }
        using = u;
        break;
      }
      case 'where':
      case 'expression':
        warnings.push(warning(filePath, step.node, `Kysely createIndex().${step.method}() (partial/expression index) is not supported: cannot transpile safely`));
        break;
      default:
        warnings.push(warning(filePath, step.node, `Unsupported Kysely createIndex builder method: ${step.method}`));
        break;
    }
  }

  if (warnings.some((w) => w.unanalyzable)) return { sql: [], warnings };

  if (!table) {
    warnings.push(warning(filePath, root.node, 'createIndex() is missing .on(table): cannot transpile'));
    return { sql: [], warnings };
  }
  if (columns.length === 0) {
    warnings.push(warning(filePath, root.node, 'createIndex() has no columns: cannot transpile'));
    return { sql: [], warnings };
  }

  const uniqueKw = unique ? 'UNIQUE ' : '';
  const ifNE = ifNotExists ? 'IF NOT EXISTS ' : '';
  const usingClause = using ? ` USING ${using}` : '';
  const nnd = nullsNotDistinct ? ' NULLS NOT DISTINCT' : '';
  return {
    sql: [`CREATE ${uniqueKw}INDEX ${ifNE}"${indexName}" ON "${table}"${usingClause} (${columns.join(', ')})${nnd}`],
    warnings,
  };
}

function transpileDropIndex(root: ChainStep, rest: ChainStep[], filePath: string): TranspileResult {
  const warnings: ExtractionWarning[] = [];
  if (root.args.length < 1) {
    warnings.push(warning(filePath, root.node, 'dropIndex() called with 0 arguments (expected 1): cannot transpile, manual review required'));
    return { sql: [], warnings };
  }
  const indexName = getStringArg(root.args[0]);
  if (!indexName) {
    warnings.push(warning(filePath, root.args[0], 'Dynamic index name in dropIndex: cannot transpile'));
    return { sql: [], warnings };
  }

  let ifExists = false;
  let cascade = false;
  for (const step of rest) {
    switch (step.method) {
      case 'on':
        // Postgres DROP INDEX doesn't take a table name; the .on() hint is
        // only meaningful for dialects (e.g. MySQL) that require it.
        break;
      case 'ifExists':
        ifExists = true;
        break;
      case 'cascade':
        cascade = true;
        break;
      default:
        warnings.push(warning(filePath, step.node, `Unsupported Kysely dropIndex builder method: ${step.method}`));
        break;
    }
  }
  if (warnings.some((w) => w.unanalyzable)) return { sql: [], warnings };

  const ifE = ifExists ? ' IF EXISTS' : '';
  const casc = cascade ? ' CASCADE' : '';
  return { sql: [`DROP INDEX${ifE} "${indexName}"${casc}`], warnings };
}
