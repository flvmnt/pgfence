import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { analyze } from '../src/analyzer.js';
import { applyFixesToFile } from '../src/fix/index.js';
import type { PgfenceConfig } from '../src/types.js';
import { RiskLevel } from '../src/types.js';

/**
 * Tier 2 (--fix --split) tests: prove the generated sibling files match
 * CLAUDE.md's documented recipe step order and count, that the original file
 * is never touched, and that the generated expand step actually clears the
 * original finding when re-analyzed on its own.
 */

const baseConfig: PgfenceConfig = {
  format: 'sql',
  output: 'cli',
  minPostgresVersion: 14,
  maxAllowedRisk: RiskLevel.HIGH,
  requireLockTimeout: true,
  requireStatementTimeout: true,
};

const SAFE_HEADER = [
  "SET lock_timeout = '2s';",
  "SET statement_timeout = '5min';",
  "SET application_name = 'migrate:test';",
  "SET idle_in_transaction_session_timeout = '30s';",
  '',
].join('\n');

const tempDirs: string[] = [];

async function tempSqlFile(sql: string, filename = 'migration.sql'): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'pgfence-fix-tier2-'));
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

function statementsOf(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--') && line.trim().length > 0)
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

describe('Tier 2 --fix --split: add-column-not-null-no-default (ADD COLUMN NOT NULL recipe)', () => {
  it('generates expand / manual-backfill / contract files in the documented order, never touching the original file', async () => {
    const filePath = await tempSqlFile(`${SAFE_HEADER}ALTER TABLE orders ADD COLUMN status text NOT NULL;\n`);
    const originalContent = await readFile(filePath, 'utf8');

    const before = await analyze([filePath], baseConfig);
    expect(before[0].checks.find((c) => c.ruleId === 'add-column-not-null-no-default')).toBeDefined();

    const report = await applyFixesToFile(filePath, before[0], baseConfig, { split: true });
    expect(report.modified).toBe(false); // Tier 2 never edits the original file
    expect(await readFile(filePath, 'utf8')).toBe(originalContent);

    const tier2 = report.tier2.find((t) => t.ruleId === 'add-column-not-null-no-default');
    expect(tier2?.status).toBe('generated');
    expect(tier2?.files).toHaveLength(3);

    const [expandFile, backfillFile, contractFile] = tier2!.files!;
    expect(expandFile.path).toMatch(/\.1-expand\.sql$/);
    expect(backfillFile.path).toMatch(/\.2-backfill\.MANUAL\.sql$/);
    expect(contractFile.path).toMatch(/\.3-contract\.sql$/);

    // --- Step 1: Expand ---
    const expandSql = await readFile(expandFile.path, 'utf8');
    const expandStatements = statementsOf(expandSql);
    expect(expandStatements).toHaveLength(1);
    expect(expandStatements[0]).toMatch(/ADD COLUMN IF NOT EXISTS\s+status\s+text/i);
    expect(expandStatements[0]).not.toMatch(/NOT NULL/);

    // The expand step alone, analyzed standalone, must no longer trigger the
    // original finding (or any new one) - it is now a plain nullable column add.
    const expandResult = await analyze([expandFile.path], { ...baseConfig, requireLockTimeout: false, requireStatementTimeout: false });
    expect(expandResult[0].checks.find((c) => c.ruleId === 'add-column-not-null-no-default')).toBeUndefined();

    // --- Step 2: Backfill (inert, manual) ---
    const backfillSql = await readFile(backfillFile.path, 'utf8');
    expect(backfillSql).toMatch(/MANUAL BACKFILL/);
    expect(backfillSql).toMatch(/DO NOT RUN/);
    const liveLines = backfillSql
      .split('\n')
      .filter((line) => line.trim().length > 0 && !line.trim().startsWith('--'));
    expect(liveLines).toHaveLength(0); // fully inert: a no-op if run by accident

    // --- Step 3: Contract, in documented order ---
    const contractSql = await readFile(contractFile.path, 'utf8');
    const contractStatements = statementsOf(contractSql);
    expect(contractStatements).toHaveLength(4);
    expect(contractStatements[0]).toMatch(/ADD CONSTRAINT .*CHECK \(.*status.*IS NOT NULL\).*NOT VALID/i);
    expect(contractStatements[1]).toMatch(/VALIDATE CONSTRAINT/i);
    expect(contractStatements[2]).toMatch(/ALTER COLUMN .*status.* SET NOT NULL/i);
    expect(contractStatements[3]).toMatch(/DROP CONSTRAINT/i);
  });

  it('skips (does not guess) when the column definition has more than just NOT NULL', async () => {
    const filePath = await tempSqlFile(`${SAFE_HEADER}ALTER TABLE orders ADD COLUMN sku text NOT NULL UNIQUE;\n`);
    const before = await analyze([filePath], baseConfig);
    const check = before[0].checks.find((c) => c.ruleId === 'add-column-not-null-no-default');
    expect(check).toBeDefined();

    const report = await applyFixesToFile(filePath, before[0], baseConfig, { split: true });
    const tier2 = report.tier2.find((t) => t.ruleId === 'add-column-not-null-no-default');
    expect(tier2?.status).toBe('skipped');
    expect(tier2?.reason).toMatch(/additional constraints/);
  });

  it('without --split, reports the recipe as available but not generated', async () => {
    const filePath = await tempSqlFile(`${SAFE_HEADER}ALTER TABLE orders ADD COLUMN status text NOT NULL;\n`);
    const before = await analyze([filePath], baseConfig);
    const report = await applyFixesToFile(filePath, before[0], baseConfig, { split: false });
    const tier2 = report.tier2.find((t) => t.ruleId === 'add-column-not-null-no-default');
    expect(tier2?.status).toBe('skipped');
    expect(tier2?.reason).toMatch(/--split/);
  });
});

describe('Tier 2 --fix --split: add-constraint-fk-no-not-valid (ADD FOREIGN KEY recipe)', () => {
  it('generates expand (NOT VALID) / contract (VALIDATE) files matching the documented recipe', async () => {
    const filePath = await tempSqlFile(
      `${SAFE_HEADER}ALTER TABLE orders ADD CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers(id);\n`,
    );
    const originalContent = await readFile(filePath, 'utf8');

    const before = await analyze([filePath], baseConfig);
    expect(before[0].checks.find((c) => c.ruleId === 'add-constraint-fk-no-not-valid')).toBeDefined();

    const report = await applyFixesToFile(filePath, before[0], baseConfig, { split: true });
    expect(report.modified).toBe(false);
    expect(await readFile(filePath, 'utf8')).toBe(originalContent);

    const tier2 = report.tier2.find((t) => t.ruleId === 'add-constraint-fk-no-not-valid');
    expect(tier2?.status).toBe('generated');
    expect(tier2?.files).toHaveLength(2);

    const [expandFile, contractFile] = tier2!.files!;
    expect(expandFile.path).toMatch(/\.1-expand\.sql$/);
    expect(contractFile.path).toMatch(/\.2-contract\.sql$/);

    const expandSql = await readFile(expandFile.path, 'utf8');
    const expandStatements = statementsOf(expandSql);
    expect(expandStatements).toHaveLength(1);
    expect(expandStatements[0]).toMatch(/ADD CONSTRAINT fk_orders_customer FOREIGN KEY \(customer_id\) REFERENCES customers\(id\) NOT VALID/i);

    const contractSql = await readFile(contractFile.path, 'utf8');
    const contractStatements = statementsOf(contractSql);
    expect(contractStatements).toHaveLength(1);
    expect(contractStatements[0]).toMatch(/VALIDATE CONSTRAINT .*fk_orders_customer/i);

    // Prove the expand step, run alone, actually clears the original finding.
    const expandResult = await analyze([expandFile.path], { ...baseConfig, requireLockTimeout: false, requireStatementTimeout: false });
    expect(expandResult[0].checks.find((c) => c.ruleId === 'add-constraint-fk-no-not-valid')).toBeUndefined();
  });

  it('skips an unnamed foreign key (cannot target a follow-up VALIDATE CONSTRAINT without a name)', async () => {
    const filePath = await tempSqlFile(
      `${SAFE_HEADER}ALTER TABLE orders ADD FOREIGN KEY (customer_id) REFERENCES customers(id);\n`,
    );
    const before = await analyze([filePath], baseConfig);
    expect(before[0].checks.find((c) => c.ruleId === 'add-constraint-fk-no-not-valid')).toBeDefined();

    const report = await applyFixesToFile(filePath, before[0], baseConfig, { split: true });
    const tier2 = report.tier2.find((t) => t.ruleId === 'add-constraint-fk-no-not-valid');
    expect(tier2?.status).toBe('skipped');
    expect(tier2?.reason).toMatch(/no explicit constraint name/);
  });

  it('skips a multi-action ALTER TABLE statement rather than misplace NOT VALID', async () => {
    const filePath = await tempSqlFile(
      `${SAFE_HEADER}ALTER TABLE orders ADD COLUMN region text, ADD CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers(id);\n`,
    );
    const before = await analyze([filePath], baseConfig);
    expect(before[0].checks.find((c) => c.ruleId === 'add-constraint-fk-no-not-valid')).toBeDefined();

    const report = await applyFixesToFile(filePath, before[0], baseConfig, { split: true });
    const tier2 = report.tier2.find((t) => t.ruleId === 'add-constraint-fk-no-not-valid');
    expect(tier2?.status).toBe('skipped');
    expect(tier2?.reason).toMatch(/more than one ALTER TABLE action/);
  });
});

describe('Tier 2 --fix --split: add-constraint-unique (ADD UNIQUE CONSTRAINT recipe)', () => {
  it('generates expand (CONCURRENTLY index) / contract (USING INDEX) files matching the documented recipe', async () => {
    const filePath = await tempSqlFile(
      `${SAFE_HEADER}ALTER TABLE orders ADD CONSTRAINT uq_orders_email UNIQUE (email);\n`,
    );
    const before = await analyze([filePath], baseConfig);
    expect(before[0].checks.find((c) => c.ruleId === 'add-constraint-unique')).toBeDefined();

    const report = await applyFixesToFile(filePath, before[0], baseConfig, { split: true });
    const tier2 = report.tier2.find((t) => t.ruleId === 'add-constraint-unique');
    expect(tier2?.status).toBe('generated');
    expect(tier2?.files).toHaveLength(2);

    const [expandFile, contractFile] = tier2!.files!;
    const expandSql = await readFile(expandFile.path, 'utf8');
    expect(statementsOf(expandSql)[0]).toMatch(/CREATE UNIQUE INDEX CONCURRENTLY .*ON .*orders.* \(.*email.*\)/i);

    const contractSql = await readFile(contractFile.path, 'utf8');
    expect(statementsOf(contractSql)[0]).toMatch(/ADD CONSTRAINT .*uq_orders_email.* UNIQUE USING INDEX/i);

    const expandResult = await analyze([expandFile.path], { ...baseConfig, requireLockTimeout: false, requireStatementTimeout: false });
    expect(expandResult[0].checks.find((c) => c.ruleId === 'add-constraint-unique')).toBeUndefined();
  });

  it('skips a UNIQUE constraint using modifiers the USING INDEX recipe cannot reproduce', async () => {
    const filePath = await tempSqlFile(
      `${SAFE_HEADER}ALTER TABLE orders ADD CONSTRAINT uq_orders_email UNIQUE (email) DEFERRABLE;\n`,
    );
    const before = await analyze([filePath], baseConfig);
    const report = await applyFixesToFile(filePath, before[0], baseConfig, { split: true });
    const tier2 = report.tier2.find((t) => t.ruleId === 'add-constraint-unique');
    expect(tier2?.status).toBe('skipped');
    expect(tier2?.reason).toMatch(/deferrable/);
  });
});

describe('Tier 2 --fix --split: same-run collisions across findings', () => {
  it('generates independent scaffolds for two NOT NULL columns added in the same file', async () => {
    const filePath = await tempSqlFile(
      `${SAFE_HEADER}ALTER TABLE orders ADD COLUMN status text NOT NULL;\nALTER TABLE orders ADD COLUMN kind text NOT NULL;\n`,
    );
    const before = await analyze([filePath], baseConfig);
    expect(before[0].checks.filter((c) => c.ruleId === 'add-column-not-null-no-default')).toHaveLength(2);

    const report = await applyFixesToFile(filePath, before[0], baseConfig, { split: true });
    const generated = report.tier2.filter(
      (t) => t.ruleId === 'add-column-not-null-no-default' && t.status === 'generated',
    );
    // Both findings must get their own scaffold, not just the first.
    expect(generated).toHaveLength(2);

    const allPaths = generated.flatMap((t) => t.files!.map((f) => f.path));
    expect(new Set(allPaths).size).toBe(allPaths.length);
    expect(allPaths.some((p) => p.includes('orders_status'))).toBe(true);
    expect(allPaths.some((p) => p.includes('orders_kind'))).toBe(true);
  });

  it('generates independent scaffolds for an FK and a UNIQUE constraint, whose suffixes are identical strings', async () => {
    const filePath = await tempSqlFile(
      `${SAFE_HEADER}ALTER TABLE orders ADD CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers(id);\n` +
      `ALTER TABLE orders ADD CONSTRAINT uq_orders_email UNIQUE (email);\n`,
    );
    const before = await analyze([filePath], baseConfig);
    const report = await applyFixesToFile(filePath, before[0], baseConfig, { split: true });

    const fkResult = report.tier2.find((t) => t.ruleId === 'add-constraint-fk-no-not-valid');
    const uqResult = report.tier2.find((t) => t.ruleId === 'add-constraint-unique');
    expect(fkResult?.status).toBe('generated');
    expect(uqResult?.status).toBe('generated');

    const fkPaths = fkResult!.files!.map((f) => f.path);
    const uqPaths = uqResult!.files!.map((f) => f.path);
    // Both rules use the literal suffixes '1-expand'/'2-contract' - only the
    // per-finding slug keeps them from writing to the same paths.
    expect(new Set([...fkPaths, ...uqPaths]).size).toBe(fkPaths.length + uqPaths.length);
  });
});

describe('Tier 2 --fix --split: safety net', () => {
  it('does not overwrite a pre-existing sibling file', async () => {
    const filePath = await tempSqlFile(`${SAFE_HEADER}ALTER TABLE orders ADD COLUMN status text NOT NULL;\n`);
    const dir = path.dirname(filePath);
    const collidingPath = path.join(dir, 'migration.orders_status.1-expand.sql');
    await writeFile(collidingPath, '-- pre-existing, hand-written\n', 'utf8');

    const before = await analyze([filePath], baseConfig);
    const report = await applyFixesToFile(filePath, before[0], baseConfig, { split: true });
    const tier2 = report.tier2.find((t) => t.ruleId === 'add-column-not-null-no-default');
    expect(tier2?.status).toBe('skipped');
    expect(tier2?.reason).toMatch(/already exists/);

    const untouched = await readFile(collidingPath, 'utf8');
    expect(untouched).toBe('-- pre-existing, hand-written\n');
  });
});
