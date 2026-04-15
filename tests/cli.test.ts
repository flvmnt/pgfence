import { describe, it, expect, beforeEach } from 'vitest';
import { exec, execFile } from 'child_process';
import util from 'util';
import path from 'path';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { analyze, RISK_ORDER } from '../src/analyzer.js';
import type { PgfenceConfig } from '../src/types.js';
import { RiskLevel } from '../src/types.js';
import { installHooks } from '../src/init.js';

const execPromise = util.promisify(exec);
const execFilePromise = util.promisify(execFile);
const cliPath = path.join(process.cwd(), 'src', 'index.ts');
const distCliPath = path.join(process.cwd(), 'dist', 'index.js');
const fixturesDir = path.join(process.cwd(), 'tests', 'fixtures');
const hasBuiltCli = () => existsSync(distCliPath);

async function git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await execFilePromise('git', args, { cwd });
    return stdout.trim();
}

/** Run CLI: use built binary if available, otherwise tsx (can fail in restricted envs). */
function cliCommand(args: string): string {
    return hasBuiltCli()
        ? `node "${distCliPath}" ${args}`
        : `npx tsx ${cliPath} ${args}`;
}

const defaultConfig: PgfenceConfig = {
    format: 'auto',
    output: 'cli',
    minPostgresVersion: 14,
    maxAllowedRisk: RiskLevel.HIGH,
    requireLockTimeout: true,
    requireStatementTimeout: true,
};

/**
 * Same CI failure logic as src/index.ts,used to test exit code behavior without subprocess.
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
    beforeEach(async () => {
        if (!existsSync(distCliPath)) {
            await execPromise('pnpm build');
        }
    });

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

    it('exits 2 on system error (snapshot with bad db url)', async () => {
        try {
            await execPromise(cliCommand('snapshot --db-url postgres://bad:bad@localhost:0/noexist'));
            throw new Error('expected snapshot to fail');
        } catch (err: unknown) {
            const error = err as { code?: number; stderr?: string };
            expect(error.code).toBe(2);
            expect(error.stderr).toContain('pgfence snapshot error');
        }
    });
});

describe('CLI tests', () => {
    it('expands action-style glob inputs before invoking pgfence', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'pgfence-action-glob-'));
        const migrationsDir = path.join(root, 'migrations');
        await mkdir(migrationsDir, { recursive: true });
        await writeFile(path.join(migrationsDir, '001.sql'), 'SELECT 1;\n');
        await writeFile(path.join(migrationsDir, '002.sql'), 'SELECT 2;\n');

        try {
            const script = `
shopt -s nullglob
INPUT_PATH='migrations/*.sql'
FILES=($INPUT_PATH)
printf '%s\\n' "\${FILES[@]}"
`;
            const { stdout } = await execFilePromise('bash', ['-lc', script], { cwd: root });
            expect(stdout.trim().split('\n').sort()).toEqual(['migrations/001.sql', 'migrations/002.sql']);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('installs hooks in worktrees and keeps existing hook behavior intact', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'pgfence-init-worktree-'));
        const repoDir = path.join(root, 'repo');
        const worktreeDir = path.join(root, 'worktree');
        await mkdir(repoDir, { recursive: true });

        const previousCwd = process.cwd();
        try {
            await git(repoDir, ['init']);
            await git(repoDir, ['config', 'user.email', 'flavius.mnt11@gmail.com']);
            await git(repoDir, ['config', 'user.name', 'Munteanu Flavius-Ioan']);
            await writeFile(path.join(repoDir, 'README.md'), 'init\n', 'utf8');
            await git(repoDir, ['add', 'README.md']);
            await git(repoDir, ['commit', '-m', 'init']);
            await git(repoDir, ['worktree', 'add', '--detach', worktreeDir, 'HEAD']);

            const hooksPath = await git(worktreeDir, ['rev-parse', '--git-path', 'hooks']);
            const resolvedHooksDir = path.isAbsolute(hooksPath) ? hooksPath : path.resolve(worktreeDir, hooksPath);
            await mkdir(resolvedHooksDir, { recursive: true });
            await writeFile(path.join(resolvedHooksDir, 'pre-commit'), '#!/bin/sh\nexit 0\n', 'utf8');

            process.chdir(worktreeDir);
            await installHooks();

            const installed = await readFile(path.join(resolvedHooksDir, 'pre-commit'), 'utf8');
            expect(installed).toContain('pgfence analyze');
            expect(installed.indexOf('pgfence analyze')).toBeLessThan(installed.indexOf('exit 0'));
        } finally {
            process.chdir(previousCwd);
            await rm(root, { recursive: true, force: true });
        }
    });

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
