import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfigFile } from '../src/config.js';
import { getCloudHooks, registerCloudHooks } from '../src/cloud-hooks.js';
import { RiskLevel } from '../src/types.js';

async function makeRepoLocalTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(process.cwd(), prefix));
}

describe('security boundaries', () => {
  afterEach(() => {
    registerCloudHooks(null);
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

  it('keeps cloud hooks explicit and opt-in', async () => {
    const hooks = await getCloudHooks();
    expect(hooks.onAnalysisStart).toBeUndefined();
    expect(hooks.onAnalysisComplete).toBeUndefined();

    const started: string[] = [];
    registerCloudHooks({
      onAnalysisStart: async (files) => {
        started.push(...files);
      },
    });

    const registered = await getCloudHooks();
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
});
