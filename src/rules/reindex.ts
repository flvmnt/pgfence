/**
 * Rule: REINDEX (non-concurrent)
 *
 * Detects:
 * - REINDEX TABLE/INDEX without CONCURRENTLY: HIGH risk, ACCESS EXCLUSIVE
 * - REINDEX SCHEMA/DATABASE without CONCURRENTLY: CRITICAL risk, ACCESS EXCLUSIVE
 * - REINDEX CONCURRENTLY: safe (no check emitted)
 */

import type { ParsedStatement } from '../parser.js';
import type { CheckResult } from '../types.js';
import { LockMode, RiskLevel, getBlockedOperations } from '../types.js';
import { makePreview } from '../parser.js';

export function checkReindex(stmt: ParsedStatement): CheckResult[] {
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

  const isWide = node.kind === 'REINDEX_OBJECT_SCHEMA' || node.kind === 'REINDEX_OBJECT_DATABASE' || node.kind === 'REINDEX_OBJECT_SYSTEM';

  return [{
    statement: stmt.sql,
    statementPreview: makePreview(stmt.sql),
    tableName,
    lockMode: LockMode.ACCESS_EXCLUSIVE,
    blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
    risk: isWide ? RiskLevel.CRITICAL : RiskLevel.HIGH,
    message: isWide
      ? `REINDEX ${kindLabel} "${targetName}" — acquires ACCESS EXCLUSIVE lock on every index in the ${kindLabel.toLowerCase()}, blocking all reads and writes`
      : `REINDEX ${kindLabel} "${targetName}" — acquires ACCESS EXCLUSIVE lock, blocking all reads and writes`,
    ruleId: 'reindex-non-concurrent',
    safeRewrite: {
      description: 'Use REINDEX CONCURRENTLY (PG12+) to avoid ACCESS EXCLUSIVE lock',
      steps: [
        `REINDEX ${kindLabel} CONCURRENTLY ${targetName};`,
        `-- Note: REINDEX CONCURRENTLY requires PG12+ and must run outside a transaction block`,
      ],
    },
  }];
}
