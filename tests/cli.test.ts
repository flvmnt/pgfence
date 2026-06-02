import { describe, it, expect } from 'vitest';
import { exec, execFile } from 'child_process';
import util from 'util';
import path from 'path';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { analyze, parseExtractedStatements, RISK_ORDER } from '../src/analyzer.js';
import type { ExtractionResult, PgfenceConfig } from '../src/types.js';
import { RiskLevel } from '../src/types.js';
import { installHooks, installPrismaGitHubAction } from '../src/init.js';

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
 * Mirror of shouldFailCI in src/index.ts. Used to test exit code behavior without subprocess.
 * Must stay in sync, including the unknownHandling=block branch.
 */
function wouldCiFail(
    results: Awaited<ReturnType<typeof analyze>>,
    maxAllowedRisk: RiskLevel,
    unknownHandling: 'warn' | 'block' = 'warn',
): boolean {
    const maxAllowedIdx = RISK_ORDER.indexOf(maxAllowedRisk);
    for (const result of results) {
        const maxIdx = RISK_ORDER.indexOf(result.maxRisk);
        if (maxIdx > maxAllowedIdx) return true;
        if (result.policyViolations.some((v) => v.severity === 'error')) return true;
    }
    const hasUnanalyzable = results.some((r) => r.extractionWarnings?.some((w) => w.unanalyzable));
    return unknownHandling === 'block' && hasUnanalyzable;
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

describe('Trace parser fallback', () => {
    it('preserves valid extracted statements when one ORM statement fails to parse', async () => {
        const extraction: ExtractionResult = {
            sql: [
                'ALTER TABLE users ADD COLUMN nickname text;',
                'ALTER TABLE',
            ].join('\n'),
            statements: [
                'ALTER TABLE users ADD COLUMN nickname text;',
                'ALTER TABLE',
            ],
            warnings: [],
        };

        const stmts = await parseExtractedStatements(extraction, 'migration.ts');

        expect(stmts).toHaveLength(1);
        expect(stmts[0].sql).toContain('ADD COLUMN nickname');
        expect(extraction.warnings).toHaveLength(1);
        expect(extraction.warnings[0]).toMatchObject({ unanalyzable: true, line: 1, column: 1 });
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

    it('exits 1 when unknown handling blocks unanalyzable SQL', async () => {
        const fixture = path.join(fixturesDir, 'dynamic-typeorm.ts');
        await expect(
            execPromise(`node "${distCliPath}" analyze --ci --unknown block --max-risk critical --no-lock-timeout --no-statement-timeout --format typeorm "${fixture}"`),
        ).rejects.toMatchObject({ code: 1 });
    });

    it('explains a single statement without full migration policy noise', async () => {
        const { stdout, stderr } = await execPromise(`node "${distCliPath}" explain "SELECT 1"`);
        expect(stdout).toContain('Statement:');
        expect(stdout).toContain('No issues found.');
        expect(stdout).not.toContain('missing-lock-timeout');
        expect(stdout).not.toContain('missing-application-name');
        expect(stderr).toBe('');

        const { stdout: jsonStdout } = await execPromise(`node "${distCliPath}" explain --output json "SELECT 1"`);
        const parsed = JSON.parse(jsonStdout) as { maxRisk: string; policyViolations: unknown[] };
        expect(parsed.maxRisk).toBe('SAFE');
        expect(parsed.policyViolations).toEqual([]);
    });

    it('rejects unsupported explain output formats', async () => {
        await expect(
            execPromise(`node "${distCliPath}" explain --output yaml "SELECT 1"`),
        ).rejects.toMatchObject({ code: 2 });
    });

    it('lets explain use config min-pg-version when the flag is omitted', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'pgfence-explain-config-'));
        await writeFile(path.join(root, '.pgfence.json'), JSON.stringify({
            'min-pg-version': 10,
            'require-lock-timeout': false,
            'require-statement-timeout': false,
        }), 'utf8');

        try {
            const { stdout } = await execPromise(
                `node "${distCliPath}" explain --output json "ALTER TABLE users ADD COLUMN flags int DEFAULT 0"`,
                { cwd: root },
            );
            const parsed = JSON.parse(stdout) as { checks: Array<{ ruleId: string; risk: string }> };
            expect(parsed.checks.some((check) => check.ruleId === 'add-column-default-pre-pg11' && check.risk === 'HIGH')).toBe(true);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('respects config file values when CLI flags are omitted', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'pgfence-config-cli-'));
        await writeFile(path.join(root, '.pgfence.json'), JSON.stringify({
            output: 'json',
            'max-risk': 'low',
            'require-lock-timeout': false,
            'require-statement-timeout': false,
        }), 'utf8');
        await writeFile(path.join(root, 'migration.sql'), 'CREATE INDEX idx_users_email ON users(email);\n', 'utf8');

        try {
            await expect(
                execPromise(`node "${distCliPath}" analyze --ci migration.sql`, { cwd: root }),
            ).rejects.toMatchObject({ code: 1 });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('exits 2 with a sanitized error when config loading fails', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'pgfence-bad-config-cli-'));
        await writeFile(path.join(root, '.pgfence.toml'), 'output = [\n', 'utf8');
        await writeFile(path.join(root, 'migration.sql'), 'SELECT 1;\n', 'utf8');

        try {
            await execPromise(`node "${distCliPath}" analyze migration.sql`, { cwd: root });
            throw new Error('expected analyze to fail');
        } catch (err: unknown) {
            const error = err as { code?: number; stderr?: string; stdout?: string };
            expect(error.code).toBe(2);
            expect(error.stderr).toContain('pgfence error:');
            expect(error.stderr).toContain('Unterminated inline array');
            expect(error.stderr).not.toContain('node_modules');
            expect(error.stderr).not.toContain('Node.js');
            expect(error.stdout).toBe('');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
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
INPUT_PATH='migrations/*.sql'
FILES=()
while IFS= read -r file; do
  if [ -n "$file" ]; then
    FILES+=("$file")
  fi
done < <(compgen -G "$INPUT_PATH" || true)
printf '%s\\n' "\${FILES[@]}"
`;
            const { stdout } = await execFilePromise('bash', ['-c', script], { cwd: root });
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

    it('writes a Prisma GitHub Actions workflow without overwriting an existing file', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'pgfence-prisma-action-'));
        const previousCwd = process.cwd();
        const workflowPath = path.join(root, '.github', 'workflows', 'pgfence-prisma.yml');
        const packageJson = JSON.parse(await readFile(path.join(previousCwd, 'package.json'), 'utf8')) as { version: string };

        try {
            process.chdir(root);
            await installPrismaGitHubAction();

            const workflow = await readFile(workflowPath, 'utf8');
            expect(workflow).toContain('name: Prisma Migration Safety');
            expect(workflow).toContain('prisma/migrations/**/migration.sql');
            expect(workflow).toContain('if [ ! -d prisma/migrations ]; then');
            expect(workflow).toContain('files=()');
            expect(workflow).toContain("find prisma/migrations -path '*/migration.sql' -type f -print0");
            expect(workflow).toContain(`npx --yes @flvmnt/pgfence@${packageJson.version} analyze --format prisma --ci --max-risk medium "\${files[@]}"`);

            await expect(installPrismaGitHubAction()).rejects.toThrow(/already exists/);
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
            expect(error.stderr).toContain('pgfence error:');
            expect(error.stderr).toContain('Invalid risk level: TERROR');
            expect(error.code).toBe(2);
        }
    });

    it('parses --stats-file for size-aware risk scoring', async () => {
        const fs = await import('node:fs/promises');
        const fixture = path.join(fixturesDir, 'safe-migration.sql');
        const statsDir = await mkdtemp(path.join(tmpdir(), 'pgfence-stats-'));
        const statsPath = path.join(statsDir, 'stats.json');
        await fs.writeFile(statsPath, JSON.stringify([{ schemaName: 'public', tableName: 'test', rowCount: 1, totalBytes: 1 }]));

        try {
            const { stdout } = await execPromise(cliCommand(`analyze "${fixture}" --stats-file "${statsPath}"`));
            expect(stdout).toContain('[LOW]');
        } finally {
            await rm(statsDir, { recursive: true, force: true });
        }
    });

    it('rejects a stats file whose later rows are malformed (not just the first)', async () => {
        const fs = await import('node:fs/promises');
        const fixture = path.join(fixturesDir, 'safe-migration.sql');
        const statsDir = await mkdtemp(path.join(tmpdir(), 'pgfence-stats-bad-'));
        const statsPath = path.join(statsDir, 'stats.json');
        // First row valid, second row has no rowCount: must NOT pass validation.
        await fs.writeFile(statsPath, JSON.stringify([
            { schemaName: 'public', tableName: 'ok', rowCount: 1, totalBytes: 1 },
            { schemaName: 'public', tableName: 'huge' },
        ]));

        try {
            let rejected = false;
            try {
                await execPromise(cliCommand(`analyze "${fixture}" --stats-file "${statsPath}"`));
            } catch (err: unknown) {
                rejected = true;
                const e = err as { code?: number; stderr?: string };
                expect(e.code).toBe(2);
                expect(e.stderr ?? '').toMatch(/Invalid stats file format at row 1/);
            }
            expect(rejected).toBe(true);
        } finally {
            await rm(statsDir, { recursive: true, force: true });
        }
    });

    it('lets --db-url override a missing --stats-file', async () => {
        const fixture = path.join(fixturesDir, 'safe-migration.sql');
        const missingStats = path.join(tmpdir(), `pgfence-missing-stats-${Date.now()}.json`);

        try {
            await execPromise(cliCommand(`analyze "${fixture}" --db-url postgres://bad:bad@localhost:0/noexist --stats-file "${missingStats}"`));
            throw new Error('expected analyze to fail on db connection');
        } catch (err: unknown) {
            const error = err as { code?: number; stderr?: string };
            expect(error.code).toBe(2);
            expect(error.stderr ?? '').toContain('pgfence error:');
            expect(error.stderr ?? '').not.toContain('Failed to load stats file');
            expect(error.stderr ?? '').not.toContain(missingStats);
        }
    });
});
