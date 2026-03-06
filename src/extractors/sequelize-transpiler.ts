/**
 * Sequelize Schema Builder Transpiler: Gap 13
 *
 * Converts Sequelize queryInterface method calls (createTable, addColumn, etc.)
 * into SQL strings that can flow through the normal parse→analyze pipeline.
 */

import type { ExtractionWarning } from '../types.js';

interface TSNode {
  type: string;
  loc?: { start: { line: number; column: number }; end: { line: number; column: number } };
  [key: string]: unknown;
}

const SEQUELIZE_TYPE_MAP: Record<string, string> = {
  STRING: 'varchar(255)',
  TEXT: 'text',
  CITEXT: 'citext',
  INTEGER: 'integer',
  BIGINT: 'bigint',
  SMALLINT: 'smallint',
  FLOAT: 'real',
  REAL: 'real',
  DOUBLE: 'double precision',
  DECIMAL: 'numeric',
  BOOLEAN: 'boolean',
  DATE: 'timestamp with time zone',
  DATEONLY: 'date',
  TIME: 'time',
  UUID: 'uuid',
  UUIDV4: 'uuid',
  UUIDV1: 'uuid',
  JSON: 'json',
  JSONB: 'jsonb',
  BLOB: 'bytea',
  ARRAY: 'text[]',
  ENUM: 'text',
  HSTORE: 'hstore',
  INET: 'inet',
  CIDR: 'cidr',
  MACADDR: 'macaddr',
};

export interface TranspileResult {
  sql: string[];
  warnings: ExtractionWarning[];
}

/**
 * Transpile a queryInterface method call into SQL.
 */
export function transpileSequelizeCall(
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
      return transpileCreateTable(args, filePath);
    case 'addColumn':
      return transpileAddColumn(args, filePath);
    case 'removeColumn':
      return transpileRemoveColumn(args, filePath);
    case 'renameColumn':
      return transpileRenameColumn(args, filePath);
    case 'changeColumn':
      return transpileChangeColumn(args, filePath);
    case 'addIndex':
      return transpileAddIndex(args, filePath);
    case 'removeIndex':
      return transpileRemoveIndex(args, filePath);
    case 'dropTable':
      return transpileDropTable(args, filePath);
    case 'renameTable':
      return transpileRenameTable(args, filePath);
    case 'addConstraint':
      return transpileAddConstraint(args, filePath);
    case 'removeConstraint':
      return transpileRemoveConstraint(args, filePath);
    default:
      warnings.push({
        filePath,
        line: callNode.loc?.start?.line ?? 0,
        column: callNode.loc?.start?.column ?? 0,
        message: `Unsupported Sequelize queryInterface method: ${methodName}`,
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

function resolveSequelizeType(typeNode: TSNode): string | null {
  // DataTypes.STRING, Sequelize.STRING
  if (typeNode.type === 'MemberExpression') {
    const prop = typeNode.property as TSNode;
    if (prop?.type === 'Identifier') {
      return SEQUELIZE_TYPE_MAP[prop.name as string] ?? null;
    }
  }
  // DataTypes.STRING(100) - CallExpression wrapping MemberExpression
  if (typeNode.type === 'CallExpression') {
    const callee = typeNode.callee as TSNode;
    if (callee?.type === 'MemberExpression') {
      const prop = callee.property as TSNode;
      if (prop?.type === 'Identifier') {
        const baseName = prop.name as string;
        const baseType = SEQUELIZE_TYPE_MAP[baseName];
        if (!baseType) return null;

        const args = typeNode.arguments as TSNode[];
        if (baseName === 'STRING' && args.length > 0) {
          const len = args[0];
          if (len.type === 'Literal' && typeof len.value === 'number') {
            return `varchar(${len.value})`;
          }
        }
        if (baseName === 'DECIMAL' && args.length >= 2) {
          const p = args[0];
          const s = args[1];
          if (p.type === 'Literal' && typeof p.value === 'number' &&
              s.type === 'Literal' && typeof s.value === 'number') {
            return `numeric(${p.value},${s.value})`;
          }
        }
        return baseType;
      }
    }
  }
  return null;
}

function transpileCreateTable(args: TSNode[], filePath: string): TranspileResult {
  const sql: string[] = [];
  const warnings: ExtractionWarning[] = [];

  if (args.length < 2) return { sql, warnings };

  const tableName = getStringArg(args[0]);
  if (!tableName) {
    warnings.push({
      filePath,
      line: args[0].loc?.start?.line ?? 0,
      column: args[0].loc?.start?.column ?? 0,
      message: 'Dynamic table name in createTable: cannot transpile',
    });
    return { sql, warnings };
  }

  const colsObj = args[1];
  if (colsObj.type !== 'ObjectExpression') {
    warnings.push({
      filePath,
      line: colsObj.loc?.start?.line ?? 0,
      column: colsObj.loc?.start?.column ?? 0,
      message: 'Non-object columns argument in createTable: cannot transpile',
    });
    return { sql, warnings };
  }

  const columns: string[] = [];
  const properties = colsObj.properties as TSNode[];
  for (const prop of properties) {
    if (prop.type !== 'Property') continue;
    const key = prop.key as TSNode;
    const colName = key.type === 'Identifier' ? (key.name as string) : getStringArg(key);
    if (!colName) continue;

    const value = prop.value as TSNode;
    const colDef = parseSequelizeColumnDef(value, filePath, warnings);
    if (colDef) {
      columns.push(`"${colName}" ${colDef}`);
    }
  }

  if (columns.length > 0) {
    sql.push(`CREATE TABLE "${tableName}" (${columns.join(', ')})`);
  }

  return { sql, warnings };
}

function parseSequelizeColumnDef(
  node: TSNode,
  filePath: string,
  warnings: ExtractionWarning[],
): string | null {
  // Simple type: DataTypes.STRING
  const simpleType = resolveSequelizeType(node);
  if (simpleType) return simpleType;

  // Object definition: { type: DataTypes.STRING, allowNull: false, ... }
  if (node.type === 'ObjectExpression') {
    const props = node.properties as TSNode[];
    let type = '';
    let modifiers = '';

    for (const prop of props) {
      if (prop.type !== 'Property') continue;
      const key = prop.key as TSNode;
      const keyName = key.type === 'Identifier' ? (key.name as string) : null;
      const value = prop.value as TSNode;

      switch (keyName) {
        case 'type': {
          const resolved = resolveSequelizeType(value);
          if (resolved) type = resolved;
          break;
        }
        case 'allowNull':
          if (value.type === 'Literal' && value.value === false) {
            modifiers += ' NOT NULL';
          }
          break;
        case 'defaultValue':
          if (value.type === 'Literal') {
            if (typeof value.value === 'string') modifiers += ` DEFAULT '${value.value.replace(/'/g, "''")}'`;
            else if (typeof value.value === 'number') modifiers += ` DEFAULT ${value.value}`;
            else if (typeof value.value === 'boolean') modifiers += ` DEFAULT ${value.value}`;
            else if (value.value === null) modifiers += ' DEFAULT NULL';
          } else if (value.type === 'CallExpression') {
            const defCallee = value.callee as TSNode;
            if (
              defCallee?.type === 'MemberExpression' &&
              (defCallee.property as TSNode)?.type === 'Identifier' &&
              ((defCallee.property as TSNode).name as string) === 'literal'
            ) {
              const literalArgs = value.arguments as TSNode[];
              const literalStr = literalArgs.length > 0 ? getStringArg(literalArgs[0]) : null;
              if (literalStr) {
                modifiers += ` DEFAULT pgfence_volatile_expr(${literalStr})`;
              } else {
                modifiers += ' DEFAULT pgfence_volatile_expr()';
              }
            }
          }
          break;
        case 'primaryKey':
          if (value.type === 'Literal' && value.value === true) {
            modifiers += ' PRIMARY KEY';
          }
          break;
        case 'unique':
          if (value.type === 'Literal' && value.value === true) {
            modifiers += ' UNIQUE';
          }
          break;
        case 'autoIncrement':
          // Handled by SERIAL type
          break;
        case 'references':
          if (value.type === 'ObjectExpression') {
            let refTable = '';
            let refCol = '';
            for (const refProp of value.properties as TSNode[]) {
              if (refProp.type !== 'Property') continue;
              const rk = refProp.key as TSNode;
              const rv = refProp.value as TSNode;
              if (rk.type === 'Identifier' && (rk.name as string) === 'model') {
                refTable = getStringArg(rv) ?? '';
              }
              if (rk.type === 'Identifier' && (rk.name as string) === 'key') {
                refCol = getStringArg(rv) ?? '';
              }
            }
            if (refTable && refCol) {
              modifiers += ` REFERENCES "${refTable}"("${refCol}")`;
            }
          }
          break;
        case 'onDelete': {
          const action = getStringArg(value);
          if (action) modifiers += ` ON DELETE ${action.toUpperCase()}`;
          break;
        }
        case 'onUpdate': {
          const action = getStringArg(value);
          if (action) modifiers += ` ON UPDATE ${action.toUpperCase()}`;
          break;
        }
      }
    }

    if (type) return type + modifiers;

    warnings.push({
      filePath,
      line: node.loc?.start?.line ?? 0,
      column: node.loc?.start?.column ?? 0,
      message: 'Could not resolve Sequelize column type: cannot transpile',
    });
  }

  return null;
}

function transpileAddColumn(args: TSNode[], filePath: string): TranspileResult {
  const sql: string[] = [];
  const warnings: ExtractionWarning[] = [];

  if (args.length < 3) return { sql, warnings };
  const tableName = getStringArg(args[0]);
  const colName = getStringArg(args[1]);
  if (!tableName || !colName) {
    warnings.push({
      filePath,
      line: args[0].loc?.start?.line ?? 0,
      column: args[0].loc?.start?.column ?? 0,
      message: 'Dynamic table/column name in addColumn: cannot statically analyze',
    });
    return { sql, warnings };
  }

  const colDef = parseSequelizeColumnDef(args[2], filePath, warnings);
  if (colDef) {
    sql.push(`ALTER TABLE "${tableName}" ADD COLUMN "${colName}" ${colDef}`);
  }

  return { sql, warnings };
}

function transpileRemoveColumn(args: TSNode[], filePath: string): TranspileResult {
  const sql: string[] = [];
  const warnings: ExtractionWarning[] = [];
  if (args.length < 2) return { sql, warnings };
  const tableName = getStringArg(args[0]);
  const colName = getStringArg(args[1]);
  if (tableName && colName) {
    sql.push(`ALTER TABLE "${tableName}" DROP COLUMN "${colName}"`);
  } else {
    warnings.push({
      filePath,
      line: args[0].loc?.start?.line ?? 0,
      column: args[0].loc?.start?.column ?? 0,
      message: 'Dynamic table/column name in removeColumn, cannot statically analyze',
    });
  }
  return { sql, warnings };
}

function transpileRenameColumn(args: TSNode[], filePath: string): TranspileResult {
  const sql: string[] = [];
  const warnings: ExtractionWarning[] = [];
  if (args.length < 3) return { sql, warnings };
  const tableName = getStringArg(args[0]);
  const from = getStringArg(args[1]);
  const to = getStringArg(args[2]);
  if (tableName && from && to) {
    sql.push(`ALTER TABLE "${tableName}" RENAME COLUMN "${from}" TO "${to}"`);
  } else {
    warnings.push({
      filePath,
      line: args[0].loc?.start?.line ?? 0,
      column: args[0].loc?.start?.column ?? 0,
      message: 'Dynamic table/column name in renameColumn, cannot statically analyze',
    });
  }
  return { sql, warnings };
}

function transpileChangeColumn(args: TSNode[], filePath: string): TranspileResult {
  const sql: string[] = [];
  const warnings: ExtractionWarning[] = [];

  if (args.length < 3) return { sql, warnings };
  const tableName = getStringArg(args[0]);
  const colName = getStringArg(args[1]);
  if (!tableName || !colName) {
    warnings.push({
      filePath,
      line: args[0].loc?.start?.line ?? 0,
      column: args[0].loc?.start?.column ?? 0,
      message: 'Dynamic table/column name in changeColumn: cannot statically analyze',
    });
    return { sql, warnings };
  }

  const typeDef = args[2];
  const resolvedType = resolveSequelizeType(typeDef);
  if (resolvedType) {
    sql.push(`ALTER TABLE "${tableName}" ALTER COLUMN "${colName}" TYPE ${resolvedType}`);
  } else if (typeDef.type === 'ObjectExpression') {
    // Object with type property
    const props = typeDef.properties as TSNode[];
    let found = false;
    for (const prop of props) {
      if (prop.type !== 'Property') continue;
      const key = prop.key as TSNode;
      if (key.type === 'Identifier' && (key.name as string) === 'type') {
        const resolved = resolveSequelizeType(prop.value as TSNode);
        if (resolved) {
          sql.push(`ALTER TABLE "${tableName}" ALTER COLUMN "${colName}" TYPE ${resolved}`);
          found = true;
        }
      }
    }
    if (!found) {
      warnings.push({
        filePath,
        line: typeDef.loc?.start?.line ?? 0,
        column: typeDef.loc?.start?.column ?? 0,
        message: `Could not resolve type in changeColumn for "${tableName}"."${colName}": cannot statically analyze`,
      });
    }
  } else {
    warnings.push({
      filePath,
      line: typeDef.loc?.start?.line ?? 0,
      column: typeDef.loc?.start?.column ?? 0,
      message: `Unsupported type argument in changeColumn for "${tableName}"."${colName}": cannot statically analyze`,
    });
  }

  return { sql, warnings };
}

function transpileAddIndex(args: TSNode[], filePath: string): TranspileResult {
  const sql: string[] = [];
  const warnings: ExtractionWarning[] = [];
  if (args.length < 2) return { sql, warnings };
  const tableName = getStringArg(args[0]);
  if (!tableName) {
    warnings.push({
      filePath,
      line: args[0].loc?.start?.line ?? 0,
      column: args[0].loc?.start?.column ?? 0,
      message: 'Dynamic table name in addIndex: cannot statically analyze',
    });
    return { sql, warnings };
  }

  const colsArg = args[1];
  if (colsArg.type !== 'ArrayExpression') return { sql, warnings };

  const cols = (colsArg.elements as TSNode[])
    .map((e) => getStringArg(e))
    .filter((c): c is string => c !== null);
  if (cols.length === 0) return { sql, warnings };

  // Parse options (third argument)
  let concurrently = false;
  let unique = false;
  let idxName = `idx_${tableName}_${cols.join('_')}`;

  if (args.length >= 3 && args[2].type === 'ObjectExpression') {
    for (const prop of args[2].properties as TSNode[]) {
      if (prop.type !== 'Property') continue;
      const key = prop.key as TSNode;
      const keyName = key.type === 'Identifier' ? (key.name as string) : null;
      const value = prop.value as TSNode;
      if (keyName === 'concurrently' && value.type === 'Literal' && value.value === true) {
        concurrently = true;
      }
      if (keyName === 'unique' && value.type === 'Literal' && value.value === true) {
        unique = true;
      }
      if (keyName === 'name') {
        const name = getStringArg(value);
        if (name) idxName = name;
      }
    }
  }

  const parts = ['CREATE'];
  if (unique) parts.push('UNIQUE');
  parts.push('INDEX');
  if (concurrently) parts.push('CONCURRENTLY');
  parts.push(`"${idxName}" ON "${tableName}" (${cols.map(c => `"${c}"`).join(', ')})`);
  sql.push(parts.join(' '));

  return { sql, warnings };
}

function transpileRemoveIndex(args: TSNode[], filePath: string): TranspileResult {
  const sql: string[] = [];
  const warnings: ExtractionWarning[] = [];
  if (args.length < 2) return { sql, warnings };
  const tableName = getStringArg(args[0]);
  if (!tableName) {
    warnings.push({
      filePath,
      line: args[0].loc?.start?.line ?? 0,
      column: args[0].loc?.start?.column ?? 0,
      message: 'Dynamic table name in removeIndex: cannot statically analyze',
    });
    return { sql, warnings };
  }

  // Second arg can be string (index name) or array (columns)
  const secondArg = args[1];
  if (secondArg.type === 'Literal' && typeof secondArg.value === 'string') {
    sql.push(`DROP INDEX "${secondArg.value}"`);
  } else if (secondArg.type === 'ArrayExpression') {
    const cols = (secondArg.elements as TSNode[])
      .map((e) => getStringArg(e))
      .filter((c): c is string => c !== null);
    if (cols.length > 0) {
      const idxName = `idx_${tableName}_${cols.join('_')}`;
      sql.push(`DROP INDEX "${idxName}"`);
    }
  }

  return { sql, warnings };
}

function transpileDropTable(args: TSNode[], filePath: string): TranspileResult {
  const sql: string[] = [];
  const warnings: ExtractionWarning[] = [];
  if (args.length < 1) return { sql, warnings };
  const tableName = getStringArg(args[0]);
  if (tableName) {
    sql.push(`DROP TABLE IF EXISTS "${tableName}"`);
  } else {
    warnings.push({
      filePath,
      line: args[0].loc?.start?.line ?? 0,
      column: args[0].loc?.start?.column ?? 0,
      message: 'Dynamic table name in dropTable: cannot statically analyze',
    });
  }
  return { sql, warnings };
}

function transpileRenameTable(args: TSNode[], filePath: string): TranspileResult {
  const sql: string[] = [];
  const warnings: ExtractionWarning[] = [];
  if (args.length < 2) return { sql, warnings };
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
    });
  }
  return { sql, warnings };
}

function transpileAddConstraint(args: TSNode[], filePath: string): TranspileResult {
  const sql: string[] = [];
  const warnings: ExtractionWarning[] = [];

  if (args.length < 2) return { sql, warnings };
  const tableName = getStringArg(args[0]);
  if (!tableName) {
    warnings.push({
      filePath,
      line: args[0].loc?.start?.line ?? 0,
      column: args[0].loc?.start?.column ?? 0,
      message: 'Dynamic table name in addConstraint, cannot statically analyze',
    });
    return { sql, warnings };
  }

  const optsArg = args[1];
  if (optsArg.type !== 'ObjectExpression') {
    warnings.push({
      filePath,
      line: optsArg.loc?.start?.line ?? 0,
      column: optsArg.loc?.start?.column ?? 0,
      message: 'Non-object options in addConstraint, cannot transpile',
    });
    return { sql, warnings };
  }

  const props = optsArg.properties as TSNode[];
  let constraintType = '';
  let constraintName = '';
  let fields: string[] = [];
  let refTable = '';
  let refFields: string[] = [];
  let whereClause = '';
  let onDelete = '';
  let onUpdate = '';

  for (const prop of props) {
    if (prop.type !== 'Property') continue;
    const key = prop.key as TSNode;
    const keyName = key.type === 'Identifier' ? (key.name as string) : null;
    const value = prop.value as TSNode;

    switch (keyName) {
      case 'type':
        constraintType = getStringArg(value)?.toLowerCase() ?? '';
        break;
      case 'name':
        constraintName = getStringArg(value) ?? '';
        break;
      case 'fields':
        if (value.type === 'ArrayExpression') {
          fields = (value.elements as TSNode[])
            .map((e) => getStringArg(e))
            .filter((c): c is string => c !== null);
        }
        break;
      case 'references':
        if (value.type === 'ObjectExpression') {
          for (const refProp of value.properties as TSNode[]) {
            if (refProp.type !== 'Property') continue;
            const rk = refProp.key as TSNode;
            const rv = refProp.value as TSNode;
            const rkName = rk.type === 'Identifier' ? (rk.name as string) : null;
            if (rkName === 'table') refTable = getStringArg(rv) ?? '';
            if (rkName === 'field') {
              const f = getStringArg(rv);
              if (f) refFields = [f];
            }
            if (rkName === 'fields' && rv.type === 'ArrayExpression') {
              refFields = (rv.elements as TSNode[])
                .map((e) => getStringArg(e))
                .filter((c): c is string => c !== null);
            }
          }
        }
        break;
      case 'where':
        if (value.type === 'ObjectExpression') {
          whereClause = ' WHERE ...';
        }
        break;
      case 'onDelete':
        onDelete = getStringArg(value)?.toUpperCase() ?? '';
        break;
      case 'onUpdate':
        onUpdate = getStringArg(value)?.toUpperCase() ?? '';
        break;
    }
  }

  if (fields.length === 0) return { sql, warnings };

  const quotedFields = fields.map(f => `"${f}"`).join(', ');
  const nameClause = constraintName ? `"${constraintName}" ` : '';

  switch (constraintType) {
    case 'unique':
      sql.push(`ALTER TABLE "${tableName}" ADD CONSTRAINT ${nameClause}UNIQUE (${quotedFields})`);
      break;
    case 'foreign key':
      if (refTable && refFields.length > 0) {
        const quotedRefFields = refFields.map(f => `"${f}"`).join(', ');
        let fkSql = `ALTER TABLE "${tableName}" ADD CONSTRAINT ${nameClause}FOREIGN KEY (${quotedFields}) REFERENCES "${refTable}" (${quotedRefFields})`;
        if (onDelete) fkSql += ` ON DELETE ${onDelete}`;
        if (onUpdate) fkSql += ` ON UPDATE ${onUpdate}`;
        sql.push(fkSql);
      }
      break;
    case 'check':
      sql.push(`ALTER TABLE "${tableName}" ADD CONSTRAINT ${nameClause}CHECK ${whereClause || '(...)'}`);
      break;
    default:
      if (constraintType) {
        sql.push(`ALTER TABLE "${tableName}" ADD CONSTRAINT ${nameClause}${constraintType.toUpperCase()} (${quotedFields})`);
      }
      break;
  }

  return { sql, warnings };
}

function transpileRemoveConstraint(args: TSNode[], filePath: string): TranspileResult {
  const sql: string[] = [];
  const warnings: ExtractionWarning[] = [];

  if (args.length < 2) return { sql, warnings };
  const tableName = getStringArg(args[0]);
  const constraintName = getStringArg(args[1]);
  if (tableName && constraintName) {
    sql.push(`ALTER TABLE "${tableName}" DROP CONSTRAINT "${constraintName}"`);
  } else {
    warnings.push({
      filePath,
      line: args[0].loc?.start?.line ?? 0,
      column: args[0].loc?.start?.column ?? 0,
      message: 'Dynamic table/constraint name in removeConstraint, cannot statically analyze',
    });
  }
  return { sql, warnings };
}