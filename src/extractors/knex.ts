/**
 * Extractor: Knex migrations (.ts/.js)
 *
 * Uses @typescript-eslint/typescript-estree to walk the TS AST and
 * extract SQL from knex.raw() / trx.raw() / knex.schema.raw() calls
 * in the exports.up / up() function.
 *
 * Warns on schema builder calls (createTable, alterTable, dropTable)
 * since those can't be analyzed as SQL.
 */

import { readFile } from 'node:fs/promises';
import type { ExtractionResult, ExtractionWarning } from '../types.js';
import { transpileKnexSchemaCall } from './knex-transpiler.js';

interface TSNode {
  type: string;
  loc?: { start: { line: number; column: number }; end: { line: number; column: number } };
  [key: string]: unknown;
}

const SCHEMA_BUILDER_METHODS = new Set([
  'createTable', 'alterTable', 'dropTable', 'renameTable',
  'dropColumn', 'renameColumn',
]);

export async function extractKnexSQL(filePath: string): Promise<ExtractionResult> {
  const source = await readFile(filePath, 'utf8');
  const warnings: ExtractionWarning[] = [];
  const queries: string[] = [];

  const { parse } = await import('@typescript-eslint/typescript-estree');
  const ast = parse(source, {
    loc: true,
    range: true,
    jsx: false,
  }) as unknown as TSNode;

  const upFn = findUpFunction(ast);
  if (!upFn) {
    warnings.push({
      filePath,
      line: 1,
      column: 0,
      message: 'No up() or exports.up function found in Knex migration',
    });
    return { sql: '', warnings };
  }

  // Gap 11: track conditional depth to warn about conditional SQL
  const conditionalTypes = new Set(['IfStatement', 'ConditionalExpression', 'SwitchCase']);
  let conditionalDepth = 0;

  walkNodeWithContext(upFn, {
    enter(node: TSNode) {
      if (conditionalTypes.has(node.type)) conditionalDepth++;

      if (node.type !== 'CallExpression') return;

      if (isRawCall(node)) {
        const args = node.arguments as TSNode[];
        if (args.length === 0) return;
        const extracted = extractStringValue(args[0]);
        if (extracted !== null) {
          queries.push(extracted);
          if (conditionalDepth > 0) {
            const loc = node.loc?.start ?? { line: 0, column: 0 };
            warnings.push({
              filePath,
              line: loc.line,
              column: loc.column,
              message: `Conditional SQL at line ${loc.line} — statement may or may not execute depending on runtime condition`,
            });
          }
        } else {
          const loc = args[0].loc?.start ?? { line: 0, column: 0 };
          warnings.push({
            filePath,
            line: loc.line,
            column: loc.column,
            message: 'Dynamic SQL — cannot statically analyze knex.raw() argument',
          });
        }
      } else if (isSchemaBuilderCall(node)) {
        // Gap 13: Transpile schema builder calls to SQL
        const result = transpileKnexSchemaCall(node, filePath);
        if (result.sql.length > 0) {
          queries.push(...result.sql);
        } else {
          const loc = node.loc?.start ?? { line: 0, column: 0 };
          warnings.push({
            filePath,
            line: loc.line,
            column: loc.column,
            message: 'Schema builder call — could not transpile to SQL',
          });
        }
        warnings.push(...result.warnings);
      }
    },
    leave(node: TSNode) {
      if (conditionalTypes.has(node.type)) conditionalDepth--;
    },
  });

  return { sql: queries.join(';\n'), warnings };
}

function findUpFunction(ast: TSNode): TSNode | null {
  let result: TSNode | null = null;
  walkNode(ast, (node: TSNode) => {
    if (result) return;
    // export async function up(knex) { ... }
    if (node.type === 'FunctionDeclaration') {
      const id = node.id as TSNode | null;
      if (id?.type === 'Identifier' && (id.name as string) === 'up') {
        result = node;
      }
    }
    // export const up = async (knex) => { ... } OR export const up = async function(knex) { ... }
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
    }
  });
  return result;
}

function isRawCall(node: TSNode): boolean {
  const callee = node.callee as TSNode;
  if (callee?.type !== 'MemberExpression') return false;
  const prop = callee.property as TSNode;
  if (prop?.type !== 'Identifier' || (prop.name as string) !== 'raw') return false;
  // knex.raw() or trx.raw()
  const obj = callee.object as TSNode;
  if (obj?.type === 'Identifier') return true;
  // knex.schema.raw()
  if (obj?.type === 'MemberExpression') {
    const innerProp = obj.property as TSNode;
    return innerProp?.type === 'Identifier' && (innerProp.name as string) === 'schema';
  }
  return false;
}

function isSchemaBuilderCall(node: TSNode): boolean {
  const callee = node.callee as TSNode;
  if (callee?.type !== 'MemberExpression') return false;
  const prop = callee.property as TSNode;
  if (prop?.type !== 'Identifier') return false;
  const name = prop.name as string;
  if (!SCHEMA_BUILDER_METHODS.has(name)) return false;
  // Check if callee object looks like knex.schema.X
  const obj = callee.object as TSNode;
  if (obj?.type === 'MemberExpression') {
    const schemaProp = obj.property as TSNode;
    return schemaProp?.type === 'Identifier' && (schemaProp.name as string) === 'schema';
  }
  return false;
}

function extractStringValue(node: TSNode): string | null {
  if (node.type === 'Literal' && typeof node.value === 'string') {
    return node.value;
  }
  if (node.type === 'TemplateLiteral') {
    const quasis = node.quasis as TSNode[];
    const expressions = node.expressions as TSNode[];
    if (expressions.length === 0) {
      return quasis.map((q) => (q.value as { cooked: string }).cooked).join('');
    }
    return null;
  }
  return null;
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
