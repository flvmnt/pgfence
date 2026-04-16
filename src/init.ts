import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';

const execFileAsync = promisify(execFile);

const PRE_COMMIT_HOOK_CONTENT = `#!/bin/sh
# pgfence pre-commit hook
# Block commits that introduce high-risk database migrations
# Customize the migrations path below to match your project layout.

echo "Running pgfence safety checks..."

if [ -x ./node_modules/.bin/pgfence ]; then
  ./node_modules/.bin/pgfence analyze --ci --max-risk medium migrations/*.sql
elif command -v pgfence >/dev/null 2>&1; then
  pgfence analyze --ci --max-risk medium migrations/*.sql
else
  echo "pgfence not found. Install it: npm install -D @flvmnt/pgfence"
  exit 1
fi

if [ $? -ne 0 ]; then
  echo "pgfence found dangerous migrations. Fix them or use an exemption."
  exit 1
fi
`;

export async function installHooks(): Promise<void> {
  const cwd = process.cwd();
  const huskyPath = join(cwd, '.husky');

  let targetDir: string;
  let usingHusky = false;

  if (existsSync(huskyPath)) {
    targetDir = huskyPath;
    usingHusky = true;
  } else {
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--git-path', 'hooks'], { cwd });
      targetDir = resolve(cwd, stdout.trim());
      if (!targetDir) {
        throw new Error('git did not return a hooks directory');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Neither .husky nor a git hooks directory could be resolved. Are you in a git repository? ${message}`);
    }
  }

  const hookFile = join(targetDir, 'pre-commit');

  let existingContent = '';
  try {
    existingContent = await readFile(hookFile, 'utf8');
  } catch (err: unknown) {
    const error = err as { code?: string };
    if (error.code !== 'ENOENT') throw err;
  }

  if (existingContent.includes('pgfence analyze')) {
    console.log(`✅ pgfence pre-commit hook is already installed in ${targetDir}`);
    return;
  }

  const existingBody = existingContent.replace(/^#![^\n]*\n?/, '');
  const newContent = existingBody
    ? `${PRE_COMMIT_HOOK_CONTENT}\n# Existing pre-commit hook preserved below\n${existingBody}`
    : PRE_COMMIT_HOOK_CONTENT;

  await mkdir(targetDir, { recursive: true });
  await writeFile(hookFile, newContent);
  await chmod(hookFile, '755');

  console.log(`✅ pgfence pre-commit hook installed successfully in ${targetDir}`);
  if (usingHusky) {
    console.log('💡 Note: You are using husky. Ensure husky is installed and enabled.');
  }
}
