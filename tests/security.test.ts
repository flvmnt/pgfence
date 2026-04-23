import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfigFile } from '../src/config.js';
import { getAnalysisHooks, registerAnalysisHooks } from '../src/analysis-hooks.js';
import { RiskLevel } from '../src/types.js';

async function makeRepoLocalTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(process.cwd(), prefix));
}

async function collectTypeScriptFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'cloud' || entry.name === 'agent') {
        continue;
      }
      files.push(...await collectTypeScriptFiles(fullPath));
      continue;
    }

    if (entry.isFile() && fullPath.endsWith('.ts')) {
      files.push(fullPath);
    }
  }

  return files;
}

describe('security boundaries', () => {
  afterEach(() => {
    registerAnalysisHooks(null);
  });

  it('does not inherit config from ancestor directories', async () => {
    const root = await makeRepoLocalTempDir('.pgfence-config-');
    const nested = path.join(root, 'nested', 'workspace');
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(root, '.pgfence.json'), JSON.stringify({ output: 'json', 'max-risk': 'low' }), 'utf8');

    try {
      expect(await loadConfigFile(nested)).toBeNull();
      const config = await loadConfigFile(root);
      expect(config).not.toBeNull();
      expect(config?.output).toBe('json');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects symlinked config files that resolve outside the workspace', async () => {
    const root = await makeRepoLocalTempDir('.pgfence-config-link-');
    const outsideRoot = await makeRepoLocalTempDir('.pgfence-config-outside-');
    const outsideConfig = path.join(outsideRoot, '.pgfence.json');
    const linkedConfig = path.join(root, '.pgfence.json');

    await writeFile(outsideConfig, JSON.stringify({ output: 'json' }), 'utf8');
    await symlink(outsideConfig, linkedConfig);

    try {
      await expect(loadConfigFile(root)).rejects.toThrow('resolves outside the current directory');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it('rejects config files with unsupported enum values', async () => {
    const root = await makeRepoLocalTempDir('.pgfence-config-invalid-output-');
    await writeFile(path.join(root, '.pgfence.json'), JSON.stringify({ output: 'xml' }), 'utf8');

    try {
      await expect(loadConfigFile(root)).rejects.toThrow('"output" must be one of');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects config files with malformed plugin lists', async () => {
    const root = await makeRepoLocalTempDir('.pgfence-config-invalid-plugins-');
    await writeFile(path.join(root, '.pgfence.json'), JSON.stringify({ plugins: ['ok.mjs', ''] }), 'utf8');

    try {
      await expect(loadConfigFile(root)).rejects.toThrow('"plugins" must be an array of non-empty strings');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects invalid config values instead of silently falling back to defaults', async () => {
    const root = await makeRepoLocalTempDir('.pgfence-config-invalid-');
    await writeFile(path.join(root, '.pgfence.json'), JSON.stringify({ 'max-risk': 'severe' }), 'utf8');

    try {
      await expect(loadConfigFile(root)).rejects.toThrow('"max-risk" must be one of');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects non-array plugin config entries', async () => {
    const root = await makeRepoLocalTempDir('.pgfence-config-plugins-');
    await writeFile(path.join(root, '.pgfence.json'), JSON.stringify({ plugins: './plugin.mjs' }), 'utf8');

    try {
      await expect(loadConfigFile(root)).rejects.toThrow('"plugins" must be an array of non-empty strings');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects symlinked plugins that resolve outside the project root', async () => {
    const projectRoot = await makeRepoLocalTempDir('.pgfence-plugin-');
    const outsideRoot = await mkdtemp(path.join(tmpdir(), 'pgfence-plugin-outside-'));
    const pluginFile = path.join(outsideRoot, 'escape.mjs');
    const symlinkPath = path.join(projectRoot, 'escape.mjs');

    await writeFile(
      pluginFile,
      `export default {
        name: 'escape',
        rules: [
          {
            ruleId: 'plugin:escape',
            check() {
              return [];
            },
          },
        ],
      };`,
      'utf8',
    );
    await symlink(pluginFile, symlinkPath);

    const previousCwd = process.cwd();
    process.chdir(projectRoot);
    try {
      const { loadPlugins } = await import('../src/plugins.js');
      await expect(loadPlugins(['escape.mjs'])).rejects.toThrow('resolves outside the project directory');
    } finally {
      process.chdir(previousCwd);
      await rm(projectRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it('loads plugin files that stay inside the project root', async () => {
    const projectRoot = await makeRepoLocalTempDir('.pgfence-plugin-ok-');
    const pluginFile = path.join(projectRoot, 'ok.mjs');
    await writeFile(
      pluginFile,
      `export default {
        name: 'ok-plugin',
        rules: [
          {
            ruleId: 'plugin:ok',
            check() {
              return [];
            },
          },
        ],
      };`,
      'utf8',
    );

    const previousCwd = process.cwd();
    process.chdir(projectRoot);
    try {
      const { loadPlugins } = await import('../src/plugins.js');
      const loaded = await loadPlugins(['ok.mjs']);
      expect(loaded.rules).toHaveLength(1);
      expect(loaded.rules[0].ruleId).toBe('plugin:ok');
    } finally {
      process.chdir(previousCwd);
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it.each(['.ts', '.mts'])('rejects %s plugin files in the shipped binary', async (extension) => {
    const projectRoot = await makeRepoLocalTempDir('.pgfence-plugin-ts-');
    const pluginFile = path.join(projectRoot, `plugin${extension}`);
    await writeFile(
      pluginFile,
      `export default {
        name: 'ts-plugin',
        rules: [
          {
            ruleId: 'plugin:ts',
            check() {
              return [];
            },
          },
        ],
      };`,
      'utf8',
    );

    const previousCwd = process.cwd();
    process.chdir(projectRoot);
    try {
      const { loadPlugins } = await import('../src/plugins.js');
      await expect(loadPlugins([`plugin${extension}`])).rejects.toThrow(`unsupported extension "${extension}"`);
    } finally {
      process.chdir(previousCwd);
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects malformed plugin rule entries', async () => {
    const projectRoot = await makeRepoLocalTempDir('.pgfence-plugin-malformed-');
    const pluginFile = path.join(projectRoot, 'bad.mjs');
    await writeFile(
      pluginFile,
      `export default {
        name: 'bad-plugin',
        rules: [
          {
            ruleId: 'plugin:bad',
          },
        ],
      };`,
      'utf8',
    );

    const previousCwd = process.cwd();
    process.chdir(projectRoot);
    try {
      const { loadPlugins } = await import('../src/plugins.js');
      await expect(loadPlugins(['bad.mjs'])).rejects.toThrow('must export { ruleId, check }');
    } finally {
      process.chdir(previousCwd);
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects malformed plugin entries with a descriptive error', async () => {
    const projectRoot = await makeRepoLocalTempDir('.pgfence-plugin-bad-shape-');
    const pluginFile = path.join(projectRoot, 'bad.mjs');
    await writeFile(
      pluginFile,
      `export default {
        name: 'bad-plugin',
        rules: [{}],
      };`,
      'utf8',
    );

    const previousCwd = process.cwd();
    process.chdir(projectRoot);
    try {
      const { loadPlugins } = await import('../src/plugins.js');
      await expect(loadPlugins(['bad.mjs'])).rejects.toThrow('must export { ruleId, check }');
    } finally {
      process.chdir(previousCwd);
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('keeps analysis hooks explicit and opt-in', async () => {
    const hooks = await getAnalysisHooks();
    expect(hooks.onAnalysisStart).toBeUndefined();
    expect(hooks.onAnalysisComplete).toBeUndefined();

    const started: string[] = [];
    registerAnalysisHooks({
      onAnalysisStart: async (files) => {
        started.push(...files);
      },
    });

    const registered = await getAnalysisHooks();
    await registered.onAnalysisStart?.(['fixture.sql'], {
      format: 'sql',
      output: 'cli',
      minPostgresVersion: 14,
      maxAllowedRisk: RiskLevel.HIGH,
      requireLockTimeout: true,
      requireStatementTimeout: true,
    });

    expect(started).toEqual(['fixture.sql']);
  });

  it('keeps public source files free of local-only cloud or agent imports', async () => {
    const sourceFiles = await collectTypeScriptFiles(path.join(process.cwd(), 'src'));
    const forbiddenReference = /from ['"]\.\.?\/(?:cloud|agent)\//;
    const forbiddenDynamicImport = /import\(['"]\.\.?\/(?:cloud|agent)\//;

    for (const sourceFile of sourceFiles) {
      const content = await readFile(sourceFile, 'utf8');
      expect(content).not.toMatch(forbiddenReference);
      expect(content).not.toMatch(forbiddenDynamicImport);
    }
  });
});
