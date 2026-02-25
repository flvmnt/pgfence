/**
 * Rule: ALTER COLUMN checks
 *
 * Detects:
 * - ALTER COLUMN TYPE (table rewrite, ACCESS EXCLUSIVE)
 * - ALTER COLUMN SET NOT NULL (ACCESS EXCLUSIVE, full table scan)
 *
 * Safe type changes (metadata-only, no table rewrite):
 * - varchar(N) -> text (removing length constraint)
 * - varchar(N) -> varchar (removing length constraint)
 * - any -> text (text is unbounded, always safe target)
 * - varchar(N) -> varchar(M) where M > N (widening — needs schema to verify)
 * - numeric(P,S) -> numeric(P2,S) where P2 > P (widening — needs schema to verify)
 */

import type { ParsedStatement } from '../parser.js';
import type { CheckResult, PgfenceConfig } from '../types.js';
import { LockMode, RiskLevel, getBlockedOperations } from '../types.js';
import { makePreview } from '../parser.js';

interface TypeNameNode {
  names?: Array<{ String?: { sval: string } }>;
  typmods?: Array<{ A_Const?: { ival?: { ival: number } } }>;
}

interface AlterTableCmd {
  AlterTableCmd: {
    subtype: string;
    name?: string;
    behavior: string;
    def?: {
      ColumnDef?: {
        typeName?: TypeNameNode;
      };
    };
  };
}

interface TargetType {
  name: string;
  modifier: number | null;
}

/**
 * Extract the target type name and optional length/precision modifier from the AST.
 *
 * libpg-query represents type names as an array of String nodes. Qualified types
 * like varchar come through as ["pg_catalog", "varchar"]; unqualified types like
 * text come through as ["text"]. We always take the last element as the canonical
 * type name.
 */
function extractTargetType(def: AlterTableCmd['AlterTableCmd']['def']): TargetType | null {
  const typeName = def?.ColumnDef?.typeName;
  if (!typeName?.names?.length) return null;

  const names = typeName.names;
  const lastNameNode = names[names.length - 1];
  const name = lastNameNode?.String?.sval ?? null;
  if (!name) return null;

  const typmods = typeName.typmods ?? [];
  const firstMod = typmods[0]?.A_Const?.ival?.ival ?? null;

  return { name, modifier: firstMod };
}

/**
 * Determine the risk level for an ALTER COLUMN TYPE based on the target type.
 *
 * Without the source type (which is not available from the AST), we classify
 * based on what we can determine from the target alone:
 *
 * - Target is `text` or `varchar` without length: LOW (always safe, metadata-only)
 * - Target is `varchar(N)` or `numeric(P,S)`: MEDIUM (safe if widening, but
 *   we cannot verify without schema info)
 * - Everything else: HIGH (potential table rewrite)
 */
interface TypeClassification {
  risk: RiskLevel;
  message: string;
}

function classifyTypeChange(target: TargetType | null): TypeClassification | null {
  if (!target) return null;

  const { name, modifier } = target;

  if (name === 'text') {
    return {
      risk: RiskLevel.LOW,
      message: 'metadata-only type change (target is text, no table rewrite)',
    };
  }

  if (name === 'varchar' && modifier === null) {
    return {
      risk: RiskLevel.LOW,
      message: 'metadata-only type change (removing varchar length constraint, no table rewrite)',
    };
  }

  if (name === 'varchar' && modifier !== null) {
    return {
      risk: RiskLevel.MEDIUM,
      message: `TYPE varchar(${modifier}) — safe if widening (increasing length), but requires schema to verify. Narrowing causes a table rewrite.`,
    };
  }

  if (name === 'numeric' && modifier !== null) {
    return {
      risk: RiskLevel.MEDIUM,
      message: `TYPE numeric — safe if widening precision, but requires schema to verify. Narrowing causes a table rewrite.`,
    };
  }

  return null;
}

export function checkAlterColumn(
  stmt: ParsedStatement,
  _config: PgfenceConfig,
): CheckResult[] {
  if (stmt.nodeType !== 'AlterTableStmt') return [];

  const node = stmt.node as {
    relation: { relname: string };
    cmds: AlterTableCmd[];
  };

  const results: CheckResult[] = [];
  const tableName = node.relation?.relname ?? null;

  for (const cmd of node.cmds ?? []) {
    const c = cmd.AlterTableCmd;

    if (c.subtype === 'AT_AlterColumnType') {
      const colName = c.name ?? '<unknown>';
      const target = extractTargetType(c.def);
      const classification = classifyTypeChange(target);

      if (classification && classification.risk !== RiskLevel.HIGH) {
        const safeRewrite = classification.risk === RiskLevel.MEDIUM
          ? {
              description: 'Verify this is a widening change (increasing length/precision). Narrowing requires expand/contract.',
              steps: [
                `-- Confirm the current type of "${colName}" is narrower than the target.`,
                `-- If widening: this ALTER is metadata-only and safe.`,
                `-- If narrowing: use the expand/contract pattern instead.`,
              ],
            }
          : undefined;

        results.push({
          statement: stmt.sql,
          statementPreview: makePreview(stmt.sql),
          tableName,
          lockMode: LockMode.ACCESS_EXCLUSIVE,
          blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
          risk: classification.risk,
          message: `ALTER COLUMN "${colName}" ${classification.message}`,
          ruleId: 'alter-column-type',
          ...(safeRewrite ? { safeRewrite } : {}),
        });
      } else {
        results.push({
          statement: stmt.sql,
          statementPreview: makePreview(stmt.sql),
          tableName,
          lockMode: LockMode.ACCESS_EXCLUSIVE,
          blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
          risk: RiskLevel.HIGH,
          message: `ALTER COLUMN "${colName}" TYPE — rewrites the entire table under ACCESS EXCLUSIVE lock`,
          ruleId: 'alter-column-type',
          safeRewrite: {
            description: 'Use expand/contract pattern: add new column, backfill, swap',
            steps: [
              `-- 1. Add new column with target type`,
              `ALTER TABLE ${tableName} ADD COLUMN ${colName}_new <new_type>;`,
              `-- 2. Backfill out-of-band in batches (repeat until 0 rows updated):`,
              `-- WITH batch AS (`,
              `--   SELECT ctid FROM ${tableName} WHERE ${colName}_new IS NULL LIMIT 1000 FOR UPDATE SKIP LOCKED`,
              `-- )`,
              `-- UPDATE ${tableName} t SET ${colName}_new = ${colName}::<new_type> FROM batch WHERE t.ctid = batch.ctid;`,
              `-- 3. Swap columns (application-level)`,
              `-- 4. Drop old column after verification`,
            ],
          },
        });
      }
    }

    if (c.subtype === 'AT_SetNotNull') {
      const colName = c.name ?? '<unknown>';
      results.push({
        statement: stmt.sql,
        statementPreview: makePreview(stmt.sql),
        tableName,
        lockMode: LockMode.ACCESS_EXCLUSIVE,
        blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
        risk: RiskLevel.MEDIUM,
        message: `ALTER COLUMN "${colName}" SET NOT NULL — scans entire table under ACCESS EXCLUSIVE lock`,
        ruleId: 'alter-column-set-not-null',
        safeRewrite: {
          description: 'Use CHECK constraint NOT VALID + VALIDATE to avoid full table lock',
          steps: [
            `ALTER TABLE ${tableName} ADD CONSTRAINT chk_${colName}_nn CHECK (${colName} IS NOT NULL) NOT VALID;`,
            `ALTER TABLE ${tableName} VALIDATE CONSTRAINT chk_${colName}_nn;`,
            `ALTER TABLE ${tableName} ALTER COLUMN ${colName} SET NOT NULL;`,
            `ALTER TABLE ${tableName} DROP CONSTRAINT chk_${colName}_nn;`,
          ],
        },
      });
    }
  }

  return results;
}
