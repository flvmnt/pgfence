/**
 * Extractor: Raw SQL files (.sql)
 *
 * Reads .sql files and returns the SQL content as-is.
 * Strips UTF-8 BOM if present.
 */

import type { ExtractionResult } from '../types.js';
import { readTextMigrationFile } from './file-guards.js';

export async function extractRawSQL(filePath: string): Promise<ExtractionResult> {
  return { sql: await readTextMigrationFile(filePath), warnings: [] };
}
