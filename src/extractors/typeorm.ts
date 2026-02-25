/**
 * Extractor: TypeORM migrations (.ts)
 *
 * Uses @typescript-eslint/typescript-estree to walk the TS AST and
 * extract SQL from queryRunner.query() calls in the up() method.
 *
 * Never uses regex. Warns on dynamic SQL — never silently ignores it.
 */

import { readFile } from 'node:fs/promises';
import type { ExtractionResult, ExtractionWarning } from '../types.js';

interface TSNode {
  type: string;
  loc?: { start: { line: number; column: number }; end: { line: number; column: number } };
  [key: string]: unknown;
}

interface UpMethodInfo {
  body: TSNode;
  paramName: string;
  autoCommit: boolean;
}

export async function extractTypeORMSQL(filePath: string): Promise<ExtractionResult> {
  const source = await readFile(filePath, 'utf8');
  const warnings: ExtractionWarning[] = [];
  const queries: string[] = [];

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
    });
    return { sql: '', warnings };
  }

  // Walk the up() method body to find <paramName>.query() calls
  walkNode(upInfo.body, (node: TSNode) => {
    if (
      node.type === 'CallExpression' &&
      isQueryRunnerQuery(node, upInfo.paramName)
    ) {
      const args = node.arguments as TSNode[];
      if (args.length === 0) return;

      const arg = args[0];
      const extracted = extractStringValue(arg);
      if (extracted !== null) {
        queries.push(extracted);
      } else {
        const loc = arg.loc?.start ?? { line: 0, column: 0 };
        warnings.push({
          filePath,
          line: loc.line,
          column: loc.column,
          message: 'Dynamic SQL — cannot statically analyze queryRunner.query() argument',
        });
      }
    }
  });

  return { sql: queries.join(';\n'), warnings, autoCommit: upInfo.autoCommit };
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

function isQueryRunnerQuery(node: TSNode, paramName: string): boolean {
  const callee = node.callee as TSNode;
  if (callee?.type !== 'MemberExpression') return false;
  const prop = callee.property as TSNode;
  if (prop?.type !== 'Identifier' || (prop.name as string) !== 'query') return false;
  const obj = callee.object as TSNode;
  if (obj?.type === 'Identifier' && (obj.name as string) === paramName) return true;
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
      // No interpolations — safe to extract
      return quasis.map((q) => (q.value as { cooked: string }).cooked).join('');
    }
    // Has interpolations — extract what we can but this is incomplete
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
