/**
 * Rule: Trigger operations
 *
 * Detects:
 * - CREATE TRIGGER: MEDIUM risk, ACCESS EXCLUSIVE on target table
 * - DROP TRIGGER: MEDIUM risk, ACCESS EXCLUSIVE on target table
 * - ENABLE/DISABLE TRIGGER: LOW risk, SHARE ROW EXCLUSIVE
 */

import type { ParsedStatement } from '../parser.js';
import type { CheckResult } from '../types.js';
import { LockMode, RiskLevel, getBlockedOperations } from '../types.js';
import { makePreview } from '../parser.js';

export function checkTrigger(stmt: ParsedStatement): CheckResult[] {
  const results: CheckResult[] = [];

  switch (stmt.nodeType) {
    case 'CreateTrigStmt': {
      const node = stmt.node as {
        trigname: string;
        relation: { relname: string };
        replace?: boolean;
      };
      const tableName = node.relation?.relname ?? null;
      const trigName = node.trigname ?? '<unknown>';

      results.push({
        statement: stmt.sql,
        statementPreview: makePreview(stmt.sql),
        tableName,
        lockMode: LockMode.ACCESS_EXCLUSIVE,
        blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
        risk: RiskLevel.MEDIUM,
        message: `CREATE TRIGGER "${trigName}" on "${tableName}" — acquires ACCESS EXCLUSIVE lock on the table`,
        ruleId: 'create-trigger',
        safeRewrite: {
          description: 'CREATE TRIGGER always requires ACCESS EXCLUSIVE — minimize lock duration with lock_timeout and retry logic',
          steps: [
            `SET lock_timeout = '2s';`,
            `${stmt.sql};`,
            `-- Retry in a loop if lock_timeout expires`,
          ],
        },
      });
      break;
    }

    case 'DropStmt': {
      const node = stmt.node as {
        objects: Array<{ List: { items: Array<{ String: { sval: string } }> } }>;
        removeType: string;
        missing_ok?: boolean;
      };
      if (node.removeType !== 'OBJECT_TRIGGER') break;

      const items = node.objects?.[0]?.List?.items ?? [];
      // For DROP TRIGGER: items = [tableName, triggerName]
      const tableName = items.length >= 2 ? items[0]?.String?.sval ?? null : null;
      const trigName = items.length >= 2 ? items[1]?.String?.sval ?? '<unknown>' : items[0]?.String?.sval ?? '<unknown>';

      results.push({
        statement: stmt.sql,
        statementPreview: makePreview(stmt.sql),
        tableName,
        lockMode: LockMode.ACCESS_EXCLUSIVE,
        blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
        risk: RiskLevel.MEDIUM,
        message: `DROP TRIGGER "${trigName}" on "${tableName}" — acquires ACCESS EXCLUSIVE lock on the table`,
        ruleId: 'drop-trigger',
      });
      break;
    }

    case 'AlterTableStmt': {
      const node = stmt.node as {
        relation: { relname: string };
        cmds: Array<{
          AlterTableCmd: {
            subtype: string;
            name?: string;
          };
        }>;
      };
      const tableName = node.relation?.relname ?? null;

      for (const cmd of node.cmds ?? []) {
        const sub = cmd.AlterTableCmd?.subtype;
        const trigName = cmd.AlterTableCmd?.name ?? 'ALL';

        if (sub === 'AT_EnableTrig' || sub === 'AT_EnableTrigAll' || sub === 'AT_EnableTrigUser') {
          results.push({
            statement: stmt.sql,
            statementPreview: makePreview(stmt.sql),
            tableName,
            lockMode: LockMode.SHARE_ROW_EXCLUSIVE,
            blocks: getBlockedOperations(LockMode.SHARE_ROW_EXCLUSIVE),
            risk: RiskLevel.LOW,
            message: `ENABLE TRIGGER "${trigName}" on "${tableName}" — acquires SHARE ROW EXCLUSIVE lock`,
            ruleId: 'enable-disable-trigger',
          });
        } else if (sub === 'AT_DisableTrig' || sub === 'AT_DisableTrigAll' || sub === 'AT_DisableTrigUser') {
          results.push({
            statement: stmt.sql,
            statementPreview: makePreview(stmt.sql),
            tableName,
            lockMode: LockMode.SHARE_ROW_EXCLUSIVE,
            blocks: getBlockedOperations(LockMode.SHARE_ROW_EXCLUSIVE),
            risk: RiskLevel.LOW,
            message: `DISABLE TRIGGER "${trigName}" on "${tableName}" — acquires SHARE ROW EXCLUSIVE lock`,
            ruleId: 'enable-disable-trigger',
          });
        }
      }
      break;
    }
  }

  return results;
}
