import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { analyze } from '../src/analyzer.js';
import { applyFixesToFile } from '../src/fix/index.js';
import type { PgfenceConfig } from '../src/types.js';
import { RiskLevel } from '../src/types.js';

/**
 * Tier 1 round-trip tests: for every ruleId in the Tier 1 allowlist, prove that
 * (a) the original SQL fires the finding, (b) applying the fix rewrites the file
 * in place, (c) re-analyzing the FIXED file no longer fires that ruleId, and
 * (d) no new error-severity / higher-risk finding was introduced.
 */

const baseConfig: PgfenceConfig = {
  format: 'sql',
  output: 'cli',
  minPostgresVersion: 14,
  maxAllowedRisk: RiskLevel.HIGH,
  requireLockTimeout: true,
  requireStatementTimeout: true,
};

// All four policy SET statements pre-populated so only the statement under
// test fires - keeps each round-trip test isolated to one ruleId.
const SAFE_HEADER = [
  "SET lock_timeout = '2s';",
  "SET statement_timeout = '5min';",
  "SET application_name = 'migrate:test';",
  "SET idle_in_transaction_session_timeout = '30s';",
  '',
].join('\n');

const tempDirs: string[] = [];

async function tempSqlFile(sql: string, filename = 'migration.sql'): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'pgfence-fix-tier1-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, filename);
  await writeFile(filePath, sql, 'utf8');
  return filePath;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

function errorViolations(result: { policyViolations: Array<{ severity: string }> }) {
  return result.policyViolations.filter((v) => v.severity === 'error');
}

/** Regression guard: a fix must never leave behind a stray ";;" (double semicolon). */
function expectNoDoubledSemicolons(content: string) {
  expect(content).not.toMatch(/;\s*;/);
}

describe('Tier 1 --fix: create-index-not-concurrent', () => {
  it('round-trips a named CREATE INDEX to CONCURRENTLY and clears the finding', async () => {
    const filePath = await tempSqlFile(`${SAFE_HEADER}CREATE INDEX idx_users_email ON users (email);\n`);

    const before = await analyze([filePath], baseConfig);
    expect(before[0].checks.find((c) => c.ruleId === 'create-index-not-concurrent')).toBeDefined();

    const report = await applyFixesToFile(filePath, before[0], baseConfig, { split: false });
    expect(report.modified).toBe(true);
    const finding = report.tier1.find((f) => f.ruleId === 'create-index-not-concurrent');
    expect(finding?.status).toBe('fixed');

    const newContent = await readFile(filePath, 'utf8');
    expect(newContent).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_email ON users \(email\);/);
    expectNoDoubledSemicolons(newContent);

    const after = await analyze([filePath], baseConfig);
    expect(after[0].checks.find((c) => c.ruleId === 'create-index-not-concurrent')).toBeUndefined();
    expect(errorViolations(after[0])).toHaveLength(0);
    expect([RiskLevel.SAFE, RiskLevel.LOW, RiskLevel.MEDIUM]).toContain(after[0].maxRisk);
  });

  it('fixes a statement that is NOT the last in the file without leaving a stray ";;" behind (regression: ParsedStatement offsets exclude the trailing ";")', async () => {
    const filePath = await tempSqlFile(
      `${SAFE_HEADER}CREATE INDEX idx_orders_status ON orders (status);\nALTER TABLE orders ADD COLUMN region text;\n`,
    );

    const before = await analyze([filePath], baseConfig);
    expect(before[0].checks.find((c) => c.ruleId === 'create-index-not-concurrent')).toBeDefined();

    await applyFixesToFile(filePath, before[0], baseConfig, { split: false });

    const newContent = await readFile(filePath, 'utf8');
    expectNoDoubledSemicolons(newContent);
    // Exact line match: no leftover orphaned ";" and the following statement
    // (which the fix must not touch) is still intact right after it.
    expect(newContent).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_status ON orders (status);\nALTER TABLE orders ADD COLUMN region text;',
    );

    const after = await analyze([filePath], baseConfig);
    expect(after[0].checks.find((c) => c.ruleId === 'create-index-not-concurrent')).toBeUndefined();
    // The untouched second statement must not have grown any new finding either.
    expect(after[0].statementCount).toBe(before[0].statementCount);
  });

  it('fixes an UNNAMED CREATE INDEX without inserting IF NOT EXISTS (regression: that combination is a Postgres syntax error)', async () => {
    const filePath = await tempSqlFile(`${SAFE_HEADER}CREATE INDEX ON users (email);\n`);

    const before = await analyze([filePath], baseConfig);
    expect(before[0].checks.find((c) => c.ruleId === 'create-index-not-concurrent')).toBeDefined();

    const report = await applyFixesToFile(filePath, before[0], baseConfig, { split: false });
    expect(report.tier1.find((f) => f.ruleId === 'create-index-not-concurrent')?.status).toBe('fixed');

    const newContent = await readFile(filePath, 'utf8');
    expect(newContent).toContain('CREATE INDEX CONCURRENTLY ON users (email);');
    expect(newContent).not.toContain('IF NOT EXISTS');
    expectNoDoubledSemicolons(newContent);

    // The real proof: the rewritten file must still PARSE (a naive "always add
    // IF NOT EXISTS" fix would write invalid SQL for an unnamed index).
    const after = await analyze([filePath], baseConfig);
    expect(after[0].extractionWarnings?.some((w) => w.unanalyzable)).not.toBe(true);
    expect(after[0].checks.find((c) => c.ruleId === 'create-index-not-concurrent')).toBeUndefined();
  });
});

describe('Tier 1 --fix: duplicate statement text', () => {
  it('fixes two byte-for-byte identical CREATE INDEX statements independently, not just the first one twice', async () => {
    const filePath = await tempSqlFile(
      `${SAFE_HEADER}CREATE INDEX idx_dup ON t (a);\nCREATE INDEX idx_dup ON t (a);\n`,
    );

    const before = await analyze([filePath], baseConfig);
    const dupChecks = before[0].checks.filter((c) => c.ruleId === 'create-index-not-concurrent');
    expect(dupChecks).toHaveLength(2);

    const report = await applyFixesToFile(filePath, before[0], baseConfig, { split: false });
    expect(report.tier1.filter((f) => f.ruleId === 'create-index-not-concurrent' && f.status === 'fixed')).toHaveLength(2);

    const newContent = await readFile(filePath, 'utf8');
    expectNoDoubledSemicolons(newContent);
    const fixedOccurrences = newContent.match(/CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dup ON t \(a\);/g) ?? [];
    expect(fixedOccurrences).toHaveLength(2);

    const after = await analyze([filePath], baseConfig);
    expect(after[0].checks.find((c) => c.ruleId === 'create-index-not-concurrent')).toBeUndefined();
  });
});

describe('Tier 1 --fix: drop-index-not-concurrent', () => {
  it('round-trips DROP INDEX to CONCURRENTLY IF EXISTS and clears the finding', async () => {
    const filePath = await tempSqlFile(`${SAFE_HEADER}DROP INDEX idx_users_email;\n`);

    const before = await analyze([filePath], baseConfig);
    expect(before[0].checks.find((c) => c.ruleId === 'drop-index-not-concurrent')).toBeDefined();

    const report = await applyFixesToFile(filePath, before[0], baseConfig, { split: false });
    expect(report.modified).toBe(true);
    const finding = report.tier1.find((f) => f.ruleId === 'drop-index-not-concurrent');
    expect(finding?.status).toBe('fixed');
    // The residual, statically-undetectable risk must always be surfaced.
    expect(finding?.caveat).toMatch(/UNIQUE or PRIMARY KEY/);

    const newContent = await readFile(filePath, 'utf8');
    expect(newContent).toMatch(/DROP INDEX CONCURRENTLY IF EXISTS idx_users_email;/);
    expectNoDoubledSemicolons(newContent);

    const after = await analyze([filePath], baseConfig);
    expect(after[0].checks.find((c) => c.ruleId === 'drop-index-not-concurrent')).toBeUndefined();
    expect(errorViolations(after[0])).toHaveLength(0);
  });

  it('preserves the schema qualifier on a schema-qualified DROP INDEX', async () => {
    const filePath = await tempSqlFile(`${SAFE_HEADER}DROP INDEX reporting.idx_orders_customer;\n`);

    const before = await analyze([filePath], baseConfig);
    expect(before[0].checks.find((c) => c.ruleId === 'drop-index-not-concurrent')).toBeDefined();

    const report = await applyFixesToFile(filePath, before[0], baseConfig, { split: false });
    expect(report.modified).toBe(true);
    expect(report.tier1.find((f) => f.ruleId === 'drop-index-not-concurrent')?.status).toBe('fixed');

    const newContent = await readFile(filePath, 'utf8');
    // The "reporting." qualifier must survive: dropping it would let the
    // statement resolve against search_path instead of the intended schema.
    expect(newContent).toMatch(/DROP INDEX CONCURRENTLY IF EXISTS reporting\.idx_orders_customer;/);
    expectNoDoubledSemicolons(newContent);

    const after = await analyze([filePath], baseConfig);
    expect(after[0].checks.find((c) => c.ruleId === 'drop-index-not-concurrent')).toBeUndefined();
    expect(errorViolations(after[0])).toHaveLength(0);
  });

  it('preserves quoting on a mixed-case/special-character DROP INDEX target', async () => {
    const filePath = await tempSqlFile(`${SAFE_HEADER}DROP INDEX "MixedCase";\n`);

    const before = await analyze([filePath], baseConfig);
    expect(before[0].checks.find((c) => c.ruleId === 'drop-index-not-concurrent')).toBeDefined();

    const report = await applyFixesToFile(filePath, before[0], baseConfig, { split: false });
    expect(report.modified).toBe(true);
    expect(report.tier1.find((f) => f.ruleId === 'drop-index-not-concurrent')?.status).toBe('fixed');

    const newContent = await readFile(filePath, 'utf8');
    // Unquoting "MixedCase" would fold it to "mixedcase", a different
    // identifier, and IF EXISTS would then silently no-op on the real index.
    expect(newContent).toMatch(/DROP INDEX CONCURRENTLY IF EXISTS "MixedCase";/);
    expectNoDoubledSemicolons(newContent);

    const after = await analyze([filePath], baseConfig);
    expect(after[0].checks.find((c) => c.ruleId === 'drop-index-not-concurrent')).toBeUndefined();
    expect(errorViolations(after[0])).toHaveLength(0);
  });

  it('refuses to fix DROP INDEX ... CASCADE (Postgres disallows CASCADE with CONCURRENTLY)', async () => {
    const filePath = await tempSqlFile(`${SAFE_HEADER}DROP INDEX idx_users_email CASCADE;\n`);

    const before = await analyze([filePath], baseConfig);
    expect(before[0].checks.find((c) => c.ruleId === 'drop-index-not-concurrent')).toBeDefined();

    const report = await applyFixesToFile(filePath, before[0], baseConfig, { split: false });
    expect(report.modified).toBe(false);
    const finding = report.tier1.find((f) => f.ruleId === 'drop-index-not-concurrent');
    expect(finding?.status).toBe('skipped');
    expect(finding?.reason).toMatch(/CASCADE/);

    const unchanged = await readFile(filePath, 'utf8');
    expect(unchanged).toContain('DROP INDEX idx_users_email CASCADE;');
  });

  it('refuses to fix a multi-index DROP INDEX (Postgres CONCURRENTLY only supports one index)', async () => {
    const filePath = await tempSqlFile(`${SAFE_HEADER}DROP INDEX idx_a, idx_b;\n`);

    const before = await analyze([filePath], baseConfig);
    expect(before[0].checks.find((c) => c.ruleId === 'drop-index-not-concurrent')).toBeDefined();

    const report = await applyFixesToFile(filePath, before[0], baseConfig, { split: false });
    expect(report.modified).toBe(false);
    const finding = report.tier1.find((f) => f.ruleId === 'drop-index-not-concurrent');
    expect(finding?.status).toBe('skipped');
    expect(finding?.reason).toMatch(/more than one index/);
  });
});

describe('Tier 1 --fix: refuses to add CONCURRENTLY inside an explicit transaction', () => {
  it('skips create-index-not-concurrent when the statement is wrapped in BEGIN/COMMIT', async () => {
    const filePath = await tempSqlFile(
      `${SAFE_HEADER}BEGIN;\nCREATE INDEX idx_users_email ON users (email);\nCOMMIT;\n`,
    );

    const before = await analyze([filePath], baseConfig);
    expect(before[0].checks.find((c) => c.ruleId === 'create-index-not-concurrent')).toBeDefined();

    const report = await applyFixesToFile(filePath, before[0], baseConfig, { split: false });
    expect(report.modified).toBe(false);
    const finding = report.tier1.find((f) => f.ruleId === 'create-index-not-concurrent');
    expect(finding?.status).toBe('skipped');
    expect(finding?.reason).toMatch(/BEGIN\.\.\.COMMIT/);

    const unchanged = await readFile(filePath, 'utf8');
    expect(unchanged).toContain('CREATE INDEX idx_users_email ON users (email);');
    expect(unchanged).not.toMatch(/CONCURRENTLY/);
  });

  it('skips drop-index-not-concurrent when the statement is wrapped in BEGIN/COMMIT', async () => {
    const filePath = await tempSqlFile(
      `${SAFE_HEADER}BEGIN;\nDROP INDEX idx_users_email;\nCOMMIT;\n`,
    );

    const before = await analyze([filePath], baseConfig);
    expect(before[0].checks.find((c) => c.ruleId === 'drop-index-not-concurrent')).toBeDefined();

    const report = await applyFixesToFile(filePath, before[0], baseConfig, { split: false });
    expect(report.modified).toBe(false);
    const finding = report.tier1.find((f) => f.ruleId === 'drop-index-not-concurrent');
    expect(finding?.status).toBe('skipped');
    expect(finding?.reason).toMatch(/BEGIN\.\.\.COMMIT/);
  });

  it('still fixes create-index-not-concurrent for a statement outside any transaction, even when the file has an earlier, already-closed one', async () => {
    const filePath = await tempSqlFile(
      `${SAFE_HEADER}BEGIN;\nSELECT 1;\nCOMMIT;\nCREATE INDEX idx_users_email ON users (email);\n`,
    );

    const before = await analyze([filePath], baseConfig);
    const report = await applyFixesToFile(filePath, before[0], baseConfig, { split: false });
    expect(report.modified).toBe(true);
    const finding = report.tier1.find((f) => f.ruleId === 'create-index-not-concurrent');
    expect(finding?.status).toBe('fixed');

    const newContent = await readFile(filePath, 'utf8');
    expect(newContent).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_email ON users \(email\);/);
  });
});

describe('Tier 1 --fix: policy SET statements', () => {
  it('round-trips missing-lock-timeout, missing-statement-timeout, and missing-idle-timeout together', async () => {
    const filePath = await tempSqlFile("SET application_name = 'migrate:test';\nSELECT 1;\n");

    const before = await analyze([filePath], baseConfig);
    for (const ruleId of ['missing-lock-timeout', 'missing-statement-timeout', 'missing-idle-timeout']) {
      expect(before[0].policyViolations.find((v) => v.ruleId === ruleId), ruleId).toBeDefined();
    }

    const report = await applyFixesToFile(filePath, before[0], baseConfig, { split: false });
    expect(report.modified).toBe(true);
    for (const ruleId of ['missing-lock-timeout', 'missing-statement-timeout', 'missing-idle-timeout']) {
      expect(report.tier1.find((f) => f.ruleId === ruleId)?.status, ruleId).toBe('fixed');
    }

    const newContent = await readFile(filePath, 'utf8');
    expect(newContent).toContain("SET lock_timeout = '2s';");
    expect(newContent).toContain("SET statement_timeout = '5min';");
    expect(newContent).toContain("SET idle_in_transaction_session_timeout = '30s';");
    expectNoDoubledSemicolons(newContent);

    const after = await analyze([filePath], baseConfig);
    for (const ruleId of ['missing-lock-timeout', 'missing-statement-timeout', 'missing-idle-timeout']) {
      expect(after[0].policyViolations.find((v) => v.ruleId === ruleId), ruleId).toBeUndefined();
    }
    expect(errorViolations(after[0])).toHaveLength(0);
  });

  it('leaves missing-application-name unfixed (placeholder value, not mechanical) with a stated reason', async () => {
    const filePath = await tempSqlFile([
      "SET lock_timeout = '2s';",
      "SET statement_timeout = '5min';",
      "SET idle_in_transaction_session_timeout = '30s';",
      'SELECT 1;',
      '',
    ].join('\n'));

    const before = await analyze([filePath], baseConfig);
    expect(before[0].policyViolations.find((v) => v.ruleId === 'missing-application-name')).toBeDefined();

    const report = await applyFixesToFile(filePath, before[0], baseConfig, { split: false });
    // missing-application-name is not in the Tier 1 allowlist at all, so it must
    // not appear as a "fixed" entry, and the finding must still be present after.
    expect(report.tier1.find((f) => f.ruleId === 'missing-application-name')).toBeUndefined();

    const after = await analyze([filePath], baseConfig);
    expect(after[0].policyViolations.find((v) => v.ruleId === 'missing-application-name')).toBeDefined();
  });
});

describe('Tier 1 --fix: format gating', () => {
  it('refuses in-place edits for a non-sql format and reports why', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pgfence-fix-tier1-typeorm-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, 'Migration123.ts');
    const source = [
      "import { MigrationInterface, QueryRunner } from 'typeorm';",
      'export class Migration123 implements MigrationInterface {',
      '  async up(queryRunner: QueryRunner): Promise<void> {',
      '    await queryRunner.query(`CREATE INDEX idx_users_email ON users (email)`);',
      '  }',
      '  async down(queryRunner: QueryRunner): Promise<void> {}',
      '}',
      '',
    ].join('\n');
    await writeFile(filePath, source, 'utf8');

    const config: PgfenceConfig = { ...baseConfig, format: 'typeorm', requireLockTimeout: false, requireStatementTimeout: false };
    const before = await analyze([filePath], config);
    expect(before[0].checks.find((c) => c.ruleId === 'create-index-not-concurrent')).toBeDefined();

    const report = await applyFixesToFile(filePath, before[0], config, { split: false });
    expect(report.modified).toBe(false);
    expect(report.supportsInPlaceFix).toBe(false);
    const finding = report.tier1.find((f) => f.ruleId === 'create-index-not-concurrent');
    expect(finding?.status).toBe('skipped');
    expect(finding?.reason).toMatch(/typeorm/);

    const unchanged = await readFile(filePath, 'utf8');
    expect(unchanged).toBe(source);
  });
});
