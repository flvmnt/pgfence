import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { analyze, adjustRisk, detectFormat } from '../src/analyzer.js';
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

  it('should detect ALTER COLUMN TYPE as HIGH risk', async () => {
    const results = await analyze([fixture('dangerous-alter-column.sql')], defaultConfig);
    expect(results).toHaveLength(1);
    const checks = results[0].checks;

    const typeCheck = checks.find((c) => c.ruleId === 'alter-column-type');
    expect(typeCheck).toBeDefined();
    expect(typeCheck!.risk).toBe(RiskLevel.HIGH);
    expect(typeCheck!.lockMode).toBe(LockMode.ACCESS_EXCLUSIVE);
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

  // --- P0: Inline ignore ---

  it('should respect -- pgfence: ignore inline directives', async () => {
    const results = await analyze([fixture('inline-ignore.sql')], defaultConfig);
    const checks = results[0].checks;

    // DROP TABLE should be suppressed
    const dropCheck = checks.find((c) => c.ruleId === 'drop-table');
    expect(dropCheck).toBeUndefined();

    // CREATE INDEX should still be flagged
    const indexCheck = checks.find((c) => c.ruleId === 'create-index-not-concurrent');
    expect(indexCheck).toBeDefined();
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
});
