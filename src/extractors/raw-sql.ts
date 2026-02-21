/**
 * Extractor: Raw SQL files (.sql)
 *
 * Reads .sql files and returns the SQL content as-is.
 * Strips UTF-8 BOM if present.
 */

import { readFile } from 'node:fs/promises';
import type { ExtractionResult } from '../types.js';

export async function extractRawSQL(filePath: string): Promise<ExtractionResult> {
  let content = await readFile(filePath, 'utf8');
  // Strip UTF-8 BOM
  if (content.charCodeAt(0) === 0xfeff) {
    content = content.slice(1);
  }
  return { sql: content, warnings: [] };
}
