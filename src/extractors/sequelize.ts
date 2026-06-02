/**
 * Extractor: Sequelize migrations (.js / .ts)
 *
 * Uses @typescript-eslint/typescript-estree to walk the JS/TS AST and
 * extract SQL from queryInterface.sequelize.query() calls.
 *
 * Warns on dynamic SQL, never silently ignores it.
 */

import type { ExtractionResult, ExtractionWarning } from '../types.js';
import { readTextMigrationFile } from './file-guards.js';
import { transpileSequelizeCall } from './sequelize-transpiler.js';

interface TSNode {
    type: string;
    loc?: { start: { line: number; column: number }; end: { line: number; column: number } };
    range?: [number, number];
    [key: string]: unknown;
}

export async function extractSequelizeSQL(filePath: string): Promise<ExtractionResult> {
    const source = await readTextMigrationFile(filePath);
    return extractSequelizeSQLFromSource(source, filePath);
}

export async function extractSequelizeSQLFromSource(
    source: string,
    filePath = '<memory>',
): Promise<ExtractionResult> {
    const warnings: ExtractionWarning[] = [];
    const queries: string[] = [];
    const sourceRanges: Array<{ startOffset: number; endOffset: number }> = [];

    // Dynamic import to keep typescript-estree as devDependency
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
            message: `Could not parse Sequelize migration source: ${message}; this file could not be analyzed`,
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
            message: 'No up() function found in Sequelize migration',
            unanalyzable: true,
        });
        return { sql: '', warnings };
    }

    // Sequelize passes queryInterface as the first positional parameter, which
    // is conventionally but not necessarily named "queryInterface" (umzug setups
    // alias or destructure it). Bind to the actual parameter name so builder
    // calls like `qi.dropTable(...)` are not silently skipped. A destructured or
    // missing first param falls back to the conventional name (which also matches
    // the umzug `{ context: queryInterface }` binding).
    const builderObjName = getFirstParamName(upFn) ?? 'queryInterface';

    let foundQuery = false;

    // Gap 11: track conditional depth to warn about conditional SQL
    const conditionalTypes = new Set(['IfStatement', 'ConditionalExpression', 'SwitchCase']);
    let conditionalDepth = 0;

    // Walk the up() function body looking for queryInterface.sequelize.query()
    walkNodeWithContext(upFn, {
        enter(node: TSNode) {
            if (conditionalTypes.has(node.type)) conditionalDepth++;

            if (node.type === 'CallExpression') {
                if (isSequelizeQuery(node)) {
                    foundQuery = true;
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
                                message: `Conditional SQL at line ${loc.line}, statement may or may not execute depending on runtime condition`,
                                unanalyzable: true,
                            });
                        }
                    } else {
                        const loc = arg.loc?.start ?? { line: 0, column: 0 };
                        warnings.push({
                            filePath,
                            line: loc.line,
                            column: loc.column,
                            message: 'Dynamic SQL: cannot statically analyze sequelize.query() argument',
                            unanalyzable: true,
                        });
                    }
                } else if (isQueryInterfaceBuilder(node, builderObjName)) {
                    // Gap 13: Transpile queryInterface builder calls to SQL
                    foundQuery = true;
                    const result = transpileSequelizeCall(node, filePath);
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
                            message: 'queryInterface builder call could not be transpiled to SQL, manual review required',
                            unanalyzable: true,
                        });
                    }
                    warnings.push(...result.warnings);
                }
            }
        },
        leave(node: TSNode) {
            if (conditionalTypes.has(node.type)) conditionalDepth--;
        },
    });

    if (!foundQuery) {
        warnings.push({
            filePath,
            line: 1,
            column: 0,
            message: 'No queryInterface.sequelize.query() or builder calls found in Sequelize migration',
            unanalyzable: true,
        });
    }

    return { sql: queries.join(';\n'), warnings, sourceRanges, statements: queries };
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

const QUERY_INTERFACE_METHODS = new Set([
    'createTable', 'addColumn', 'removeColumn', 'renameColumn',
    'changeColumn', 'addIndex', 'removeIndex', 'dropTable', 'renameTable',
    'addConstraint', 'removeConstraint',
]);

function getFirstParamName(fn: TSNode): string | null {
    const params = fn.params as TSNode[] | undefined;
    const first = params?.[0];
    if (first?.type === 'Identifier') return first.name as string;
    return null;
}

function isQueryInterfaceBuilder(node: TSNode, objName: string): boolean {
    const callee = node.callee as TSNode;
    if (callee?.type !== 'MemberExpression') return false;

    const prop = callee.property as TSNode;
    if (prop?.type !== 'Identifier') return false;
    if (!QUERY_INTERFACE_METHODS.has(prop.name as string)) return false;

    // Check that the object is the bound queryInterface parameter (which may be
    // named anything, e.g. `qi`), not the literal identifier "queryInterface".
    const obj = callee.object as TSNode;
    if (obj?.type === 'Identifier' && (obj.name as string) === objName) {
        return true;
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

function nodeRange(node: TSNode): { startOffset: number; endOffset: number } {
    if (!node.range) return { startOffset: 0, endOffset: 0 };
    return { startOffset: node.range[0], endOffset: node.range[1] };
}

function findUpFunction(ast: TSNode): TSNode | null {
    let result: TSNode | null = null;
    walkNode(ast, (node: TSNode) => {
        if (result) return;
        // export async function up(queryInterface, Sequelize) { ... }
        if (node.type === 'FunctionDeclaration') {
            const id = node.id as TSNode | null;
            if (id?.type === 'Identifier' && (id.name as string) === 'up') {
                result = node;
            }
        }
        // module.exports = { async up(queryInterface, Sequelize) { ... } }
        // or module.exports = { up: async (queryInterface, Sequelize) => { ... } }
        if (node.type === 'Property') {
            const key = node.key as TSNode;
            if (
                key?.type === 'Identifier' &&
                (key.name as string) === 'up'
            ) {
                const val = node.value as TSNode;
                if (
                    val &&
                    (val.type === 'FunctionExpression' ||
                     val.type === 'ArrowFunctionExpression')
                ) {
                    result = val;
                }
            }
        }
        // export const up = async (queryInterface) => { ... }
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
