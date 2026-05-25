/**
 * Rule: Production footguns no other linter catches today.
 *
 * - CLUSTER: rewrites entire table holding ACCESS EXCLUSIVE; same blast radius as VACUUM FULL.
 * - ALTER TABLE ... REPLICA IDENTITY FULL: 10-100x amplifies logical-replication WAL volume.
 * - CREATE POLICY / ALTER POLICY / DROP POLICY / ALTER TABLE ENABLE | DISABLE | FORCE | NO FORCE ROW LEVEL SECURITY: toggling RLS without a
 *   policy locks users out of their own data; disabling silently exposes data.
 * - ALTER TABLE ... INHERIT | NO INHERIT: ACCESS EXCLUSIVE catalog changes on inherited tables.
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

function extractPolicyTableName(objects: unknown[] | undefined): string | null {
  const first = objects?.[0] as { List?: { items?: Array<{ String?: { sval?: string } }> } } | undefined;
  const items = first?.List?.items ?? [];
  const names = items.map((item) => item.String?.sval).filter((name): name is string => Boolean(name));
  if (names.length < 2) return null;
  return names.slice(1).join('.');
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
        if (
          sub === 'AT_EnableRowSecurity' ||
          sub === 'AT_DisableRowSecurity' ||
          sub === 'AT_ForceRowSecurity' ||
          sub === 'AT_NoForceRowSecurity'
        ) {
          const enabling = sub === 'AT_EnableRowSecurity';
          const forcing = sub === 'AT_ForceRowSecurity';
          const noForcing = sub === 'AT_NoForceRowSecurity';
          results.push({
            statement: stmt.sql,
            statementPreview: makePreview(stmt.sql),
            tableName,
            lockMode: LockMode.ACCESS_EXCLUSIVE,
            blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
            risk: RiskLevel.HIGH,
            message: forcing
              ? `ALTER TABLE "${tableName}" FORCE ROW LEVEL SECURITY: table owners are now subject to policies too. If no applicable policy exists for the owner path, owner-backed maintenance and application flows can stop seeing or changing rows.`
              : noForcing
                ? `ALTER TABLE "${tableName}" NO FORCE ROW LEVEL SECURITY: table owners bypass policies again. Verify owner-backed application connections are not relying on policy enforcement.`
                : enabling
                  ? `ALTER TABLE "${tableName}" ENABLE ROW LEVEL SECURITY: affected non-owner roles need matching policies. Without an applicable policy, reads return no rows and writes fail.`
                  : `ALTER TABLE "${tableName}" DISABLE ROW LEVEL SECURITY: silently exposes every row that was previously gated by policies. Any role with table-level SELECT can see rows a policy was hiding.`,
            ruleId: forcing ? 'force-rls' : noForcing ? 'no-force-rls' : enabling ? 'enable-rls' : 'disable-rls',
            safeRewrite: {
              description: forcing
                ? 'Audit all owner-backed access before forcing RLS, then test as the owner and target roles.'
                : noForcing
                  ? 'Verify owner bypass is intended before removing forced RLS.'
                  : enabling
                    ? 'Define policies before enabling RLS. The order matters: with RLS on and no matching policy, affected roles are denied.'
                    : 'Verify no policy on this table is hiding data that should remain hidden. If RLS is being removed because the policies are wrong, fix the policies instead.',
              steps: forcing
                ? [
                    `-- Audit policies and owner-backed access first`,
                    `SELECT polname, polcmd, polqual FROM pg_policy WHERE polrelid = '${tableName}'::regclass;`,
                    `ALTER TABLE ${tableName} FORCE ROW LEVEL SECURITY;`,
                    `SET ROLE <owner_or_app_role>; SELECT count(*) FROM ${tableName};`,
                  ]
                : noForcing
                  ? [
                      `-- Confirm owner bypass is intended`,
                      `ALTER TABLE ${tableName} NO FORCE ROW LEVEL SECURITY;`,
                    ]
                  : enabling
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

        // INHERIT / NO INHERIT: catalog-bound ACCESS EXCLUSIVE changes on inherited tables.
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
              ? `ALTER TABLE "${tableName}" INHERIT: catalog-bound inheritance change that takes ACCESS EXCLUSIVE on the child and parent while validating inherited table metadata.`
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

    case 'AlterPolicyStmt': {
      const node = stmt.node as { table?: TableRef; policy_name?: string };
      const tableName = tableNameOf(node.table);
      results.push({
        statement: stmt.sql,
        statementPreview: makePreview(stmt.sql),
        tableName,
        lockMode: LockMode.ACCESS_EXCLUSIVE,
        blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
        risk: RiskLevel.MEDIUM,
        message: `ALTER POLICY "${node.policy_name ?? '<unnamed>'}" on "${tableName}": changes who can see or modify rows under RLS. Test as every affected role before shipping.`,
        ruleId: 'alter-policy',
      });
      break;
    }

    case 'CreatePolicyStmt': {
      // CREATE POLICY itself is informational. The HIGH-risk pairing is "policy + enable RLS"
      // which we already flag on AT_EnableRowSecurity. Surface a MEDIUM note so reviewers
      // see the full picture.
      const node = stmt.node as { table?: TableRef; policy_name?: string };
      const tableName = tableNameOf(node.table);
      results.push({
        statement: stmt.sql,
        statementPreview: makePreview(stmt.sql),
        tableName,
        lockMode: LockMode.ACCESS_EXCLUSIVE,
        blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
        risk: RiskLevel.MEDIUM,
        message: `CREATE POLICY "${node.policy_name ?? '<unnamed>'}" on "${tableName}": brief ACCESS EXCLUSIVE catalog change. It has no effect until ROW LEVEL SECURITY is enabled on the table. Verify the corresponding ALTER TABLE ... ENABLE ROW LEVEL SECURITY exists and runs after all policies are created.`,
        ruleId: 'create-policy',
      });
      break;
    }

    case 'DropStmt': {
      const node = stmt.node as { removeType?: string; objects?: unknown[] };
      if (node.removeType !== 'OBJECT_POLICY') break;
      const tableName = extractPolicyTableName(node.objects);
      results.push({
        statement: stmt.sql,
        statementPreview: makePreview(stmt.sql),
        tableName,
        lockMode: LockMode.ACCESS_EXCLUSIVE,
        blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
        risk: RiskLevel.HIGH,
        message: `DROP POLICY on "${tableName ?? '<unknown>'}": removes an RLS rule and can immediately expose or deny rows for affected roles.`,
        ruleId: 'drop-policy',
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
