/**
 * Plugin System — Gap 14
 *
 * Loads external rule and policy plugins from user-specified file paths.
 * Plugin rule IDs must be namespaced with `plugin:` to avoid conflicts.
 */

import type { ParsedStatement } from './parser.js';
import type { CheckResult, PgfenceConfig, PolicyViolation } from './types.js';

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

  for (const pluginPath of paths) {
    const mod = await import(pluginPath);
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
): CheckResult[] {
  const results: CheckResult[] = [];
  for (const rule of pluginRules) {
    try {
      results.push(...rule.check(stmt, config));
    } catch {
      // Plugin errors are swallowed — don't crash the analyzer
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
): PolicyViolation[] {
  const results: PolicyViolation[] = [];
  for (const policy of pluginPolicies) {
    try {
      results.push(...policy.check(stmts, config));
    } catch {
      // Plugin errors are swallowed — don't crash the analyzer
    }
  }
  return results;
}
