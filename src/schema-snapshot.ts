/**
 * Schema Snapshot: Gap 10
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

export interface DomainSnapshot {
  schemaName: string;
  domainName: string;
  hasConstraint: boolean;
}

export interface SchemaSnapshot {
  version: number;
  generatedAt: string;
  tables: TableSnapshot[];
  domains?: DomainSnapshot[];
}

export interface SchemaLookup {
  getColumn(table: string, column: string): ColumnSnapshot | null;
  getTable(table: string): TableSnapshot | null;
  getTableByIndex(indexName: string): TableSnapshot | null;
  getDomain(typeName: string): DomainSnapshot | null;
  getDomains(): DomainSnapshot[];
  hasTable(table: string): boolean;
}

/**
 * Build a lookup interface from a schema snapshot.
 */
export function loadSnapshot(snapshot: SchemaSnapshot): SchemaLookup {
  const exactTableMap = new Map<string, TableSnapshot>();
  const bareTableMap = new Map<string, TableSnapshot | null>();
  const exactDomainMap = new Map<string, DomainSnapshot>();
  const bareDomainMap = new Map<string, DomainSnapshot | null>();
  // Reverse map: index name -> owning table. DROP INDEX names only the index,
  // never its table, so this is the only way to resolve a bare DROP INDEX back
  // to a table for size-aware risk scoring. Ambiguous names (same index name
  // under two schemas) map to null and are treated as unresolved.
  const indexToTableMap = new Map<string, TableSnapshot | null>();

  for (const table of snapshot.tables) {
    const key = table.tableName.toLowerCase();
    const exactKey = `${table.schemaName.toLowerCase()}.${key}`;
    exactTableMap.set(exactKey, table);

    const existing = bareTableMap.get(key);
    if (existing === undefined) {
      bareTableMap.set(key, table);
    } else if (existing !== table) {
      bareTableMap.set(key, null);
    }

    for (const index of table.indexes) {
      const indexKey = index.indexName.toLowerCase();
      const existingIndex = indexToTableMap.get(indexKey);
      if (existingIndex === undefined) {
        indexToTableMap.set(indexKey, table);
      } else if (existingIndex !== table) {
        indexToTableMap.set(indexKey, null);
      }
    }
  }

  for (const domain of snapshot.domains ?? []) {
    const key = domain.domainName.toLowerCase();
    const exactKey = `${domain.schemaName.toLowerCase()}.${key}`;
    exactDomainMap.set(exactKey, domain);

    const existing = bareDomainMap.get(key);
    if (existing === undefined) {
      bareDomainMap.set(key, domain);
    } else if (existing !== domain) {
      bareDomainMap.set(key, null);
    }
  }

  return {
    getColumn(table: string, column: string): ColumnSnapshot | null {
      const tableKey = table.toLowerCase();
      const t = exactTableMap.get(tableKey) ?? bareTableMap.get(tableKey) ?? null;
      if (!t) return null;
      return t.columns.find((c) => c.columnName.toLowerCase() === column.toLowerCase()) ?? null;
    },
    getTable(table: string): TableSnapshot | null {
      const tableKey = table.toLowerCase();
      return exactTableMap.get(tableKey) ?? bareTableMap.get(tableKey) ?? null;
    },
    getTableByIndex(indexName: string): TableSnapshot | null {
      return indexToTableMap.get(indexName.toLowerCase()) ?? null;
    },
    getDomain(typeName: string): DomainSnapshot | null {
      const typeKey = typeName.toLowerCase();
      return exactDomainMap.get(typeKey) ?? bareDomainMap.get(typeKey) ?? null;
    },
    getDomains(): DomainSnapshot[] {
      return [...exactDomainMap.values()];
    },
    hasTable(table: string): boolean {
      const tableKey = table.toLowerCase();
      if (exactTableMap.has(tableKey)) return true;
      return bareTableMap.get(tableKey) != null;
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
    // Safety: read-only mode (consistent with db-stats.ts)
    await pool.query('SET default_transaction_read_only = on');

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

    const domainsResult = await pool.query(`
      SELECT
        n.nspname AS schema_name,
        t.typname AS domain_name,
        EXISTS (
          SELECT 1
          FROM pg_constraint c
          WHERE c.contypid = t.oid
        ) AS has_constraint
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE t.typtype = 'd'
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY n.nspname, t.typname
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
      domains: domainsResult.rows.map((row) => ({
        schemaName: row.schema_name,
        domainName: row.domain_name,
        hasConstraint: row.has_constraint === true,
      })),
    };
  } finally {
    await pool.end();
  }
}
