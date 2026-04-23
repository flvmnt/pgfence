import { readFile, stat } from 'node:fs/promises';

const DEFAULT_MAX_MIGRATION_BYTES = 10 * 1024 * 1024;

export async function readTextMigrationFile(filePath: string): Promise<string> {
  const stats = await stat(filePath);
  const maxBytes = Number.parseInt(process.env.PGFENCE_MAX_MIGRATION_BYTES ?? '', 10) || DEFAULT_MAX_MIGRATION_BYTES;

  if (stats.size > maxBytes) {
    throw new Error(
      `Migration file is too large to analyze safely (${stats.size} bytes, limit ${maxBytes} bytes): ${filePath}`,
    );
  }

  const content = await readFile(filePath, 'utf8');
  if (content.includes('\0')) {
    throw new Error(`Migration file appears to be binary or contains NUL bytes: ${filePath}`);
  }

  return stripUtf8Bom(content);
}

export function stripUtf8Bom(content: string): string {
  if (content.charCodeAt(0) === 0xfeff) {
    return content.slice(1);
  }
  return content;
}
