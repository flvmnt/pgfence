import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function listPublicSourceFiles(): Set<string> {
  const tracked = execFileSync('git', ['ls-files', 'src'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', 'src'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  return new Set(
    `${tracked}\n${untracked}`
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.endsWith('.ts')),
  );
}

function buildSourcePathForArtifact(filePath: string): string {
  return filePath
    .replace(/^dist\//, 'src/')
    .replace(/\.d\.ts\.map$/, '.ts')
    .replace(/\.d\.ts$/, '.ts')
    .replace(/\.js\.map$/, '.ts')
    .replace(/\.js$/, '.ts');
}

function parsePackJson(rawPackJson: string): Array<{ files?: Array<{ path: string }> }> {
  const jsonStart = rawPackJson.search(/\[\s*{/s);
  if (jsonStart === -1) {
    throw new Error('npm pack --json did not emit a JSON payload');
  }
  return JSON.parse(rawPackJson.slice(jsonStart)) as Array<{ files?: Array<{ path: string }> }>;
}

describe('package surface', () => {
  it('only ships dist artifacts backed by tracked public source files', () => {
    expect(existsSync('dist/index.js')).toBe(true);
    expect(existsSync('dist/lsp/server.js')).toBe(true);

    const packJson = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    const pack = parsePackJson(packJson);
    const files = pack.flatMap((entry) => entry.files ?? []).map((file) => file.path);

    const publicSources = listPublicSourceFiles();
    const distArtifacts = files.filter((file) => /^dist\/.+\.(?:js|js\.map|d\.ts|d\.ts\.map)$/.test(file));
    const orphanArtifacts = distArtifacts.filter((file) => !publicSources.has(buildSourcePathForArtifact(file)));

    expect(orphanArtifacts).toEqual([]);
    expect(files.some((file) => file.startsWith('src/'))).toBe(false);
    expect(files.some((file) => file.startsWith('packages/vscode-pgfence/'))).toBe(false);
  });

  it('exports the documented LSP subpath', async () => {
    const lsp = await import('@flvmnt/pgfence/lsp');
    expect(typeof lsp.createServer).toBe('function');
    expect(typeof lsp.startStdioServer).toBe('function');
  });
});
