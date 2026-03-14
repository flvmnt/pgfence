/**
 * Merge static analysis results with trace mode observations.
 *
 * For each SQL statement, compares the lock modes predicted by static analysis
 * against those actually observed via pg_locks during trace execution, producing
 * a verification status for every check.
 */

import {
  LockMode,
  RiskLevel,
  getBlockedOperations,
} from './types.js';
import type {
  CheckResult,
  TraceCheckResult,
  TracedLock,
  TracedObject,
  TraceVerification,
  ColumnChange,
  ConstraintChange,
  IndexChange,
} from './types.js';
import { mapPgLockMode, mapRelkind } from './tracer.js';
import type { StatementTrace, LockSnapshot } from './tracer.js';

/**
 * Lock strength ordering from weakest to strongest.
 * Used to find the strongest lock among traced locks for a given object.
 */
const LOCK_STRENGTH: LockMode[] = [
  LockMode.ACCESS_SHARE,
  LockMode.ROW_SHARE,
  LockMode.ROW_EXCLUSIVE,
  LockMode.SHARE_UPDATE_EXCLUSIVE,
  LockMode.SHARE,
  LockMode.SHARE_ROW_EXCLUSIVE,
  LockMode.EXCLUSIVE,
  LockMode.ACCESS_EXCLUSIVE,
];

function lockStrength(mode: LockMode): number {
  return LOCK_STRENGTH.indexOf(mode);
}

/**
 * Find the strongest lock mode from a list of traced locks.
 */
function strongestLock(locks: TracedLock[]): LockMode | null {
  if (locks.length === 0) return null;

  let strongest = locks[0].lockMode;
  for (let i = 1; i < locks.length; i++) {
    if (lockStrength(locks[i].lockMode) > lockStrength(strongest)) {
      strongest = locks[i].lockMode;
    }
  }
  return strongest;
}

/**
 * Convert a LockSnapshot from the tracer into a TracedLock with mapped types.
 */
function toTracedLock(snap: LockSnapshot): TracedLock | null {
  const lockMode = mapPgLockMode(snap.mode);
  if (lockMode === null) return null;

  return {
    schemaName: snap.schemaName,
    objectName: snap.objectName,
    lockMode,
    objectType: mapRelkind(snap.relkind),
  };
}

/**
 * Normalize a table name for matching: strip schema prefix if present,
 * lowercase, and remove surrounding quotes.
 */
function normalizeTableName(name: string): string {
  const stripped = name.replace(/^"(.*)"$/, '$1');
  const parts = stripped.split('.');
  const tablePart = parts[parts.length - 1];
  return tablePart.toLowerCase();
}

/**
 * Convert tracer catalog diff structures into typed change arrays for TraceCheckResult.
 */
function mapColumnChanges(
  trace: StatementTrace,
): ColumnChange[] {
  const changes: ColumnChange[] = [];

  for (const col of trace.columnChanges.added) {
    changes.push({
      tableName: String(col.attrelid),
      columnName: col.attname,
      changeType: 'added',
      typeName: col.typname,
      notNull: col.attnotnull,
    });
  }

  for (const col of trace.columnChanges.modified) {
    changes.push({
      tableName: String(col.attrelid),
      columnName: col.attname,
      changeType: 'modified',
      typeName: col.typname,
      notNull: col.attnotnull,
    });
  }

  return changes;
}

function mapConstraintChanges(
  trace: StatementTrace,
): ConstraintChange[] {
  const changes: ConstraintChange[] = [];

  for (const con of trace.constraintChanges.added) {
    changes.push({
      tableName: String(con.conrelid),
      constraintName: con.conname,
      changeType: 'added',
      constraintType: con.contype,
      validated: con.convalidated,
      definition: con.definition,
    });
  }

  for (const con of trace.constraintChanges.modified) {
    changes.push({
      tableName: String(con.conrelid),
      constraintName: con.conname,
      changeType: 'modified',
      constraintType: con.contype,
      validated: con.convalidated,
      definition: con.definition,
    });
  }

  return changes;
}

function mapIndexChanges(
  trace: StatementTrace,
): IndexChange[] {
  const changes: IndexChange[] = [];

  for (const idx of trace.indexChanges.added) {
    changes.push({
      tableName: idx.tableName,
      indexName: idx.indexName,
      changeType: 'added',
      isValid: idx.indisvalid,
      isReady: idx.indisready,
      isPrimary: idx.indisprimary,
      isUnique: idx.indisunique,
    });
  }

  for (const idx of trace.indexChanges.modified) {
    changes.push({
      tableName: idx.tableName,
      indexName: idx.indexName,
      changeType: 'modified',
      isValid: idx.indisvalid,
      isReady: idx.indisready,
      isPrimary: idx.indisprimary,
      isUnique: idx.indisunique,
    });
  }

  return changes;
}

/**
 * Convert tracer's new object snapshots into TracedObject[].
 */
function mapNewObjects(trace: StatementTrace): TracedObject[] {
  return trace.newObjects.map((obj) => ({
    schemaName: obj.nspname,
    objectName: obj.relname,
    objectType: mapRelkind(obj.relkind),
  }));
}

/**
 * Merge static analysis results with trace mode observations.
 *
 * For each statement, compares predicted lock modes against observed locks
 * and produces a TraceCheckResult with a verification status:
 *
 * - confirmed: static prediction matches trace observation
 * - mismatch: static predicted one lock mode, trace observed a different one
 * - static-only: no trace data available for this check (e.g. policy check with no tableName)
 * - trace-only: trace observed locks that static analysis did not predict
 * - error: statement failed during execution
 * - cascade-error: statement was not executed because a prior statement failed
 */
export function mergeTraceWithStatic(
  staticChecks: CheckResult[],
  traces: StatementTrace[],
  statements: string[],
): TraceCheckResult[] {
  const results: TraceCheckResult[] = [];
  let priorError = false;

  for (let i = 0; i < statements.length; i++) {
    const trace = traces[i];
    const matchingChecks = staticChecks.filter((c) => c.statement === statements[i]);

    // Convert trace locks to TracedLock[]
    const tracedLocks: TracedLock[] = [];
    if (trace) {
      for (const snap of trace.newLocks) {
        const tl = toTracedLock(snap);
        if (tl !== null) {
          tracedLocks.push(tl);
        }
      }
    }

    // Prepare trace metadata
    const tableRewrite = trace ? trace.rewrites.length > 0 : undefined;
    const durationMs = trace?.durationMs;
    const newObjects = trace ? mapNewObjects(trace) : undefined;
    const columnChanges = trace ? mapColumnChanges(trace) : undefined;
    const constraintChanges = trace ? mapConstraintChanges(trace) : undefined;
    const indexChanges = trace ? mapIndexChanges(trace) : undefined;

    // Handle execution errors
    if (trace?.executionError) {
      const verification: TraceVerification = priorError ? 'cascade-error' : 'error';
      priorError = true;

      if (matchingChecks.length > 0) {
        for (const check of matchingChecks) {
          results.push({
            ...check,
            verification,
            tracedLocksAll: tracedLocks.length > 0 ? tracedLocks : undefined,
            tableRewrite: tableRewrite || undefined,
            durationMs,
            newObjects: newObjects && newObjects.length > 0 ? newObjects : undefined,
            columnChanges: columnChanges && columnChanges.length > 0 ? columnChanges : undefined,
            constraintChanges: constraintChanges && constraintChanges.length > 0 ? constraintChanges : undefined,
            indexChanges: indexChanges && indexChanges.length > 0 ? indexChanges : undefined,
            executionError: trace.executionError,
          });
        }
      } else {
        // No static checks for this errored statement, create a trace-only error entry
        results.push({
          statement: statements[i],
          statementPreview: statements[i].slice(0, 100),
          tableName: null,
          lockMode: LockMode.ACCESS_SHARE,
          blocks: getBlockedOperations(LockMode.ACCESS_SHARE),
          risk: RiskLevel.SAFE,
          message: `Statement execution failed: ${trace.executionError}`,
          ruleId: 'trace-error',
          verification,
          tracedLocksAll: tracedLocks.length > 0 ? tracedLocks : undefined,
          durationMs,
          executionError: trace.executionError,
        });
      }
      continue;
    }

    // Track which traced locks have been matched to static checks
    const matchedLockIndices = new Set<number>();

    if (matchingChecks.length > 0) {
      for (const check of matchingChecks) {
        // If check has no tableName, it's a policy check: static-only
        if (check.tableName === null) {
          results.push({
            ...check,
            verification: 'static-only',
            durationMs,
            newObjects: newObjects && newObjects.length > 0 ? newObjects : undefined,
          });
          continue;
        }

        // Find traced locks matching this check's tableName
        const normalizedCheckTable = normalizeTableName(check.tableName);
        const matchingLocks: TracedLock[] = [];

        for (let li = 0; li < tracedLocks.length; li++) {
          const tl = tracedLocks[li];
          if (normalizeTableName(tl.objectName) === normalizedCheckTable) {
            matchingLocks.push(tl);
            matchedLockIndices.add(li);
          }
        }

        if (matchingLocks.length === 0) {
          // No traced lock for this table
          results.push({
            ...check,
            verification: 'static-only',
            tracedLocksAll: tracedLocks.length > 0 ? tracedLocks : undefined,
            tableRewrite: tableRewrite || undefined,
            durationMs,
            newObjects: newObjects && newObjects.length > 0 ? newObjects : undefined,
            columnChanges: columnChanges && columnChanges.length > 0 ? columnChanges : undefined,
            constraintChanges: constraintChanges && constraintChanges.length > 0 ? constraintChanges : undefined,
            indexChanges: indexChanges && indexChanges.length > 0 ? indexChanges : undefined,
          });
          continue;
        }

        const strongest = strongestLock(matchingLocks);

        if (strongest !== null && strongest === check.lockMode) {
          // Lock mode confirmed
          results.push({
            ...check,
            verification: 'confirmed',
            tracedLocksAll: tracedLocks,
            tableRewrite: tableRewrite || undefined,
            durationMs,
            newObjects: newObjects && newObjects.length > 0 ? newObjects : undefined,
            columnChanges: columnChanges && columnChanges.length > 0 ? columnChanges : undefined,
            constraintChanges: constraintChanges && constraintChanges.length > 0 ? constraintChanges : undefined,
            indexChanges: indexChanges && indexChanges.length > 0 ? indexChanges : undefined,
          });
        } else if (strongest !== null) {
          // Mismatch: static predicted a different lock mode
          results.push({
            ...check,
            verification: 'mismatch',
            tracedLockMode: strongest,
            tracedLocksAll: tracedLocks,
            tableRewrite: tableRewrite || undefined,
            durationMs,
            newObjects: newObjects && newObjects.length > 0 ? newObjects : undefined,
            columnChanges: columnChanges && columnChanges.length > 0 ? columnChanges : undefined,
            constraintChanges: constraintChanges && constraintChanges.length > 0 ? constraintChanges : undefined,
            indexChanges: indexChanges && indexChanges.length > 0 ? indexChanges : undefined,
          });
        }
      }
    }

    // Trace-only: locks observed by trace that have no matching static check
    for (let li = 0; li < tracedLocks.length; li++) {
      if (matchedLockIndices.has(li)) continue;

      // Check if any static check already covers this object
      const tl = tracedLocks[li];
      const normalizedTracedName = normalizeTableName(tl.objectName);
      const hasStaticCoverage = matchingChecks.some(
        (c) => c.tableName !== null && normalizeTableName(c.tableName) === normalizedTracedName,
      );

      if (!hasStaticCoverage) {
        results.push({
          statement: statements[i],
          statementPreview: statements[i].slice(0, 100),
          tableName: tl.objectName,
          lockMode: tl.lockMode,
          blocks: getBlockedOperations(tl.lockMode),
          risk: RiskLevel.LOW as RiskLevel,
          message: `Trace observed ${tl.lockMode} lock on ${tl.objectName} (not predicted by static analysis)`,
          ruleId: 'trace-only',
          verification: 'trace-only',
          tracedLockMode: tl.lockMode,
          tracedLocksAll: tracedLocks,
          tableRewrite: tableRewrite || undefined,
          durationMs,
          newObjects: newObjects && newObjects.length > 0 ? newObjects : undefined,
        });
      }
    }
  }

  return results;
}
