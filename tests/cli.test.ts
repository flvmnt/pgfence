import { describe, it, expect, vi, beforeEach } from 'vitest';
import { exec } from 'child_process';
import util from 'util';
import path from 'path';

const execPromise = util.promisify(exec);
const cliPath = path.join(process.cwd(), 'src', 'index.ts');

describe('CLI tests', () => {
    it('runs default cli analysis', async () => {
        const fixture = path.join(process.cwd(), 'tests', 'fixtures', 'safe-migration.sql');
        const { stdout } = await execPromise(`npx tsx ${cliPath} analyze ${fixture}`);
        expect(stdout).toContain('[LOW]');
    });

    it('runs json output analysis', async () => {
        const fixture = path.join(process.cwd(), 'tests', 'fixtures', 'safe-migration.sql');
        const { stdout } = await execPromise(`npx tsx ${cliPath} analyze --output json ${fixture}`);
        expect(stdout).toContain('"version": "1.0"');
    });

    it('runs github output analysis', async () => {
        const fixture = path.join(process.cwd(), 'tests', 'fixtures', 'safe-migration.sql');
        const { stdout } = await execPromise(`npx tsx ${cliPath} analyze --output github ${fixture}`);
        expect(stdout).toContain('## pgfence Migration Safety Report');
    });

    it('fails on high risk with --ci', async () => {
        const fixture = path.join(process.cwd(), 'tests', 'fixtures', 'dangerous-add-column.sql');

        await expect(execPromise(`npx tsx ${cliPath} analyze --ci --max-risk medium ${fixture}`)).rejects.toThrow();
    });

    it('fails with invalid risk level parsing error', async () => {
        const fixture = path.join(process.cwd(), 'tests', 'fixtures', 'safe-migration.sql');
        try {
            await execPromise(`npx tsx ${cliPath} analyze ${fixture} --max-risk TERROR`);
        } catch (error: any) {
            expect(error.stderr).toContain('Invalid risk level: TERROR');
            expect(error.code).toBe(1);
        }
    });

    it('handles optional cloud CLI arguments properly and parses --stats-file', async () => {
        const fs = await import('node:fs/promises');
        const fixture = path.join(process.cwd(), 'tests', 'fixtures', 'safe-migration.sql');
        await fs.writeFile('test-stats.json', JSON.stringify([{ schemaName: "public", tableName: "test", rowCount: 1, totalBytes: 1 }]));

        try {
            const { stdout } = await execPromise(`npx tsx ${cliPath} analyze ${fixture} --stats-file test-stats.json`);
            expect(stdout).toContain('[LOW]');
        } finally {
            await fs.unlink('test-stats.json').catch(() => { });
        }
    });
});
