import { describe, it, expect } from 'vitest';
import { mergeTraceWithStatic } from '../src/trace-merge.js';
import { LockMode, RiskLevel, getBlockedOperations } from '../src/types.js';
import type { CheckResult } from '../src/types.js';
import type { StatementTrace } from '../src/tracer.js';

/**
 * Helper to build a minimal CheckResult for testing.
 */
function makeCheck(overrides: Partial<CheckResult> & { statement: string }): CheckResult {
  return {
    statementPreview: overrides.statement.slice(0, 80),
    tableName: 'users',
    lockMode: LockMode.ACCESS_EXCLUSIVE,
    blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
    risk: RiskLevel.HIGH,
    message: 'test check',
    ruleId: 'test-rule',
    ...overrides,
  };
}

/**
 * Helper to build a minimal StatementTrace for testing.
 */
function makeTrace(overrides: Partial<StatementTrace> & { sql: string }): StatementTrace {
  return {
    durationMs: 5,
    newLocks: [],
    rewrites: [],
    columnChanges: { added: [], modified: [] },
    constraintChanges: { added: [], modified: [] },
    indexChanges: { added: [], modified: [] },
    newObjects: [],
    ...overrides,
  };
}

describe('mergeTraceWithStatic', () => {
  describe('verification outcomes', () => {
    it('should mark as confirmed when static lock matches trace lock', () => {
      const sql = 'ALTER TABLE users ADD COLUMN age integer NOT NULL';
      const checks = [makeCheck({ statement: sql, lockMode: LockMode.ACCESS_EXCLUSIVE })];
      const traces = [
        makeTrace({
          sql,
          newLocks: [
            {
              schemaName: 'public',
              objectName: 'users',
              relkind: 'r',
              mode: 'AccessExclusiveLock',
              oid: 12345,
            },
          ],
        }),
      ];

      const results = mergeTraceWithStatic(checks, traces, [sql]);

      expect(results).toHaveLength(1);
      expect(results[0].verification).toBe('confirmed');
      expect(results[0].lockMode).toBe(LockMode.ACCESS_EXCLUSIVE);
      expect(results[0].tracedLockMode).toBeUndefined();
    });

    it('should mark as mismatch when static lock differs from trace lock', () => {
      const sql = 'CREATE INDEX idx_email ON users (email)';
      const checks = [makeCheck({ statement: sql, lockMode: LockMode.SHARE, tableName: 'users' })];
      const traces = [
        makeTrace({
          sql,
          newLocks: [
            {
              schemaName: 'public',
              objectName: 'users',
              relkind: 'r',
              mode: 'AccessExclusiveLock',
              oid: 12345,
            },
          ],
        }),
      ];

      const results = mergeTraceWithStatic(checks, traces, [sql]);

      expect(results).toHaveLength(1);
      expect(results[0].verification).toBe('mismatch');
      expect(results[0].lockMode).toBe(LockMode.SHARE);
      expect(results[0].tracedLockMode).toBe(LockMode.ACCESS_EXCLUSIVE);
      // Risk is upgraded to max of static (HIGH) and trace-derived (CRITICAL)
      expect(results[0].risk).toBe(RiskLevel.CRITICAL);
    });

    it('should mark as static-only when check has null tableName (policy check)', () => {
      const sql = "SET lock_timeout = '2s'";
      const checks = [
        makeCheck({
          statement: sql,
          tableName: null,
          lockMode: LockMode.ACCESS_SHARE,
          risk: RiskLevel.SAFE,
          ruleId: 'policy-lock-timeout',
        }),
      ];
      const traces = [makeTrace({ sql })];

      const results = mergeTraceWithStatic(checks, traces, [sql]);

      expect(results).toHaveLength(1);
      expect(results[0].verification).toBe('static-only');
      expect(results[0].tableName).toBeNull();
    });

    it('should mark as static-only when trace has no matching lock for table', () => {
      const sql = 'ALTER TABLE orders ADD COLUMN total numeric';
      const checks = [makeCheck({ statement: sql, tableName: 'orders' })];
      const traces = [
        makeTrace({
          sql,
          newLocks: [
            {
              schemaName: 'public',
              objectName: 'users',
              relkind: 'r',
              mode: 'AccessExclusiveLock',
              oid: 99999,
            },
          ],
        }),
      ];

      const results = mergeTraceWithStatic(checks, traces, [sql]);

      // orders check is static-only, users lock is trace-only
      const ordersResult = results.find((r) => r.tableName === 'orders');
      expect(ordersResult).toBeDefined();
      expect(ordersResult!.verification).toBe('static-only');
    });

    it('should create trace-only entry for locks with no matching static check', () => {
      const sql = 'ALTER TABLE users ADD COLUMN age integer';
      // No static checks for this statement
      const checks: CheckResult[] = [];
      const traces = [
        makeTrace({
          sql,
          newLocks: [
            {
              schemaName: 'public',
              objectName: 'users',
              relkind: 'r',
              mode: 'AccessExclusiveLock',
              oid: 12345,
            },
          ],
        }),
      ];

      const results = mergeTraceWithStatic(checks, traces, [sql]);

      expect(results).toHaveLength(1);
      expect(results[0].verification).toBe('trace-only');
      expect(results[0].tableName).toBe('users');
      expect(results[0].tracedLockMode).toBe(LockMode.ACCESS_EXCLUSIVE);
      expect(results[0].ruleId).toBe('trace-only');
      // Risk is derived from observed lock mode, not hard-coded
      expect(results[0].risk).toBe(RiskLevel.CRITICAL);
    });

    it('should mark as error when trace has executionError', () => {
      const sql = 'ALTER TABLE users ADD COLUMN id integer NOT NULL';
      const checks = [makeCheck({ statement: sql })];
      const traces = [
        makeTrace({
          sql,
          executionError: 'column "id" already exists',
        }),
      ];

      const results = mergeTraceWithStatic(checks, traces, [sql]);

      expect(results).toHaveLength(1);
      expect(results[0].verification).toBe('error');
      expect(results[0].executionError).toBe('column "id" already exists');
    });

    it('should mark as cascade-error when a prior statement already errored', () => {
      const sql1 = 'ALTER TABLE users ADD COLUMN id integer NOT NULL';
      const sql2 = 'ALTER TABLE users ADD COLUMN name text';
      const checks = [
        makeCheck({ statement: sql1 }),
        makeCheck({ statement: sql2 }),
      ];
      const traces = [
        makeTrace({ sql: sql1, executionError: 'column "id" already exists' }),
        makeTrace({ sql: sql2, executionError: 'current transaction is aborted' }),
      ];

      const results = mergeTraceWithStatic(checks, traces, [sql1, sql2]);

      expect(results).toHaveLength(2);
      expect(results[0].verification).toBe('error');
      expect(results[1].verification).toBe('cascade-error');
    });
  });

  describe('trace metadata', () => {
    it('should attach table rewrite detection to correct check', () => {
      const sql = 'ALTER TABLE users ALTER COLUMN age TYPE bigint';
      const checks = [makeCheck({ statement: sql })];
      const traces = [
        makeTrace({
          sql,
          newLocks: [
            {
              schemaName: 'public',
              objectName: 'users',
              relkind: 'r',
              mode: 'AccessExclusiveLock',
              oid: 12345,
            },
          ],
          rewrites: [
            {
              oid: 12345,
              relfilenode: 99999,
              nspname: 'public',
              relname: 'users',
              relkind: 'r',
            },
          ],
        }),
      ];

      const results = mergeTraceWithStatic(checks, traces, [sql]);

      expect(results).toHaveLength(1);
      expect(results[0].tableRewrite).toBe(true);
    });

    it('should pass through durationMs from trace', () => {
      const sql = 'ALTER TABLE users ADD COLUMN age integer NOT NULL';
      const checks = [makeCheck({ statement: sql })];
      const traces = [
        makeTrace({
          sql,
          durationMs: 42,
          newLocks: [
            {
              schemaName: 'public',
              objectName: 'users',
              relkind: 'r',
              mode: 'AccessExclusiveLock',
              oid: 12345,
            },
          ],
        }),
      ];

      const results = mergeTraceWithStatic(checks, traces, [sql]);

      expect(results).toHaveLength(1);
      expect(results[0].durationMs).toBe(42);
    });

    it('should include new objects from trace', () => {
      const sql = 'CREATE TABLE orders (id serial PRIMARY KEY)';
      const checks: CheckResult[] = [];
      const traces = [
        makeTrace({
          sql,
          newLocks: [
            {
              schemaName: 'public',
              objectName: 'orders',
              relkind: 'r',
              mode: 'AccessExclusiveLock',
              oid: 55555,
            },
          ],
          newObjects: [
            {
              oid: 55555,
              relfilenode: 55555,
              nspname: 'public',
              relname: 'orders',
              relkind: 'r',
            },
          ],
        }),
      ];

      const results = mergeTraceWithStatic(checks, traces, [sql]);

      expect(results).toHaveLength(1);
      expect(results[0].newObjects).toEqual([
        { schemaName: 'public', objectName: 'orders', objectType: 'table' },
      ]);
    });
  });

  describe('lock strength ordering', () => {
    it('should pick the strongest lock when multiple locks on same table', () => {
      const sql = 'ALTER TABLE users ADD COLUMN age integer';
      const checks = [
        makeCheck({ statement: sql, lockMode: LockMode.ACCESS_EXCLUSIVE }),
      ];
      const traces = [
        makeTrace({
          sql,
          newLocks: [
            {
              schemaName: 'public',
              objectName: 'users',
              relkind: 'r',
              mode: 'RowExclusiveLock',
              oid: 12345,
            },
            {
              schemaName: 'public',
              objectName: 'users',
              relkind: 'r',
              mode: 'AccessExclusiveLock',
              oid: 12345,
            },
            {
              schemaName: 'public',
              objectName: 'users',
              relkind: 'r',
              mode: 'ShareLock',
              oid: 12345,
            },
          ],
        }),
      ];

      const results = mergeTraceWithStatic(checks, traces, [sql]);

      expect(results).toHaveLength(1);
      expect(results[0].verification).toBe('confirmed');
    });
  });

  describe('table name matching', () => {
    it('should match case-insensitively', () => {
      const sql = 'ALTER TABLE Users ADD COLUMN age integer NOT NULL';
      const checks = [makeCheck({ statement: sql, tableName: 'Users' })];
      const traces = [
        makeTrace({
          sql,
          newLocks: [
            {
              schemaName: 'public',
              objectName: 'users',
              relkind: 'r',
              mode: 'AccessExclusiveLock',
              oid: 12345,
            },
          ],
        }),
      ];

      const results = mergeTraceWithStatic(checks, traces, [sql]);

      expect(results).toHaveLength(1);
      expect(results[0].verification).toBe('confirmed');
    });

    it('should strip schema prefix when matching', () => {
      const sql = 'ALTER TABLE public.users ADD COLUMN age integer NOT NULL';
      const checks = [makeCheck({ statement: sql, tableName: 'public.users' })];
      const traces = [
        makeTrace({
          sql,
          newLocks: [
            {
              schemaName: 'public',
              objectName: 'users',
              relkind: 'r',
              mode: 'AccessExclusiveLock',
              oid: 12345,
            },
          ],
        }),
      ];

      const results = mergeTraceWithStatic(checks, traces, [sql]);

      expect(results).toHaveLength(1);
      expect(results[0].verification).toBe('confirmed');
    });
  });

  describe('risk derivation', () => {
    it('should derive LOW risk for trace-only ROW EXCLUSIVE locks', () => {
      const sql = 'INSERT INTO audit_log VALUES (1)';
      const traces = [
        makeTrace({
          sql,
          newLocks: [
            {
              schemaName: 'public',
              objectName: 'audit_log',
              relkind: 'r',
              mode: 'RowExclusiveLock',
              oid: 999,
            },
          ],
        }),
      ];

      const results = mergeTraceWithStatic([], traces, [sql]);

      expect(results).toHaveLength(1);
      expect(results[0].risk).toBe(RiskLevel.LOW);
    });

    it('should not downgrade risk when trace shows weaker lock than static', () => {
      const sql = 'ALTER TABLE users ADD COLUMN age integer NOT NULL';
      const checks = [
        makeCheck({
          statement: sql,
          lockMode: LockMode.ACCESS_EXCLUSIVE,
          risk: RiskLevel.HIGH,
        }),
      ];
      const traces = [
        makeTrace({
          sql,
          newLocks: [
            {
              schemaName: 'public',
              objectName: 'users',
              relkind: 'r',
              mode: 'ShareUpdateExclusiveLock',
              oid: 12345,
            },
          ],
        }),
      ];

      const results = mergeTraceWithStatic(checks, traces, [sql]);

      expect(results[0].verification).toBe('mismatch');
      // Static risk HIGH is kept since trace-derived MEDIUM is lower
      expect(results[0].risk).toBe(RiskLevel.HIGH);
    });

    it('should set MEDIUM risk for synthetic trace-error entries', () => {
      const sql = 'SOME INVALID SQL';
      const traces = [makeTrace({ sql, executionError: 'syntax error' })];

      const results = mergeTraceWithStatic([], traces, [sql]);

      expect(results).toHaveLength(1);
      expect(results[0].ruleId).toBe('trace-error');
      expect(results[0].risk).toBe(RiskLevel.MEDIUM);
    });
  });

  describe('multiple statements', () => {
    it('should handle statements with no static checks and no trace locks', () => {
      const sql = "SET lock_timeout = '2s'";
      const results = mergeTraceWithStatic([], [makeTrace({ sql })], [sql]);

      expect(results).toHaveLength(0);
    });

    it('should handle multiple checks for the same statement', () => {
      const sql = 'ALTER TABLE users ADD CONSTRAINT fk FOREIGN KEY (org_id) REFERENCES orgs(id)';
      const checks = [
        makeCheck({ statement: sql, tableName: 'users', ruleId: 'fk-source' }),
        makeCheck({ statement: sql, tableName: 'orgs', ruleId: 'fk-target' }),
      ];
      const traces = [
        makeTrace({
          sql,
          newLocks: [
            {
              schemaName: 'public',
              objectName: 'users',
              relkind: 'r',
              mode: 'AccessExclusiveLock',
              oid: 100,
            },
            {
              schemaName: 'public',
              objectName: 'orgs',
              relkind: 'r',
              mode: 'AccessExclusiveLock',
              oid: 200,
            },
          ],
        }),
      ];

      const results = mergeTraceWithStatic(checks, traces, [sql]);

      // Both checks should be confirmed
      const usersResult = results.find((r) => r.ruleId === 'fk-source');
      const orgsResult = results.find((r) => r.ruleId === 'fk-target');
      expect(usersResult?.verification).toBe('confirmed');
      expect(orgsResult?.verification).toBe('confirmed');
    });
  });
});
