/**
 * Filter migration file paths by --start-after (skip files older than timestamp).
 */

import { stat } from 'node:fs/promises';

/**
 * Parse --start-after value: ISO date string (e.g. 2024-01-15 or 2024-01-15T00:00:00Z) or Unix ms.
 */
export function parseStartAfter(value: string): number {
  const trimmed = value.trim();
  const asNumber = Number(trimmed);
  if (!Number.isNaN(asNumber) && asNumber > 0) {
    return asNumber;
  }
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid --start-after value: ${value}. Use ISO date or Unix timestamp (ms).`);
  }
  return date.getTime();
}

/**
 * Return only files whose mtime is >= startAfterMs.
 */
export async function filterFilesByStartAfter(
  filePaths: string[],
  startAfterMs: number,
): Promise<string[]> {
  const result: string[] = [];
  for (const fp of filePaths) {
    try {
      const st = await stat(fp);
      if (st.mtimeMs >= startAfterMs) result.push(fp);
    } catch (err) {
      const error = err as { code?: string };
      if (error.code === 'ENOENT') continue;
      throw new Error(`Cannot stat migration file "${fp}": ${error.code ?? err}`);
    }
  }
  return result;
}
