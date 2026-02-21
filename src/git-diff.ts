/**
 * Resolve migration files changed since a git ref (for --git-diff).
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execAsync = promisify(exec);

const MIGRATION_EXTENSIONS = new Set(['.sql', '.ts', '.js']);

/**
 * Return list of file paths that have changed since the given ref and match migration extensions.
 * Runs from cwd. Paths are absolute.
 */
export async function getGitDiffFiles(ref: string, cwd: string, pathspec?: string): Promise<string[]> {
  const pathArg = pathspec ? ` -- ${pathspec}` : ' -- .';
  const { stdout } = await execAsync(`git diff --name-only ${ref}${pathArg}`, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  const lines = stdout.trim() ? stdout.trim().split('\n') : [];
  const absCwd = path.resolve(cwd);
  const result: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const ext = path.extname(trimmed);
    if (!MIGRATION_EXTENSIONS.has(ext)) continue;
    result.push(path.isAbsolute(trimmed) ? trimmed : path.join(absCwd, trimmed));
  }
  return result;
}
