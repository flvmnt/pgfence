/**
 * Extractor: Kysely migrations (.ts/.js)
 *
 * Uses @typescript-eslint/typescript-estree to walk the TS AST and extract
 * SQL from two shapes inside the exports.up / up() function:
 *
 *   1. sql`...`.execute(db)                 (literal raw SQL)
 *   2. db.schema.<method>()...execute(db)   (schema builder chain, transpiled)
 *
 * Warns on interpolated sql`` templates and unsupported/dynamic builder
 * chains, per the Trust Contract: dynamic SQL is never silently skipped.
 */

import type { ExtractionResult, ExtractionWarning } from '../types.js';
import { readTextMigrationFile } from './file-guards.js';
import { transpileKyselySchemaChain, type ChainStep } from './kysely-transpiler.js';

interface TSNode {
  type: string;
  loc?: { start: { line: number; column: number }; end: { line: number; column: number } };
  range?: [number, number];
  [key: string]: unknown;
}

export async function extractKyselySQL(filePath: string): Promise<ExtractionResult> {
  const source = await readTextMigrationFile(filePath);
  return extractKyselySQLFromSource(source, filePath);
}

export async function extractKyselySQLFromSource(
  source: string,
  filePath = '<memory>',
): Promise<ExtractionResult> {
  const warnings: ExtractionWarning[] = [];
  const queries: string[] = [];
  const sourceRanges: Array<{ startOffset: number; endOffset: number }> = [];

  const { parse } = await import('@typescript-eslint/typescript-estree');
  let ast: TSNode;
  try {
    ast = parse(source, {
      loc: true,
      range: true,
      jsx: false,
    }) as unknown as TSNode;
  } catch (err) {
    // A syntax error in the migration source must not abort the whole batch.
    const message = err instanceof Error ? err.message : String(err);
    warnings.push({
      filePath,
      line: 1,
      column: 0,
      message: `Could not parse Kysely migration source: ${message}; this file could not be analyzed`,
      unanalyzable: true,
    });
    return { sql: '', warnings };
  }

  const upFn = findUpFunction(ast);
  if (!upFn) {
    warnings.push({
      filePath,
      line: 1,
      column: 0,
      message: 'No up() function found in Kysely migration',
      unanalyzable: true,
    });
    return { sql: '', warnings };
  }

  // Gap 11 parity: track conditional depth to warn about conditional SQL
  const conditionalTypes = new Set(['IfStatement', 'ConditionalExpression', 'SwitchCase']);
  const schemaNames = new Set<string>();
  let conditionalDepth = 0;

  walkNodeWithContext(upFn, {
    enter(node: TSNode) {
      if (conditionalTypes.has(node.type)) conditionalDepth++;

      if (node.type === 'VariableDeclarator') {
        trackSchemaAlias(node, schemaNames);
      }

      if (node.type !== 'CallExpression') return;

      if (isSqlExecuteCall(node)) {
        const tte = (node.callee as TSNode).object as TSNode;
        const extracted = extractTaggedTemplateLiteral(tte);
        if (extracted !== null) {
          queries.push(extracted.value);
          sourceRanges.push(extracted.range);
          if (conditionalDepth > 0) {
            const loc = node.loc?.start ?? { line: 0, column: 0 };
            warnings.push({
              filePath,
              line: loc.line,
              column: loc.column,
              message: `Conditional SQL at line ${loc.line}, statement may or may not execute depending on runtime condition`,
              unanalyzable: true,
            });
          }
        } else {
          const loc = tte.loc?.start ?? { line: 0, column: 0 };
          warnings.push({
            filePath,
            line: loc.line,
            column: loc.column,
            message: 'Dynamic SQL: cannot statically analyze sql`` tagged template argument',
            unanalyzable: true,
          });
        }
        return;
      }

      const chain = collectSchemaChain(node, schemaNames);
      if (chain) {
        const result = transpileKyselySchemaChain(chain, filePath);
        if (result.sql.length > 0) {
          queries.push(...result.sql);
          for (let i = 0; i < result.sql.length; i++) {
            sourceRanges.push(nodeRange(node));
          }
          if (conditionalDepth > 0) {
            const loc = node.loc?.start ?? { line: 0, column: 0 };
            warnings.push({
              filePath,
              line: loc.line,
              column: loc.column,
              message: `Conditional SQL at line ${loc.line}, statement may or may not execute depending on runtime condition`,
              unanalyzable: true,
            });
          }
        } else if (result.warnings.length === 0) {
          const loc = node.loc?.start ?? { line: 0, column: 0 };
          warnings.push({
            filePath,
            line: loc.line,
            column: loc.column,
            message: 'Schema builder call: could not transpile to SQL',
            unanalyzable: true,
          });
        }
        warnings.push(...result.warnings);
      }
    },
    leave(node: TSNode) {
      if (conditionalTypes.has(node.type)) conditionalDepth--;
    },
  });

  return { sql: queries.join(';\n'), warnings, sourceRanges, sourceText: source, statements: queries };
}

function findUpFunction(ast: TSNode): TSNode | null {
  let result: TSNode | null = null;
  walkNode(ast, (node: TSNode) => {
    if (result) return;
    // export async function up(db) { ... }
    if (node.type === 'FunctionDeclaration') {
      const id = node.id as TSNode | null;
      if (id?.type === 'Identifier' && (id.name as string) === 'up') {
        result = node;
      }
    }
    // export const up = async (db) => { ... } OR export const up = async function(db) { ... }
    if (node.type === 'VariableDeclarator') {
      const id = node.id as TSNode | null;
      const init = node.init as TSNode | null;
      if (
        id?.type === 'Identifier' &&
        (id.name as string) === 'up' &&
        init &&
        (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression')
      ) {
        result = init;
      }
    }
    // exports.up = async function(...)
    if (node.type === 'AssignmentExpression') {
      const left = node.left as TSNode;
      if (
        left?.type === 'MemberExpression' &&
        (left.object as TSNode)?.type === 'Identifier' &&
        ((left.object as TSNode).name as string) === 'exports' &&
        (left.property as TSNode)?.type === 'Identifier' &&
        ((left.property as TSNode).name as string) === 'up'
      ) {
        result = node.right as TSNode;
      }
    }
    // module.exports.up = ...
    if (node.type === 'AssignmentExpression') {
      const left = node.left as TSNode;
      const right = node.right as TSNode;
      if (
        left?.type === 'MemberExpression' &&
        (left.object as TSNode)?.type === 'MemberExpression'
      ) {
        const outerObj = left.object as TSNode;
        if (
          (outerObj.object as TSNode)?.type === 'Identifier' &&
          ((outerObj.object as TSNode).name as string) === 'module' &&
          (outerObj.property as TSNode)?.type === 'Identifier' &&
          ((outerObj.property as TSNode).name as string) === 'exports' &&
          (left.property as TSNode)?.type === 'Identifier' &&
          ((left.property as TSNode).name as string) === 'up'
        ) {
          result = node.right as TSNode;
        }
      }
      if (
        left?.type === 'MemberExpression' &&
        (left.object as TSNode)?.type === 'Identifier' &&
        ((left.object as TSNode).name as string) === 'module' &&
        (left.property as TSNode)?.type === 'Identifier' &&
        ((left.property as TSNode).name as string) === 'exports' &&
        right?.type === 'ObjectExpression'
      ) {
        const props = right.properties as TSNode[] | undefined;
        for (const prop of props ?? []) {
          if (prop.type !== 'Property') continue;
          const key = prop.key as TSNode;
          const value = prop.value as TSNode;
          if (key?.type === 'Identifier' && key.name === 'up' &&
            (value.type === 'FunctionExpression' || value.type === 'ArrowFunctionExpression')) {
            result = value;
          }
        }
      }
    }
  });
  return result;
}

/** `sql\`...\`.execute(db)`: callee is a MemberExpression whose object is a `sql` tagged template. */
function isSqlExecuteCall(node: TSNode): boolean {
  const callee = node.callee as TSNode;
  if (callee?.type !== 'MemberExpression') return false;
  const prop = callee.property as TSNode;
  if (prop?.type !== 'Identifier' || (prop.name as string) !== 'execute') return false;
  const obj = callee.object as TSNode;
  if (obj?.type !== 'TaggedTemplateExpression') return false;
  const tag = obj.tag as TSNode;
  return tag?.type === 'Identifier' && (tag.name as string) === 'sql';
}

/**
 * Collects a `db.schema.<method>(...)....execute()` chain into an ordered
 * array of steps (root method first, `execute()` itself excluded). Returns
 * null when `node` isn't the terminal `.execute()` call of such a chain
 * (including a plain query-builder `.execute()` unrelated to db.schema).
 */
function collectSchemaChain(node: TSNode, schemaNames: Set<string>): ChainStep[] | null {
  const callee = node.callee as TSNode;
  if (callee?.type !== 'MemberExpression') return null;
  const prop = callee.property as TSNode;
  if (prop?.type !== 'Identifier' || (prop.name as string) !== 'execute') return null;

  const chain: ChainStep[] = [];
  let current: TSNode | null = callee.object as TSNode;
  while (current?.type === 'CallExpression') {
    const innerCallee = current.callee as TSNode;
    if (innerCallee?.type !== 'MemberExpression') return null;
    const innerProp = innerCallee.property as TSNode;
    if (innerProp?.type !== 'Identifier') return null;
    chain.unshift({ method: innerProp.name as string, args: (current.arguments as TSNode[]) ?? [], node: current });
    current = innerCallee.object as TSNode;
  }

  if (current?.type === 'MemberExpression') {
    const schemaProp = current.property as TSNode;
    if (!(schemaProp?.type === 'Identifier' && (schemaProp.name as string) === 'schema')) return null;
  } else if (current?.type === 'Identifier') {
    if (!schemaNames.has(current.name as string)) return null;
  } else {
    return null;
  }

  return chain.length > 0 ? chain : null;
}

/** Tracks `const schema = db.schema` aliasing so `schema.createTable(...)` chains are still recognized. */
function trackSchemaAlias(node: TSNode, schemaNames: Set<string>): void {
  const id = node.id as TSNode | undefined;
  const init = node.init as TSNode | undefined;
  if (!id || !init) return;
  if (id.type === 'Identifier' && isSchemaMember(init)) {
    schemaNames.add(id.name as string);
  }
}

function isSchemaMember(node: TSNode): boolean {
  if (node.type !== 'MemberExpression') return false;
  const prop = node.property as TSNode;
  return prop?.type === 'Identifier' && (prop.name as string) === 'schema';
}

function extractTaggedTemplateLiteral(tte: TSNode): { value: string; range: { startOffset: number; endOffset: number } } | null {
  const quasi = tte.quasi as TSNode;
  if (!quasi) return null;
  const quasis = quasi.quasis as TSNode[];
  const expressions = quasi.expressions as TSNode[];
  if (expressions.length !== 0) return null;
  return {
    value: quasis.map((q) => (q.value as { cooked: string }).cooked).join(''),
    range: literalContentRange(quasi),
  };
}

function literalContentRange(node: TSNode): { startOffset: number; endOffset: number } {
  if (!node.range) return { startOffset: 0, endOffset: 0 };
  const [start, end] = node.range;
  return { startOffset: start + 1, endOffset: Math.max(start + 1, end - 1) };
}

function nodeRange(node: TSNode): { startOffset: number; endOffset: number } {
  if (!node.range) return { startOffset: 0, endOffset: 0 };
  return { startOffset: node.range[0], endOffset: node.range[1] };
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

function walkNodeWithContext(
  node: unknown,
  visitor: { enter: (n: TSNode) => void; leave: (n: TSNode) => void },
): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walkNodeWithContext(child, visitor);
    return;
  }
  const n = node as TSNode;
  if (n.type) visitor.enter(n);
  for (const key of Object.keys(n)) {
    if (key === 'parent') continue;
    const val = n[key];
    if (val && typeof val === 'object') {
      walkNodeWithContext(val, visitor);
    }
  }
  if (n.type) visitor.leave(n);
}
