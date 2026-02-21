/**
 * Extractor: Prisma migrations
 *
 * Prisma generates plain SQL files at:
 *   prisma/migrations/<timestamp>_<name>/migration.sql
 *
 * These are standard SQL files, so this delegates to the raw-sql extractor.
 */

import type { ExtractionResult } from '../types.js';
import { extractRawSQL } from './raw-sql.js';

export async function extractPrismaSQL(filePath: string): Promise<ExtractionResult> {
  return extractRawSQL(filePath);
}
