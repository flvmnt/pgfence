/**
 * Rule: ADD CONSTRAINT checks
 *
 * Detects:
 * - FOREIGN KEY without NOT VALID (SHARE ROW EXCLUSIVE on both tables)
 * - CHECK constraint without NOT VALID (SHARE ROW EXCLUSIVE + scan)
 * - UNIQUE constraint (SHARE ROW EXCLUSIVE, full table scan)
 * - PRIMARY KEY without USING INDEX (SHARE ROW EXCLUSIVE, full table scan)
 * - EXCLUDE constraint (SHARE ROW EXCLUSIVE)
 * - UNIQUE/PRIMARY KEY USING INDEX (SHARE UPDATE EXCLUSIVE, instant)
 * - ALTER DOMAIN ADD CONSTRAINT (blocks all queries using the domain)
 * - CREATE DOMAIN WITH CONSTRAINT (poor migration support)
 *
 * PostgreSQL's AlterTableGetLockLevel() returns ShareRowExclusiveLock for
 * AT_AddConstraint since PG 9.3. USING INDEX variants use ShareUpdateExclusiveLock.
 *
 * Detection key from AST probe:
 * - skip_validation === true -> NOT VALID was used (safe)
 * - skip_validation absent -> validated immediately (dangerous)
 *
 * AT_ValidateConstraint -> SHARE UPDATE EXCLUSIVE (non-blocking scan), LOW risk
 */

import type { ParsedStatement } from '../parser.js';
import type { CheckResult } from '../types.js';
import { LockMode, RiskLevel, getBlockedOperations } from '../types.js';
import { makePreview } from '../parser.js';

interface ConstraintDef {
  contype: string;
  conname?: string;
  indexname?: string;
  skip_validation?: boolean;
  initially_valid?: boolean;
  pktable?: { relname: string };
  fk_attrs?: Array<{ String: { sval: string } }>;
  keys?: Array<{ String: { sval: string } }>;
}

interface AlterTableCmd {
  AlterTableCmd: {
    subtype: string;
    name?: string;
    def?: {
      Constraint?: ConstraintDef;
    };
    behavior: string;
  };
}

export function checkAddConstraint(stmt: ParsedStatement): CheckResult[] {
  if (stmt.nodeType !== 'AlterTableStmt') return [];

  const node = stmt.node as {
    relation: { relname: string };
    cmds: AlterTableCmd[];
  };

  const results: CheckResult[] = [];
  const tableName = node.relation?.relname ?? null;

  for (const cmd of node.cmds ?? []) {
    const c = cmd.AlterTableCmd;

    // VALIDATE CONSTRAINT → safe, non-blocking scan
    if (c.subtype === 'AT_ValidateConstraint') {
      results.push({
        statement: stmt.sql,
        statementPreview: makePreview(stmt.sql),
        tableName,
        lockMode: LockMode.SHARE_UPDATE_EXCLUSIVE,
        blocks: getBlockedOperations(LockMode.SHARE_UPDATE_EXCLUSIVE),
        risk: RiskLevel.LOW,
        message: `VALIDATE CONSTRAINT "${c.name}": non-blocking scan under SHARE UPDATE EXCLUSIVE lock`,
        ruleId: 'validate-constraint',
      });
      continue;
    }

    if (c.subtype !== 'AT_AddConstraint') continue;

    const constraint = c.def?.Constraint;
    if (!constraint) continue;
    const conName = constraint.conname ?? '<unnamed>';

    switch (constraint.contype) {
      case 'CONSTR_FOREIGN': {
        if (constraint.skip_validation === true) continue; // NOT VALID → safe
        const refTable = constraint.pktable?.relname ?? '<unknown>';
        results.push({
          statement: stmt.sql,
          statementPreview: makePreview(stmt.sql),
          tableName,
          lockMode: LockMode.SHARE_ROW_EXCLUSIVE,
          blocks: getBlockedOperations(LockMode.SHARE_ROW_EXCLUSIVE),
          risk: RiskLevel.HIGH,
          message: `ADD FOREIGN KEY "${conName}" without NOT VALID: acquires SHARE ROW EXCLUSIVE lock on "${tableName}" and "${refTable}", blocks writes on both tables`,
          ruleId: 'add-constraint-fk-no-not-valid',
          safeRewrite: {
            description: 'Add FK with NOT VALID, then validate separately',
            steps: [
              `ALTER TABLE ${tableName} ADD CONSTRAINT ${conName} FOREIGN KEY (...) REFERENCES ${refTable}(...) NOT VALID;`,
              `ALTER TABLE ${tableName} VALIDATE CONSTRAINT ${conName};`,
              `-- Note: VALIDATE CONSTRAINT may take a long time, but it only requires a SHARE UPDATE EXCLUSIVE lock which does not block normal reads or writes.`,
            ],
          },
        });
        break;
      }

      case 'CONSTR_CHECK': {
        if (constraint.skip_validation === true) continue; // NOT VALID → safe
        results.push({
          statement: stmt.sql,
          statementPreview: makePreview(stmt.sql),
          tableName,
          lockMode: LockMode.SHARE_ROW_EXCLUSIVE,
          blocks: getBlockedOperations(LockMode.SHARE_ROW_EXCLUSIVE),
          risk: RiskLevel.MEDIUM,
          message: `ADD CHECK "${conName}" without NOT VALID: acquires SHARE ROW EXCLUSIVE lock and scans entire table`,
          ruleId: 'add-constraint-check-no-not-valid',
          safeRewrite: {
            description: 'Add CHECK with NOT VALID, then validate separately',
            steps: [
              `ALTER TABLE ${tableName} ADD CONSTRAINT ${conName} CHECK (...) NOT VALID;`,
              `ALTER TABLE ${tableName} VALIDATE CONSTRAINT ${conName};`,
            ],
          },
        });
        break;
      }

      case 'CONSTR_UNIQUE': {
        if (constraint.indexname) {
          results.push({
            statement: stmt.sql,
            statementPreview: makePreview(stmt.sql),
            tableName,
            lockMode: LockMode.SHARE_UPDATE_EXCLUSIVE,
            blocks: getBlockedOperations(LockMode.SHARE_UPDATE_EXCLUSIVE),
            risk: RiskLevel.LOW,
            message: `ADD UNIQUE "${conName}" USING INDEX "${constraint.indexname}": instant metadata operation, index already built`,
            ruleId: 'add-constraint-unique-using-index',
          });
        } else {
          results.push({
            statement: stmt.sql,
            statementPreview: makePreview(stmt.sql),
            tableName,
            lockMode: LockMode.SHARE_ROW_EXCLUSIVE,
            blocks: getBlockedOperations(LockMode.SHARE_ROW_EXCLUSIVE),
            risk: RiskLevel.HIGH,
            message: `ADD UNIQUE "${conName}": acquires SHARE ROW EXCLUSIVE lock with full table scan`,
            ruleId: 'add-constraint-unique',
            safeRewrite: {
              description: 'Create unique index concurrently, then add constraint using the index',
              steps: [
                `CREATE UNIQUE INDEX CONCURRENTLY ${conName}_idx ON ${tableName}(...);`,
                `ALTER TABLE ${tableName} ADD CONSTRAINT ${conName} UNIQUE USING INDEX ${conName}_idx;`,
              ],
            },
          });
        }
        break;
      }

      case 'CONSTR_PRIMARY': {
        if (constraint.indexname) {
          results.push({
            statement: stmt.sql,
            statementPreview: makePreview(stmt.sql),
            tableName,
            lockMode: LockMode.SHARE_UPDATE_EXCLUSIVE,
            blocks: getBlockedOperations(LockMode.SHARE_UPDATE_EXCLUSIVE),
            risk: RiskLevel.LOW,
            message: `ADD PRIMARY KEY "${conName}" USING INDEX "${constraint.indexname}": instant metadata operation, index already built`,
            ruleId: 'add-pk-using-index',
          });
        } else {
          results.push({
            statement: stmt.sql,
            statementPreview: makePreview(stmt.sql),
            tableName,
            lockMode: LockMode.SHARE_ROW_EXCLUSIVE,
            blocks: getBlockedOperations(LockMode.SHARE_ROW_EXCLUSIVE),
            risk: RiskLevel.HIGH,
            message: `ADD PRIMARY KEY "${conName}" without USING INDEX: acquires SHARE ROW EXCLUSIVE lock with full table scan`,
            ruleId: 'add-pk-without-using-index',
            safeRewrite: {
              description: 'Create unique index concurrently, then add primary key using the index',
              steps: [
                `CREATE UNIQUE INDEX CONCURRENTLY ${conName}_idx ON ${tableName}(...);`,
                `ALTER TABLE ${tableName} ADD CONSTRAINT ${conName} PRIMARY KEY USING INDEX ${conName}_idx;`,
              ],
            },
          });
        }
        break;
      }

      case 'CONSTR_EXCLUSION': {
        results.push({
          statement: stmt.sql,
          statementPreview: makePreview(stmt.sql),
          tableName,
          lockMode: LockMode.SHARE_ROW_EXCLUSIVE,
          blocks: getBlockedOperations(LockMode.SHARE_ROW_EXCLUSIVE),
          risk: RiskLevel.HIGH,
          message: `ADD EXCLUDE "${conName}": acquires SHARE ROW EXCLUSIVE lock`,
          ruleId: 'add-constraint-exclude',
          safeRewrite: {
            description: 'No concurrent alternative exists for EXCLUDE constraints. Minimize lock duration.',
            steps: [
              `-- EXCLUDE constraints always require SHARE ROW EXCLUSIVE lock with no safe alternative.`,
              `-- Minimize impact by setting a low lock_timeout:`,
              `SET lock_timeout = '2s';`,
              `ALTER TABLE ${tableName} ADD CONSTRAINT ${conName} EXCLUDE USING gist (...);`,
              `-- Retry in a loop if lock_timeout expires.`,
            ],
          },
        });
        break;
      }

      default: {
        results.push({
          statement: stmt.sql,
          statementPreview: makePreview(stmt.sql),
          tableName,
          lockMode: LockMode.SHARE_ROW_EXCLUSIVE,
          blocks: getBlockedOperations(LockMode.SHARE_ROW_EXCLUSIVE),
          risk: RiskLevel.MEDIUM,
          message: `ADD CONSTRAINT "${conName}" with unrecognized type "${constraint.contype}": pgfence cannot determine the exact risk, assuming SHARE ROW EXCLUSIVE`,
          ruleId: 'add-constraint-unknown-type',
        });
        break;
      }
    }
  }

  return results;
}

/**
 * Detect ALTER DOMAIN ADD CONSTRAINT and CREATE DOMAIN with constraints.
 * Domains with constraints have poor support for online migrations.
 */
export function checkDomainConstraint(stmt: ParsedStatement): CheckResult[] {
  const results: CheckResult[] = [];

  if (stmt.nodeType === 'AlterDomainStmt') {
    const node = stmt.node as {
      typeName?: Array<{ String: { sval: string } }>;
      subtype: string;
    };
    if (node.subtype === 'C') {
      // 'C' = ADD CONSTRAINT in AlterDomainStmt subtype enum
      const domainName = node.typeName?.[node.typeName.length - 1]?.String?.sval ?? '<unknown>';
      results.push({
        statement: stmt.sql,
        statementPreview: makePreview(stmt.sql),
        tableName: null,
        lockMode: LockMode.SHARE,
        blocks: getBlockedOperations(LockMode.SHARE),
        risk: RiskLevel.HIGH,
        message: `ALTER DOMAIN "${domainName}" ADD CONSTRAINT: validates against all columns using this domain, blocking writes on those tables. Domains with constraints have poor support for online migrations`,
        ruleId: 'ban-alter-domain-add-constraint',
        appliesToNewTables: true,
      });
    }
  }

  if (stmt.nodeType === 'CreateDomainStmt') {
    const node = stmt.node as {
      domainname?: Array<{ String: { sval: string } }>;
      constraints?: Array<unknown>;
    };
    if (node.constraints && node.constraints.length > 0) {
      const domainName = node.domainname?.[node.domainname.length - 1]?.String?.sval ?? '<unknown>';
      results.push({
        statement: stmt.sql,
        statementPreview: makePreview(stmt.sql),
        tableName: null,
        lockMode: LockMode.ACCESS_SHARE,
        blocks: getBlockedOperations(LockMode.ACCESS_SHARE),
        risk: RiskLevel.LOW,
        message: `CREATE DOMAIN "${domainName}" with constraints: domains with constraints have poor support for online migrations. Use table-level CHECK constraints instead`,
        ruleId: 'ban-create-domain-with-constraint',
        appliesToNewTables: true,
      });
    }
  }

  return results;
}
