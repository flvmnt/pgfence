/**
 * Plugin System: Gap 14
 *
 * Loads external rule and policy plugins from user-specified file paths.
 * Plugin rule IDs must be namespaced with `plugin:` to avoid conflicts.
 */

import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ParsedStatement } from './parser.js';
import type { CheckResult, ExtractionWarning, PgfenceConfig, PolicyViolation } from './types.js';

const ALLOWED_PLUGIN_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts']);

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export interface PgfencePluginRule {
  ruleId: string;
  check(stmt: ParsedStatement, config: PgfenceConfig): CheckResult[];
}

export interface PgfencePluginPolicy {
  ruleId: string;
  check(stmts: ParsedStatement[], config: PgfenceConfig): PolicyViolation[];
}

export interface PgfencePlugin {
  name: string;
  rules?: PgfencePluginRule[];
  policies?: PgfencePluginPolicy[];
}

export interface LoadedPlugins {
  rules: PgfencePluginRule[];
  policies: PgfencePluginPolicy[];
}

/**
 * Load plugins from file paths.
 * Validates shape and enforces `plugin:` namespace on rule IDs.
 */
export async function loadPlugins(paths: string[]): Promise<LoadedPlugins> {
  const rules: PgfencePluginRule[] = [];
  const policies: PgfencePluginPolicy[] = [];
  const seenIds = new Set<string>();
  const projectRoot = await realpath(process.cwd());

  for (const pluginPath of paths) {
    // Resolve relative to cwd, then collapse symlinks so the real target
    // must also stay inside the trusted project root.
    const resolved = path.resolve(projectRoot, pluginPath);
    let realPluginPath: string;
    try {
      realPluginPath = await realpath(resolved);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Plugin "${pluginPath}" could not be resolved: ${message}`);
    }

    // Prevent loading plugins from outside the project directory, including
    // symlink escapes that resolve to a path outside the repo root.
    if (!isWithinRoot(projectRoot, realPluginPath)) {
      throw new Error(
        `Plugin "${pluginPath}" resolves outside the project directory. ` +
        `For security, plugins must be within the project root.`,
      );
    }

    const ext = path.extname(realPluginPath).toLowerCase();
    if (!ALLOWED_PLUGIN_EXTENSIONS.has(ext)) {
      throw new Error(
        `Plugin "${pluginPath}" has unsupported extension "${ext}". ` +
        `Allowed: ${[...ALLOWED_PLUGIN_EXTENSIONS].join(', ')}`,
      );
    }
    const mod = await import(pathToFileURL(realPluginPath).href);
    const plugin: PgfencePlugin = mod.default ?? mod;

    if (!plugin.name || typeof plugin.name !== 'string') {
      throw new Error(`Plugin at ${pluginPath} must export a "name" string`);
    }

    for (const rule of plugin.rules ?? []) {
      if (!rule.ruleId.startsWith('plugin:')) {
        throw new Error(
          `Plugin "${plugin.name}" rule "${rule.ruleId}" must be namespaced with "plugin:" prefix`,
        );
      }
      if (seenIds.has(rule.ruleId)) {
        throw new Error(
          `Duplicate rule ID "${rule.ruleId}" across plugins`,
        );
      }
      seenIds.add(rule.ruleId);
      rules.push(rule);
    }

    for (const policy of plugin.policies ?? []) {
      if (!policy.ruleId.startsWith('plugin:')) {
        throw new Error(
          `Plugin "${plugin.name}" policy "${policy.ruleId}" must be namespaced with "plugin:" prefix`,
        );
      }
      if (seenIds.has(policy.ruleId)) {
        throw new Error(
          `Duplicate policy ID "${policy.ruleId}" across plugins`,
        );
      }
      seenIds.add(policy.ruleId);
      policies.push(policy);
    }
  }

  return { rules, policies };
}

/**
 * Run plugin rules on a statement. Errors are caught per-plugin (don't crash analyzer).
 */
export function runPluginRules(
  pluginRules: PgfencePluginRule[],
  stmt: ParsedStatement,
  config: PgfenceConfig,
  warnings: ExtractionWarning[],
  filePath: string,
): CheckResult[] {
  const results: CheckResult[] = [];
  for (const rule of pluginRules) {
    try {
      results.push(...rule.check(stmt, config));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`pgfence: plugin rule "${rule.ruleId}" threw: ${message}\n`);
      warnings.push({
        filePath,
        message: `Plugin rule "${rule.ruleId}" crashed: ${message}. This rule's checks were skipped.`,
      });
    }
  }
  return results;
}

/**
 * Run plugin policies on all statements. Errors are caught per-plugin.
 */
export function runPluginPolicies(
  pluginPolicies: PgfencePluginPolicy[],
  stmts: ParsedStatement[],
  config: PgfenceConfig,
  warnings: ExtractionWarning[],
  filePath: string,
): PolicyViolation[] {
  const results: PolicyViolation[] = [];
  for (const policy of pluginPolicies) {
    try {
      results.push(...policy.check(stmts, config));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`pgfence: plugin policy "${policy.ruleId}" threw: ${message}\n`);
      warnings.push({
        filePath,
        message: `Plugin policy "${policy.ruleId}" crashed: ${message}. This policy's checks were skipped.`,
      });
    }
  }
  return results;
}
