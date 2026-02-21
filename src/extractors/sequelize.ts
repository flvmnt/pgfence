/**
 * Extractor: Sequelize migrations (.js / .ts)
 *
 * Uses @typescript-eslint/typescript-estree to walk the JS/TS AST and
 * extract SQL from queryInterface.sequelize.query() calls.
 *
 * Warns on dynamic SQL — never silently ignores it.
 */

import { readFile } from 'node:fs/promises';
import type { ExtractionResult, ExtractionWarning } from '../types.js';

interface TSNode {
    type: string;
    loc?: { start: { line: number; column: number }; end: { line: number; column: number } };
    [key: string]: unknown;
}

export async function extractSequelizeSQL(filePath: string): Promise<ExtractionResult> {
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

    let foundQuery = false;

    // Walk the AST looking for queryInterface.sequelize.query()
    walkNode(ast, (node: TSNode) => {
        if (
            node.type === 'CallExpression' &&
            isSequelizeQuery(node)
        ) {
            foundQuery = true;
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
                    message: 'Dynamic SQL — cannot statically analyze sequelize.query() argument',
                });
            }
        }
    });

    if (!foundQuery) {
        warnings.push({
            filePath,
            line: 1,
            column: 0,
            message: 'No queryInterface.sequelize.query() calls found in Sequelize migration',
        });
    }

    return { sql: queries.join(';\n'), warnings };
}

function isSequelizeQuery(node: TSNode): boolean {
    const callee = node.callee as TSNode;
    if (callee?.type !== 'MemberExpression') return false;

    // Looking for `something.sequelize.query()`
    const prop = callee.property as TSNode;
    if (prop?.type !== 'Identifier' || (prop.name as string) !== 'query') return false;

    const obj = callee.object as TSNode;
    if (obj?.type === 'MemberExpression') {
        const innerProp = obj.property as TSNode;
        if (innerProp?.type === 'Identifier' && (innerProp.name as string) === 'sequelize') {
            return true;
        }
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
