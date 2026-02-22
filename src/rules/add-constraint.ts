/**
 * Rule: ADD CONSTRAINT checks
 *
 * Detects:
 * - FOREIGN KEY without NOT VALID (ACCESS EXCLUSIVE on both tables)
 * - CHECK constraint without NOT VALID (ACCESS EXCLUSIVE + scan)
 * - UNIQUE constraint (ACCESS EXCLUSIVE, full table scan)
 * - PRIMARY KEY without USING INDEX (ACCESS EXCLUSIVE, full table scan)
 * - EXCLUDE constraint (ACCESS EXCLUSIVE)
 *
 * Detection key from AST probe:
 * - skip_validation === true → NOT VALID was used (safe)
 * - skip_validation absent → validated immediately (dangerous)
 *
 * AT_ValidateConstraint → SHARE UPDATE EXCLUSIVE (non-blocking scan), LOW risk
 */

import type { ParsedStatement } from '../parser.js';
import type { CheckResult } from '../types.js';
import { LockMode, RiskLevel, getBlockedOperations } from '../types.js';
import { makePreview } from '../parser.js';

interface ConstraintDef {
  contype: string;
  conname?: string;
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
        message: `VALIDATE CONSTRAINT "${c.name}" — non-blocking scan under SHARE UPDATE EXCLUSIVE lock`,
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
          lockMode: LockMode.ACCESS_EXCLUSIVE,
          blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
          risk: RiskLevel.HIGH,
          message: `ADD FOREIGN KEY "${conName}" without NOT VALID — acquires ACCESS EXCLUSIVE lock on "${tableName}" and SHARE lock on "${refTable}"`,
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
          lockMode: LockMode.ACCESS_EXCLUSIVE,
          blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
          risk: RiskLevel.MEDIUM,
          message: `ADD CHECK "${conName}" without NOT VALID — acquires ACCESS EXCLUSIVE lock and scans entire table`,
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
        results.push({
          statement: stmt.sql,
          statementPreview: makePreview(stmt.sql),
          tableName,
          lockMode: LockMode.ACCESS_EXCLUSIVE,
          blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
          risk: RiskLevel.HIGH,
          message: `ADD UNIQUE "${conName}" — acquires ACCESS EXCLUSIVE lock with full table scan`,
          ruleId: 'add-constraint-unique',
          safeRewrite: {
            description: 'Create unique index concurrently, then add constraint using the index',
            steps: [
              `CREATE UNIQUE INDEX CONCURRENTLY ${conName}_idx ON ${tableName}(...);`,
              `ALTER TABLE ${tableName} ADD CONSTRAINT ${conName} UNIQUE USING INDEX ${conName}_idx;`,
            ],
          },
        });
        break;
      }

      case 'CONSTR_PRIMARY': {
        results.push({
          statement: stmt.sql,
          statementPreview: makePreview(stmt.sql),
          tableName,
          lockMode: LockMode.ACCESS_EXCLUSIVE,
          blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
          risk: RiskLevel.HIGH,
          message: `ADD PRIMARY KEY "${conName}" without USING INDEX — acquires ACCESS EXCLUSIVE lock with full table scan`,
          ruleId: 'add-pk-without-using-index',
          safeRewrite: {
            description: 'Create unique index concurrently, then add primary key using the index',
            steps: [
              `CREATE UNIQUE INDEX CONCURRENTLY ${conName}_idx ON ${tableName}(...);`,
              `ALTER TABLE ${tableName} ADD CONSTRAINT ${conName} PRIMARY KEY USING INDEX ${conName}_idx;`,
            ],
          },
        });
        break;
      }

      case 'CONSTR_EXCLUSION': {
        results.push({
          statement: stmt.sql,
          statementPreview: makePreview(stmt.sql),
          tableName,
          lockMode: LockMode.ACCESS_EXCLUSIVE,
          blocks: getBlockedOperations(LockMode.ACCESS_EXCLUSIVE),
          risk: RiskLevel.HIGH,
          message: `ADD EXCLUDE "${conName}" — acquires ACCESS EXCLUSIVE lock`,
          ruleId: 'add-constraint-exclude',
          safeRewrite: {
            description: 'Build exclusion index concurrently, then add constraint using the index',
            steps: [
              `-- 1. Build the underlying index concurrently`,
              `CREATE INDEX CONCURRENTLY ${conName}_idx ON ${tableName} USING gist (...);`,
              `-- 2. Add the exclusion constraint using the pre-built index`,
              `ALTER TABLE ${tableName} ADD CONSTRAINT ${conName} EXCLUDE USING INDEX ${conName}_idx (...);`,
            ],
          },
        });
        break;
      }
    }
  }

  return results;
}
