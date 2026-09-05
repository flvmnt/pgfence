import { describe, it, expect } from 'vitest';
import { loadSnapshot, type SchemaSnapshot } from '../src/schema-snapshot.js';

function tableWith(schemaName: string, tableName: string, indexNames: string[]) {
  return {
    schemaName,
    tableName,
    columns: [],
    constraints: [],
    indexes: indexNames.map((indexName) => ({
      indexName,
      indexDef: `CREATE INDEX ${indexName} ON ${schemaName}.${tableName} (id)`,
      isUnique: false,
    })),
  };
}

function snapshotOf(tables: SchemaSnapshot['tables']): SchemaSnapshot {
  return { version: 1, generatedAt: '2025-01-01T00:00:00.000Z', tables };
}

describe('SchemaLookup.getTableByIndex', () => {
  it('resolves an index name to its owning table', () => {
    const lookup = loadSnapshot(snapshotOf([
      tableWith('public', 'users', ['users_email_idx']),
    ]));

    expect(lookup.getTableByIndex('users_email_idx')?.tableName).toBe('users');
  });

  it('is case-insensitive on the index name', () => {
    const lookup = loadSnapshot(snapshotOf([
      tableWith('public', 'users', ['Users_Email_Idx']),
    ]));

    expect(lookup.getTableByIndex('users_email_idx')?.tableName).toBe('users');
  });

  it('returns null for an index name not present in the snapshot', () => {
    const lookup = loadSnapshot(snapshotOf([
      tableWith('public', 'users', ['users_email_idx']),
    ]));

    expect(lookup.getTableByIndex('does_not_exist')).toBeNull();
  });

  it('returns null when the same index name exists on two tables (ambiguous)', () => {
    const lookup = loadSnapshot(snapshotOf([
      tableWith('public', 'users', ['name_idx']),
      tableWith('archive', 'users', ['name_idx']),
    ]));

    // Ambiguous: do not guess a parent table, which would risk attributing the
    // drop to the wrong table's size.
    expect(lookup.getTableByIndex('name_idx')).toBeNull();
  });
});
