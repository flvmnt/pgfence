import { existsSync } from 'node:fs';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';

const PRE_COMMIT_HOOK_CONTENT = `#!/bin/sh
# pgfence pre-commit hook
# Block commits that introduce high-risk database migrations

echo "🔍 Running pgfence safety checks..."
npx @flvmnt/pgfence analyze --ci --max-risk medium migrations/*.sql

if [ $? -ne 0 ]; then
  echo "❌ pgfence found dangerous migrations! Please fix them or use an exemption."
  exit 1
fi
`;

export async function installHooks(): Promise<void> {
    const cwd = process.cwd();
    const huskyPath = join(cwd, '.husky');
    const gitHooksPath = join(cwd, '.git', 'hooks');

    let targetDir: string;
    let usingHusky = false;

    if (existsSync(huskyPath)) {
        targetDir = huskyPath;
        usingHusky = true;
    } else if (existsSync(join(cwd, '.git'))) {
        if (!existsSync(gitHooksPath)) {
            await mkdir(gitHooksPath, { recursive: true });
        }
        targetDir = gitHooksPath;
    } else {
        throw new Error('Neither .husky nor .git directory found. Are you in a git repository?');
    }

    const hookFile = join(targetDir, 'pre-commit');

    let existingContent = '';
    try {
        const { readFile } = await import('node:fs/promises');
        existingContent = await readFile(hookFile, 'utf8');
    } catch (err: unknown) {
        const error = err as { code?: string };
        if (error.code !== 'ENOENT') throw err;
    }

    if (existingContent.includes('pgfence analyze')) {
        console.log(`✅ pgfence pre-commit hook is already installed in ${targetDir}`);
        return;
    }

    const newContent = existingContent
        ? existingContent + '\n' + PRE_COMMIT_HOOK_CONTENT.replace('#!/bin/sh\n', '')
        : PRE_COMMIT_HOOK_CONTENT;

    await writeFile(hookFile, newContent);
    await chmod(hookFile, '755');

    console.log(`✅ pgfence pre-commit hook installed successfully in ${targetDir}`);
    if (usingHusky) {
        console.log('💡 Note: You are using husky. Ensure husky is installed and enabled.');
    }
}
