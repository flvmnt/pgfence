import { describe, it, expect } from 'vitest';
import { exec } from 'child_process';
import util from 'util';
import path from 'path';
import { existsSync } from 'node:fs';
import { analyze, RISK_ORDER } from '../src/analyzer.js';
import type { PgfenceConfig } from '../src/types.js';
import { RiskLevel } from '../src/types.js';

const execPromise = util.promisify(exec);
const cliPath = path.join(process.cwd(), 'src', 'index.ts');
const distCliPath = path.join(process.cwd(), 'dist', 'index.js');
const fixturesDir = path.join(process.cwd(), 'tests', 'fixtures');
const hasBuiltCli = () => existsSync(distCliPath);

/** Run CLI: use built binary if available, otherwise tsx (can fail in restricted envs). */
function cliCommand(args: string): string {
    return hasBuiltCli()
        ? `node "${distCliPath}" ${args}`
        : `npx tsx ${cliPath} ${args}`;
}

const defaultConfig: PgfenceConfig = {
    format: 'auto',
    output: 'cli',
    minPostgresVersion: 11,
    maxAllowedRisk: RiskLevel.HIGH,
    requireLockTimeout: true,
    requireStatementTimeout: true,
};

/**
 * Same CI failure logic as src/index.ts — used to test exit code behavior without subprocess.
 */
function wouldCiFail(results: Awaited<ReturnType<typeof analyze>>, maxAllowedRisk: RiskLevel): boolean {
    const maxAllowedIdx = RISK_ORDER.indexOf(maxAllowedRisk);
    let shouldFail = false;
    for (const result of results) {
        const maxIdx = RISK_ORDER.indexOf(result.maxRisk);
        if (maxIdx > maxAllowedIdx) shouldFail = true;
        if (result.policyViolations.some((v) => v.severity === 'error')) shouldFail = true;
    }
    return shouldFail;
}

describe('CI exit code logic', () => {
    it('does not fail when max risk is within limit and no policy errors', async () => {
        const results = await analyze(
            [path.join(fixturesDir, 'safe-migration.sql')],
            { ...defaultConfig, maxAllowedRisk: RiskLevel.HIGH },
        );
        expect(wouldCiFail(results, RiskLevel.HIGH)).toBe(false);
    });

    it('fails when max risk exceeds --max-risk', async () => {
        const results = await analyze(
            [path.join(fixturesDir, 'dangerous-add-column.sql')],
            { ...defaultConfig, maxAllowedRisk: RiskLevel.MEDIUM },
        );
        expect(wouldCiFail(results, RiskLevel.MEDIUM)).toBe(true);
    });

    it('fails when there are policy errors (e.g. missing lock_timeout)', async () => {
        const results = await analyze(
            [path.join(fixturesDir, 'missing-policy.sql')],
            { ...defaultConfig, maxAllowedRisk: RiskLevel.HIGH },
        );
        expect(results[0].policyViolations.some((v) => v.severity === 'error')).toBe(true);
        expect(wouldCiFail(results, RiskLevel.HIGH)).toBe(true);
    });
});

describe.skipIf(!hasBuiltCli())('CLI e2e (built binary)', () => {
    it('exits 0 and prints coverage when analyzing safe migration', async () => {
        const fixture = path.join(fixturesDir, 'safe-migration.sql');
        const { stdout, stderr } = await execPromise(`node "${distCliPath}" analyze "${fixture}"`);
        expect(stdout).toContain('=== Coverage ===');
        expect(stdout).toMatch(/Coverage: \d+%/);
        expect(stderr).toBe('');
    });

    it('exits 1 when --ci and max-risk exceeded', async () => {
        const fixture = path.join(fixturesDir, 'dangerous-add-column.sql');
        await expect(
            execPromise(`node "${distCliPath}" analyze --ci --max-risk medium "${fixture}"`),
        ).rejects.toMatchObject({ code: 1 });
    });
});

describe('CLI tests', () => {
    it('runs default cli analysis', async () => {
        const fixture = path.join(fixturesDir, 'safe-migration.sql');
        const { stdout } = await execPromise(cliCommand(`analyze "${fixture}"`));
        expect(stdout).toContain('[LOW]');
    });

    it('runs json output analysis', async () => {
        const fixture = path.join(fixturesDir, 'safe-migration.sql');
        const { stdout } = await execPromise(cliCommand(`analyze --output json "${fixture}"`));
        expect(stdout).toContain('"version": "1.0"');
    });

    it('runs github output analysis', async () => {
        const fixture = path.join(fixturesDir, 'safe-migration.sql');
        const { stdout } = await execPromise(cliCommand(`analyze --output github "${fixture}"`));
        expect(stdout).toContain('## pgfence Migration Safety Report');
    });

    it('fails on high risk with --ci', async () => {
        const fixture = path.join(fixturesDir, 'dangerous-add-column.sql');
        await expect(execPromise(cliCommand(`analyze --ci --max-risk medium "${fixture}"`))).rejects.toThrow();
    });

    it('fails with invalid risk level parsing error', async () => {
        const fixture = path.join(fixturesDir, 'safe-migration.sql');
        try {
            await execPromise(cliCommand(`analyze "${fixture}" --max-risk TERROR`));
        } catch (err: unknown) {
            const error = err as { stderr?: string; code?: number };
            expect(error.stderr).toContain('Invalid risk level: TERROR');
            expect(error.code).toBe(1);
        }
    });

    it('parses --stats-file for size-aware risk scoring', async () => {
        const fs = await import('node:fs/promises');
        const fixture = path.join(fixturesDir, 'safe-migration.sql');
        await fs.writeFile('test-stats.json', JSON.stringify([{ schemaName: 'public', tableName: 'test', rowCount: 1, totalBytes: 1 }]));

        try {
            const { stdout } = await execPromise(cliCommand(`analyze "${fixture}" --stats-file test-stats.json`));
            expect(stdout).toContain('[LOW]');
        } finally {
            await fs.unlink('test-stats.json').catch(() => {});
        }
    });
});
