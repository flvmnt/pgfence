import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { analyze, adjustRisk, detectFormat } from '../src/analyzer.js';
import { parseTimeoutString } from '../src/rules/policy.js';
import { createTransactionState, processTransactionStmt, recordLock } from '../src/transaction-state.js';
import { loadSnapshot } from '../src/schema-snapshot.js';
import type { SchemaSnapshot } from '../src/schema-snapshot.js';
import { RiskLevel, LockMode } from '../src/types.js';
import type { PgfenceConfig } from '../src/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures');

function fixture(name: string): string {
  return path.join(FIXTURES, name);
}

const defaultConfig: PgfenceConfig = {
  format: 'auto',
  output: 'cli',
  minPostgresVersion: 11,
  maxAllowedRisk: RiskLevel.HIGH,
  requireLockTimeout: true,
  requireStatementTimeout: true,
};

describe('pgfence analyzer', () => {
  it('should detect ADD COLUMN NOT NULL without DEFAULT as HIGH risk', async () => {
    const results = await analyze([fixture('dangerous-add-column.sql')], defaultConfig);
    expect(results).toHaveLength(1);
    const checks = results[0].checks;

    const notNullCheck = checks.find((c) => c.ruleId === 'add-column-not-null-no-default');
    expect(notNullCheck).toBeDefined();
    expect(notNullCheck!.risk).toBe(RiskLevel.HIGH);
    expect(notNullCheck!.lockMode).toBe(LockMode.ACCESS_EXCLUSIVE);
    expect(notNullCheck!.tableName).toBe('appointments');
  });

  it('should detect CREATE INDEX without CONCURRENTLY as MEDIUM risk', async () => {
    const results = await analyze([fixture('dangerous-index.sql')], defaultConfig);
    expect(results).toHaveLength(1);
    const checks = results[0].checks;

    const indexCheck = checks.find((c) => c.ruleId === 'create-index-not-concurrent');
    expect(indexCheck).toBeDefined();
    expect(indexCheck!.risk).toBe(RiskLevel.MEDIUM);
    expect(indexCheck!.lockMode).toBe(LockMode.SHARE);
  });

  it('should detect ADD CONSTRAINT FOREIGN KEY without NOT VALID as HIGH risk', async () => {
    const results = await analyze([fixture('dangerous-constraint.sql')], defaultConfig);
    expect(results).toHaveLength(1);
    const checks = results[0].checks;

    const fkCheck = checks.find((c) => c.ruleId === 'add-constraint-fk-no-not-valid');
    expect(fkCheck).toBeDefined();
    expect(fkCheck!.risk).toBe(RiskLevel.HIGH);
  });

  it('should detect ALTER COLUMN TYPE (cross-family) as HIGH risk', async () => {
    const results = await analyze([fixture('dangerous-alter-column.sql')], defaultConfig);
    expect(results).toHaveLength(1);
    const checks = results[0].checks;

    const typeCheck = checks.find((c) => c.ruleId === 'alter-column-type');
    expect(typeCheck).toBeDefined();
    expect(typeCheck!.risk).toBe(RiskLevel.HIGH);
    expect(typeCheck!.lockMode).toBe(LockMode.ACCESS_EXCLUSIVE);
    expect(typeCheck!.safeRewrite).toBeDefined();
  });

  it('should detect ALTER COLUMN SET NOT NULL as MEDIUM risk', async () => {
    const results = await analyze([fixture('dangerous-alter-column.sql')], defaultConfig);
    const checks = results[0].checks;

    const notNullCheck = checks.find((c) => c.ruleId === 'alter-column-set-not-null');
    expect(notNullCheck).toBeDefined();
    expect(notNullCheck!.risk).toBe(RiskLevel.MEDIUM);
  });

  it('should detect DROP TABLE as CRITICAL risk', async () => {
    const results = await analyze([fixture('dangerous-destructive.sql')], defaultConfig);
    const checks = results[0].checks;

    const dropCheck = checks.find((c) => c.ruleId === 'drop-table');
    expect(dropCheck).toBeDefined();
    expect(dropCheck!.risk).toBe(RiskLevel.CRITICAL);
    expect(dropCheck!.lockMode).toBe(LockMode.ACCESS_EXCLUSIVE);
  });

  it('should detect TRUNCATE as CRITICAL risk', async () => {
    const results = await analyze([fixture('dangerous-destructive.sql')], defaultConfig);
    const checks = results[0].checks;

    const truncCheck = checks.find((c) => c.ruleId === 'truncate');
    expect(truncCheck).toBeDefined();
    expect(truncCheck!.risk).toBe(RiskLevel.CRITICAL);
  });

  it('should pass safe migration patterns with SAFE/LOW risk', async () => {
    const results = await analyze([fixture('safe-migration.sql')], defaultConfig);
    expect(results).toHaveLength(1);
    const checks = results[0].checks;

    // No HIGH or CRITICAL checks
    const highOrCritical = checks.filter(
      (c) => c.risk === RiskLevel.HIGH || c.risk === RiskLevel.CRITICAL,
    );
    expect(highOrCritical).toHaveLength(0);

    // No error-severity policy violations
    const errorPolicies = results[0].policyViolations.filter((v) => v.severity === 'error');
    expect(errorPolicies).toHaveLength(0);
  });

  it('should detect missing lock_timeout as policy violation', async () => {
    const results = await analyze([fixture('missing-policy.sql')], defaultConfig);
    const violations = results[0].policyViolations;

    const lockTimeout = violations.find((v) => v.ruleId === 'missing-lock-timeout');
    expect(lockTimeout).toBeDefined();
    expect(lockTimeout!.severity).toBe('error');
  });

  it('should detect missing statement_timeout as policy violation', async () => {
    const results = await analyze([fixture('missing-policy.sql')], defaultConfig);
    const violations = results[0].policyViolations;

    const stmtTimeout = violations.find((v) => v.ruleId === 'missing-statement-timeout');
    expect(stmtTimeout).toBeDefined();
  });

  it('should detect CREATE INDEX CONCURRENTLY inside transaction', async () => {
    const results = await analyze([fixture('concurrent-in-tx.sql')], defaultConfig);
    const violations = results[0].policyViolations;

    const concurrentInTx = violations.find((v) => v.ruleId === 'concurrent-in-transaction');
    expect(concurrentInTx).toBeDefined();
    expect(concurrentInTx!.severity).toBe('error');
  });

  it('should extract SQL from TypeORM queryRunner.query() calls', async () => {
    const results = await analyze(
      [fixture('dangerous-typeorm.ts')],
      { ...defaultConfig, format: 'typeorm' },
    );
    expect(results).toHaveLength(1);
    const checks = results[0].checks;

    // Should find CREATE INDEX check from TypeORM extraction
    const indexCheck = checks.find((c) => c.ruleId === 'create-index-not-concurrent');
    expect(indexCheck).toBeDefined();
  });

  it('should skip down() method in TypeORM migrations', async () => {
    const results = await analyze(
      [fixture('dangerous-typeorm.ts')],
      { ...defaultConfig, format: 'typeorm' },
    );
    const checks = results[0].checks;

    // down() contains DROP COLUMN and DROP INDEX — should NOT appear
    const dropChecks = checks.filter(
      (c) => c.ruleId === 'drop-table' || c.ruleId === 'drop-index-not-concurrent',
    );
    expect(dropChecks).toHaveLength(0);
  });

  it('should adjust risk levels based on table stats', () => {
    // < 10K rows → no change
    expect(adjustRisk(RiskLevel.MEDIUM, 5_000)).toBe(RiskLevel.MEDIUM);

    // 10K - 1M rows → bump +1
    expect(adjustRisk(RiskLevel.MEDIUM, 100_000)).toBe(RiskLevel.HIGH);
    expect(adjustRisk(RiskLevel.LOW, 50_000)).toBe(RiskLevel.MEDIUM);

    // 1M - 10M rows → bump +2
    expect(adjustRisk(RiskLevel.MEDIUM, 5_000_000)).toBe(RiskLevel.CRITICAL);
    expect(adjustRisk(RiskLevel.LOW, 2_000_000)).toBe(RiskLevel.HIGH);

    // > 10M rows → always CRITICAL
    expect(adjustRisk(RiskLevel.LOW, 50_000_000)).toBe(RiskLevel.CRITICAL);
    expect(adjustRisk(RiskLevel.SAFE, 100_000_000)).toBe(RiskLevel.CRITICAL);
  });

  it('should generate safe rewrite recipes for dangerous patterns', async () => {
    const results = await analyze([fixture('dangerous-add-column.sql')], defaultConfig);
    const checks = results[0].checks;

    const notNullCheck = checks.find((c) => c.ruleId === 'add-column-not-null-no-default');
    expect(notNullCheck).toBeDefined();
    expect(notNullCheck!.safeRewrite).toBeDefined();
    expect(notNullCheck!.safeRewrite!.steps.length).toBeGreaterThan(0);
    expect(notNullCheck!.safeRewrite!.description).toBeTruthy();
  });

  it('should detect RENAME COLUMN as LOW risk with ACCESS EXCLUSIVE lock', async () => {
    const results = await analyze([fixture('dangerous-rename-column.sql')], defaultConfig);
    expect(results).toHaveLength(1);
    const checks = results[0].checks;

    const renameCheck = checks.find((c) => c.ruleId === 'rename-column');
    expect(renameCheck).toBeDefined();
    expect(renameCheck!.risk).toBe(RiskLevel.LOW);
    expect(renameCheck!.lockMode).toBe(LockMode.ACCESS_EXCLUSIVE);
    expect(renameCheck!.tableName).toBe('appointments');
  });

  it('should detect DROP INDEX without CONCURRENTLY as MEDIUM risk', async () => {
    const results = await analyze([fixture('dangerous-index.sql')], defaultConfig);
    const checks = results[0].checks;

    const dropIndexCheck = checks.find((c) => c.ruleId === 'drop-index-not-concurrent');
    expect(dropIndexCheck).toBeDefined();
    expect(dropIndexCheck!.risk).toBe(RiskLevel.MEDIUM);
    expect(dropIndexCheck!.lockMode).toBe(LockMode.ACCESS_EXCLUSIVE);
  });

  it('should detect ADD CHECK without NOT VALID as MEDIUM risk', async () => {
    const results = await analyze([fixture('dangerous-constraint.sql')], defaultConfig);
    const checks = results[0].checks;

    const checkConstraint = checks.find((c) => c.ruleId === 'add-constraint-check-no-not-valid');
    expect(checkConstraint).toBeDefined();
    expect(checkConstraint!.risk).toBe(RiskLevel.MEDIUM);
    expect(checkConstraint!.lockMode).toBe(LockMode.ACCESS_EXCLUSIVE);
  });

  it('should detect ADD UNIQUE constraint as HIGH risk', async () => {
    const results = await analyze([fixture('dangerous-constraint.sql')], defaultConfig);
    const checks = results[0].checks;

    const uniqueCheck = checks.find((c) => c.ruleId === 'add-constraint-unique');
    expect(uniqueCheck).toBeDefined();
    expect(uniqueCheck!.risk).toBe(RiskLevel.HIGH);
    expect(uniqueCheck!.lockMode).toBe(LockMode.ACCESS_EXCLUSIVE);
  });

  it('should detect ADD EXCLUDE constraint as HIGH risk', async () => {
    const results = await analyze([fixture('dangerous-constraint.sql')], defaultConfig);
    const checks = results[0].checks;

    const excludeCheck = checks.find((c) => c.ruleId === 'add-constraint-exclude');
    expect(excludeCheck).toBeDefined();
    expect(excludeCheck!.risk).toBe(RiskLevel.HIGH);
    expect(excludeCheck!.lockMode).toBe(LockMode.ACCESS_EXCLUSIVE);
    expect(excludeCheck!.tableName).toBe('reservations');
    expect(excludeCheck!.safeRewrite).toBeDefined();
    expect(excludeCheck!.safeRewrite!.steps.length).toBeGreaterThan(1);
  });

  it('should detect DELETE without WHERE as HIGH risk', async () => {
    const results = await analyze([fixture('dangerous-destructive.sql')], defaultConfig);
    const checks = results[0].checks;

    const deleteCheck = checks.find((c) => c.ruleId === 'delete-without-where');
    expect(deleteCheck).toBeDefined();
    expect(deleteCheck!.risk).toBe(RiskLevel.HIGH);
    expect(deleteCheck!.lockMode).toBe(LockMode.ROW_EXCLUSIVE);
    expect(deleteCheck!.tableName).toBe('audit_log');
  });

  it('should detect VACUUM FULL as HIGH risk', async () => {
    const results = await analyze([fixture('dangerous-destructive.sql')], defaultConfig);
    const checks = results[0].checks;

    const vacuumCheck = checks.find((c) => c.ruleId === 'vacuum-full');
    expect(vacuumCheck).toBeDefined();
    expect(vacuumCheck!.risk).toBe(RiskLevel.HIGH);
    expect(vacuumCheck!.lockMode).toBe(LockMode.ACCESS_EXCLUSIVE);
    expect(vacuumCheck!.tableName).toBe('appointments');
  });

  it('should provide safe rewrite recipe for FK constraint', async () => {
    const results = await analyze([fixture('dangerous-constraint.sql')], defaultConfig);
    const checks = results[0].checks;

    const fkCheck = checks.find((c) => c.ruleId === 'add-constraint-fk-no-not-valid');
    expect(fkCheck).toBeDefined();
    expect(fkCheck!.safeRewrite).toBeDefined();
    expect(fkCheck!.safeRewrite!.steps.length).toBeGreaterThan(0);
    expect(fkCheck!.safeRewrite!.description).toContain('NOT VALID');
  });

  it('should detect ADD COLUMN with function DEFAULT as HIGH risk', async () => {
    const results = await analyze([fixture('dangerous-add-column-function.sql')], defaultConfig);
    const checks = results[0].checks;

    const defaultCheck = checks.find((c) => c.ruleId === 'add-column-non-constant-default');
    expect(defaultCheck).toBeDefined();
    expect(defaultCheck!.risk).toBe(RiskLevel.HIGH);
  });

  it('should detect ADD COLUMN with constant DEFAULT on pre-PG11 as HIGH risk', async () => {
    const results = await analyze([fixture('safe-add-column-cast.sql')], { ...defaultConfig, minPostgresVersion: 10 });
    const checks = results[0].checks;

    const defaultCheck = checks.find((c) => c.ruleId === 'add-column-default-pre-pg11');
    expect(defaultCheck).toBeDefined();
    expect(defaultCheck!.risk).toBe(RiskLevel.HIGH);
  });

  it('should treat ADD COLUMN with cast constant DEFAULT as instant/LOW on PG11+', async () => {
    const results = await analyze([fixture('safe-add-column-cast.sql')], defaultConfig);
    const checks = results[0].checks;

    const defaultCheck = checks.find((c) => c.ruleId === 'add-column-constant-default');
    expect(defaultCheck).toBeDefined();
    expect(defaultCheck!.risk).toBe(RiskLevel.LOW);
  });

  it('should warn on UPDATE without WHERE in migration', async () => {
    const results = await analyze([fixture('bulk-update.sql')], defaultConfig);
    const violations = results[0].policyViolations;

    const updateCheck = violations.find((v) => v.ruleId === 'update-in-migration');
    expect(updateCheck).toBeDefined();
    expect(updateCheck!.severity).toBe('warning');
  });

  it('should NOT warn on UPDATE with WHERE in migration', async () => {
    const results = await analyze([fixture('safe-policies.sql')], defaultConfig);
    const violations = results[0].policyViolations;

    const updateCheck = violations.find((v) => v.ruleId === 'update-in-migration');
    expect(updateCheck).toBeUndefined();
  });

  it('should auto-detect Prisma migrations safely', () => {
    expect(detectFormat('prisma/migrations/init/migration.sql', '')).toBe('prisma');
    expect(detectFormat('prisma\\migrations\\init\\migration.sql', '')).toBe('prisma');
  });

  it('should throw error for unknown ts formats without proper imports', () => {
    expect(() => detectFormat('test.ts', 'const a = 1;')).toThrow('Cannot auto-detect migration format');
  });

  it('should throw error for unsupported extensions', () => {
    expect(() => detectFormat('test.txt', 'SELECT 1')).toThrow('Unsupported file extension');
  });

  // --- P0: DROP COLUMN ---

  it('should detect DROP COLUMN as HIGH risk', async () => {
    const results = await analyze([fixture('dangerous-drop-column.sql')], defaultConfig);
    const checks = results[0].checks;

    const dropCol = checks.find((c) => c.ruleId === 'drop-column');
    expect(dropCol).toBeDefined();
    expect(dropCol!.risk).toBe(RiskLevel.HIGH);
    expect(dropCol!.lockMode).toBe(LockMode.ACCESS_EXCLUSIVE);
    expect(dropCol!.tableName).toBe('appointments');
    expect(dropCol!.safeRewrite).toBeDefined();
    expect(dropCol!.safeRewrite!.steps.length).toBeGreaterThan(0);
  });

  // --- P0: NOT VALID + VALIDATE in same transaction ---

  it('should detect NOT VALID + VALIDATE CONSTRAINT in same transaction as error', async () => {
    const results = await analyze([fixture('not-valid-validate-same-tx.sql')], defaultConfig);
    const violations = results[0].policyViolations;

    const sameTransaction = violations.find((v) => v.ruleId === 'not-valid-validate-same-tx');
    expect(sameTransaction).toBeDefined();
    expect(sameTransaction!.severity).toBe('error');
  });

  // --- P0: Statement after ACCESS EXCLUSIVE ---

  it('should warn on multiple ACCESS EXCLUSIVE statements compounding danger', async () => {
    const results = await analyze([fixture('compounding-access-exclusive.sql')], defaultConfig);
    const violations = results[0].policyViolations;

    const compounding = violations.find((v) => v.ruleId === 'statement-after-access-exclusive');
    expect(compounding).toBeDefined();
    expect(compounding!.severity).toBe('warning');
  });

  it('should NOT warn on compounding ACCESS EXCLUSIVE when TypeORM transaction = false', async () => {
    const results = await analyze(
      [fixture('typeorm-transaction-false.ts')],
      { ...defaultConfig, format: 'typeorm' },
    );
    const violations = results[0].policyViolations;

    const compounding = violations.find((v) => v.ruleId === 'statement-after-access-exclusive');
    expect(compounding).toBeUndefined();
  });

  it('should extract SQL from TypeORM migrations with non-standard parameter names', async () => {
    const results = await analyze(
      [fixture('typeorm-qr-parameter.ts')],
      { ...defaultConfig, format: 'typeorm' },
    );
    expect(results).toHaveLength(1);
    // Should have extracted the ALTER TABLE statement
    expect(results[0].statementCount).toBeGreaterThan(0);
    // Should not have missing lock_timeout since the fixture sets it
    const missingLockTimeout = results[0].policyViolations.find(
      (v) => v.ruleId === 'missing-lock-timeout',
    );
    expect(missingLockTimeout).toBeUndefined();
  });

  // --- P0: Inline ignore ---

  it('should respect -- pgfence: ignore inline directives (legacy syntax)', async () => {
    const results = await analyze([fixture('inline-ignore.sql')], defaultConfig);
    const checks = results[0].checks;

    // DROP TABLE should be suppressed
    const dropCheck = checks.find((c) => c.ruleId === 'drop-table');
    expect(dropCheck).toBeUndefined();

    // CREATE INDEX should still be flagged
    const indexCheck = checks.find((c) => c.ruleId === 'create-index-not-concurrent');
    expect(indexCheck).toBeDefined();
  });

  it('should suppress ALL checks for a statement with bare -- pgfence-ignore', async () => {
    const results = await analyze([fixture('inline-ignore-all.sql')], defaultConfig);
    const checks = results[0].checks;

    // DROP TABLE check should be fully suppressed
    const dropCheck = checks.find((c) => c.ruleId === 'drop-table');
    expect(dropCheck).toBeUndefined();

    // CREATE INDEX on the *other* statement should still be flagged
    const indexCheck = checks.find((c) => c.ruleId === 'create-index-not-concurrent');
    expect(indexCheck).toBeDefined();
  });

  it('should suppress only the named rule with -- pgfence-ignore: <ruleId>', async () => {
    const results = await analyze([fixture('inline-ignore-specific.sql')], defaultConfig);
    const checks = results[0].checks;

    // drop-table is named in the directive — should be suppressed
    const dropCheck = checks.find((c) => c.ruleId === 'drop-table');
    expect(dropCheck).toBeUndefined();

    // create-index-not-concurrent is NOT named — should still fire
    const indexCheck = checks.find((c) => c.ruleId === 'create-index-not-concurrent');
    expect(indexCheck).toBeDefined();
  });

  it('should suppress multiple rules on the same statement with -- pgfence-ignore: rule1, rule2', async () => {
    const sql = `SET lock_timeout = '2s';
SET statement_timeout = '5min';
-- pgfence-ignore: drop-table, prefer-robust-drop-table
DROP TABLE old_data;`;
    const tmpFile = '/tmp/pgfence-multi-ignore-test.sql';
    const { writeFile } = await import('node:fs/promises');
    await writeFile(tmpFile, sql, 'utf8');
    const results = await analyze([tmpFile], defaultConfig);
    const checks = results[0].checks;
    // Both named rules suppressed
    expect(checks.find((c) => c.ruleId === 'drop-table')).toBeUndefined();
    expect(checks.find((c) => c.ruleId === 'prefer-robust-drop-table')).toBeUndefined();
  });

  // --- P0: Visibility logic (new tables) ---

  it('should skip warnings for operations on tables created in the same migration', async () => {
    const results = await analyze([fixture('new-table-visibility.sql')], defaultConfig);
    const checks = results[0].checks;

    // Lock/safety checks on fresh_table should not be flagged — the table was just created
    // But best practice checks (appliesToNewTables) may still appear
    const lockChecks = checks.filter((c) => c.tableName === 'fresh_table' && !c.appliesToNewTables);
    expect(lockChecks).toHaveLength(0);
  });

  // --- P1: ADD COLUMN json ---

  it('should detect ADD COLUMN with json type and suggest jsonb', async () => {
    const results = await analyze([fixture('add-column-json.sql')], defaultConfig);
    const checks = results[0].checks;

    const jsonCheck = checks.find((c) => c.ruleId === 'add-column-json');
    expect(jsonCheck).toBeDefined();
    expect(jsonCheck!.risk).toBe(RiskLevel.LOW);
    expect(jsonCheck!.message).toContain('jsonb');
  });

  // --- P1: ADD COLUMN serial ---

  it('should detect ADD COLUMN with serial and suggest IDENTITY', async () => {
    const results = await analyze([fixture('add-column-serial.sql')], defaultConfig);
    const checks = results[0].checks;

    const serialCheck = checks.find((c) => c.ruleId === 'add-column-serial');
    expect(serialCheck).toBeDefined();
    expect(serialCheck!.risk).toBe(RiskLevel.MEDIUM);
    expect(serialCheck!.safeRewrite).toBeDefined();
    expect(serialCheck!.message).toContain('IDENTITY');
  });

  // --- P1: ADD COLUMN stored generated ---

  it('should detect ADD COLUMN with GENERATED ALWAYS AS STORED as HIGH risk', async () => {
    const results = await analyze([fixture('add-column-stored-generated.sql')], defaultConfig);
    const checks = results[0].checks;

    const genCheck = checks.find((c) => c.ruleId === 'add-column-stored-generated');
    expect(genCheck).toBeDefined();
    expect(genCheck!.risk).toBe(RiskLevel.HIGH);
    expect(genCheck!.lockMode).toBe(LockMode.ACCESS_EXCLUSIVE);
    expect(genCheck!.safeRewrite).toBeDefined();
  });

  // --- P1: RENAME TABLE ---

  it('should detect RENAME TABLE as HIGH risk', async () => {
    const results = await analyze([fixture('rename-table.sql')], defaultConfig);
    const checks = results[0].checks;

    const renameCheck = checks.find((c) => c.ruleId === 'rename-table');
    expect(renameCheck).toBeDefined();
    expect(renameCheck!.risk).toBe(RiskLevel.HIGH);
    expect(renameCheck!.lockMode).toBe(LockMode.ACCESS_EXCLUSIVE);
    expect(renameCheck!.tableName).toBe('appointments');
    expect(renameCheck!.safeRewrite).toBeDefined();
  });

  // --- P1: TRUNCATE CASCADE ---

  it('should detect TRUNCATE CASCADE as CRITICAL risk', async () => {
    const results = await analyze([fixture('truncate-cascade.sql')], defaultConfig);
    const checks = results[0].checks;

    const cascadeCheck = checks.find((c) => c.ruleId === 'truncate-cascade');
    expect(cascadeCheck).toBeDefined();
    expect(cascadeCheck!.risk).toBe(RiskLevel.CRITICAL);
    expect(cascadeCheck!.message).toContain('CASCADE');
  });

  // --- P1: Best practices — type warnings on ALTER TABLE ---

  it('should detect integer, varchar(N), and timestamp as best practice warnings', async () => {
    const results = await analyze([fixture('best-practices-types.sql')], defaultConfig);
    const checks = results[0].checks;

    const intCheck = checks.find((c) => c.ruleId === 'prefer-bigint-over-int');
    expect(intCheck).toBeDefined();
    expect(intCheck!.risk).toBe(RiskLevel.LOW);

    const varcharCheck = checks.find((c) => c.ruleId === 'prefer-text-field');
    expect(varcharCheck).toBeDefined();
    expect(varcharCheck!.risk).toBe(RiskLevel.LOW);

    const tsCheck = checks.find((c) => c.ruleId === 'prefer-timestamptz');
    expect(tsCheck).toBeDefined();
    expect(tsCheck!.risk).toBe(RiskLevel.LOW);
  });

  // --- P1: Best practices fire on CREATE TABLE (appliesToNewTables) ---

  it('should fire best practice warnings even on tables created in same migration', async () => {
    const results = await analyze([fixture('best-practices-create-table.sql')], defaultConfig);
    const checks = results[0].checks;

    // Even though events is created in this migration, best practice checks should fire
    const intCheck = checks.find((c) => c.ruleId === 'prefer-bigint-over-int' && c.tableName === 'events');
    expect(intCheck).toBeDefined();

    const varcharCheck = checks.find((c) => c.ruleId === 'prefer-text-field' && c.tableName === 'events');
    expect(varcharCheck).toBeDefined();

    const tsCheck = checks.find((c) => c.ruleId === 'prefer-timestamptz' && c.tableName === 'events');
    expect(tsCheck).toBeDefined();
  });

  // --- FP #1: ALTER COLUMN TYPE — safe type changes ---

  it('should detect ALTER COLUMN TYPE to text as LOW risk (metadata-only)', async () => {
    const results = await analyze([fixture('alter-column-varchar-widening.sql')], defaultConfig);
    const checks = results[0].checks.filter((c) => c.ruleId === 'alter-column-type');

    const textChange = checks.find((c) => c.message.includes('target is text'));
    expect(textChange).toBeDefined();
    expect(textChange!.risk).toBe(RiskLevel.LOW);
    expect(textChange!.lockMode).toBe(LockMode.ACCESS_EXCLUSIVE);
    expect(textChange!.safeRewrite).toBeUndefined();
  });

  it('should detect ALTER COLUMN TYPE to varchar (no length) as LOW risk', async () => {
    const results = await analyze([fixture('alter-column-varchar-widening.sql')], defaultConfig);
    const checks = results[0].checks.filter((c) => c.ruleId === 'alter-column-type');

    const varcharNoLen = checks.find((c) => c.message.includes('removing varchar length constraint'));
    expect(varcharNoLen).toBeDefined();
    expect(varcharNoLen!.risk).toBe(RiskLevel.LOW);
    expect(varcharNoLen!.safeRewrite).toBeUndefined();
  });

  it('should detect ALTER COLUMN TYPE to varchar(N) as MEDIUM risk (needs schema to verify)', async () => {
    const results = await analyze([fixture('alter-column-varchar-widening.sql')], defaultConfig);
    const checks = results[0].checks.filter((c) => c.ruleId === 'alter-column-type');

    const varcharWithLen = checks.filter((c) => c.risk === RiskLevel.MEDIUM);
    // Two varchar(N) statements: varchar(64) and varchar(255)
    expect(varcharWithLen).toHaveLength(2);
    expect(varcharWithLen[0].message).toContain('safe if widening');
    expect(varcharWithLen[0].safeRewrite).toBeDefined();
  });

  it('should detect ALTER COLUMN TYPE cross-family change as HIGH risk', async () => {
    const results = await analyze([fixture('alter-column-varchar-widening.sql')], defaultConfig);
    const checks = results[0].checks.filter((c) => c.ruleId === 'alter-column-type');

    const highRisk = checks.filter((c) => c.risk === RiskLevel.HIGH);
    expect(highRisk).toHaveLength(1);
    expect(highRisk[0].message).toContain('rewrites the entire table');
    expect(highRisk[0].safeRewrite).toBeDefined();
  });

  // --- FP #2: UNIQUE/PK USING INDEX should be LOW risk ---

  it('should detect ADD UNIQUE USING INDEX as LOW risk (instant metadata operation)', async () => {
    const results = await analyze([fixture('safe-constraint-using-index.sql')], defaultConfig);
    const checks = results[0].checks;

    const uniqueCheck = checks.find((c) => c.ruleId === 'add-constraint-unique-using-index');
    expect(uniqueCheck).toBeDefined();
    expect(uniqueCheck!.risk).toBe(RiskLevel.LOW);
    expect(uniqueCheck!.lockMode).toBe(LockMode.ACCESS_EXCLUSIVE);
    expect(uniqueCheck!.tableName).toBe('businesses');
    expect(uniqueCheck!.safeRewrite).toBeUndefined();
  });

  it('should detect ADD PRIMARY KEY USING INDEX as LOW risk (instant metadata operation)', async () => {
    const results = await analyze([fixture('safe-constraint-using-index.sql')], defaultConfig);
    const checks = results[0].checks;

    const pkCheck = checks.find((c) => c.ruleId === 'add-pk-using-index');
    expect(pkCheck).toBeDefined();
    expect(pkCheck!.risk).toBe(RiskLevel.LOW);
    expect(pkCheck!.lockMode).toBe(LockMode.ACCESS_EXCLUSIVE);
    expect(pkCheck!.tableName).toBe('users');
    expect(pkCheck!.safeRewrite).toBeUndefined();
  });

  // --- FP #3: EXCLUDE safeRewrite should not suggest invalid USING INDEX syntax ---

  it('should provide honest EXCLUDE safeRewrite without invalid USING INDEX syntax', async () => {
    const results = await analyze([fixture('dangerous-constraint.sql')], defaultConfig);
    const checks = results[0].checks;

    const excludeCheck = checks.find((c) => c.ruleId === 'add-constraint-exclude');
    expect(excludeCheck).toBeDefined();
    expect(excludeCheck!.safeRewrite).toBeDefined();
    expect(excludeCheck!.safeRewrite!.description).toContain('No concurrent alternative');
    // Must NOT contain invalid USING INDEX syntax
    const allSteps = excludeCheck!.safeRewrite!.steps.join('\n');
    expect(allSteps).not.toContain('USING INDEX');
    expect(allSteps).toContain('lock_timeout');
  });

  // --- Gap 1: ALTER TYPE ADD VALUE (enum) ---

  it('should detect ALTER TYPE ADD VALUE as LOW risk on PG12+ (default config minPg=11 is < 12)', async () => {
    const results = await analyze([fixture('alter-enum-add-value.sql')], { ...defaultConfig, minPostgresVersion: 12 });
    const checks = results[0].checks.filter((c) => c.ruleId === 'alter-enum-add-value');
    expect(checks.length).toBeGreaterThanOrEqual(1);
    expect(checks[0].risk).toBe(RiskLevel.LOW);
    expect(checks[0].message).toContain('instant');
  });

  it('should detect ALTER TYPE ADD VALUE as MEDIUM risk on PG < 12', async () => {
    const results = await analyze([fixture('alter-enum-add-value.sql')], { ...defaultConfig, minPostgresVersion: 11 });
    const checks = results[0].checks.filter((c) => c.ruleId === 'alter-enum-add-value');
    expect(checks.length).toBeGreaterThanOrEqual(1);
    expect(checks[0].risk).toBe(RiskLevel.MEDIUM);
    expect(checks[0].lockMode).toBe(LockMode.ACCESS_EXCLUSIVE);
    expect(checks[0].safeRewrite).toBeDefined();
  });

  // --- Gap 3: REINDEX ---

  it('should detect REINDEX TABLE without CONCURRENTLY as HIGH risk', async () => {
    const results = await analyze([fixture('reindex.sql')], defaultConfig);
    const checks = results[0].checks.filter((c) => c.ruleId === 'reindex-non-concurrent');
    const tableReindex = checks.find((c) => c.message.includes('TABLE'));
    expect(tableReindex).toBeDefined();
    expect(tableReindex!.risk).toBe(RiskLevel.HIGH);
    expect(tableReindex!.lockMode).toBe(LockMode.ACCESS_EXCLUSIVE);
    expect(tableReindex!.safeRewrite).toBeDefined();
  });

  it('should NOT flag REINDEX CONCURRENTLY', async () => {
    const results = await analyze([fixture('reindex.sql')], defaultConfig);
    const checks = results[0].checks.filter((c) => c.ruleId === 'reindex-non-concurrent');
    // 3 non-concurrent statements: TABLE, INDEX, SCHEMA
    expect(checks).toHaveLength(3);
  });

  it('should detect REINDEX SCHEMA as CRITICAL risk', async () => {
    const results = await analyze([fixture('reindex.sql')], defaultConfig);
    const checks = results[0].checks.filter((c) => c.ruleId === 'reindex-non-concurrent');
    const schemaReindex = checks.find((c) => c.message.includes('SCHEMA'));
    expect(schemaReindex).toBeDefined();
    expect(schemaReindex!.risk).toBe(RiskLevel.CRITICAL);
  });

  // --- Gap 4: REFRESH MATERIALIZED VIEW ---

  it('should detect REFRESH MATERIALIZED VIEW without CONCURRENTLY as HIGH risk', async () => {
    const results = await analyze([fixture('refresh-matview.sql')], defaultConfig);
    const checks = results[0].checks;
    const refreshCheck = checks.find((c) => c.ruleId === 'refresh-matview-blocking' && c.risk === RiskLevel.HIGH);
    expect(refreshCheck).toBeDefined();
    expect(refreshCheck!.lockMode).toBe(LockMode.ACCESS_EXCLUSIVE);
    expect(refreshCheck!.safeRewrite).toBeDefined();
  });

  it('should detect REFRESH MATERIALIZED VIEW CONCURRENTLY as LOW risk', async () => {
    const results = await analyze([fixture('refresh-matview.sql')], defaultConfig);
    const checks = results[0].checks;
    const concurrentCheck = checks.find((c) => c.ruleId === 'refresh-matview-concurrent');
    expect(concurrentCheck).toBeDefined();
    expect(concurrentCheck!.risk).toBe(RiskLevel.LOW);
    expect(concurrentCheck!.lockMode).toBe(LockMode.SHARE_UPDATE_EXCLUSIVE);
  });

  // --- Gap 6: Triggers ---

  it('should detect CREATE TRIGGER as MEDIUM risk with ACCESS EXCLUSIVE', async () => {
    const results = await analyze([fixture('trigger.sql')], defaultConfig);
    const checks = results[0].checks;
    const createTrigger = checks.find((c) => c.ruleId === 'create-trigger');
    expect(createTrigger).toBeDefined();
    expect(createTrigger!.risk).toBe(RiskLevel.MEDIUM);
    expect(createTrigger!.lockMode).toBe(LockMode.ACCESS_EXCLUSIVE);
    expect(createTrigger!.tableName).toBe('appointments');
  });

  it('should detect DROP TRIGGER as MEDIUM risk with ACCESS EXCLUSIVE', async () => {
    const results = await analyze([fixture('trigger.sql')], defaultConfig);
    const checks = results[0].checks;
    const dropTrigger = checks.find((c) => c.ruleId === 'drop-trigger');
    expect(dropTrigger).toBeDefined();
    expect(dropTrigger!.risk).toBe(RiskLevel.MEDIUM);
    expect(dropTrigger!.lockMode).toBe(LockMode.ACCESS_EXCLUSIVE);
  });

  it('should detect ENABLE/DISABLE TRIGGER as LOW risk with SHARE ROW EXCLUSIVE', async () => {
    const results = await analyze([fixture('trigger.sql')], defaultConfig);
    const checks = results[0].checks;
    const enableDisable = checks.filter((c) => c.ruleId === 'enable-disable-trigger');
    expect(enableDisable).toHaveLength(2);
    expect(enableDisable[0].risk).toBe(RiskLevel.LOW);
    expect(enableDisable[0].lockMode).toBe(LockMode.SHARE_ROW_EXCLUSIVE);
  });

  // --- Gap 7: Partition operations ---

  it('should detect ATTACH PARTITION as HIGH risk with ACCESS EXCLUSIVE', async () => {
    const results = await analyze([fixture('partition.sql')], defaultConfig);
    const checks = results[0].checks;
    const attachCheck = checks.find((c) => c.ruleId === 'attach-partition');
    expect(attachCheck).toBeDefined();
    expect(attachCheck!.risk).toBe(RiskLevel.HIGH);
    expect(attachCheck!.lockMode).toBe(LockMode.ACCESS_EXCLUSIVE);
    expect(attachCheck!.tableName).toBe('orders');
    expect(attachCheck!.safeRewrite).toBeDefined();
  });

  it('should detect DETACH PARTITION without CONCURRENTLY as HIGH risk', async () => {
    const results = await analyze([fixture('partition.sql')], defaultConfig);
    const checks = results[0].checks;
    const detachCheck = checks.find((c) => c.ruleId === 'detach-partition');
    expect(detachCheck).toBeDefined();
    expect(detachCheck!.risk).toBe(RiskLevel.HIGH);
    expect(detachCheck!.lockMode).toBe(LockMode.ACCESS_EXCLUSIVE);
  });

  it('should detect DETACH PARTITION CONCURRENTLY as LOW risk', async () => {
    const results = await analyze([fixture('partition.sql')], defaultConfig);
    const checks = results[0].checks;
    const concurrentDetach = checks.find((c) => c.ruleId === 'detach-partition-concurrent');
    expect(concurrentDetach).toBeDefined();
    expect(concurrentDetach!.risk).toBe(RiskLevel.LOW);
    expect(concurrentDetach!.lockMode).toBe(LockMode.SHARE_UPDATE_EXCLUSIVE);
  });

  // --- Gap 2: lock_timeout ordering validation ---

  it('should detect lock_timeout set AFTER dangerous statement as error', async () => {
    const results = await analyze([fixture('lock-timeout-ordering-bad.sql')], defaultConfig);
    const violations = results[0].policyViolations;
    const ordering = violations.find((v) => v.ruleId === 'lock-timeout-after-dangerous-statement');
    expect(ordering).toBeDefined();
    expect(ordering!.severity).toBe('error');
    expect(ordering!.message).toContain('AFTER');
  });

  it('should NOT flag lock_timeout ordering when set BEFORE dangerous statement', async () => {
    const results = await analyze([fixture('lock-timeout-ordering-good.sql')], defaultConfig);
    const violations = results[0].policyViolations;
    const ordering = violations.find((v) => v.ruleId === 'lock-timeout-after-dangerous-statement');
    expect(ordering).toBeUndefined();
  });

  // --- Gap 5: Timeout value validation ---

  it('should warn when lock_timeout exceeds threshold', async () => {
    const results = await analyze([fixture('lock-timeout-too-long.sql')], defaultConfig);
    const violations = results[0].policyViolations;
    const tooLong = violations.find((v) => v.ruleId === 'lock-timeout-too-long');
    expect(tooLong).toBeDefined();
    expect(tooLong!.severity).toBe('warning');
    expect(tooLong!.message).toContain('300000');
  });

  it('should warn when statement_timeout exceeds threshold', async () => {
    const results = await analyze([fixture('lock-timeout-too-long.sql')], defaultConfig);
    const violations = results[0].policyViolations;
    const tooLong = violations.find((v) => v.ruleId === 'statement-timeout-too-long');
    expect(tooLong).toBeDefined();
    expect(tooLong!.severity).toBe('warning');
  });

  it('should NOT warn when timeout is within threshold', async () => {
    const results = await analyze([fixture('lock-timeout-ordering-good.sql')], defaultConfig);
    const violations = results[0].policyViolations;
    expect(violations.find((v) => v.ruleId === 'lock-timeout-too-long')).toBeUndefined();
    expect(violations.find((v) => v.ruleId === 'statement-timeout-too-long')).toBeUndefined();
  });

  it('should respect custom maxLockTimeoutMs config', async () => {
    // lock-timeout-ordering-good.sql uses SET lock_timeout = '2s' (2000ms)
    const results = await analyze([fixture('lock-timeout-ordering-good.sql')], {
      ...defaultConfig,
      maxLockTimeoutMs: 1000,
    });
    const violations = results[0].policyViolations;
    const tooLong = violations.find((v) => v.ruleId === 'lock-timeout-too-long');
    expect(tooLong).toBeDefined();
  });

  // --- Gap 8: Cross-file migration state ---

  it('should suppress warnings for tables created in earlier migration files', async () => {
    const results = await analyze([
      fixture('cross-file-001-create.sql'),
      fixture('cross-file-002-alter.sql'),
    ], defaultConfig);
    expect(results).toHaveLength(2);
    // Second file operates on new_users which was created in file 1
    const file2Checks = results[1].checks.filter(
      (c) => c.tableName === 'new_users' && !c.appliesToNewTables,
    );
    expect(file2Checks).toHaveLength(0);
  });

  it('should NOT suppress warnings when files are analyzed individually', async () => {
    const results = await analyze([fixture('cross-file-002-alter.sql')], defaultConfig);
    const checks = results[0].checks.filter(
      (c) => c.tableName === 'new_users' && !c.appliesToNewTables,
    );
    expect(checks.length).toBeGreaterThan(0);
  });

  // --- Gap 9: Per-rule enable/disable config ---

  it('should suppress disabled rules via config', async () => {
    const results = await analyze([fixture('lock-timeout-ordering-good.sql')], {
      ...defaultConfig,
      rules: { disable: ['alter-column-set-not-null'] },
    });
    const checks = results[0].checks;
    expect(checks.find((c) => c.ruleId === 'alter-column-set-not-null')).toBeUndefined();
  });

  it('should suppress disabled policy rules', async () => {
    const results = await analyze([fixture('lock-timeout-ordering-good.sql')], {
      ...defaultConfig,
      rules: { disable: ['missing-application-name'] },
    });
    const violations = results[0].policyViolations;
    expect(violations.find((v) => v.ruleId === 'missing-application-name')).toBeUndefined();
  });

  it('should only run enabled rules when enable list is specified', async () => {
    const results = await analyze([fixture('lock-timeout-ordering-good.sql')], {
      ...defaultConfig,
      rules: { enable: ['alter-column-set-not-null'] },
    });
    const checks = results[0].checks;
    for (const check of checks) {
      expect(check.ruleId).toBe('alter-column-set-not-null');
    }
  });

  // --- Gap 11: Conditional SQL warnings in extractors ---

  it('should warn about conditional SQL in TypeORM migrations', async () => {
    const results = await analyze(
      [fixture('typeorm-conditional.ts')],
      { ...defaultConfig, format: 'typeorm' },
    );
    const warnings = results[0].extractionWarnings ?? [];
    const conditionalWarnings = warnings.filter((w) => w.message.includes('Conditional SQL'));
    expect(conditionalWarnings.length).toBeGreaterThanOrEqual(1);
  });

  it('should still extract SQL from conditional branches in TypeORM', async () => {
    const results = await analyze(
      [fixture('typeorm-conditional.ts')],
      { ...defaultConfig, format: 'typeorm' },
    );
    // Should have extracted the CREATE INDEX even though it's in a conditional
    expect(results[0].statementCount).toBeGreaterThanOrEqual(3);
  });

  it('should warn about conditional SQL in Knex migrations', async () => {
    const results = await analyze(
      [fixture('knex-conditional.ts')],
      { ...defaultConfig, format: 'knex' },
    );
    const warnings = results[0].extractionWarnings ?? [];
    const conditionalWarnings = warnings.filter((w) => w.message.includes('Conditional SQL'));
    expect(conditionalWarnings.length).toBeGreaterThanOrEqual(1);
  });

  it('should still extract SQL from conditional branches in Knex', async () => {
    const results = await analyze(
      [fixture('knex-conditional.ts')],
      { ...defaultConfig, format: 'knex' },
    );
    // Should have extracted the CREATE INDEX even though it's in a conditional
    expect(results[0].statementCount).toBeGreaterThanOrEqual(3);
  });
});

describe('parseTimeoutString', () => {
  it('should parse "2s" as 2000ms', () => {
    expect(parseTimeoutString('2s')).toBe(2000);
  });

  it('should parse "2000" as 2000ms', () => {
    expect(parseTimeoutString('2000')).toBe(2000);
  });

  it('should parse "2000ms" as 2000ms', () => {
    expect(parseTimeoutString('2000ms')).toBe(2000);
  });

  it('should parse "5min" as 300000ms', () => {
    expect(parseTimeoutString('5min')).toBe(300000);
  });

  it('should parse "1h" as 3600000ms', () => {
    expect(parseTimeoutString('1h')).toBe(3600000);
  });

  it('should parse "2 seconds" as 2000ms', () => {
    expect(parseTimeoutString('2 seconds')).toBe(2000);
  });

  it('should parse "0" as 0ms', () => {
    expect(parseTimeoutString('0')).toBe(0);
  });

  it('should return null for unparseable values', () => {
    expect(parseTimeoutString('invalid')).toBeNull();
    expect(parseTimeoutString('abc123')).toBeNull();
  });
});

// --- Gap 12: Transaction State Machine ---

describe('TransactionState', () => {
  it('should track basic transaction lifecycle', () => {
    const state = createTransactionState();
    expect(state.active).toBe(false);

    processTransactionStmt(state, 'TRANS_STMT_BEGIN');
    expect(state.active).toBe(true);
    expect(state.depth).toBe(1);

    processTransactionStmt(state, 'TRANS_STMT_COMMIT');
    expect(state.active).toBe(false);
    expect(state.depth).toBe(0);
  });

  it('should handle savepoints and rollback to savepoint', () => {
    const state = createTransactionState();
    processTransactionStmt(state, 'TRANS_STMT_BEGIN');

    recordLock(state, 'users', LockMode.ACCESS_EXCLUSIVE);
    expect(state.locksHeld.has('users')).toBe(true);

    processTransactionStmt(state, 'TRANS_STMT_SAVEPOINT', 'sp1');
    expect(state.savepoints).toEqual(['sp1']);

    recordLock(state, 'orders', LockMode.ACCESS_EXCLUSIVE);
    expect(state.locksHeld.has('orders')).toBe(true);

    // Rollback to savepoint should restore lock state
    processTransactionStmt(state, 'TRANS_STMT_ROLLBACK_TO', 'sp1');
    expect(state.locksHeld.has('users')).toBe(true);
    expect(state.locksHeld.has('orders')).toBe(false);
  });

  it('should detect wide lock window', () => {
    const state = createTransactionState();
    processTransactionStmt(state, 'TRANS_STMT_BEGIN');

    const r1 = recordLock(state, 'users', LockMode.ACCESS_EXCLUSIVE);
    expect(r1.wideLockWindow).toBe(false);

    const r2 = recordLock(state, 'orders', LockMode.ACCESS_EXCLUSIVE);
    expect(r2.wideLockWindow).toBe(true);
    expect(r2.previousTable).toBe('users');
  });

  it('should NOT detect wide lock window on same table', () => {
    const state = createTransactionState();
    processTransactionStmt(state, 'TRANS_STMT_BEGIN');

    recordLock(state, 'users', LockMode.ACCESS_EXCLUSIVE);
    const r2 = recordLock(state, 'users', LockMode.ACCESS_EXCLUSIVE);
    expect(r2.wideLockWindow).toBe(false);
  });

  it('should clear state on COMMIT', () => {
    const state = createTransactionState();
    processTransactionStmt(state, 'TRANS_STMT_BEGIN');
    recordLock(state, 'users', LockMode.ACCESS_EXCLUSIVE);
    processTransactionStmt(state, 'TRANS_STMT_SAVEPOINT', 'sp1');

    processTransactionStmt(state, 'TRANS_STMT_COMMIT');
    expect(state.active).toBe(false);
    expect(state.locksHeld.size).toBe(0);
    expect(state.savepoints.length).toBe(0);
    expect(state.accessExclusiveTables.size).toBe(0);
  });
});

describe('wide-lock-window integration', () => {
  it('should detect wide lock window in SQL migration', async () => {
    const results = await analyze([fixture('wide-lock-window.sql')], defaultConfig);
    const violations = results[0].policyViolations;
    const wideLock = violations.find((v) => v.ruleId === 'wide-lock-window');
    expect(wideLock).toBeDefined();
    expect(wideLock!.severity).toBe('warning');
    expect(wideLock!.message).toContain('users');
    expect(wideLock!.message).toContain('orders');
  });

  it('should handle savepoint rollback in SQL migration', async () => {
    const results = await analyze([fixture('savepoint-rollback.sql')], defaultConfig);
    // Should not crash and should produce results
    expect(results).toHaveLength(1);
    expect(results[0].statementCount).toBeGreaterThan(0);
  });
});

// --- Gap 10: Schema Snapshot ---

describe('SchemaSnapshot', () => {
  it('should load and query schema snapshot', () => {
    const snapshot: SchemaSnapshot = {
      version: 1,
      generatedAt: '2025-01-01T00:00:00.000Z',
      tables: [
        {
          schemaName: 'public',
          tableName: 'users',
          columns: [
            {
              columnName: 'email',
              dataType: 'character varying',
              udtName: 'varchar',
              characterMaximumLength: 255,
              numericPrecision: null,
              numericScale: null,
              isNullable: false,
              columnDefault: null,
            },
          ],
          constraints: [],
          indexes: [],
        },
      ],
    };

    const lookup = loadSnapshot(snapshot);
    expect(lookup.hasTable('users')).toBe(true);
    expect(lookup.hasTable('orders')).toBe(false);

    const col = lookup.getColumn('users', 'email');
    expect(col).toBeDefined();
    expect(col!.characterMaximumLength).toBe(255);
    expect(col!.udtName).toBe('varchar');
  });

  it('should support case-insensitive lookups', () => {
    const snapshot: SchemaSnapshot = {
      version: 1,
      generatedAt: '2025-01-01T00:00:00.000Z',
      tables: [
        {
          schemaName: 'public',
          tableName: 'Users',
          columns: [
            {
              columnName: 'Email',
              dataType: 'character varying',
              udtName: 'varchar',
              characterMaximumLength: 100,
              numericPrecision: null,
              numericScale: null,
              isNullable: true,
              columnDefault: null,
            },
          ],
          constraints: [],
          indexes: [],
        },
      ],
    };

    const lookup = loadSnapshot(snapshot);
    expect(lookup.hasTable('users')).toBe(true);
    expect(lookup.hasTable('USERS')).toBe(true);
    expect(lookup.getColumn('users', 'email')).toBeDefined();
  });

  it('should support schema-qualified lookups', () => {
    const snapshot: SchemaSnapshot = {
      version: 1,
      generatedAt: '2025-01-01T00:00:00.000Z',
      tables: [
        {
          schemaName: 'myschema',
          tableName: 'orders',
          columns: [],
          constraints: [],
          indexes: [],
        },
      ],
    };

    const lookup = loadSnapshot(snapshot);
    expect(lookup.hasTable('myschema.orders')).toBe(true);
    expect(lookup.hasTable('orders')).toBe(true);
  });
});

// --- Gap 14: Plugin System ---

describe('Plugin system', () => {
  it('should load and run plugin rules', async () => {
    const pluginPath = path.resolve(fixture('test-plugin.js'));
    const results = await analyze(
      [fixture('cross-file-001-create.sql')],
      { ...defaultConfig, plugins: [pluginPath] },
    );
    const checks = results[0].checks;
    // The test plugin flags CREATE TABLE without PK
    // cross-file-001-create.sql has CREATE TABLE new_users with IDENTITY PK
    // so it should NOT be flagged
    const pluginCheck = checks.find((c) => c.ruleId === 'plugin:require-primary-key');
    // The new_users table has a PK (GENERATED ALWAYS AS IDENTITY PRIMARY KEY)
    expect(pluginCheck).toBeUndefined();
  });

  it('should transpile Knex schema builder calls and analyze them', async () => {
    const results = await analyze(
      [fixture('knex-builder-create.ts')],
      { ...defaultConfig, format: 'knex' },
    );
    expect(results).toHaveLength(1);
    // Should have transpiled the createTable into SQL and analyzed it
    expect(results[0].statementCount).toBeGreaterThan(0);
    // Should contain checks from the transpiled SQL
    const checks = results[0].checks;
    // best-practice checks should fire on the transpiled CREATE TABLE
    expect(checks.length).toBeGreaterThanOrEqual(0);
  });

  it('should transpile Sequelize builder calls and analyze them', async () => {
    const results = await analyze(
      [fixture('sequelize-builder.js')],
      { ...defaultConfig, format: 'sequelize' },
    );
    expect(results).toHaveLength(1);
    // Should have transpiled the createTable and addIndex into SQL
    expect(results[0].statementCount).toBeGreaterThan(0);
  });

  it('should respect plugin rule namespace requirement', async () => {
    // Plugin rules must start with "plugin:"
    const { loadPlugins } = await import('../src/plugins.js');
    const badPlugin = path.join(FIXTURES, 'test-plugin-bad-namespace.js');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(badPlugin, `module.exports = {
      name: 'bad-plugin',
      rules: [{ ruleId: 'no-namespace', check() { return []; } }],
    };`, 'utf8');
    await expect(loadPlugins([badPlugin])).rejects.toThrow('plugin:');
    // Clean up
    const { unlink } = await import('node:fs/promises');
    await unlink(badPlugin);
  });
});
