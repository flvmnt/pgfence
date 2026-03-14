import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LockMode } from '../src/types.js';
import type {
  LockSnapshot,
  RelfilenodeSnapshot,
  ColumnSnapshot,
  ConstraintSnapshot,
  IndexSnapshot,
} from '../src/tracer.js';

// Mock child_process before importing tracer
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

// Mock pg module
vi.mock('pg', () => {
  const mClient = {
    connect: vi.fn(),
    query: vi.fn(),
    end: vi.fn(),
  };
  return {
    default: { Client: vi.fn(() => mClient) },
    Client: vi.fn(() => mClient),
  };
});

describe('tracer', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let execFileSyncMock: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const cp = await import('node:child_process');
    execFileSyncMock = cp.execFileSync;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('checkDockerAvailable', () => {
    it('returns true when docker info succeeds', async () => {
      execFileSyncMock.mockReturnValueOnce(Buffer.from(''));
      const { checkDockerAvailable } = await import('../src/tracer.js');
      expect(checkDockerAvailable()).toBe(true);
      expect(execFileSyncMock).toHaveBeenCalledWith(
        'docker',
        ['info'],
        expect.objectContaining({ stdio: 'pipe', timeout: 10_000 }),
      );
    });

    it('returns false when docker info throws', async () => {
      execFileSyncMock.mockImplementationOnce(() => {
        throw new Error('Docker not found');
      });
      const { checkDockerAvailable } = await import('../src/tracer.js');
      expect(checkDockerAvailable()).toBe(false);
    });
  });

  describe('cleanupOrphanContainers', () => {
    it('removes listed pgfence-trace containers', async () => {
      // First call: docker ps listing
      execFileSyncMock.mockReturnValueOnce('pgfence-trace-abc123\npgfence-trace-def456\n');
      // Subsequent calls: docker rm for each
      execFileSyncMock.mockReturnValueOnce(Buffer.from(''));
      execFileSyncMock.mockReturnValueOnce(Buffer.from(''));

      const { cleanupOrphanContainers } = await import('../src/tracer.js');
      cleanupOrphanContainers();

      expect(execFileSyncMock).toHaveBeenCalledTimes(3);
      expect(execFileSyncMock).toHaveBeenCalledWith(
        'docker',
        ['rm', '-f', 'pgfence-trace-abc123'],
        expect.any(Object),
      );
      expect(execFileSyncMock).toHaveBeenCalledWith(
        'docker',
        ['rm', '-f', 'pgfence-trace-def456'],
        expect.any(Object),
      );
    });

    it('does nothing when docker ps fails', async () => {
      execFileSyncMock.mockImplementationOnce(() => {
        throw new Error('Docker not available');
      });

      const { cleanupOrphanContainers } = await import('../src/tracer.js');
      cleanupOrphanContainers();

      // Only the ps call was attempted
      expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    });

    it('handles empty container list', async () => {
      execFileSyncMock.mockReturnValueOnce('\n');

      const { cleanupOrphanContainers } = await import('../src/tracer.js');
      cleanupOrphanContainers();

      // Only the ps call
      expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('startContainer', () => {
    it('returns ContainerInfo with correct name pattern, port, and password length', async () => {
      // Mock docker run
      execFileSyncMock.mockReturnValueOnce(Buffer.from('container-id-here'));
      // Mock docker port
      execFileSyncMock.mockReturnValueOnce('127.0.0.1:54321\n');

      // Prevent actual signal handler registration from polluting test state
      const exitSpy = vi.spyOn(process, 'on').mockImplementation(() => process);

      const { startContainer } = await import('../src/tracer.js');
      const info = await startContainer({ pgVersion: 15 });

      expect(info.name).toMatch(/^pgfence-trace-[0-9a-f]{16}$/);
      expect(info.port).toBe(54321);
      expect(info.password).toHaveLength(20);
      expect(info.image).toBe('postgres:15-alpine');

      // Verify docker run was called with correct args
      const runCall = execFileSyncMock.mock.calls[0];
      expect(runCall[0]).toBe('docker');
      expect(runCall[1]).toContain('run');
      expect(runCall[1]).toContain('-d');
      expect(runCall[1]).toContain('127.0.0.1::5432');

      // Verify cleanup handlers registered
      expect(exitSpy).toHaveBeenCalledWith('exit', expect.any(Function));
      expect(exitSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
      expect(exitSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));

      exitSpy.mockRestore();
    });

    it('uses custom docker image when provided', async () => {
      execFileSyncMock.mockReturnValueOnce(Buffer.from('container-id'));
      execFileSyncMock.mockReturnValueOnce('127.0.0.1:55555\n');
      vi.spyOn(process, 'on').mockImplementation(() => process);

      const { startContainer } = await import('../src/tracer.js');
      const info = await startContainer({ dockerImage: 'timescale/timescaledb:latest-pg16' });

      expect(info.image).toBe('timescale/timescaledb:latest-pg16');

      // Verify the image was passed to docker run
      const runArgs = execFileSyncMock.mock.calls[0][1] as string[];
      expect(runArgs[runArgs.length - 1]).toBe('timescale/timescaledb:latest-pg16');

      vi.restoreAllMocks();
    });

    it('defaults to postgres:16-alpine when no options specified', async () => {
      execFileSyncMock.mockReturnValueOnce(Buffer.from('container-id'));
      execFileSyncMock.mockReturnValueOnce('127.0.0.1:55555\n');
      vi.spyOn(process, 'on').mockImplementation(() => process);

      const { startContainer } = await import('../src/tracer.js');
      const info = await startContainer({});

      expect(info.image).toBe('postgres:16-alpine');

      vi.restoreAllMocks();
    });

    it('throws and cleans up when port parsing fails', async () => {
      execFileSyncMock.mockReturnValueOnce(Buffer.from('container-id'));
      // Malformed port output
      execFileSyncMock.mockReturnValueOnce('invalid-output');
      // The cleanup rm call
      execFileSyncMock.mockReturnValueOnce(Buffer.from(''));

      vi.spyOn(process, 'on').mockImplementation(() => process);

      const { startContainer } = await import('../src/tracer.js');
      await expect(startContainer({})).rejects.toThrow('Failed to parse Docker port output');

      // Verify stopContainer was called to clean up
      expect(execFileSyncMock).toHaveBeenCalledWith(
        'docker',
        ['rm', '-f', expect.stringMatching(/^pgfence-trace-/)],
        expect.any(Object),
      );

      vi.restoreAllMocks();
    });
  });

  describe('stopContainer', () => {
    it('calls docker rm -f with the container name', async () => {
      execFileSyncMock.mockReturnValueOnce(Buffer.from(''));

      const { stopContainer } = await import('../src/tracer.js');
      stopContainer('pgfence-trace-abc123');

      expect(execFileSyncMock).toHaveBeenCalledWith(
        'docker',
        ['rm', '-f', 'pgfence-trace-abc123'],
        expect.objectContaining({ stdio: 'pipe', timeout: 10_000 }),
      );
    });
  });

  describe('waitForReady', () => {
    it('resolves when SELECT 1 succeeds', async () => {
      const pg = await import('pg');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mClient = new (pg.Client as any)();
      mClient.connect.mockResolvedValueOnce(undefined);
      mClient.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
      mClient.end.mockResolvedValueOnce(undefined);

      const { waitForReady } = await import('../src/tracer.js');
      await expect(
        waitForReady({ name: 'pgfence-trace-test', port: 5432, password: 'test', image: 'postgres:16-alpine' }),
      ).resolves.toBeUndefined();

      expect(mClient.connect).toHaveBeenCalled();
      expect(mClient.query).toHaveBeenCalledWith('SELECT 1');
    });

    it('rejects when timeout expires', async () => {
      const pg = await import('pg');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mClient = new (pg.Client as any)();
      mClient.connect.mockRejectedValue(new Error('ECONNREFUSED'));
      mClient.end.mockResolvedValue(undefined);

      const { waitForReady } = await import('../src/tracer.js');
      await expect(
        waitForReady(
          { name: 'pgfence-trace-test', port: 5432, password: 'test', image: 'postgres:16-alpine' },
          1000,
        ),
      ).rejects.toThrow('did not become ready within 1000ms');
    }, 10_000);
  });

  describe('mapRelkind', () => {
    it('maps all standard pg_class.relkind values', async () => {
      const { mapRelkind } = await import('../src/tracer.js');

      expect(mapRelkind('r')).toBe('table');
      expect(mapRelkind('i')).toBe('index');
      expect(mapRelkind('S')).toBe('sequence');
      expect(mapRelkind('v')).toBe('view');
      expect(mapRelkind('m')).toBe('materialized view');
      expect(mapRelkind('c')).toBe('composite type');
      expect(mapRelkind('t')).toBe('toast table');
      expect(mapRelkind('f')).toBe('foreign table');
      expect(mapRelkind('p')).toBe('partitioned table');
      expect(mapRelkind('I')).toBe('partitioned index');
    });

    it('returns "unknown" for unrecognized relkind', async () => {
      const { mapRelkind } = await import('../src/tracer.js');
      expect(mapRelkind('Z')).toBe('unknown');
      expect(mapRelkind('')).toBe('unknown');
    });
  });

  describe('mapPgLockMode', () => {
    it('maps all 8 pg_locks mode strings to LockMode enum values', async () => {
      const { mapPgLockMode } = await import('../src/tracer.js');

      expect(mapPgLockMode('AccessShareLock')).toBe(LockMode.ACCESS_SHARE);
      expect(mapPgLockMode('RowShareLock')).toBe(LockMode.ROW_SHARE);
      expect(mapPgLockMode('RowExclusiveLock')).toBe(LockMode.ROW_EXCLUSIVE);
      expect(mapPgLockMode('ShareUpdateExclusiveLock')).toBe(LockMode.SHARE_UPDATE_EXCLUSIVE);
      expect(mapPgLockMode('ShareLock')).toBe(LockMode.SHARE);
      expect(mapPgLockMode('ShareRowExclusiveLock')).toBe(LockMode.SHARE_ROW_EXCLUSIVE);
      expect(mapPgLockMode('ExclusiveLock')).toBe(LockMode.EXCLUSIVE);
      expect(mapPgLockMode('AccessExclusiveLock')).toBe(LockMode.ACCESS_EXCLUSIVE);
    });

    it('returns null for unrecognized lock modes', async () => {
      const { mapPgLockMode } = await import('../src/tracer.js');
      expect(mapPgLockMode('SomeFakeLock')).toBeNull();
      expect(mapPgLockMode('')).toBeNull();
      expect(mapPgLockMode('accesssharelock')).toBeNull(); // case-sensitive
    });
  });

  describe('diffLocks', () => {
    it('detects new locks, ignores existing', async () => {
      const { diffLocks } = await import('../src/tracer.js');

      const pre: LockSnapshot[] = [
        { schemaName: 'public', objectName: 'users', relkind: 'r', mode: 'AccessShareLock', oid: 100 },
      ];
      const post: LockSnapshot[] = [
        { schemaName: 'public', objectName: 'users', relkind: 'r', mode: 'AccessShareLock', oid: 100 },
        { schemaName: 'public', objectName: 'users', relkind: 'r', mode: 'AccessExclusiveLock', oid: 100 },
        { schemaName: 'public', objectName: 'orders', relkind: 'r', mode: 'RowExclusiveLock', oid: 200 },
      ];

      const result = diffLocks(pre, post);
      expect(result).toHaveLength(2);
      expect(result[0].mode).toBe('AccessExclusiveLock');
      expect(result[1].oid).toBe(200);
    });
  });

  describe('diffRelfilenodes', () => {
    it('detects changed relfilenode (table rewrite)', async () => {
      const { diffRelfilenodes } = await import('../src/tracer.js');

      const pre: RelfilenodeSnapshot[] = [
        { oid: 100, relfilenode: 100, nspname: 'public', relname: 'users', relkind: 'r' },
        { oid: 200, relfilenode: 200, nspname: 'public', relname: 'orders', relkind: 'r' },
      ];
      const post: RelfilenodeSnapshot[] = [
        { oid: 100, relfilenode: 999, nspname: 'public', relname: 'users', relkind: 'r' },
        { oid: 200, relfilenode: 200, nspname: 'public', relname: 'orders', relkind: 'r' },
      ];

      const result = diffRelfilenodes(pre, post);
      expect(result).toHaveLength(1);
      expect(result[0].oid).toBe(100);
      expect(result[0].relfilenode).toBe(999);
    });

    it('returns empty when nothing changed', async () => {
      const { diffRelfilenodes } = await import('../src/tracer.js');

      const snap: RelfilenodeSnapshot[] = [
        { oid: 100, relfilenode: 100, nspname: 'public', relname: 'users', relkind: 'r' },
      ];

      expect(diffRelfilenodes(snap, snap)).toHaveLength(0);
    });
  });

  describe('diffColumns', () => {
    it('detects added and modified columns', async () => {
      const { diffColumns } = await import('../src/tracer.js');

      const pre: ColumnSnapshot[] = [
        { attrelid: 100, attname: 'id', attnum: 1, attnotnull: true, typname: 'int4', atttypmod: -1 },
        { attrelid: 100, attname: 'name', attnum: 2, attnotnull: false, typname: 'text', atttypmod: -1 },
      ];
      const post: ColumnSnapshot[] = [
        { attrelid: 100, attname: 'id', attnum: 1, attnotnull: true, typname: 'int4', atttypmod: -1 },
        { attrelid: 100, attname: 'name', attnum: 2, attnotnull: true, typname: 'text', atttypmod: -1 }, // modified: attnotnull changed
        { attrelid: 100, attname: 'email', attnum: 3, attnotnull: false, typname: 'text', atttypmod: -1 }, // added
      ];

      const result = diffColumns(pre, post);
      expect(result.added).toHaveLength(1);
      expect(result.added[0].attname).toBe('email');
      expect(result.modified).toHaveLength(1);
      expect(result.modified[0].attname).toBe('name');
      expect(result.modified[0].attnotnull).toBe(true);
    });
  });

  describe('diffConstraints', () => {
    it('detects added and modified constraints', async () => {
      const { diffConstraints } = await import('../src/tracer.js');

      const pre: ConstraintSnapshot[] = [
        { conrelid: 100, conname: 'chk_positive', contype: 'c', convalidated: false, definition: 'CHECK (amount > 0)' },
      ];
      const post: ConstraintSnapshot[] = [
        { conrelid: 100, conname: 'chk_positive', contype: 'c', convalidated: true, definition: 'CHECK (amount > 0)' }, // modified: validated
        { conrelid: 100, conname: 'fk_user', contype: 'f', convalidated: false, definition: 'FOREIGN KEY (user_id) REFERENCES users(id)' }, // added
      ];

      const result = diffConstraints(pre, post);
      expect(result.added).toHaveLength(1);
      expect(result.added[0].conname).toBe('fk_user');
      expect(result.modified).toHaveLength(1);
      expect(result.modified[0].conname).toBe('chk_positive');
      expect(result.modified[0].convalidated).toBe(true);
    });
  });

  describe('diffIndexes', () => {
    it('detects added and modified indexes', async () => {
      const { diffIndexes } = await import('../src/tracer.js');

      const pre: IndexSnapshot[] = [
        { indexrelid: 300, indrelid: 100, indisvalid: false, indisready: true, indisprimary: false, indisunique: true, indexName: 'idx_email', tableName: 'users' },
      ];
      const post: IndexSnapshot[] = [
        { indexrelid: 300, indrelid: 100, indisvalid: true, indisready: true, indisprimary: false, indisunique: true, indexName: 'idx_email', tableName: 'users' }, // modified: became valid
        { indexrelid: 400, indrelid: 100, indisvalid: true, indisready: true, indisprimary: false, indisunique: false, indexName: 'idx_name', tableName: 'users' }, // added
      ];

      const result = diffIndexes(pre, post);
      expect(result.added).toHaveLength(1);
      expect(result.added[0].indexName).toBe('idx_name');
      expect(result.modified).toHaveLength(1);
      expect(result.modified[0].indexName).toBe('idx_email');
      expect(result.modified[0].indisvalid).toBe(true);
    });
  });

  describe('traceStatement', () => {
    function createMockClient() {
      const calls: string[] = [];
      const queryResults = new Map<string, { rows: Array<Record<string, unknown>> }>();

      // Default: empty results for all catalog queries
      const emptyResult = { rows: [] as Array<Record<string, unknown>> };

      const client = {
        query: vi.fn(async (sql: string, _params?: unknown[]) => {
          calls.push(sql.trim().split('\n')[0].trim());
          // Check for exact SQL matches first
          if (queryResults.has(sql)) {
            return queryResults.get(sql)!;
          }
          // Match by prefix for catalog queries
          for (const [key, val] of queryResults.entries()) {
            if (sql.includes(key)) {
              return val;
            }
          }
          return emptyResult;
        }),
      };

      return { client, calls, queryResults };
    }

    it('wraps non-concurrent statement in BEGIN/COMMIT', async () => {
      const { traceStatement } = await import('../src/tracer.js');
      const { client, calls } = createMockClient();

      await traceStatement(client, 'ALTER TABLE users ADD COLUMN email text', [], false);

      // Verify the call order includes BEGIN, the statement, and COMMIT
      expect(calls).toContain('BEGIN');
      expect(calls).toContain('ALTER TABLE users ADD COLUMN email text');
      expect(calls).toContain('COMMIT');

      // BEGIN must come before the statement, COMMIT must come after
      const beginIdx = calls.indexOf('BEGIN');
      const stmtIdx = calls.indexOf('ALTER TABLE users ADD COLUMN email text');
      const commitIdx = calls.indexOf('COMMIT');
      expect(beginIdx).toBeLessThan(stmtIdx);
      expect(stmtIdx).toBeLessThan(commitIdx);
    });

    it('does not wrap concurrent statement in BEGIN/COMMIT', async () => {
      const { traceStatement } = await import('../src/tracer.js');
      const { client, calls } = createMockClient();

      await traceStatement(
        client,
        'CREATE INDEX CONCURRENTLY idx_email ON users(email)',
        [],
        true,
      );

      expect(calls).not.toContain('BEGIN');
      expect(calls).not.toContain('COMMIT');
      expect(calls).toContain('CREATE INDEX CONCURRENTLY idx_email ON users(email)');
    });

    it('captures execution error and sets executionError field', async () => {
      const { traceStatement } = await import('../src/tracer.js');
      const { client } = createMockClient();

      // Make the actual statement fail, but let all other queries succeed
      let callCount = 0;
      client.query.mockImplementation(async (sql: string) => {
        callCount++;
        const trimmed = sql.trim();
        if (trimmed === 'DROP TABLE nonexistent') {
          throw new Error('relation "nonexistent" does not exist');
        }
        return { rows: [] };
      });

      const result = await traceStatement(client, 'DROP TABLE nonexistent', [], false);

      expect(result.executionError).toBe('relation "nonexistent" does not exist');
      expect(result.sql).toBe('DROP TABLE nonexistent');
    });

    it('calls ROLLBACK on error for non-concurrent statements', async () => {
      const { traceStatement } = await import('../src/tracer.js');
      const { client } = createMockClient();

      const calls: string[] = [];
      client.query.mockImplementation(async (sql: string) => {
        const firstLine = sql.trim().split('\n')[0].trim();
        calls.push(firstLine);
        if (firstLine === 'ALTER TABLE users ALTER COLUMN id TYPE bigint') {
          throw new Error('cannot alter type of a column used by a view');
        }
        return { rows: [] };
      });

      const result = await traceStatement(
        client,
        'ALTER TABLE users ALTER COLUMN id TYPE bigint',
        [],
        false,
      );

      expect(result.executionError).toBeDefined();
      expect(calls).toContain('ROLLBACK');

      // ROLLBACK should come after BEGIN
      const beginIdx = calls.indexOf('BEGIN');
      const rollbackIdx = calls.indexOf('ROLLBACK');
      expect(beginIdx).toBeLessThan(rollbackIdx);

      // No COMMIT should be present
      expect(calls).not.toContain('COMMIT');
    });

    it('returns duration and empty diffs when statement has no catalog effects', async () => {
      const { traceStatement } = await import('../src/tracer.js');
      const { client } = createMockClient();

      const result = await traceStatement(client, 'SELECT 1', [], false);

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.newLocks).toEqual([]);
      expect(result.rewrites).toEqual([]);
      expect(result.columnChanges).toEqual({ added: [], modified: [] });
      expect(result.constraintChanges).toEqual({ added: [], modified: [] });
      expect(result.indexChanges).toEqual({ added: [], modified: [] });
      expect(result.newObjects).toEqual([]);
      expect(result.executionError).toBeUndefined();
    });
  });
});
