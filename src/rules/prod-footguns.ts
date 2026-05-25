/**
 * Rule: Production footguns no other linter catches today.
 *
 * - CLUSTER: rewrites entire table holding ACCESS EXCLUSIVE; same blast radius as VACUUM FULL.
 * - ALTER TABLE ... REPLICA IDENTITY FULL: 10-100x amplifies logical-replication WAL volume.
 * - CREATE POLICY / ALTER TABLE ENABLE | DISABLE ROW LEVEL SECURITY: toggling RLS without a
 *   policy locks users out of their own data; disabling silently exposes data.
 * - ALTER TABLE ... INHERIT | NO INHERIT: validation scan under ACCESS EXCLUSIVE on both tables.
 * - CREATE TYPE AS ENUM: future ALTER TYPE DROP VALUE is impossible in Postgres, warn early.
 *
 * Every assignment here is justified against the PostgreSQL source (tablecmds.c, cluster.c,
 * policy.c, pg_enum.c) and the documented lock modes in explicit-locking.html.
 */

import type { ParsedStatement } from '../parser.js';
import type { CheckResult } from '../types.js';
import { LockMode, RiskLevel, getBlockedOperations } from '../types.js';
import { makePreview } from '../parser.js';

type TableRef = { relname?: string; schemaname?: string };

function tableNameOf(rel: TableRef | undefined | null): string | null {
  if (!rel?.relname) return null;
  return rel.schemaname ? `${rel.schemaname}.${rel.relname}` : rel.relname;
}

export function checkProdFootguns(stmt: ParsedStatement): CheckResult[] {
  const results: CheckResult[] = [];

  switch (stmt.nodeType) {
    case 'ClusterStmt': {
      const node = stmt.node as { relation?: TableRef; indexname?: string };
      const tableName = tableNameOf(node.relation);
      // CLUSTER without a table = recluster everything in DB; still ACCESS EXCLUSIVE per table.
      const target = tableName ?? '<all clustered tables>';
      const indexName = node.indexname ? ` ON ${node.indexname}` : '';
      results.push({
        statement: stmt.sql,
        statementPreview: makePreview(stmt.sql),
        tableName,
        lockMode: LockMode.ACCESS_EXCLUSIVE,
        blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
        risk: RiskLevel.HIGH,
        message: `CLUSTER ${target}${indexName}: rewrites the entire table while holding ACCESS EXCLUSIVE. Reads and writes are blocked for the full duration of the rewrite. Same blast radius as VACUUM FULL.`,
        ruleId: 'cluster',
        safeRewrite: {
          description: 'CLUSTER cannot be made online. Use pg_repack (or pg_squeeze) for an online reclustering with minimal locking. If you only need physical ordering for a one-time backfill, do it in maintenance window with explicit lock_timeout.',
          steps: [
            `-- Option A (recommended): use pg_repack instead`,
            `--   pg_repack --table=${tableName ?? '<table>'} --order-by=<index_cols>`,
            `-- Option B: schedule CLUSTER in a maintenance window`,
            `SET lock_timeout = '5s';`,
            `${stmt.sql.trim().replace(/;\s*$/, '')};`,
          ],
        },
      });
      break;
    }

    case 'AlterTableStmt': {
      const node = stmt.node as {
        relation?: TableRef;
        cmds?: Array<{ AlterTableCmd: { subtype: string; name?: string; def?: unknown } }>;
      };
      const tableName = tableNameOf(node.relation);
      const cmds = node.cmds ?? [];
      for (const c of cmds) {
        const sub = c.AlterTableCmd?.subtype;

        // REPLICA IDENTITY: only FULL is the bomb. DEFAULT/NOTHING/USING INDEX are fine.
        if (sub === 'AT_ReplicaIdentity') {
          const def = c.AlterTableCmd?.def as { ReplicaIdentityStmt?: { identity_type?: string } } | undefined;
          // identity_type values: 'd' (default), 'n' (nothing), 'f' (full), 'i' (index)
          if (def?.ReplicaIdentityStmt?.identity_type === 'f') {
            results.push({
              statement: stmt.sql,
              statementPreview: makePreview(stmt.sql),
              tableName,
              lockMode: LockMode.ACCESS_EXCLUSIVE,
              blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
              risk: RiskLevel.HIGH,
              message: `ALTER TABLE "${tableName}" REPLICA IDENTITY FULL: every UPDATE and DELETE now writes the entire old row image to WAL. This 10x to 100x amplifies WAL volume on this table and saturates logical replication consumers (Debezium, pglogical). Almost always a misconfiguration.`,
              ruleId: 'replica-identity-full',
              safeRewrite: {
                description: 'REPLICA IDENTITY FULL is rarely the right answer. Use the table primary key (default) or a unique non-null index. Only use FULL on tables without any unique key, and only if you understand the WAL cost.',
                steps: [
                  `-- Prefer the primary key (the default if one exists)`,
                  `ALTER TABLE ${tableName} REPLICA IDENTITY DEFAULT;`,
                  `-- Or a specific unique non-null index`,
                  `ALTER TABLE ${tableName} REPLICA IDENTITY USING INDEX <unique_non_null_index>;`,
                ],
              },
            });
          }
          continue;
        }

        // RLS toggle on the table itself.
        if (sub === 'AT_EnableRowSecurity' || sub === 'AT_DisableRowSecurity') {
          const enabling = sub === 'AT_EnableRowSecurity';
          results.push({
            statement: stmt.sql,
            statementPreview: makePreview(stmt.sql),
            tableName,
            lockMode: LockMode.ACCESS_EXCLUSIVE,
            blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
            risk: RiskLevel.HIGH,
            message: enabling
              ? `ALTER TABLE "${tableName}" ENABLE ROW LEVEL SECURITY: without a CREATE POLICY for the current role, this denies access to every row of "${tableName}". Reads return empty, writes fail.`
              : `ALTER TABLE "${tableName}" DISABLE ROW LEVEL SECURITY: silently exposes every row that was previously gated by policies. Any role with table-level SELECT will see all rows, including those a policy was hiding.`,
            ruleId: enabling ? 'enable-rls' : 'disable-rls',
            safeRewrite: {
              description: enabling
                ? 'Define policies BEFORE enabling RLS. The order matters: with RLS on and no policy, the default is deny-all.'
                : 'Verify no policy on this table is hiding data that should remain hidden. If RLS is being removed because the policies are wrong, fix the policies instead.',
              steps: enabling
                ? [
                    `-- 1. Create the policies first`,
                    `CREATE POLICY <name> ON ${tableName} FOR SELECT USING (<condition>);`,
                    `-- 2. Then enable RLS`,
                    `ALTER TABLE ${tableName} ENABLE ROW LEVEL SECURITY;`,
                    `-- 3. Test as the target role`,
                    `SET ROLE <app_role>; SELECT count(*) FROM ${tableName};`,
                  ]
                : [
                    `-- Audit before disabling`,
                    `SELECT polname, polcmd, polqual FROM pg_policy WHERE polrelid = '${tableName}'::regclass;`,
                    `-- Only then`,
                    `ALTER TABLE ${tableName} DISABLE ROW LEVEL SECURITY;`,
                  ],
            },
          });
          continue;
        }

        // INHERIT / NO INHERIT: validation scan of child under ACCESS EXCLUSIVE on both tables.
        if (sub === 'AT_AddInherit' || sub === 'AT_DropInherit') {
          const adding = sub === 'AT_AddInherit';
          results.push({
            statement: stmt.sql,
            statementPreview: makePreview(stmt.sql),
            tableName,
            lockMode: LockMode.ACCESS_EXCLUSIVE,
            blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
            risk: RiskLevel.HIGH,
            message: adding
              ? `ALTER TABLE "${tableName}" INHERIT: scans the child to validate column shape and CHECK constraints against the parent, holding ACCESS EXCLUSIVE on both tables for the duration of the scan.`
              : `ALTER TABLE "${tableName}" NO INHERIT: brief but ACCESS EXCLUSIVE on both parent and child; verify no application code expects the inheritance relationship.`,
            ruleId: adding ? 'inherit' : 'no-inherit',
            safeRewrite: {
              description: 'Inheritance changes always lock both tables. Schedule in a maintenance window with explicit lock_timeout.',
              steps: [
                `SET lock_timeout = '2s';`,
                `${stmt.sql.trim().replace(/;\s*$/, '')};`,
              ],
            },
          });
        }
      }
      break;
    }

    case 'CreatePolicyStmt': {
      // CREATE POLICY itself is informational. The HIGH-risk pairing is "policy + enable RLS"
      // which we already flag on AT_EnableRowSecurity. Surface a LOW informational so reviewers
      // see the full picture.
      const node = stmt.node as { table?: TableRef; policy_name?: string };
      const tableName = tableNameOf(node.table);
      results.push({
        statement: stmt.sql,
        statementPreview: makePreview(stmt.sql),
        tableName,
        lockMode: LockMode.ACCESS_EXCLUSIVE,
        blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
        risk: RiskLevel.LOW,
        message: `CREATE POLICY "${node.policy_name ?? '<unnamed>'}" on "${tableName}": no effect until ROW LEVEL SECURITY is enabled on the table. Verify the corresponding ALTER TABLE ... ENABLE ROW LEVEL SECURITY exists and runs AFTER all policies are created.`,
        ruleId: 'create-policy',
      });
      break;
    }

    // CREATE TYPE AS ENUM emits a CreateEnumStmt directly (not a generic DefineStmt).
    case 'CreateEnumStmt': {
      const node = stmt.node as { typeName?: Array<{ String?: { sval?: string } }> };
      const typeName = node.typeName?.map((n) => n.String?.sval).filter(Boolean).join('.') ?? '<enum>';
      results.push({
        statement: stmt.sql,
        statementPreview: makePreview(stmt.sql),
        tableName: null,
        lockMode: LockMode.ACCESS_SHARE,
        blocks: getBlockedOperations(LockMode.ACCESS_SHARE),
        risk: RiskLevel.LOW,
        message: `CREATE TYPE "${typeName}" AS ENUM: Postgres enums cannot have values removed once added. ALTER TYPE ... DROP VALUE does not exist. If you may ever need to remove a value, prefer a lookup table or a CHECK constraint instead.`,
        ruleId: 'create-enum-type',
        safeRewrite: {
          description: 'Prefer a lookup table for evolving categorical data; the table can be edited (DELETE, UPDATE) while enums are append-only.',
          steps: [
            `-- Option A: lookup table (recommended for evolving sets)`,
            `CREATE TABLE ${typeName}_kinds (kind text PRIMARY KEY);`,
            `INSERT INTO ${typeName}_kinds (kind) VALUES (...);`,
            `-- Option B: CHECK constraint (works for small, stable sets)`,
            `ALTER TABLE <t> ADD CONSTRAINT <t>_kind_check CHECK (kind IN ('a','b','c'));`,
            `-- Option C: keep the enum, but document the trade-off`,
          ],
        },
      });
      break;
    }
  }

  return results;
}
