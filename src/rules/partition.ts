/**
 * Rule: Partition operations (ATTACH/DETACH)
 *
 * Detects:
 * - ATTACH PARTITION: HIGH risk, ACCESS EXCLUSIVE (validates partition constraint)
 * - DETACH PARTITION (non-concurrent): HIGH risk, ACCESS EXCLUSIVE
 * - DETACH PARTITION CONCURRENTLY (PG14+): LOW risk, SHARE UPDATE EXCLUSIVE
 */

import type { ParsedStatement } from '../parser.js';
import type { CheckResult, PgfenceConfig } from '../types.js';
import { LockMode, RiskLevel, getBlockedOperations } from '../types.js';
import { makePreview } from '../parser.js';

export function checkPartition(
  stmt: ParsedStatement,
  config: PgfenceConfig,
): CheckResult[] {
  if (stmt.nodeType !== 'AlterTableStmt') return [];

  const node = stmt.node as {
    relation: { relname: string };
    cmds: Array<{
      AlterTableCmd: {
        subtype: string;
        def?: {
          PartitionCmd?: {
            name: { relname: string };
            concurrent?: boolean;
          };
        };
      };
    }>;
  };

  const parentTable = node.relation?.relname ?? null;
  const results: CheckResult[] = [];

  for (const cmd of node.cmds ?? []) {
    const sub = cmd.AlterTableCmd?.subtype;
    const partCmd = cmd.AlterTableCmd?.def?.PartitionCmd;
    const partName = partCmd?.name?.relname ?? '<unknown>';

    if (sub === 'AT_AttachPartition') {
      results.push({
        statement: stmt.sql,
        statementPreview: makePreview(stmt.sql),
        tableName: parentTable,
        lockMode: LockMode.ACCESS_EXCLUSIVE,
        blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
        risk: RiskLevel.HIGH,
        message: `ATTACH PARTITION "${partName}" to "${parentTable}" — acquires ACCESS EXCLUSIVE lock on the parent table while validating the partition constraint`,
        ruleId: 'attach-partition',
        safeRewrite: {
          description: 'Add a CHECK constraint matching the partition bounds before attaching to skip the validation scan',
          steps: [
            `-- 1. Add a matching CHECK constraint on the partition (skips scan during ATTACH):`,
            `ALTER TABLE ${partName} ADD CONSTRAINT ${partName}_partition_check CHECK (...) NOT VALID;`,
            `ALTER TABLE ${partName} VALIDATE CONSTRAINT ${partName}_partition_check;`,
            `-- 2. Attach the partition (will skip scan since CHECK matches):`,
            `ALTER TABLE ${parentTable} ATTACH PARTITION ${partName} FOR VALUES ...;`,
            `-- 3. Drop the helper constraint (now redundant):`,
            `ALTER TABLE ${partName} DROP CONSTRAINT ${partName}_partition_check;`,
          ],
        },
      });
    } else if (sub === 'AT_DetachPartition') {
      if (partCmd?.concurrent === true) {
        results.push({
          statement: stmt.sql,
          statementPreview: makePreview(stmt.sql),
          tableName: parentTable,
          lockMode: LockMode.SHARE_UPDATE_EXCLUSIVE,
          blocks: getBlockedOperations(LockMode.SHARE_UPDATE_EXCLUSIVE),
          risk: RiskLevel.LOW,
          message: `DETACH PARTITION CONCURRENTLY "${partName}" from "${parentTable}" — acquires SHARE UPDATE EXCLUSIVE lock (non-blocking)`,
          ruleId: 'detach-partition-concurrent',
        });
      } else {
        results.push({
          statement: stmt.sql,
          statementPreview: makePreview(stmt.sql),
          tableName: parentTable,
          lockMode: LockMode.ACCESS_EXCLUSIVE,
          blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
          risk: RiskLevel.HIGH,
          message: `DETACH PARTITION "${partName}" from "${parentTable}" — acquires ACCESS EXCLUSIVE lock on the parent table`,
          ruleId: 'detach-partition',
          safeRewrite: config.minPostgresVersion >= 14
            ? {
              description: 'Use DETACH PARTITION CONCURRENTLY (PG14+) to avoid ACCESS EXCLUSIVE lock',
              steps: [
                `ALTER TABLE ${parentTable} DETACH PARTITION ${partName} CONCURRENTLY;`,
                `-- Note: DETACH CONCURRENTLY requires PG14+ and must run outside a transaction block`,
              ],
            }
            : {
              description: 'Upgrade to PG14+ to use DETACH PARTITION CONCURRENTLY, or minimize lock duration',
              steps: [
                `SET lock_timeout = '2s';`,
                `${stmt.sql};`,
                `-- Retry in a loop if lock_timeout expires`,
              ],
            },
        });
      }
    }
  }

  return results;
}
