/**
 * Pre-flight hook scaffolding for pgfence cloud submodules.
 *
 * OSS runtime never imports local-only cloud modules. Private builds can
 * register hooks explicitly at startup, and OSS builds simply get no-op hooks.
 */

import type { AnalysisResult, PgfenceConfig } from './types.js';

export interface CloudHooks {
  onAnalysisStart?: (files: string[], config: PgfenceConfig) => Promise<void>;
  onAnalysisComplete?: (results: AnalysisResult[], config: PgfenceConfig) => Promise<void>;
}

let registeredHooks: CloudHooks | null = null;

export function registerCloudHooks(hooks: CloudHooks | null): void {
  registeredHooks = hooks;
}

export async function getCloudHooks(): Promise<CloudHooks> {
  return registeredHooks ?? {};
}
