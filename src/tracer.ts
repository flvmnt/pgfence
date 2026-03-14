/**
 * Docker container lifecycle management and utility functions for trace mode.
 *
 * Trace mode spins up a disposable Postgres container, replays migrations,
 * and captures actual pg_locks to verify static analysis results.
 *
 * All Docker commands use execFileSync (no shell) to prevent injection.
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { LockMode } from './types.js';

export interface ContainerInfo {
  name: string;
  port: number;
  password: string;
  image: string;
}

export interface TraceOptions {
  pgVersion?: number;
  dockerImage?: string;
}

const CONTAINER_PREFIX = 'pgfence-trace-';

/**
 * Check whether Docker is available and responsive.
 */
export function checkDockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'pipe', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove any orphaned pgfence-trace-* containers from previous runs.
 */
export function cleanupOrphanContainers(): void {
  let output: string;
  try {
    output = execFileSync(
      'docker',
      ['ps', '-a', '--filter', `name=${CONTAINER_PREFIX}`, '--format', '{{.Names}}'],
      { stdio: 'pipe', encoding: 'utf-8', timeout: 10_000 },
    );
  } catch {
    // Docker not available or command failed; nothing to clean up
    return;
  }

  const names = output
    .split('\n')
    .map((n) => n.trim())
    .filter((n) => n.length > 0);

  for (const name of names) {
    try {
      execFileSync('docker', ['rm', '-f', name], { stdio: 'pipe', timeout: 10_000 });
    } catch {
      // Best effort: ignore failures on individual containers
    }
  }
}

/**
 * Start a disposable Postgres container for trace mode.
 *
 * - Binds to 127.0.0.1 only (Docker assigns a free host port)
 * - Generates a random 20-char password
 * - Registers process exit and signal handlers for cleanup
 */
export async function startContainer(opts: TraceOptions): Promise<ContainerInfo> {
  const suffix = randomBytes(8).toString('hex');
  const name = `${CONTAINER_PREFIX}${suffix}`;
  const password = randomBytes(15).toString('base64url').slice(0, 20);
  const pgVersion = opts.pgVersion ?? 16;
  const image = opts.dockerImage ?? `postgres:${pgVersion}-alpine`;

  execFileSync(
    'docker',
    [
      'run',
      '-d',
      '--name',
      name,
      '-e',
      `POSTGRES_PASSWORD=${password}`,
      '-p',
      '127.0.0.1::5432',
      image,
    ],
    { stdio: 'pipe', timeout: 30_000 },
  );

  // Discover the host port Docker assigned
  const portOutput = execFileSync('docker', ['port', name, '5432'], {
    stdio: 'pipe',
    encoding: 'utf-8',
    timeout: 5_000,
  });

  // Output format: "127.0.0.1:NNNNN\n" or "0.0.0.0:NNNNN\n"
  const portMatch = portOutput.trim().match(/:(\d+)$/);
  if (!portMatch) {
    stopContainer(name);
    throw new Error(`Failed to parse Docker port output: ${portOutput.trim()}`);
  }
  const port = parseInt(portMatch[1], 10);

  const container: ContainerInfo = { name, port, password, image };

  // Register cleanup handlers so the container is removed even on crashes
  const cleanup = (): void => {
    try {
      stopContainer(name);
    } catch {
      // Ignore: container may already be removed
    }
  };

  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });

  return container;
}

/**
 * Wait until the Postgres container is ready to accept connections.
 *
 * Polls with SELECT 1 every 500ms until success or timeout.
 */
export async function waitForReady(
  container: ContainerInfo,
  timeoutMs: number = 30_000,
): Promise<void> {
  // Dynamic import: pg is optional
  type PgClient = {
    connect(): Promise<void>;
    query(sql: string): Promise<{ rows: Array<Record<string, unknown>> }>;
    end(): Promise<void>;
  };
  type PgClientConstructor = new (config: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    connectionTimeoutMillis?: number;
  }) => PgClient;

  let Client: PgClientConstructor;
  try {
    const pg = await import('pg');
    Client = (pg.default?.Client ?? pg.Client) as PgClientConstructor;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot load pg module (needed for trace mode): ${message}. Try: pnpm add pg`);
  }

  const deadline = Date.now() + timeoutMs;
  const interval = 500;

  while (Date.now() < deadline) {
    const client = new Client({
      host: '127.0.0.1',
      port: container.port,
      user: 'postgres',
      password: container.password,
      database: 'postgres',
      connectionTimeoutMillis: 2000,
    });

    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch {
      try {
        await client.end();
      } catch {
        // Ignore cleanup errors during polling
      }
    }

    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error(`Postgres container ${container.name} did not become ready within ${timeoutMs}ms`);
}

/**
 * Force-remove a container by name.
 */
export function stopContainer(name: string): void {
  execFileSync('docker', ['rm', '-f', name], { stdio: 'pipe', timeout: 10_000 });
}

/**
 * Map pg_class.relkind single-char codes to human-readable object types.
 *
 * See: https://www.postgresql.org/docs/current/catalog-pg-class.html
 */
export function mapRelkind(relkind: string): string {
  const map: Record<string, string> = {
    r: 'table',
    i: 'index',
    S: 'sequence',
    v: 'view',
    m: 'materialized view',
    c: 'composite type',
    t: 'toast table',
    f: 'foreign table',
    p: 'partitioned table',
    I: 'partitioned index',
  };
  return map[relkind] ?? 'unknown';
}

/**
 * Map pg_locks mode strings to pgfence LockMode enum values.
 *
 * Postgres lock mode names in pg_locks use CamelCase with "Lock" suffix.
 * Returns null for unrecognized modes.
 */
export function mapPgLockMode(pgMode: string): LockMode | null {
  const map: Record<string, LockMode> = {
    AccessShareLock: LockMode.ACCESS_SHARE,
    RowShareLock: LockMode.ROW_SHARE,
    RowExclusiveLock: LockMode.ROW_EXCLUSIVE,
    ShareUpdateExclusiveLock: LockMode.SHARE_UPDATE_EXCLUSIVE,
    ShareLock: LockMode.SHARE,
    ShareRowExclusiveLock: LockMode.SHARE_ROW_EXCLUSIVE,
    ExclusiveLock: LockMode.EXCLUSIVE,
    AccessExclusiveLock: LockMode.ACCESS_EXCLUSIVE,
  };
  return map[pgMode] ?? null;
}

// --- Catalog Snapshot Types ---

export interface LockSnapshot {
  schemaName: string;
  objectName: string;
  relkind: string;
  mode: string;
  oid: number;
}

export interface RelfilenodeSnapshot {
  oid: number;
  relfilenode: number;
  nspname: string;
  relname: string;
  relkind: string;
}

export interface ColumnSnapshot {
  attrelid: number;
  attname: string;
  attnum: number;
  attnotnull: boolean;
  typname: string;
  atttypmod: number;
}

export interface ConstraintSnapshot {
  conrelid: number;
  conname: string;
  contype: string;
  convalidated: boolean;
  definition: string;
}

export interface IndexSnapshot {
  indexrelid: number;
  indrelid: number;
  indisvalid: boolean;
  indisready: boolean;
  indisprimary: boolean;
  indisunique: boolean;
  indexName: string;
  tableName: string;
}

export interface CatalogSnapshot {
  locks: LockSnapshot[];
  relfilenodes: RelfilenodeSnapshot[];
  columns: ColumnSnapshot[];
  constraints: ConstraintSnapshot[];
  indexes: IndexSnapshot[];
}

// --- Catalog Diff Functions ---

/**
 * Returns locks present in `post` but not in `pre`.
 * Key: `${oid}:${mode}`
 */
export function diffLocks(pre: LockSnapshot[], post: LockSnapshot[]): LockSnapshot[] {
  const preKeys = new Set(pre.map((l) => `${l.oid}:${l.mode}`));
  return post.filter((l) => !preKeys.has(`${l.oid}:${l.mode}`));
}

/**
 * Returns entries where the relfilenode changed for the same OID (table rewrite).
 */
export function diffRelfilenodes(
  pre: RelfilenodeSnapshot[],
  post: RelfilenodeSnapshot[],
): RelfilenodeSnapshot[] {
  const preMap = new Map(pre.map((r) => [r.oid, r.relfilenode]));
  return post.filter((r) => {
    const prev = preMap.get(r.oid);
    return prev !== undefined && prev !== r.relfilenode;
  });
}

/**
 * Returns added and modified columns between two snapshots.
 * Modified: typname, attnotnull, or atttypmod changed for same (attrelid, attnum).
 */
export function diffColumns(
  pre: ColumnSnapshot[],
  post: ColumnSnapshot[],
): { added: ColumnSnapshot[]; modified: ColumnSnapshot[] } {
  const preMap = new Map(pre.map((c) => [`${c.attrelid}:${c.attnum}`, c]));

  const added: ColumnSnapshot[] = [];
  const modified: ColumnSnapshot[] = [];

  for (const col of post) {
    const key = `${col.attrelid}:${col.attnum}`;
    const prev = preMap.get(key);
    if (!prev) {
      added.push(col);
    } else if (
      prev.typname !== col.typname ||
      prev.attnotnull !== col.attnotnull ||
      prev.atttypmod !== col.atttypmod
    ) {
      modified.push(col);
    }
  }

  return { added, modified };
}

/**
 * Returns added and modified constraints between two snapshots.
 * Modified: convalidated or definition changed for same (conrelid, conname).
 */
export function diffConstraints(
  pre: ConstraintSnapshot[],
  post: ConstraintSnapshot[],
): { added: ConstraintSnapshot[]; modified: ConstraintSnapshot[] } {
  const preMap = new Map(pre.map((c) => [`${c.conrelid}:${c.conname}`, c]));

  const added: ConstraintSnapshot[] = [];
  const modified: ConstraintSnapshot[] = [];

  for (const con of post) {
    const key = `${con.conrelid}:${con.conname}`;
    const prev = preMap.get(key);
    if (!prev) {
      added.push(con);
    } else if (prev.convalidated !== con.convalidated || prev.definition !== con.definition) {
      modified.push(con);
    }
  }

  return { added, modified };
}

/**
 * Returns added and modified indexes between two snapshots.
 * Modified: indisvalid or indisready changed for same indexrelid.
 */
export function diffIndexes(
  pre: IndexSnapshot[],
  post: IndexSnapshot[],
): { added: IndexSnapshot[]; modified: IndexSnapshot[] } {
  const preMap = new Map(pre.map((i) => [i.indexrelid, i]));

  const added: IndexSnapshot[] = [];
  const modified: IndexSnapshot[] = [];

  for (const idx of post) {
    const prev = preMap.get(idx.indexrelid);
    if (!prev) {
      added.push(idx);
    } else if (prev.indisvalid !== idx.indisvalid || prev.indisready !== idx.indisready) {
      modified.push(idx);
    }
  }

  return { added, modified };
}

// --- Observer Polling for CONCURRENTLY Statements ---

/**
 * Poll pg_locks from an observer connection while an action runs on another connection.
 * Used for CONCURRENTLY statements that cannot run in a transaction.
 * Returns all unique lock snapshots observed during the action.
 */
export async function observeLocksDuring(
  observerClient: PgClient,
  targetPid: number,
  action: () => Promise<void>,
  pollIntervalMs: number = 50,
): Promise<LockSnapshot[]> {
  const observed = new Map<string, LockSnapshot>();
  let polling = true;

  const pollLoop = async () => {
    while (polling) {
      try {
        const result = await observerClient.query(
          `SELECT n.nspname AS "schemaName", c.relname AS "objectName",
                  c.relkind AS relkind, l.mode, c.oid::int AS oid
           FROM pg_locks l
           JOIN pg_class c ON c.oid = l.relation
           JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE l.locktype = 'relation' AND l.pid = $1`,
          [targetPid],
        );
        for (const row of result.rows) {
          const lock = row as unknown as LockSnapshot;
          const key = `${lock.oid}:${lock.mode}`;
          if (!observed.has(key)) observed.set(key, lock);
        }
      } catch {
        /* connection may be busy, skip this poll */
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  };

  const pollPromise = pollLoop();
  try {
    await action();
  } finally {
    polling = false;
    await pollPromise;
  }

  return [...observed.values()];
}

// --- Statement Execution ---

export interface StatementTrace {
  sql: string;
  durationMs: number;
  newLocks: LockSnapshot[];
  rewrites: RelfilenodeSnapshot[];
  columnChanges: { added: ColumnSnapshot[]; modified: ColumnSnapshot[] };
  constraintChanges: { added: ConstraintSnapshot[]; modified: ConstraintSnapshot[] };
  indexChanges: { added: IndexSnapshot[]; modified: IndexSnapshot[] };
  newObjects: RelfilenodeSnapshot[];
  executionError?: string;
}

/** Minimal pg client interface for catalog queries. */
export type PgClient = {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
};

// --- SQL Query Constants (module-internal) ---

const LOCK_QUERY = `
  SELECT n.nspname AS "schemaName",
         c.relname AS "objectName",
         c.relkind,
         l.mode,
         c.oid
  FROM pg_locks l
  JOIN pg_class c ON c.oid = l.relation
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE l.pid = pg_backend_pid()
    AND n.nspname NOT IN ('pg_catalog', 'information_schema')
`;

const RELFILENODE_QUERY = `
  SELECT c.oid::int AS oid,
         c.relfilenode::int AS relfilenode,
         n.nspname,
         c.relname,
         c.relkind
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.oid = ANY($1)
`;

const COLUMN_QUERY = `
  SELECT a.attrelid::int AS attrelid,
         a.attname,
         a.attnum::int AS attnum,
         a.attnotnull,
         t.typname,
         a.atttypmod::int AS atttypmod
  FROM pg_attribute a
  JOIN pg_type t ON t.oid = a.atttypid
  WHERE a.attrelid = ANY($1)
    AND a.attnum > 0
    AND NOT a.attisdropped
  ORDER BY a.attrelid, a.attnum
`;

const CONSTRAINT_QUERY = `
  SELECT c.conrelid::int AS conrelid,
         c.conname,
         c.contype,
         c.convalidated,
         pg_get_constraintdef(c.oid) AS definition
  FROM pg_constraint c
  WHERE c.conrelid = ANY($1)
`;

const INDEX_QUERY = `
  SELECT i.indexrelid::int AS "indexrelid",
         i.indrelid::int AS "indrelid",
         i.indisvalid AS "indisvalid",
         i.indisready AS "indisready",
         i.indisprimary AS "indisprimary",
         i.indisunique AS "indisunique",
         ci.relname AS "indexName",
         ct.relname AS "tableName"
  FROM pg_index i
  JOIN pg_class ci ON ci.oid = i.indexrelid
  JOIN pg_class ct ON ct.oid = i.indrelid
  WHERE i.indrelid = ANY($1)
`;

const ALL_OBJECTS_QUERY = `
  SELECT c.oid::int AS oid,
         c.relfilenode::int AS relfilenode,
         n.nspname,
         c.relname,
         c.relkind
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
`;

/**
 * Take a catalog snapshot for the given tracked OIDs.
 * Runs lock, relfilenode, column, constraint, and index queries in parallel.
 */
export async function snapshotCatalog(
  client: PgClient,
  trackedOids: number[],
): Promise<CatalogSnapshot> {
  const oidParam = trackedOids.length > 0 ? [trackedOids] : [[]];

  const [lockResult, relfilenodeResult, columnResult, constraintResult, indexResult] =
    await Promise.all([
      client.query(LOCK_QUERY),
      trackedOids.length > 0
        ? client.query(RELFILENODE_QUERY, oidParam)
        : Promise.resolve({ rows: [] as Array<Record<string, unknown>> }),
      trackedOids.length > 0
        ? client.query(COLUMN_QUERY, oidParam)
        : Promise.resolve({ rows: [] as Array<Record<string, unknown>> }),
      trackedOids.length > 0
        ? client.query(CONSTRAINT_QUERY, oidParam)
        : Promise.resolve({ rows: [] as Array<Record<string, unknown>> }),
      trackedOids.length > 0
        ? client.query(INDEX_QUERY, oidParam)
        : Promise.resolve({ rows: [] as Array<Record<string, unknown>> }),
    ]);

  return {
    locks: lockResult.rows as unknown as LockSnapshot[],
    relfilenodes: relfilenodeResult.rows as unknown as RelfilenodeSnapshot[],
    columns: columnResult.rows as unknown as ColumnSnapshot[],
    constraints: constraintResult.rows as unknown as ConstraintSnapshot[],
    indexes: indexResult.rows as unknown as IndexSnapshot[],
  };
}

/**
 * Execute a single SQL statement and capture its catalog effects.
 *
 * For non-concurrent statements, wraps execution in BEGIN/COMMIT so that
 * locks are still held when the post-snapshot is taken. For concurrent
 * operations (CREATE INDEX CONCURRENTLY, etc.) or on execution error,
 * runs outside a transaction and snapshots after completion.
 */
export async function traceStatement(
  client: PgClient,
  sql: string,
  trackedOids: number[],
  isConcurrent: boolean,
): Promise<StatementTrace> {
  // Pre-snapshot: discover all existing objects
  const allObjectsResult = await client.query(ALL_OBJECTS_QUERY);
  const allObjects = allObjectsResult.rows as unknown as RelfilenodeSnapshot[];
  const existingOids = new Set(allObjects.map((o) => o.oid));

  // Combine existing OIDs with explicitly tracked OIDs
  const preOids = [...new Set([...trackedOids, ...allObjects.map((o) => o.oid)])];
  const preSnapshot = await snapshotCatalog(client, preOids);

  const start = performance.now();
  let executionError: string | undefined;
  let postSnapshot: CatalogSnapshot;

  if (isConcurrent) {
    // Concurrent operations cannot run inside a transaction
    try {
      await client.query(sql);
    } catch (err) {
      executionError = err instanceof Error ? err.message : String(err);
    }

    // Discover any new objects after execution
    const postObjectsResult = await client.query(ALL_OBJECTS_QUERY);
    const postObjects = postObjectsResult.rows as unknown as RelfilenodeSnapshot[];
    const postOids = [...new Set([...preOids, ...postObjects.map((o) => o.oid)])];
    postSnapshot = await snapshotCatalog(client, postOids);
  } else {
    // Wrap in transaction so locks are still held during snapshot
    let inTransaction = false;
    try {
      await client.query('BEGIN');
      inTransaction = true;
      await client.query(sql);

      // Discover any new objects created by the statement
      const postObjectsResult = await client.query(ALL_OBJECTS_QUERY);
      const postObjects = postObjectsResult.rows as unknown as RelfilenodeSnapshot[];
      const postOids = [...new Set([...preOids, ...postObjects.map((o) => o.oid)])];

      // Snapshot while locks are still held
      postSnapshot = await snapshotCatalog(client, postOids);
      await client.query('COMMIT');
    } catch (err) {
      executionError = err instanceof Error ? err.message : String(err);
      if (inTransaction) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Ignore rollback errors
        }
      }

      // Snapshot after rollback (locks released, but structural changes visible if any)
      const postObjectsResult = await client.query(ALL_OBJECTS_QUERY);
      const postObjects = postObjectsResult.rows as unknown as RelfilenodeSnapshot[];
      const postOids = [...new Set([...preOids, ...postObjects.map((o) => o.oid)])];
      postSnapshot = await snapshotCatalog(client, postOids);
    }
  }

  const durationMs = Math.round(performance.now() - start);

  // Diff pre vs post
  const newLocks = diffLocks(preSnapshot.locks, postSnapshot.locks);
  const rewrites = diffRelfilenodes(preSnapshot.relfilenodes, postSnapshot.relfilenodes);
  const columnChanges = diffColumns(preSnapshot.columns, postSnapshot.columns);
  const constraintChanges = diffConstraints(preSnapshot.constraints, postSnapshot.constraints);
  const indexChanges = diffIndexes(preSnapshot.indexes, postSnapshot.indexes);

  // Detect new objects (OIDs in post that were not in pre)
  const postObjectsAll = postSnapshot.relfilenodes;
  const newObjects = postObjectsAll.filter((o) => !existingOids.has(o.oid));

  return {
    sql,
    durationMs,
    newLocks,
    rewrites,
    columnChanges,
    constraintChanges,
    indexChanges,
    newObjects,
    ...(executionError !== undefined && { executionError }),
  };
}
