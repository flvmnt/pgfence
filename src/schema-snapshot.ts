/**
 * Schema Snapshot — Gap 10
 *
 * Fetches schema information from a Postgres database and persists it
 * as a JSON snapshot. Used by rules (e.g., alter-column.ts) to make
 * definitive type change classifications instead of heuristic guesses.
 */

import { readFile } from 'node:fs/promises';

export interface ColumnSnapshot {
  columnName: string;
  dataType: string;
  udtName: string;
  characterMaximumLength: number | null;
  numericPrecision: number | null;
  numericScale: number | null;
  isNullable: boolean;
  columnDefault: string | null;
}

export interface ConstraintSnapshot {
  constraintName: string;
  constraintType: string;
  columns: string[];
}

export interface IndexSnapshot {
  indexName: string;
  indexDef: string;
  isUnique: boolean;
}

export interface TableSnapshot {
  schemaName: string;
  tableName: string;
  columns: ColumnSnapshot[];
  constraints: ConstraintSnapshot[];
  indexes: IndexSnapshot[];
}

export interface SchemaSnapshot {
  version: number;
  generatedAt: string;
  tables: TableSnapshot[];
}

export interface SchemaLookup {
  getColumn(table: string, column: string): ColumnSnapshot | null;
  getTable(table: string): TableSnapshot | null;
  hasTable(table: string): boolean;
}

/**
 * Build a lookup interface from a schema snapshot.
 */
export function loadSnapshot(snapshot: SchemaSnapshot): SchemaLookup {
  const tableMap = new Map<string, TableSnapshot>();

  for (const table of snapshot.tables) {
    const key = table.tableName.toLowerCase();
    tableMap.set(key, table);
    tableMap.set(`${table.schemaName.toLowerCase()}.${key}`, table);
  }

  return {
    getColumn(table: string, column: string): ColumnSnapshot | null {
      const t = tableMap.get(table.toLowerCase());
      if (!t) return null;
      return t.columns.find((c) => c.columnName.toLowerCase() === column.toLowerCase()) ?? null;
    },
    getTable(table: string): TableSnapshot | null {
      return tableMap.get(table.toLowerCase()) ?? null;
    },
    hasTable(table: string): boolean {
      return tableMap.has(table.toLowerCase());
    },
  };
}

/**
 * Load a schema snapshot from a JSON file.
 */
export async function loadSnapshotFile(filePath: string): Promise<SchemaSnapshot> {
  const raw = await readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw) as SchemaSnapshot;
  if (!parsed.tables || !Array.isArray(parsed.tables)) {
    throw new Error(`Invalid schema snapshot: expected { tables: [...] } in ${filePath}`);
  }
  return parsed;
}

/**
 * Fetch schema snapshot from a live database.
 */
export async function fetchSchemaSnapshot(dbUrl: string): Promise<SchemaSnapshot> {
  // Dynamic import to keep pg as optional
  const pg = await import('pg');
  const Pool = pg.default?.Pool ?? pg.Pool;
  const pool = new Pool({ connectionString: dbUrl });

  try {
    // Fetch columns
    const columnsResult = await pool.query(`
      SELECT
        table_schema,
        table_name,
        column_name,
        data_type,
        udt_name,
        character_maximum_length,
        numeric_precision,
        numeric_scale,
        is_nullable,
        column_default
      FROM information_schema.columns
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY table_schema, table_name, ordinal_position
    `);

    // Fetch constraints
    const constraintsResult = await pool.query(`
      SELECT
        tc.table_schema,
        tc.table_name,
        tc.constraint_name,
        tc.constraint_type,
        array_agg(kcu.column_name ORDER BY kcu.ordinal_position) as columns
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      WHERE tc.table_schema NOT IN ('pg_catalog', 'information_schema')
      GROUP BY tc.table_schema, tc.table_name, tc.constraint_name, tc.constraint_type
    `);

    // Fetch indexes
    const indexesResult = await pool.query(`
      SELECT
        schemaname,
        tablename,
        indexname,
        indexdef
      FROM pg_indexes
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
    `);

    // Build table map
    const tableMap = new Map<string, TableSnapshot>();

    for (const row of columnsResult.rows) {
      const key = `${row.table_schema}.${row.table_name}`;
      if (!tableMap.has(key)) {
        tableMap.set(key, {
          schemaName: row.table_schema,
          tableName: row.table_name,
          columns: [],
          constraints: [],
          indexes: [],
        });
      }
      tableMap.get(key)!.columns.push({
        columnName: row.column_name,
        dataType: row.data_type,
        udtName: row.udt_name,
        characterMaximumLength: row.character_maximum_length,
        numericPrecision: row.numeric_precision,
        numericScale: row.numeric_scale,
        isNullable: row.is_nullable === 'YES',
        columnDefault: row.column_default,
      });
    }

    for (const row of constraintsResult.rows) {
      const key = `${row.table_schema}.${row.table_name}`;
      if (tableMap.has(key)) {
        tableMap.get(key)!.constraints.push({
          constraintName: row.constraint_name,
          constraintType: row.constraint_type,
          columns: row.columns,
        });
      }
    }

    for (const row of indexesResult.rows) {
      const key = `${row.schemaname}.${row.tablename}`;
      if (tableMap.has(key)) {
        tableMap.get(key)!.indexes.push({
          indexName: row.indexname,
          indexDef: row.indexdef,
          isUnique: (row.indexdef as string).includes('UNIQUE'),
        });
      }
    }

    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      tables: [...tableMap.values()],
    };
  } finally {
    await pool.end();
  }
}
