import type { AnalysisResult, PgfenceConfig } from './types.js';

export interface AnalysisHooks {
  onAnalysisStart?: (files: string[], config: PgfenceConfig) => Promise<void>;
  onAnalysisComplete?: (results: AnalysisResult[], config: PgfenceConfig) => Promise<void>;
}

let registeredHooks: AnalysisHooks | null = null;

export function registerAnalysisHooks(hooks: AnalysisHooks | null): void {
  registeredHooks = hooks;
}

export async function getAnalysisHooks(): Promise<AnalysisHooks> {
  return registeredHooks ?? {};
}
