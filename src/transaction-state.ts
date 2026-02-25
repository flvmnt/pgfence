/**
 * Transaction State Machine — Gap 12
 *
 * Tracks transaction state including savepoints, lock accumulation,
 * and wide-lock-window detection across statements.
 *
 * Replaces the simple txDepth counter in policy.ts with a full
 * state machine that handles savepoints and partial rollbacks.
 */

import type { LockMode } from './types.js';

export interface TransactionState {
  /** Whether we're inside an explicit transaction */
  active: boolean;
  /** Transaction depth (for nested BEGIN support, though PG doesn't support it) */
  depth: number;
  /** Stack of savepoint names */
  savepoints: string[];
  /** Locks held in current transaction: table → highest lock mode */
  locksHeld: Map<string, LockMode>;
  /** Number of statements executed in current transaction */
  statementsInTx: number;
  /**
   * Maps savepoint name → snapshot of locksHeld at the time
   * the savepoint was created. Used for ROLLBACK TO.
   */
  savepointSnapshots: Map<string, Map<string, LockMode>>;
  /** Tables with ACCESS EXCLUSIVE locks — for wide-lock-window detection */
  accessExclusiveTables: Set<string>;
}

export function createTransactionState(): TransactionState {
  return {
    active: false,
    depth: 0,
    savepoints: [],
    locksHeld: new Map(),
    statementsInTx: 0,
    savepointSnapshots: new Map(),
    accessExclusiveTables: new Set(),
  };
}

/**
 * Process a TransactionStmt and update state accordingly.
 * Returns the updated state (mutates in place for efficiency).
 */
export function processTransactionStmt(
  state: TransactionState,
  kind: string,
  savepointName?: string,
): TransactionState {
  switch (kind) {
    case 'TRANS_STMT_BEGIN':
    case 'TRANS_STMT_START':
      state.depth++;
      state.active = true;
      break;

    case 'TRANS_STMT_COMMIT':
    case 'TRANS_STMT_ROLLBACK':
      state.depth = Math.max(0, state.depth - 1);
      if (state.depth === 0) {
        state.active = false;
        state.savepoints = [];
        state.locksHeld.clear();
        state.statementsInTx = 0;
        state.savepointSnapshots.clear();
        state.accessExclusiveTables.clear();
      }
      break;

    case 'TRANS_STMT_SAVEPOINT':
      if (savepointName) {
        state.savepoints.push(savepointName);
        // Snapshot current locks at this savepoint
        state.savepointSnapshots.set(savepointName, new Map(state.locksHeld));
      }
      break;

    case 'TRANS_STMT_RELEASE':
      if (savepointName) {
        // Release pops this savepoint and all above it
        const idx = state.savepoints.lastIndexOf(savepointName);
        if (idx >= 0) {
          state.savepoints.splice(idx);
          state.savepointSnapshots.delete(savepointName);
        }
      }
      break;

    case 'TRANS_STMT_ROLLBACK_TO':
      if (savepointName) {
        // Rollback to savepoint: pop everything above it, restore lock snapshot
        const idx = state.savepoints.lastIndexOf(savepointName);
        if (idx >= 0) {
          // Remove savepoints above this one
          state.savepoints.splice(idx + 1);
          // Restore lock state to the savepoint snapshot
          const snapshot = state.savepointSnapshots.get(savepointName);
          if (snapshot) {
            state.locksHeld = new Map(snapshot);
            // Recompute accessExclusiveTables from restored locks
            state.accessExclusiveTables.clear();
            for (const [table, lock] of state.locksHeld) {
              if (lock === 'ACCESS EXCLUSIVE') {
                state.accessExclusiveTables.add(table);
              }
            }
          }
        }
      }
      break;
  }

  return state;
}

/**
 * Record a statement's lock acquisition in the transaction state.
 * Returns true if this creates a "wide lock window" — multiple
 * ACCESS EXCLUSIVE locks on different tables in the same transaction.
 */
export function recordLock(
  state: TransactionState,
  tableName: string | null,
  lockMode: LockMode,
): { wideLockWindow: boolean; previousTable?: string } {
  state.statementsInTx++;

  if (!tableName) return { wideLockWindow: false };

  const table = tableName.toLowerCase();

  // Track the highest lock mode per table
  const current = state.locksHeld.get(table);
  if (!current || lockModeRank(lockMode) > lockModeRank(current)) {
    state.locksHeld.set(table, lockMode);
  }

  // Wide lock window detection: multiple ACCESS EXCLUSIVE on different tables
  if (lockMode === 'ACCESS EXCLUSIVE') {
    if (state.accessExclusiveTables.size > 0 && !state.accessExclusiveTables.has(table)) {
      const previousTable = [...state.accessExclusiveTables][0];
      state.accessExclusiveTables.add(table);
      return { wideLockWindow: true, previousTable };
    }
    state.accessExclusiveTables.add(table);
  }

  return { wideLockWindow: false };
}

function lockModeRank(mode: LockMode | string): number {
  const ranks: Record<string, number> = {
    'ACCESS SHARE': 0,
    'ROW SHARE': 1,
    'ROW EXCLUSIVE': 2,
    'SHARE UPDATE EXCLUSIVE': 3,
    'SHARE': 4,
    'SHARE ROW EXCLUSIVE': 5,
    'EXCLUSIVE': 6,
    'ACCESS EXCLUSIVE': 7,
  };
  return ranks[mode] ?? -1;
}
