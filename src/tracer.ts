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
