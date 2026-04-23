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

import type { ExtractionResult, ExtractionWarning } from '../types.js';
import { readTextMigrationFile } from './file-guards.js';
import { transpileKnexSchemaCall } from './knex-transpiler.js';

interface TSNode {
  type: string;
  loc?: { start: { line: number; column: number }; end: { line: number; column: number } };
  range?: [number, number];
  [key: string]: unknown;
}

const SCHEMA_BUILDER_METHODS = new Set([
  'createTable', 'createTableIfNotExists', 'alterTable', 'table',
  'dropTable', 'dropTableIfExists', 'renameTable',
  'dropColumn', 'renameColumn',
]);

export async function extractKnexSQL(filePath: string): Promise<ExtractionResult> {
  const source = await readTextMigrationFile(filePath);
  return extractKnexSQLFromSource(source, filePath);
}

export async function extractKnexSQLFromSource(
  source: string,
  filePath = '<memory>',
): Promise<ExtractionResult> {
  const warnings: ExtractionWarning[] = [];
  const queries: string[] = [];
  const sourceRanges: Array<{ startOffset: number; endOffset: number }> = [];

  const { parse } = await import('@typescript-eslint/typescript-estree');
  const ast = parse(source, {
    loc: true,
    range: true,
    jsx: false,
  }) as unknown as TSNode;

  const autoCommit = detectAutoCommit(ast);
  const upFn = findUpFunction(ast);
  if (!upFn) {
    warnings.push({
      filePath,
      line: 1,
      column: 0,
      message: 'No up() or exports.up function found in Knex migration',
      unanalyzable: true,
    });
    return { sql: '', warnings, autoCommit };
  }

  // Gap 11: track conditional depth to warn about conditional SQL
  const conditionalTypes = new Set(['IfStatement', 'ConditionalExpression', 'SwitchCase']);
  const rawFunctionNames = new Set<string>();
  let conditionalDepth = 0;

  walkNodeWithContext(upFn, {
    enter(node: TSNode) {
      if (conditionalTypes.has(node.type)) conditionalDepth++;

      if (node.type === 'VariableDeclarator') {
        trackKnexRawAlias(node, rawFunctionNames);
      }

      if (node.type !== 'CallExpression') return;

      if (isRawCall(node) || isRawFunctionCall(node, rawFunctionNames)) {
        const args = node.arguments as TSNode[];
        if (args.length === 0) return;
        const extracted = extractStringLiteral(args[0]);
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
          const loc = args[0].loc?.start ?? { line: 0, column: 0 };
          warnings.push({
            filePath,
            line: loc.line,
            column: loc.column,
            message: 'Dynamic SQL: cannot statically analyze knex.raw() argument',
            unanalyzable: true,
          });
        }
      } else if (isSchemaBuilderCall(node)) {
        // Gap 13: Transpile schema builder calls to SQL
        const result = transpileKnexSchemaCall(node, filePath);
        if (result.sql.length > 0) {
          queries.push(...result.sql);
          for (let i = 0; i < result.sql.length; i++) {
            sourceRanges.push(nodeRange(node));
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

  return { sql: queries.join(';\n'), warnings, autoCommit, sourceRanges };
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

function detectAutoCommit(ast: TSNode): boolean {
  let autoCommit = false;

  walkNode(ast, (node: TSNode) => {
    if (autoCommit) return;

    if (node.type === 'VariableDeclarator') {
      const id = node.id as TSNode | null;
      const init = node.init as TSNode | null;
      if (id?.type === 'Identifier' && (id.name as string) === 'config' && init?.type === 'ObjectExpression') {
        if (objectHasTransactionFalse(init)) autoCommit = true;
      }
    }

    if (node.type === 'AssignmentExpression') {
      const left = node.left as TSNode;
      const right = node.right as TSNode;
      if (left?.type === 'MemberExpression') {
        const chain = memberExpressionChain(left);
        if (right?.type === 'ObjectExpression' && chain.join('.') === 'exports.config') {
          if (objectHasTransactionFalse(right)) autoCommit = true;
        }
        if (right?.type === 'ObjectExpression' && chain.join('.') === 'module.exports.config') {
          if (objectHasTransactionFalse(right)) autoCommit = true;
        }
        if (right?.type === 'Literal' && right.value === false && chain.join('.') === 'exports.config.transaction') {
          autoCommit = true;
        }
        if (right?.type === 'Literal' && right.value === false && chain.join('.') === 'module.exports.config.transaction') {
          autoCommit = true;
        }
        if (right?.type === 'ObjectExpression' && chain.join('.') === 'module.exports') {
          if (objectHasNestedConfigTransactionFalse(right)) autoCommit = true;
        }
      }
    }
  });

  return autoCommit;
}

function memberExpressionChain(node: TSNode): string[] {
  const parts: string[] = [];
  let current: TSNode | null = node;
  while (current?.type === 'MemberExpression') {
    const prop = current.property as TSNode;
    if (prop?.type === 'Identifier') {
      parts.unshift(prop.name as string);
    }
    current = current.object as TSNode;
  }
  if (current?.type === 'Identifier') {
    parts.unshift(current.name as string);
  }
  return parts;
}

function objectHasTransactionFalse(node: TSNode): boolean {
  const props = node.properties as TSNode[] | undefined;
  if (!props) return false;
  for (const prop of props) {
    if (prop.type !== 'Property') continue;
    const key = prop.key as TSNode;
    const value = prop.value as TSNode;
    if (key?.type !== 'Identifier' || (key.name as string) !== 'transaction') continue;
    if (value.type === 'Literal' && value.value === false) return true;
  }
  return false;
}

function objectHasNestedConfigTransactionFalse(node: TSNode): boolean {
  const props = node.properties as TSNode[] | undefined;
  if (!props) return false;
  for (const prop of props) {
    if (prop.type !== 'Property') continue;
    const key = prop.key as TSNode;
    if (key?.type !== 'Identifier' || (key.name as string) !== 'config') continue;
    const value = prop.value as TSNode;
    if (value.type === 'ObjectExpression' && objectHasTransactionFalse(value)) return true;
  }
  return false;
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

function isRawFunctionCall(node: TSNode, rawFunctionNames: Set<string>): boolean {
  const callee = node.callee as TSNode;
  return callee?.type === 'Identifier' && rawFunctionNames.has(callee.name as string);
}

function trackKnexRawAlias(node: TSNode, rawFunctionNames: Set<string>): void {
  const id = node.id as TSNode | undefined;
  const init = node.init as TSNode | undefined;
  if (!id || !init) return;

  if (id.type === 'Identifier' && isRawMember(init)) {
    rawFunctionNames.add(id.name as string);
    return;
  }

  if (id.type === 'ObjectPattern') {
    const properties = id.properties as TSNode[] | undefined;
    for (const prop of properties ?? []) {
      if (prop.type !== 'Property') continue;
      const key = prop.key as TSNode;
      const value = prop.value as TSNode;
      if (key?.type === 'Identifier' && key.name === 'raw' && value?.type === 'Identifier') {
        rawFunctionNames.add(value.name as string);
      }
    }
  }
}

function isRawMember(node: TSNode): boolean {
  if (node.type !== 'MemberExpression') return false;
  const prop = node.property as TSNode;
  return prop?.type === 'Identifier' && prop.name === 'raw';
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

function extractStringLiteral(node: TSNode): { value: string; range: { startOffset: number; endOffset: number } } | null {
  if (node.type === 'Literal' && typeof node.value === 'string') {
    return { value: node.value, range: literalContentRange(node) };
  }
  if (node.type === 'TemplateLiteral') {
    const quasis = node.quasis as TSNode[];
    const expressions = node.expressions as TSNode[];
    if (expressions.length === 0) {
      return {
        value: quasis.map((q) => (q.value as { cooked: string }).cooked).join(''),
        range: literalContentRange(node),
      };
    }
    return null;
  }
  return null;
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
