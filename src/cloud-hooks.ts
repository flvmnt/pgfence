/**
 * Pre-flight hook scaffolding for pgfence cloud submodules.
 *
 * This module dynamically attempts to load the proprietary `cloud/` and `agent/`
 * integrations if they are present in the filesystem. If they are absent (standard open-source usage),
 * it fails silently and returns no-op hooks.
 */

import type { AnalysisResult, PgfenceConfig } from './types.js';

export interface CloudHooks {
    onAnalysisStart?: (files: string[], config: PgfenceConfig) => Promise<void>;
    onAnalysisComplete?: (results: AnalysisResult[], config: PgfenceConfig) => Promise<void>;
}

let cachedHooks: CloudHooks | null = null;

export async function getCloudHooks(): Promise<CloudHooks> {
    if (cachedHooks !== null) {
        return cachedHooks;
    }

    const hooks: CloudHooks = {};

    try {
        // Attempt to load the cloud integration entrypoint
        // We use a dynamic import with a catch to prevent startup crashes when the folder is missing
        // @ts-expect-error - The cloud directory is local-only and excluded from git
        const cloudModule = await import('./cloud/index.js');
        if (cloudModule && cloudModule.hooks) {
            if (typeof cloudModule.hooks.onAnalysisStart === 'function') {
                hooks.onAnalysisStart = cloudModule.hooks.onAnalysisStart;
            }
            if (typeof cloudModule.hooks.onAnalysisComplete === 'function') {
                hooks.onAnalysisComplete = cloudModule.hooks.onAnalysisComplete;
            }
        }
    } catch (err: unknown) {
        // MODULE_NOT_FOUND or ERR_MODULE_NOT_FOUND is expected in OS mode.
        // Anything else might be a compilation error inside the cloud module.
        const error = err as { code?: string, message?: string };
        const isNotFound = error.code === 'MODULE_NOT_FOUND' || error.code === 'ERR_MODULE_NOT_FOUND';
        if (!isNotFound && process.env.DEBUG) {
            console.warn('pgfence [debug]: Failed to load cloud hooks:', error.message);
        }
    }

    cachedHooks = hooks;
    return hooks;
}
