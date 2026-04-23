/**
 * Extractor: TypeORM migrations (.ts)
 *
 * Uses @typescript-eslint/typescript-estree to walk the TS AST and
 * extract SQL from queryRunner.query() calls in the up() method.
 *
 * Never uses regex. Warns on dynamic SQL, never silently ignores it.
 */

import type { ExtractionResult, ExtractionWarning } from '../types.js';
import { readTextMigrationFile } from './file-guards.js';

interface TSNode {
  type: string;
  loc?: { start: { line: number; column: number }; end: { line: number; column: number } };
  range?: [number, number];
  [key: string]: unknown;
}

interface UpMethodInfo {
  body: TSNode;
  paramName: string;
  autoCommit: boolean;
}

const TYPEORM_BUILDER_METHODS = new Set([
  // Table operations
  'createTable', 'dropTable', 'renameTable', 'clearTable',
  // Column operations (singular + plural)
  'addColumn', 'addColumns',
  'dropColumn', 'dropColumns',
  'changeColumn', 'changeColumns',
  'renameColumn',
  // Index operations (singular + plural)
  'createIndex', 'createIndices',
  'dropIndex', 'dropIndices',
  // Unique constraint (singular + plural)
  'createUniqueConstraint', 'createUniqueConstraints',
  'dropUniqueConstraint', 'dropUniqueConstraints',
  // Foreign key (singular + plural)
  'createForeignKey', 'createForeignKeys',
  'dropForeignKey', 'dropForeignKeys',
  // Primary key
  'createPrimaryKey', 'dropPrimaryKey', 'updatePrimaryKeys',
  // Check constraint (singular + plural)
  'createCheckConstraint', 'createCheckConstraints',
  'dropCheckConstraint', 'dropCheckConstraints',
  // Exclusion constraint (singular + plural)
  'createExclusionConstraint', 'createExclusionConstraints',
  'dropExclusionConstraint', 'dropExclusionConstraints',
  // View operations
  'createView', 'dropView',
  // Schema/database operations
  'createSchema', 'dropSchema',
]);

export async function extractTypeORMSQL(filePath: string): Promise<ExtractionResult> {
  const source = await readTextMigrationFile(filePath);
  return extractTypeORMSQLFromSource(source, filePath);
}

export async function extractTypeORMSQLFromSource(
  source: string,
  filePath = '<memory>',
): Promise<ExtractionResult> {
  const warnings: ExtractionWarning[] = [];
  const queries: string[] = [];
  const sourceRanges: Array<{ startOffset: number; endOffset: number }> = [];

  // Dynamic import to keep typescript-estree as devDependency
  const { parse } = await import('@typescript-eslint/typescript-estree');
  const ast = parse(source, {
    loc: true,
    range: true,
    jsx: false,
  }) as unknown as TSNode;

  // Find the up() method in the class
  const upInfo = findUpMethod(ast);
  if (!upInfo) {
    warnings.push({
      filePath,
      line: 1,
      column: 0,
      message: 'No up() method found in TypeORM migration',
      unanalyzable: true,
    });
    return { sql: '', warnings };
  }

  // Walk the up() method body to find <paramName>.query() calls
  // Gap 11: track conditional depth to warn about conditional SQL
  const conditionalTypes = new Set(['IfStatement', 'ConditionalExpression', 'SwitchCase']);
  const queryRunnerNames = new Set([upInfo.paramName]);
  const queryFunctionNames = new Set<string>();
  let conditionalDepth = 0;

  walkNodeWithContext(upInfo.body, {
    enter(node: TSNode) {
      if (conditionalTypes.has(node.type)) conditionalDepth++;

      if (node.type === 'VariableDeclarator') {
        trackTypeORMAlias(node, queryRunnerNames, queryFunctionNames);
      }

      if (node.type === 'CallExpression') {
        // Check for builder API calls (queryRunner.createTable(), etc.)
        const callee = node.callee as TSNode;
        if (
          callee?.type === 'MemberExpression' &&
          (callee.object as TSNode)?.type === 'Identifier' &&
          queryRunnerNames.has((callee.object as TSNode).name as string) &&
          (callee.property as TSNode)?.type === 'Identifier' &&
          TYPEORM_BUILDER_METHODS.has((callee.property as TSNode).name as string)
        ) {
          const methodName = (callee.property as TSNode).name as string;
          const loc = node.loc?.start ?? { line: 0, column: 0 };
          warnings.push({
            filePath,
            line: loc.line,
            column: loc.column,
            message: `TypeORM builder API detected (${upInfo.paramName}.${methodName}) -- pgfence can only analyze ${upInfo.paramName}.query() raw SQL calls`,
            unanalyzable: true,
          });
          return;
        }

        // Check for queryRunner.query() calls
        if (isQueryRunnerQuery(node, queryRunnerNames) || isQueryFunctionCall(node, queryFunctionNames)) {
          const args = node.arguments as TSNode[];
          if (args.length === 0) return;

          const arg = args[0];
          const extracted = extractStringLiteral(arg);
          if (extracted !== null) {
            queries.push(extracted.value);
            sourceRanges.push(extracted.range);
            if (conditionalDepth > 0) {
              const loc = node.loc?.start ?? { line: 0, column: 0 };
              warnings.push({
                filePath,
                line: loc.line,
                column: loc.column,
                message: `Conditional SQL at line ${loc.line} -- statement may or may not execute depending on runtime condition`,
                unanalyzable: true,
              });
            }
          } else {
            const loc = arg.loc?.start ?? { line: 0, column: 0 };
            warnings.push({
              filePath,
              line: loc.line,
              column: loc.column,
              message: 'Dynamic SQL -- cannot statically analyze queryRunner.query() argument',
              unanalyzable: true,
            });
          }
        }
      }
    },
    leave(node: TSNode) {
      if (conditionalTypes.has(node.type)) conditionalDepth--;
    },
  });

  return { sql: queries.join(';\n'), warnings, autoCommit: upInfo.autoCommit, sourceRanges };
}

function findUpMethod(ast: TSNode): UpMethodInfo | null {
  let body: TSNode | null = null;
  let paramName = 'queryRunner';
  let autoCommit = false;
  let classBody: TSNode | null = null;

  walkNode(ast, (node: TSNode) => {
    // Track the class body so we can check for `transaction = false`
    if (node.type === 'ClassBody') {
      classBody = node;
    }

    if (body) return;
    if (
      node.type === 'MethodDefinition' &&
      (node.key as TSNode)?.type === 'Identifier' &&
      ((node.key as TSNode).name as string) === 'up'
    ) {
      const method = node.value as TSNode;
      body = method;

      // Extract the first parameter name (e.g. `qr` from `up(qr: QueryRunner)`)
      const params = method.params as TSNode[] | undefined;
      if (params && params.length > 0) {
        const firstParam = params[0];
        if (firstParam.type === 'Identifier') {
          paramName = firstParam.name as string;
        }
      }
    }
  });

  if (!body) return null;

  // Check for `transaction = false` class property
  if (classBody) {
    const members = (classBody as TSNode).body as TSNode[] | undefined;
    if (members) {
      for (const member of members) {
        if (
          member.type === 'PropertyDefinition' &&
          (member.key as TSNode)?.type === 'Identifier' &&
          ((member.key as TSNode).name as string) === 'transaction' &&
          (member.value as TSNode)?.type === 'Literal' &&
          (member.value as TSNode).value === false
        ) {
          autoCommit = true;
          break;
        }
      }
    }
  }

  return { body, paramName, autoCommit };
}

function isQueryRunnerQuery(node: TSNode, queryRunnerNames: Set<string>): boolean {
  const callee = node.callee as TSNode;
  if (callee?.type !== 'MemberExpression') return false;
  const prop = callee.property as TSNode;
  if (prop?.type !== 'Identifier' || (prop.name as string) !== 'query') return false;
  const obj = callee.object as TSNode;
  // queryRunner.query()
  if (obj?.type === 'Identifier' && queryRunnerNames.has(obj.name as string)) return true;
  // queryRunner.manager.query()
  if (obj?.type === 'MemberExpression') {
    const innerObj = obj.object as TSNode;
    const innerProp = obj.property as TSNode;
    if (innerObj?.type === 'Identifier' && queryRunnerNames.has(innerObj.name as string) &&
        innerProp?.type === 'Identifier' && (innerProp.name as string) === 'manager') {
      return true;
    }
  }
  return false;
}

function isQueryFunctionCall(node: TSNode, queryFunctionNames: Set<string>): boolean {
  const callee = node.callee as TSNode;
  return callee?.type === 'Identifier' && queryFunctionNames.has(callee.name as string);
}

function trackTypeORMAlias(
  node: TSNode,
  queryRunnerNames: Set<string>,
  queryFunctionNames: Set<string>,
): void {
  const id = node.id as TSNode | undefined;
  const init = node.init as TSNode | undefined;
  if (!id || !init) return;

  if (id.type === 'Identifier' && init.type === 'Identifier' && queryRunnerNames.has(init.name as string)) {
    queryRunnerNames.add(id.name as string);
    return;
  }

  if (id.type === 'Identifier' && isQueryMember(init, queryRunnerNames)) {
    queryFunctionNames.add(id.name as string);
    return;
  }

  if (id.type === 'ObjectPattern' && init.type === 'Identifier' && queryRunnerNames.has(init.name as string)) {
    const properties = id.properties as TSNode[] | undefined;
    for (const prop of properties ?? []) {
      if (prop.type !== 'Property') continue;
      const key = prop.key as TSNode;
      const value = prop.value as TSNode;
      if (key?.type === 'Identifier' && key.name === 'query' && value?.type === 'Identifier') {
        queryFunctionNames.add(value.name as string);
      }
    }
  }
}

function isQueryMember(node: TSNode, queryRunnerNames: Set<string>): boolean {
  if (node.type !== 'MemberExpression') return false;
  const prop = node.property as TSNode;
  if (prop?.type !== 'Identifier' || prop.name !== 'query') return false;
  const obj = node.object as TSNode;
  return obj?.type === 'Identifier' && queryRunnerNames.has(obj.name as string);
}

function extractStringLiteral(node: TSNode): { value: string; range: { startOffset: number; endOffset: number } } | null {
  if (node.type === 'Literal' && typeof node.value === 'string') {
    return { value: node.value, range: literalContentRange(node) };
  }
  if (node.type === 'TemplateLiteral') {
    const quasis = node.quasis as TSNode[];
    const expressions = node.expressions as TSNode[];
    if (expressions.length === 0) {
      // No interpolations - safe to extract
      return {
        value: quasis.map((q) => (q.value as { cooked: string }).cooked).join(''),
        range: literalContentRange(node),
      };
    }
    // Has interpolations - extract what we can but this is incomplete
    return null;
  }
  return null;
}

function literalContentRange(node: TSNode): { startOffset: number; endOffset: number } {
  if (!node.range) return { startOffset: 0, endOffset: 0 };
  const [start, end] = node.range;
  return { startOffset: start + 1, endOffset: Math.max(start + 1, end - 1) };
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
