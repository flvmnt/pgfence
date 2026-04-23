import type { ParsedStatement } from './parser.js';

interface RelationRef {
  schemaname?: string;
  relname?: string;
}

interface RelationLike {
  relation?: RelationRef;
}

function relationKey(relation?: RelationRef | null): string | null {
  if (!relation?.relname) return null;
  const table = relation.relname.toLowerCase();
  const schema = relation.schemaname?.toLowerCase();
  return schema ? `${schema}.${table}` : table;
}

export function getStatementTableKey(stmt: ParsedStatement): string | null {
  switch (stmt.nodeType) {
    case 'CreateStmt':
    case 'IndexStmt':
    case 'AlterTableStmt':
    case 'DeleteStmt':
    case 'UpdateStmt':
    case 'InsertStmt':
    case 'CopyStmt':
    case 'MergeStmt': {
      const node = stmt.node as RelationLike;
      return relationKey(node.relation);
    }
    case 'RenameStmt': {
      const node = stmt.node as RelationLike;
      return relationKey(node.relation);
    }
    case 'TruncateStmt': {
      const node = stmt.node as {
        relations?: Array<{ RangeVar?: RelationRef }>;
      };
      return relationKey(node.relations?.[0]?.RangeVar ?? null);
    }
    default:
      return null;
  }
}

export function getRelationKey(relation?: RelationRef | null): string | null {
  return relationKey(relation);
}
