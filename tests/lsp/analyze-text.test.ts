import { describe, it, expect } from 'vitest';
import { analyzeText } from '../../src/lsp/analyze-text.js';
import { RiskLevel, LockMode } from '../../src/types.js';
import type { PgfenceConfig } from '../../src/types.js';

const defaultConfig: PgfenceConfig = {
  format: 'auto',
  output: 'cli',
  minPostgresVersion: 14,
  maxAllowedRisk: RiskLevel.HIGH,
  requireLockTimeout: true,
  requireStatementTimeout: true,
};

describe('analyzeText', () => {
  it('should analyze raw SQL and return checks with source offsets', async () => {
    const sql = 'ALTER TABLE users ADD COLUMN name text NOT NULL;';
    const result = await analyzeText({
      content: sql,
      filePath: 'migrations/001.sql',
      config: defaultConfig,
    });
    expect(result.checks.length).toBeGreaterThan(0);
    const check = result.checks.find(c => c.ruleId === 'add-column-not-null-no-default');
    expect(check).toBeDefined();
    expect(check!.risk).toBe(RiskLevel.HIGH);
    expect(check!.lockMode).toBe(LockMode.ACCESS_EXCLUSIVE);
    expect(result.sourceRanges.length).toBe(result.checks.length);
    expect(result.sourceRanges[0].startOffset).toBe(0);
    expect(result.sourceRanges[0].endOffset).toBeGreaterThan(0);
  });

  it('should handle parse errors gracefully', async () => {
    const result = await analyzeText({
      content: 'ALTER TABLE users INVALID SYNTAX;',
      filePath: 'migrations/001.sql',
      config: defaultConfig,
    });
    expect(result.checks).toHaveLength(0);
    expect(result.parseError).toBeDefined();
    expect(result.extractionWarnings.some((warning) => warning.unanalyzable)).toBe(true);
  });

  it('should return empty results for empty content', async () => {
    const result = await analyzeText({
      content: '',
      filePath: 'migrations/001.sql',
      config: defaultConfig,
    });
    expect(result.checks).toHaveLength(0);
    expect(result.policyViolations).toHaveLength(0);
    expect(result.statementCount).toBe(0);
  });

  it('should return empty results for whitespace-only content', async () => {
    const result = await analyzeText({
      content: '   \n  \n  ',
      filePath: 'migrations/001.sql',
      config: defaultConfig,
    });
    expect(result.checks).toHaveLength(0);
    expect(result.statementCount).toBe(0);
  });

  it('should detect CREATE INDEX without CONCURRENTLY', async () => {
    const result = await analyzeText({
      content: 'CREATE INDEX idx ON users (email);',
      filePath: 'migrations/001.sql',
      config: defaultConfig,
    });
    const check = result.checks.find(c => c.ruleId === 'create-index-not-concurrent');
    expect(check).toBeDefined();
    expect(check!.risk).toBe(RiskLevel.MEDIUM);
    expect(check!.lockMode).toBe(LockMode.SHARE);
  });

  it('should include policy violations', async () => {
    const result = await analyzeText({
      content: 'ALTER TABLE users ADD COLUMN x int;',
      filePath: 'migrations/001.sql',
      config: { ...defaultConfig, requireLockTimeout: true },
    });
    const lockPolicy = result.policyViolations.find(v => v.ruleId === 'missing-lock-timeout');
    expect(lockPolicy).toBeDefined();
  });

  it('should suppress checks for newly-created tables', async () => {
    const sql = `CREATE TABLE fresh (id serial PRIMARY KEY);
ALTER TABLE fresh ADD COLUMN name text NOT NULL;`;
    const result = await analyzeText({
      content: sql,
      filePath: 'migrations/001.sql',
      config: defaultConfig,
    });
    // ADD COLUMN NOT NULL on fresh table should be suppressed
    const check = result.checks.find(c => c.ruleId === 'add-column-not-null-no-default');
    expect(check).toBeUndefined();
  });

  it('should stop suppressing after DML on a newly-created table', async () => {
    const sql = `CREATE TABLE fresh (id serial PRIMARY KEY);
INSERT INTO fresh (id) VALUES (1);
ALTER TABLE fresh ADD COLUMN name text NOT NULL;`;
    const result = await analyzeText({
      content: sql,
      filePath: 'migrations/001.sql',
      config: defaultConfig,
    });

    const check = result.checks.find(c => c.ruleId === 'add-column-not-null-no-default');
    expect(check).toBeDefined();
  });

  it('should respect inline pgfence-ignore directives', async () => {
    const sql = `-- pgfence-ignore: create-index-not-concurrent
CREATE INDEX idx ON users (email);`;
    const result = await analyzeText({
      content: sql,
      filePath: 'migrations/001.sql',
      config: defaultConfig,
    });
    const check = result.checks.find(c => c.ruleId === 'create-index-not-concurrent');
    expect(check).toBeUndefined();
  });

  it('should respect rules.disable config', async () => {
    const result = await analyzeText({
      content: 'CREATE INDEX idx ON users (email);',
      filePath: 'migrations/001.sql',
      config: { ...defaultConfig, rules: { disable: ['create-index-not-concurrent'] } },
    });
    const check = result.checks.find(c => c.ruleId === 'create-index-not-concurrent');
    expect(check).toBeUndefined();
  });

  it('should track correct source ranges for multi-statement SQL', async () => {
    const sql = `ALTER TABLE a ADD COLUMN x int NOT NULL;
CREATE INDEX idx ON b (col);`;
    const result = await analyzeText({
      content: sql,
      filePath: 'migrations/001.sql',
      config: defaultConfig,
    });
    expect(result.checks.length).toBeGreaterThanOrEqual(2);
    // First check should start at offset 0
    expect(result.sourceRanges[0].startOffset).toBe(0);
    // Second check should start after the first statement
    const secondStart = result.sourceRanges[result.sourceRanges.length - 1].startOffset;
    expect(secondStart).toBeGreaterThan(0);
  });

  it('should adjust risk with table stats', async () => {
    const result = await analyzeText({
      content: 'ALTER TABLE big_table ADD COLUMN x int NOT NULL;',
      filePath: 'migrations/001.sql',
      config: defaultConfig,
      tableStats: [{ schemaName: 'public', tableName: 'big_table', rowCount: 50_000_000, totalBytes: 1e10 }],
    });
    const check = result.checks.find(c => c.ruleId === 'add-column-not-null-no-default');
    expect(check).toBeDefined();
    expect(check!.adjustedRisk).toBe(RiskLevel.CRITICAL);
  });

  it('should compute maxRisk correctly', async () => {
    const result = await analyzeText({
      content: 'DROP TABLE users;',
      filePath: 'migrations/001.sql',
      config: defaultConfig,
    });
    expect(result.maxRisk).toBe(RiskLevel.CRITICAL);
  });

  it('should detect safe SQL with no issues', async () => {
    const sql = `SET lock_timeout = '2s';
SET statement_timeout = '30s';
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx ON users (email);`;
    const result = await analyzeText({
      content: sql,
      filePath: 'migrations/001.sql',
      config: defaultConfig,
    });
    // No dangerous checks
    const dangerous = result.checks.filter(c => c.risk !== RiskLevel.SAFE && c.risk !== RiskLevel.LOW);
    expect(dangerous).toHaveLength(0);
  });

  it('should detect DROP TABLE as CRITICAL', async () => {
    const result = await analyzeText({
      content: 'DROP TABLE users;',
      filePath: 'migrations/001.sql',
      config: defaultConfig,
    });
    const check = result.checks.find(c => c.ruleId === 'drop-table');
    expect(check).toBeDefined();
    expect(check!.risk).toBe(RiskLevel.CRITICAL);
  });

  it('should auto-detect format as sql for .sql files', async () => {
    const result = await analyzeText({
      content: 'CREATE INDEX idx ON users (email);',
      filePath: 'migrations/001.sql',
      config: { ...defaultConfig, format: 'auto' },
    });
    expect(result.checks.length).toBeGreaterThan(0);
  });

  it('should preserve auto-detect warnings when falling back to raw SQL', async () => {
    const result = await analyzeText({
      content: 'CREATE INDEX idx ON users (email);',
      filePath: 'migrations/001.txt',
      config: { ...defaultConfig, format: 'auto' },
    });

    const warning = result.extractionWarnings.find((w) => w.message.includes('Format auto-detection failed'));
    expect(warning).toBeDefined();
    expect(result.checks.length).toBeGreaterThan(0);
  });

  it('should handle extraction errors gracefully', async () => {
    // Non-SQL, non-ORM file
    const result = await analyzeText({
      content: 'some random text',
      filePath: 'migrations/001.txt',
      config: { ...defaultConfig, format: 'auto' },
    });
    // Should have extraction warning or parse error, not crash
    expect(result.parseError ?? result.extractionWarnings.length > 0).toBeTruthy();
  });

  it('should analyze TypeORM content from the in-memory buffer', async () => {
    const content = `export class AddUserIndex {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE INDEX idx_users_email ON users (email)');
  }
}`;
    const result = await analyzeText({
      content,
      filePath: 'migrations/001-typeorm.ts',
      config: { ...defaultConfig, format: 'typeorm' },
    });

    expect(result.checks.find((c) => c.ruleId === 'create-index-not-concurrent')).toBeDefined();
    expect(result.extractionWarnings).toHaveLength(0);
    const range = result.sourceRanges[0];
    expect(content.slice(range.startOffset, range.endOffset)).toBe('CREATE INDEX idx_users_email ON users (email)');
  });

  it('should analyze Knex content from the in-memory buffer', async () => {
    const result = await analyzeText({
      content: `export async function up(knex) {
  await knex.raw('CREATE INDEX idx_users_email ON users (email)');
}`,
      filePath: 'migrations/002-knex.ts',
      config: { ...defaultConfig, format: 'knex' },
    });

    expect(result.checks.find((c) => c.ruleId === 'create-index-not-concurrent')).toBeDefined();
    expect(result.extractionWarnings).toHaveLength(0);
  });

  it('should respect Knex transaction = false when analyzing in memory', async () => {
    const result = await analyzeText({
      content: `export const config = { transaction: false };
export async function up(knex) {
  await knex.raw('CREATE INDEX CONCURRENTLY idx_users_email ON users (email)');
}`,
      filePath: 'migrations/004-knex.ts',
      config: { ...defaultConfig, format: 'knex' },
    });

    expect(result.policyViolations.find((v) => v.ruleId === 'concurrent-in-transaction')).toBeUndefined();
  });

  it('should analyze Sequelize content from the in-memory buffer', async () => {
    const result = await analyzeText({
      content: `export async function up(queryInterface) {
  await queryInterface.sequelize.query('CREATE INDEX idx_users_email ON users (email)');
}`,
      filePath: 'migrations/003-sequelize.ts',
      config: { ...defaultConfig, format: 'sequelize' },
    });

    expect(result.checks.find((c) => c.ruleId === 'create-index-not-concurrent')).toBeDefined();
    expect(result.extractionWarnings).toHaveLength(0);
  });

  it('should count statements correctly', async () => {
    const sql = `SET lock_timeout = '2s';
ALTER TABLE users ADD COLUMN x int;
CREATE INDEX idx ON users (x);`;
    const result = await analyzeText({
      content: sql,
      filePath: 'migrations/001.sql',
      config: defaultConfig,
    });
    expect(result.statementCount).toBe(3);
  });

  it('should detect multiple policy violations simultaneously', async () => {
    const sql = 'ALTER TABLE users ADD COLUMN x int;';
    const result = await analyzeText({
      content: sql,
      filePath: 'migrations/001.sql',
      config: { ...defaultConfig, requireLockTimeout: true, requireStatementTimeout: true },
    });
    const lockTimeout = result.policyViolations.find(v => v.ruleId === 'missing-lock-timeout');
    const stmtTimeout = result.policyViolations.find(v => v.ruleId === 'missing-statement-timeout');
    expect(lockTimeout).toBeDefined();
    expect(stmtTimeout).toBeDefined();
  });

  it('should not report policy violations when disabled', async () => {
    const sql = 'ALTER TABLE users ADD COLUMN x int;';
    const result = await analyzeText({
      content: sql,
      filePath: 'migrations/001.sql',
      config: { ...defaultConfig, requireLockTimeout: false, requireStatementTimeout: false },
    });
    const lockTimeout = result.policyViolations.find(v => v.ruleId === 'missing-lock-timeout');
    const stmtTimeout = result.policyViolations.find(v => v.ruleId === 'missing-statement-timeout');
    expect(lockTimeout).toBeUndefined();
    expect(stmtTimeout).toBeUndefined();
  });

  it('should disable multiple rules via config', async () => {
    const sql = `ALTER TABLE users ADD COLUMN x int NOT NULL;
CREATE INDEX idx ON users (x);`;
    const result = await analyzeText({
      content: sql,
      filePath: 'migrations/001.sql',
      config: {
        ...defaultConfig,
        rules: { disable: ['add-column-not-null-no-default', 'create-index-not-concurrent'] },
      },
    });
    expect(result.checks.find(c => c.ruleId === 'add-column-not-null-no-default')).toBeUndefined();
    expect(result.checks.find(c => c.ruleId === 'create-index-not-concurrent')).toBeUndefined();
  });

  it('should detect RENAME TABLE as HIGH risk', async () => {
    const result = await analyzeText({
      content: 'ALTER TABLE old_name RENAME TO new_name;',
      filePath: 'migrations/001.sql',
      config: defaultConfig,
    });
    const check = result.checks.find(c => c.ruleId === 'rename-table');
    expect(check).toBeDefined();
    expect(check!.risk).toBe(RiskLevel.HIGH);
    expect(check!.lockMode).toBe(LockMode.ACCESS_EXCLUSIVE);
  });

  it('should detect ADD COLUMN with volatile default', async () => {
    const result = await analyzeText({
      content: 'ALTER TABLE users ADD COLUMN created_at TIMESTAMP NOT NULL DEFAULT now();',
      filePath: 'migrations/001.sql',
      config: defaultConfig,
    });
    const check = result.checks.find(c => c.ruleId === 'add-column-non-constant-default');
    expect(check).toBeDefined();
    expect(check!.risk).toBe(RiskLevel.HIGH);
  });

  it('should detect TRUNCATE as CRITICAL risk', async () => {
    const result = await analyzeText({
      content: 'TRUNCATE orders;',
      filePath: 'migrations/001.sql',
      config: defaultConfig,
    });
    const check = result.checks.find(c => c.ruleId === 'truncate');
    expect(check).toBeDefined();
    expect(check!.risk).toBe(RiskLevel.CRITICAL);
    expect(check!.lockMode).toBe(LockMode.ACCESS_EXCLUSIVE);
  });
});
