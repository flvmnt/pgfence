/**
 * Rule: REINDEX (non-concurrent)
 *
 * Detects:
 * - REINDEX TABLE without CONCURRENTLY: HIGH risk, SHARE lock on table (ACCESS EXCLUSIVE on each index internally)
 * - REINDEX INDEX without CONCURRENTLY: HIGH risk, ACCESS EXCLUSIVE
 * - REINDEX SCHEMA/DATABASE without CONCURRENTLY: CRITICAL risk, ACCESS EXCLUSIVE
 * - REINDEX CONCURRENTLY: safe (no check emitted)
 */

import type { ParsedStatement } from '../parser.js';
import type { CheckResult } from '../types.js';
import { LockMode, RiskLevel, getBlockedOperations } from '../types.js';
import { makePreview } from '../parser.js';

export function checkReindex(stmt: ParsedStatement, minPostgresVersion = 14): CheckResult[] {
  if (stmt.nodeType !== 'ReindexStmt') return [];

  const node = stmt.node as {
    kind: string;
    relation?: { relname: string };
    name?: string;
    params?: Array<{ DefElem: { defname: string } }>;
  };

  const isConcurrent = (node.params ?? []).some(
    (p) => p.DefElem?.defname === 'concurrently',
  );
  if (isConcurrent) return [];

  const kindMap: Record<string, string> = {
    REINDEX_OBJECT_TABLE: 'TABLE',
    REINDEX_OBJECT_INDEX: 'INDEX',
    REINDEX_OBJECT_SCHEMA: 'SCHEMA',
    REINDEX_OBJECT_DATABASE: 'DATABASE',
    REINDEX_OBJECT_SYSTEM: 'SYSTEM',
  };
  const kindLabel = kindMap[node.kind] ?? node.kind;
  const targetName = node.relation?.relname ?? node.name ?? '<unknown>';
  const tableName = node.relation?.relname ?? null;
  const supportsConcurrentReindex = minPostgresVersion >= 12;

  const isWide = node.kind === 'REINDEX_OBJECT_SCHEMA' || node.kind === 'REINDEX_OBJECT_DATABASE' || node.kind === 'REINDEX_OBJECT_SYSTEM';

  // REINDEX TABLE takes ShareLock on the table (blocks writes, not reads)
  // but ACCESS EXCLUSIVE on each index. REINDEX INDEX takes ACCESS EXCLUSIVE on the index itself.
  const isTable = node.kind === 'REINDEX_OBJECT_TABLE';
  const lockMode = isTable ? LockMode.SHARE : LockMode.ACCESS_EXCLUSIVE;

  return [{
    statement: stmt.sql,
    statementPreview: makePreview(stmt.sql),
    tableName,
    lockMode,
    blocks: getBlockedOperations(lockMode),
    risk: isWide ? RiskLevel.CRITICAL : RiskLevel.HIGH,
    message: isWide
      ? `REINDEX ${kindLabel} "${targetName}": acquires ACCESS EXCLUSIVE lock on every index in the ${kindLabel.toLowerCase()}, blocking all reads and writes`
      : isTable
        ? `REINDEX ${kindLabel} "${targetName}": acquires SHARE lock on the table (blocking writes) and ACCESS EXCLUSIVE on each index`
        : `REINDEX ${kindLabel} "${targetName}": acquires ACCESS EXCLUSIVE lock on the index, queries using this index will block`,
    ruleId: 'reindex-non-concurrent',
    safeRewrite: {
      description: supportsConcurrentReindex
        ? 'Use REINDEX CONCURRENTLY (PG12+) to avoid ACCESS EXCLUSIVE lock'
        : 'Upgrade to PG12+ before using REINDEX CONCURRENTLY to avoid ACCESS EXCLUSIVE lock',
      steps: [
        supportsConcurrentReindex
          ? `REINDEX ${kindLabel} CONCURRENTLY ${targetName};`
          : '-- REINDEX CONCURRENTLY requires Postgres 12+.',
        supportsConcurrentReindex
          ? '-- Note: REINDEX CONCURRENTLY must run outside a transaction block'
          : `-- After upgrading to PG12+, run REINDEX ${kindLabel} CONCURRENTLY ${targetName} outside a transaction block.`,
      ],
    },
  }];
}
