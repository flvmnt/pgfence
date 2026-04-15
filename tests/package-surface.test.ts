import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';

function listTrackedSourceFiles(): Set<string> {
  const stdout = execFileSync('git', ['ls-files', 'src'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  return new Set(
    stdout
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

describe('package surface', () => {
  it('only ships dist artifacts backed by tracked public source files', () => {
    const packJson = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    const pack = JSON.parse(packJson) as Array<{
      files?: Array<{ path: string }>;
    }>;
    const files = pack.flatMap((entry) => entry.files ?? []).map((file) => file.path);

    const trackedSources = listTrackedSourceFiles();
    const distArtifacts = files.filter((file) => /^dist\/.+\.(?:js|js\.map|d\.ts|d\.ts\.map)$/.test(file));
    const orphanArtifacts = distArtifacts.filter((file) => !trackedSources.has(buildSourcePathForArtifact(file)));

    expect(orphanArtifacts).toEqual([]);
  });
});
