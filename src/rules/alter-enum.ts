/**
 * Rule: ALTER TYPE ... ADD VALUE (enum)
 *
 * Detects:
 * - ALTER TYPE ... ADD VALUE on PG < 12: MEDIUM risk, ACCESS EXCLUSIVE lock on the type object (not on any table)
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
    newValNeighbor?: string;
    newValIsAfter?: boolean;
    skipIfNewValExists?: boolean;
  };

  const typeName = node.typeName?.[node.typeName.length - 1]?.String?.sval ?? '<unknown>';
  const newVal = node.newVal ?? '<unknown>';

  const results: CheckResult[] = [];

  if (config.minPostgresVersion >= 12) {
    results.push({
      statement: stmt.sql,
      statementPreview: makePreview(stmt.sql),
      tableName: null,
      lockMode: LockMode.EXCLUSIVE,
      blocks: getBlockedOperations(LockMode.EXCLUSIVE),
      risk: RiskLevel.LOW,
      message: `ALTER TYPE "${typeName}" ADD VALUE '${newVal}': instant on PG12+, but the new value cannot be used in the same transaction. Lock is on the type object, not on any table.`,
      ruleId: 'alter-enum-add-value',
      safeRewrite: {
        description: 'Safe on PG12+, but the new enum value is not usable in the same transaction',
        steps: [
          `-- COMMIT after ADD VALUE before inserting rows that use the new value.`,
          `-- Using the new value in the same transaction causes: "unsafe use of new value"`,
        ],
      },
    });
  } else {
    results.push({
      statement: stmt.sql,
      statementPreview: makePreview(stmt.sql),
      tableName: null,
      lockMode: LockMode.ACCESS_EXCLUSIVE,
      blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
      risk: RiskLevel.MEDIUM,
      message: `ALTER TYPE "${typeName}" ADD VALUE '${newVal}': takes ACCESS EXCLUSIVE on PG < 12, blocking all concurrent enum usage`,
      ruleId: 'alter-enum-add-value',
      safeRewrite: {
        description: 'Upgrade to Postgres 12+ where ALTER TYPE ADD VALUE is instant and non-blocking',
        steps: [
          '-- On PG12+: ALTER TYPE ADD VALUE is instant and non-blocking.',
          '-- On PG < 12: there is no safe alternative. Minimize lock duration by ensuring no long-running queries.',
        ],
      },
    });
  }

  // Ordering advisory: when no BEFORE/AFTER is given, the value is appended at the END.
  // Enum value positions are permanent - cannot be reordered without recreating the type.
  if (!node.newValNeighbor) {
    const lockMode = config.minPostgresVersion >= 12 ? LockMode.EXCLUSIVE : LockMode.ACCESS_EXCLUSIVE;
    results.push({
      statement: stmt.sql,
      statementPreview: makePreview(stmt.sql),
      tableName: null,
      lockMode,
      blocks: getBlockedOperations(lockMode),
      risk: RiskLevel.LOW,
      message: `ALTER TYPE "${typeName}" ADD VALUE '${newVal}': no BEFORE/AFTER position specified, value will be appended at the END of the enum ordering. Enum value positions are permanent - cannot be reordered without recreating the type.`,
      ruleId: 'alter-enum-no-ordering',
      safeRewrite: {
        description: 'Choose an enum anchor value before adding the new label, then run ALTER TYPE with BEFORE or AFTER.',
        steps: [
          `-- Identify the existing enum label that should come before or after the new value.`,
          `-- Re-run ALTER TYPE "${typeName}" ADD VALUE '${newVal}' with BEFORE or AFTER once the anchor label is known.`,
          `-- Enum value positions are permanent, choose carefully before deploying.`,
        ],
      },
    });
  }

  return results;
}
