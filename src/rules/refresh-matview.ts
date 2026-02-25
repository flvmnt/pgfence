/**
 * Rule: REFRESH MATERIALIZED VIEW
 *
 * Detects:
 * - REFRESH MATERIALIZED VIEW (non-concurrent): HIGH risk, ACCESS EXCLUSIVE
 * - REFRESH MATERIALIZED VIEW CONCURRENTLY: LOW risk, SHARE UPDATE EXCLUSIVE (allows reads and writes, blocks DDL)
 */

import type { ParsedStatement } from '../parser.js';
import type { CheckResult } from '../types.js';
import { LockMode, RiskLevel, getBlockedOperations } from '../types.js';
import { makePreview } from '../parser.js';

export function checkRefreshMatView(stmt: ParsedStatement): CheckResult[] {
  if (stmt.nodeType !== 'RefreshMatViewStmt') return [];

  const node = stmt.node as {
    relation: { relname: string };
    concurrent?: boolean;
    skipData?: boolean;
  };

  const viewName = node.relation?.relname ?? '<unknown>';

  if (node.concurrent === true) {
    return [{
      statement: stmt.sql,
      statementPreview: makePreview(stmt.sql),
      tableName: viewName,
      lockMode: LockMode.SHARE_UPDATE_EXCLUSIVE,
      blocks: getBlockedOperations(LockMode.SHARE_UPDATE_EXCLUSIVE),
      risk: RiskLevel.LOW,
      message: `REFRESH MATERIALIZED VIEW CONCURRENTLY "${viewName}" — acquires SHARE UPDATE EXCLUSIVE lock (allows reads and writes, blocks only DDL)`,
      ruleId: 'refresh-matview-concurrent',
    }];
  }

  return [{
    statement: stmt.sql,
    statementPreview: makePreview(stmt.sql),
    tableName: viewName,
    lockMode: LockMode.ACCESS_EXCLUSIVE,
    blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
    risk: node.skipData ? RiskLevel.MEDIUM : RiskLevel.HIGH,
    message: node.skipData
      ? `REFRESH MATERIALIZED VIEW "${viewName}" WITH NO DATA — acquires ACCESS EXCLUSIVE lock (brief, truncates without repopulating)`
      : `REFRESH MATERIALIZED VIEW "${viewName}" — acquires ACCESS EXCLUSIVE lock, blocking all reads and writes for the entire refresh duration`,
    ruleId: 'refresh-matview-blocking',
    safeRewrite: node.skipData ? undefined : {
      description: 'Use CONCURRENTLY to allow reads during refresh (requires a unique index on the materialized view)',
      steps: [
        `-- 1. Ensure a unique index exists on the materialized view:`,
        `-- CREATE UNIQUE INDEX ON ${viewName} (...);`,
        `-- 2. Refresh concurrently:`,
        `REFRESH MATERIALIZED VIEW CONCURRENTLY ${viewName};`,
        `-- Note: CONCURRENTLY still blocks writes (EXCLUSIVE lock) but allows reads`,
      ],
    },
  }];
}
