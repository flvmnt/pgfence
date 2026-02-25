/**
 * Rule: ALTER TYPE ... ADD VALUE (enum)
 *
 * Detects:
 * - ALTER TYPE ... ADD VALUE on PG < 12: MEDIUM risk, ACCESS EXCLUSIVE
 * - ALTER TYPE ... ADD VALUE on PG12+: LOW risk (instant, but can't use in same tx)
 */

import type { ParsedStatement } from '../parser.js';
import type { CheckResult, PgfenceConfig } from '../types.js';
import { LockMode, RiskLevel, getBlockedOperations } from '../types.js';
import { makePreview } from '../parser.js';

export function checkAlterEnum(
  stmt: ParsedStatement,
  config: PgfenceConfig,
): CheckResult[] {
  if (stmt.nodeType !== 'AlterEnumStmt') return [];

  const node = stmt.node as {
    typeName: Array<{ String: { sval: string } }>;
    newVal: string;
    newValIsAfter?: boolean;
    skipIfNewValExists?: boolean;
  };

  const typeName = node.typeName?.[node.typeName.length - 1]?.String?.sval ?? '<unknown>';
  const newVal = node.newVal ?? '<unknown>';

  if (config.minPostgresVersion >= 12) {
    return [{
      statement: stmt.sql,
      statementPreview: makePreview(stmt.sql),
      tableName: null,
      lockMode: LockMode.SHARE_UPDATE_EXCLUSIVE,
      blocks: getBlockedOperations(LockMode.SHARE_UPDATE_EXCLUSIVE),
      risk: RiskLevel.LOW,
      message: `ALTER TYPE "${typeName}" ADD VALUE '${newVal}' — instant on PG12+, but the new value cannot be used in the same transaction`,
      ruleId: 'alter-enum-add-value',
    }];
  }

  return [{
    statement: stmt.sql,
    statementPreview: makePreview(stmt.sql),
    tableName: null,
    lockMode: LockMode.ACCESS_EXCLUSIVE,
    blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
    risk: RiskLevel.MEDIUM,
    message: `ALTER TYPE "${typeName}" ADD VALUE '${newVal}' — takes ACCESS EXCLUSIVE on PG < 12, blocking all concurrent enum usage`,
    ruleId: 'alter-enum-add-value',
    safeRewrite: {
      description: 'Upgrade to Postgres 12+ where ALTER TYPE ADD VALUE is instant and non-blocking',
      steps: [
        '-- On PG12+: ALTER TYPE ADD VALUE is instant and non-blocking.',
        '-- On PG < 12: there is no safe alternative. Minimize lock duration by ensuring no long-running queries.',
      ],
    },
  }];
}
