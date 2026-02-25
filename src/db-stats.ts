/**
 * DB stats fetcher — optional connection for size-aware risk scoring.
 *
 * Connects to a Postgres instance (read replica recommended) and queries
 * pg_stat_user_tables for row counts and table sizes.
 *
 * Connection uses read-only transaction mode for safety.
 */

import type { TableStats } from './types.js';

export async function fetchTableStats(dbUrl: string): Promise<TableStats[]> {
  // Dynamic import — pg is optional, only needed with --db-url
  let Client: new (config: { connectionString: string; connectionTimeoutMillis?: number }) => {
    connect(): Promise<void>;
    query(sql: string): Promise<{ rows: Array<Record<string, unknown>> }>;
    end(): Promise<void>;
  };
  try {
    const pg = await import('pg');
    Client = (pg.default?.Client ?? pg.Client) as typeof Client;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot load pg module (needed for --db-url): ${message}. Try: pnpm add pg`);
  }

  const client = new Client({ connectionString: dbUrl, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    // Safety: read-only mode
    await client.query('SET default_transaction_read_only = on');
    await client.query("SET application_name = 'pgfence'");

    const result = await client.query(`
      SELECT
        schemaname,
        relname,
        n_live_tup,
        pg_total_relation_size(relid) as total_bytes
      FROM pg_stat_user_tables
      ORDER BY n_live_tup DESC
    `);

    return result.rows.map((row) => ({
      schemaName: row.schemaname as string,
      tableName: row.relname as string,
      rowCount: Number(row.n_live_tup),
      totalBytes: Number(row.total_bytes),
    }));
  } finally {
    await client.end();
  }
}
