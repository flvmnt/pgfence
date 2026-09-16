/**
 * Regression suite for issue #2: pgfence exiting 0 with zero bytes and zero analysis.
 *
 * Three defects are covered, because they are one defect wearing three hats:
 *  1. The entry-point guard in dist/index.js compared a lexical path against an
 *     already-realpath-resolved one, so ANY symlink anywhere in the launch path made the
 *     CLI fall off the end of the module: exit 0, zero bytes, nothing analyzed. That is
 *     every npm/pnpm/yarn bin, every npx cache entry, and pgfence's own GitHub Action.
 *  2. dist/lsp/server.js carried its own copy of the same comparison, so an editor saw a
 *     server that started and died silently, which reads as "no problems found".
 *  3. A run that analyzed zero SQL statements reported SAFE at "Coverage: 100%" and
 *     exited 0, which is the Trust Contract's "false safety implied" failure verbatim.
 *
 * Two rules govern every assertion below.
 *
 * FIRST: never assert on an exit code alone. The exit code is precisely what this bug
 * faked. Every test that expects a finding asserts on the reported CONTENT first and the
 * exit code second, so a build that exits 1 for an unrelated reason cannot pass.
 *
 * SECOND: everything here runs the REAL built artifacts in dist/. tests/cli.test.ts falls
 * back to `npx tsx src/index.ts` when dist/ is absent; that fallback is deliberately NOT
 * used here, because tsx resolves and loads the entry differently and the bug is entirely
 * about how the SHIPPED file is entered. Without a build these suites skip, and the skip
 * is announced loudly on stderr and turned into a hard failure under CI, because a
 * silently skipped regression test is the same failure mode as a silently green CI gate.
 */

import { describe, it, expect } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import util from 'node:util';
import path from 'node:path';
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

// execFile, not exec: every path here lives in a temp directory, and an argv array has no
// shell quoting to get wrong. tests/cli.test.ts already uses this form for git.
const execFilePromise = util.promisify(execFile);

const repoRoot = process.cwd();
const distCliPath = path.resolve(repoRoot, 'dist', 'index.js');
const distDir = path.dirname(distCliPath);
const distEntryPoint = path.resolve(repoRoot, 'dist', 'entry-point.js');
const distLspPath = path.resolve(repoRoot, 'dist', 'lsp', 'server.js');
const hasBuiltCli = existsSync(distCliPath) && existsSync(distLspPath);

/** A CI marker set to anything that is not empty, '0' or 'false'. */
const ciValue = process.env.CI;
const runningInCI =
  typeof ciValue === 'string' && !['', '0', 'false'].includes(ciValue.trim().toLowerCase());

let symlinkSkipReason = '';
function probeSymlinkSupport(): boolean {
  let dir: string | undefined;
  try {
    dir = mkdtempSync(path.join(tmpdir(), 'pgfence-symlink-probe-'));
    const target = path.join(dir, 'target.txt');
    writeFileSync(target, 'x', 'utf8');
    symlinkSync(target, path.join(dir, 'link.txt'));
    return true;
  } catch (err) {
    // Windows without Developer Mode or SeCreateSymbolicLinkPrivilege throws EPERM here.
    // Swallowed on purpose and recorded, never rethrown: an unprivileged runner is an
    // environment fact, not a product failure. The reason is printed in the banner below
    // and asserted on in the preconditions, so the skip can never be silent.
    symlinkSkipReason = err instanceof Error ? err.message : String(err);
    return false;
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}
const canSymlink = probeSymlinkSupport();

const BUILD_REQUIRED =
  'tests/entry-point.test.ts needs the real built artifacts (dist/index.js and ' +
  'dist/lsp/server.js). These tests verify how the SHIPPED entry point is launched, so ' +
  'the npx tsx fallback used elsewhere in the suite would prove nothing. Run: pnpm build';

// Announced at module load, not only from inside a test, so the reason survives any
// reporter that collapses skipped tests into a single line.
if (!hasBuiltCli || !canSymlink) {
  const lines = ['', 'pgfence regression suite (tests/entry-point.test.ts) is SKIPPING tests:'];
  if (!hasBuiltCli) {
    lines.push(`  - dist/ is missing or incomplete. ${BUILD_REQUIRED}`);
    lines.push('    Skipped: symlink launch guard, LSP guard, import boundary, zero-analysis gate.');
  }
  if (!canSymlink) {
    lines.push(`  - symlinks cannot be created here: ${symlinkSkipReason}`);
    lines.push('    Skipped: every symlinked-launcher test, which is the issue #2 regression itself.');
  }
  lines.push('');
  process.stderr.write(lines.join('\n'));
}

const CLEAN_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  NO_COLOR: '1',
  FORCE_COLOR: '0',
  // Belt and braces: telemetry already disables itself under a test runner. Pinning it
  // off keeps every stderr assertion below about pgfence's own diagnostics.
  PGFENCE_TELEMETRY: '0',
};

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run `node <entry> <args...>` and return the outcome.
 *
 * execFile REJECTS on a non-zero exit, and here a non-zero exit is the expected result
 * rather than a failure, so the rejection is caught and turned into data. This is the
 * same idiom tests/cli.test.ts uses inline (`const error = err as { code?: number }`),
 * hoisted into one helper because almost every test in this file needs it.
 */
async function runNode(
  entry: string,
  args: string[],
  cwd: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFilePromise(process.execPath, [entry, ...args], {
      cwd,
      env: { ...CLEAN_ENV, ...extraEnv },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const error = err as { code?: number; stdout?: string; stderr?: string };
    return { code: error.code ?? -1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

/** Temp workspace holding a CRITICAL fixture (bad.sql), plus any extra files requested. */
async function makeWorkspace(files: Record<string, string> = {}): Promise<string> {
  // realpath, not the raw mkdtemp result: on macOS os.tmpdir() is /var/folders/... which
  // is a symlink to /private/var/folders/..., so a RELATIVE symlink written below would
  // need one more '..' than a lexical path.relative() produces. Resolving the workspace
  // once keeps every path in this file honest. It does not weaken the tests: the entry
  // paths under test are made symlinked deliberately, one link at a time.
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'pgfence-entry-')));
  await writeFile(path.join(dir, 'bad.sql'), 'DROP TABLE users;\n', 'utf8');
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
  return dir;
}

/**
 * Remove the workspace.
 *
 * `links` are unlinked first. fs.rm(recursive) already lstats and unlinks a symlink
 * instead of descending into it, so this is redundant by design: these workspaces contain
 * links that point INTO the repository, and one defensive line is a cheap price for
 * never discovering otherwise.
 */
async function cleanupWorkspace(dir: string, links: string[] = []): Promise<void> {
  for (const link of links) {
    await rm(link, { force: true });
  }
  await rm(dir, { recursive: true, force: true });
}

function parseJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    // Rethrown, never swallowed: unparseable stdout is exactly what these assertions
    // exist to catch, and the raw bytes are the only thing that identifies which of
    // truncation, a stray diagnostic, or an empty stream happened.
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${label}: stdout was not parseable JSON (${message}). Raw stdout:\n${raw}`);
  }
}

interface JsonReport {
  version: string;
  coverage: {
    totalStatements: number;
    analyzedStatements: number;
    dynamicStatements: number;
    coveragePercent: number | null;
    analyzedNothing: boolean;
    filesWithNoStatements: string[];
  };
  results: Array<{
    filePath: string;
    statementCount: number;
    maxRisk: string;
    policyViolations: Array<{ ruleId: string; severity: string }>;
  }>;
}

interface SarifReport {
  version: string;
  runs: Array<{
    tool: { driver: { rules: Array<{ id: string; helpUri?: string }> } };
    results: Array<{ ruleId: string; level: string; message: { text: string } }>;
    properties: {
      coverageSummary: {
        analyzedNothing: boolean;
        coveragePercent: number | null;
        filesWithNoStatements: string[];
      };
    };
  }>;
}

interface GitLabViolation {
  description: string;
  check_name: string;
  severity: string;
  fingerprint: string;
}

describe('entry point preconditions', () => {
  it('has a built CLI and LSP server to test against (hard requirement under CI)', () => {
    if (!hasBuiltCli && runningInCI) {
      throw new Error(BUILD_REQUIRED);
    }
    expect(hasBuiltCli || !runningInCI).toBe(true);
  });

  it('can create symlinks on this platform (hard requirement on POSIX)', () => {
    if (process.platform === 'win32' && !canSymlink) {
      // Not a product bug: Windows needs Developer Mode or SeCreateSymbolicLinkPrivilege.
      // The recorded reason is what keeps the skip explicit rather than invisible.
      expect(symlinkSkipReason).not.toBe('');
      return;
    }
    expect(canSymlink).toBe(true);
  });
});

describe.skipIf(!hasBuiltCli || !canSymlink)('CLI entry through symlinked launchers', () => {
  it('analyzes and fails correctly when launched through a bin file symlink', async () => {
    const work = await makeWorkspace();
    const link = path.join(work, 'bin', 'pgfence');
    try {
      await mkdir(path.dirname(link), { recursive: true });
      await symlink(distCliPath, link);

      const run = await runNode(link, ['analyze', '--ci', 'bad.sql'], work);

      // Content first, exit code last. A silent exit 1 would be just as broken as the
      // silent exit 0 this suite exists to prevent: the report is the product.
      expect(run.stdout).toContain('[CRITICAL]');
      expect(run.stdout).toContain('drop-table');
      expect(run.stdout).toContain('Analyzed 1 SQL statement');
      expect(run.stderr).toBe(
        'pgfence: Enforce this as a required check that cannot be bypassed locally: https://pgfence.com\n',
      );
      expect(run.code).toBe(1);
    } finally {
      await cleanupWorkspace(work, [link]);
    }
  });

  it('analyzes correctly through a relative node_modules/.bin symlink (npm and yarn shape)', async () => {
    const work = await makeWorkspace();
    const link = path.join(work, 'node_modules', '.bin', 'pgfence');
    try {
      await mkdir(path.dirname(link), { recursive: true });
      // npm writes a RELATIVE link. path.resolve(argv[1]) turns it into a path that
      // exists but is not the module's own, which is the lexical trap behind issue #2.
      await symlink(path.relative(path.dirname(link), distCliPath), link);

      const run = await runNode(link, ['analyze', '--ci', 'bad.sql'], work);

      expect(run.stdout).toContain('[CRITICAL]');
      expect(run.stdout).toContain('Analyzed 1 SQL statement');
      expect(run.code).toBe(1);
    } finally {
      await cleanupWorkspace(work, [link]);
    }
  });

  it('analyzes correctly when a parent directory in the path is a symlink', async () => {
    // A distinct failure mode from a symlinked file: nothing in the path the user typed
    // is a link except a DIRECTORY component, which path.resolve cannot see at all. This
    // is the shape of a symlinked node_modules, a Jenkins workspace link, a Docker bind
    // mount, and macOS /tmp -> /private/tmp.
    const work = await makeWorkspace();
    const linkedDist = path.join(work, 'linkeddist');
    try {
      await symlink(distDir, linkedDist, 'dir');

      const run = await runNode(path.join(linkedDist, 'index.js'), ['analyze', '--ci', 'bad.sql'], work);

      expect(run.stdout).toContain('[CRITICAL]');
      expect(run.stdout).toContain('Analyzed 1 SQL statement');
      expect(run.code).toBe(1);
    } finally {
      await cleanupWorkspace(work, [linkedDist]);
    }
  });

  it('analyzes correctly through a pnpm-shaped package symlink into a store', async () => {
    // pnpm's node_modules/@flvmnt/pgfence is itself a symlink into node_modules/.pnpm,
    // so even the "invoke dist/index.js directly" workaround from issue #2 stays broken
    // for pnpm users. Two hops here, exactly as pnpm lays it out.
    const work = await makeWorkspace();
    const storePkg = path.join(
      work, 'node_modules', '.pnpm', '@flvmnt+pgfence@0.8.0', 'node_modules', '@flvmnt', 'pgfence',
    );
    const storeDistLink = path.join(storePkg, 'dist');
    const pkgLink = path.join(work, 'node_modules', '@flvmnt', 'pgfence');
    try {
      await mkdir(storePkg, { recursive: true });
      await symlink(distDir, storeDistLink, 'dir');
      await mkdir(path.dirname(pkgLink), { recursive: true });
      await symlink(path.relative(path.dirname(pkgLink), storePkg), pkgLink, 'dir');

      const run = await runNode(path.join(pkgLink, 'dist', 'index.js'), ['analyze', '--ci', 'bad.sql'], work);

      expect(run.stdout).toContain('[CRITICAL]');
      expect(run.stdout).toContain('drop-table');
      expect(run.code).toBe(1);
    } finally {
      await cleanupWorkspace(work, [pkgLink, storeDistLink]);
    }
  });

  it('analyzes correctly when argv[1] is the package DIRECTORY, not a file', async () => {
    // `node ./node_modules/@flvmnt/pgfence` is legal: Node reads that directory's
    // package.json "main" and starts dist/index.js, but leaves argv[1] as the directory.
    // No comparison of two paths can reconcile a directory with a file, so the guard has
    // to redo the resolution Node did. Without that it says "not the entry point" and the
    // CLI exits 0 having analyzed nothing, which is issue #2 with a different trigger.
    const work = await makeWorkspace();
    const pkgLink = path.join(work, 'node_modules', '@flvmnt', 'pgfence');
    try {
      await mkdir(path.dirname(pkgLink), { recursive: true });
      await symlink(repoRoot, pkgLink, 'dir');

      const run = await runNode(pkgLink, ['analyze', '--ci', 'bad.sql'], work);

      expect(run.stdout).toContain('[CRITICAL]');
      expect(run.stdout).toContain('drop-table');
      expect(run.stdout).toContain('Analyzed 1 SQL statement');
      expect(run.code).toBe(1);
    } finally {
      await cleanupWorkspace(work, [pkgLink]);
    }
  });

  it('analyzes correctly when argv[1] is a dist DIRECTORY with no package.json', async () => {
    // The other half of the directory case: no package.json next to the entry at all, so
    // Node falls back to <dir>/index.js. `node ./node_modules/@flvmnt/pgfence/dist` is
    // what a hand-written CI step produces, and it was silent on every runtime without
    // import.meta.main, which is every Node 20 and every Node 22 before 22.18.
    const work = await makeWorkspace();
    const linkedDist = path.join(work, 'linkeddist');
    try {
      await symlink(distDir, linkedDist, 'dir');

      const run = await runNode(linkedDist, ['analyze', '--ci', 'bad.sql'], work);

      expect(run.stdout).toContain('[CRITICAL]');
      expect(run.stdout).toContain('Analyzed 1 SQL statement');
      expect(run.code).toBe(1);
    } finally {
      await cleanupWorkspace(work, [linkedDist]);
    }
  });
});

describe.skipIf(!hasBuiltCli || !canSymlink)('entry-point path comparison', () => {
  it('matches a symlinked launcher against the module path without import.meta.main', async () => {
    // Node 24 answers import.meta.main directly, so every end-to-end test above takes
    // the short circuit on a modern runtime and never touches the realpath comparison.
    // That comparison is the whole fix, and it is the ONLY path a Node 20 runtime has,
    // so it gets exercised directly here by passing a plain object with no main property.
    const work = await makeWorkspace({
      'probe.mjs': [
        `import { pathToFileURL, fileURLToPath } from 'node:url';`,
        `const mod = await import(pathToFileURL(process.env.PGFENCE_ENTRY_POINT).href);`,
        `const meta = { url: import.meta.url };`,
        `process.stdout.write(JSON.stringify({`,
        `  isEntryPoint: mod.isEntryPoint(meta),`,
        `  launchedAs: mod.launchedAs('pgfence'),`,
        `  argv1: process.argv[1],`,
        `  modulePath: fileURLToPath(import.meta.url),`,
        `}));`,
      ].join('\n'),
    });
    const link = path.join(work, 'bin', 'pgfence');
    try {
      await mkdir(path.dirname(link), { recursive: true });
      await symlink(path.join(work, 'probe.mjs'), link);

      const run = await runNode(link, [], work, { PGFENCE_ENTRY_POINT: distEntryPoint });
      if (run.stdout === '') {
        throw new Error(
          `the entry-point probe wrote nothing (code=${run.code}). ` +
          `dist/entry-point.js must exist, so run pnpm build. stderr: ${run.stderr || '(empty)'}`,
        );
      }
      const parsed = parseJson<{
        isEntryPoint: boolean;
        launchedAs: boolean;
        argv1: string;
        modulePath: string;
      }>(run.stdout, 'entry-point probe');

      // The premise first: the launcher path and the module path really are different
      // strings here, which is the condition the old lexical comparison got wrong.
      expect(parsed.argv1).not.toBe(parsed.modulePath);
      expect(parsed.isEntryPoint).toBe(true);
      expect(parsed.launchedAs).toBe(true);
    } finally {
      await cleanupWorkspace(work, [link]);
    }
  });

  it('matches a DIRECTORY launcher against the module it resolves to, without import.meta.main', async () => {
    // Same reason as above: on Node 24 the end-to-end directory tests take the
    // import.meta.main short circuit and never reach the resolution this exercises,
    // which is the only path Node 20 and Node 22.0 to 22.17 have. CI runs both.
    //
    // launchedAs is asserted false on purpose: it keys on the basename of argv[1], which
    // here is the directory name, so the contradiction net does NOT cover this shape.
    // The guard itself has to be right; there is no second line of defence behind it.
    const work = await makeWorkspace({
      'pkg/package.json': JSON.stringify({ type: 'module', main: 'inner/probe.mjs' }),
      'pkg/inner/probe.mjs': [
        `import { pathToFileURL, fileURLToPath } from 'node:url';`,
        `const mod = await import(pathToFileURL(process.env.PGFENCE_ENTRY_POINT).href);`,
        `const meta = { url: import.meta.url };`,
        `process.stdout.write(JSON.stringify({`,
        `  isEntryPoint: mod.isEntryPoint(meta),`,
        `  launchedAs: mod.launchedAs('pgfence'),`,
        `  argv1: process.argv[1],`,
        `  modulePath: fileURLToPath(import.meta.url),`,
        `}));`,
      ].join('\n'),
    });
    try {
      const run = await runNode(path.join(work, 'pkg'), [], work, {
        PGFENCE_ENTRY_POINT: distEntryPoint,
      });
      if (run.stdout === '') {
        throw new Error(
          `the directory-entry probe wrote nothing (code=${run.code}). ` +
          `dist/entry-point.js must exist, so run pnpm build. stderr: ${run.stderr || '(empty)'}`,
        );
      }
      const parsed = parseJson<{
        isEntryPoint: boolean;
        launchedAs: boolean;
        argv1: string;
        modulePath: string;
      }>(run.stdout, 'directory-entry probe');

      // The premise: argv[1] really is the directory and the module really is the file
      // Node resolved it to, so this is not the symlink case wearing a different name.
      expect(parsed.argv1).toBe(path.join(work, 'pkg'));
      expect(parsed.modulePath).toBe(path.join(work, 'pkg', 'inner', 'probe.mjs'));
      expect(parsed.isEntryPoint).toBe(true);
      expect(parsed.launchedAs).toBe(false);
    } finally {
      await cleanupWorkspace(work);
    }
  });
});

describe.skipIf(!hasBuiltCli)('module import boundary', () => {
  it('does not run the CLI when dist/index.js is imported as a module', async () => {
    // This is why the guard cannot simply be deleted, and it has never been tested.
    // package.json points main, exports["."] and bin.pgfence at one file, so an
    // unconditional program.parse() would hand a HOST's argv to commander, and commander
    // exits 1 on an unknown command. The importer below is deliberately given an argv
    // that looks exactly like a pgfence CLI invocation.
    const work = await makeWorkspace({
      'importer.mjs': [
        `import { pathToFileURL } from 'node:url';`,
        `const ns = await import(pathToFileURL(process.env.PGFENCE_DIST).href);`,
        `process.stdout.write('KEYS=' + JSON.stringify(Object.keys(ns)));`,
      ].join('\n'),
    });
    try {
      // Unwrapped on purpose: any non-zero exit rejects and fails the test, which IS the
      // assertion. KEYS=[] also records, somewhere executable, that the root export is
      // empty, so nothing about this file's exports can change unnoticed.
      const { stdout, stderr } = await execFilePromise(
        process.execPath,
        [path.join(work, 'importer.mjs'), 'analyze', '--ci', 'bad.sql'],
        { cwd: work, env: { ...CLEAN_ENV, PGFENCE_DIST: distCliPath } },
      );
      expect(stdout).toBe('KEYS=[]');
      expect(stderr).toBe('');
    } finally {
      await cleanupWorkspace(work);
    }
  });

  it('exits 2 with a diagnostic when launched as "pgfence" but not the entry module', async () => {
    // The contradiction: the guard says "not the entry point" while argv says "launched
    // as the CLI". For a safety linter the one outcome that must never happen is a
    // silent exit 0 that reads as a clean analysis, so this refuses loudly instead.
    const work = await makeWorkspace({
      'pgfence.mjs': [
        `import { pathToFileURL } from 'node:url';`,
        `await import(pathToFileURL(process.env.PGFENCE_DIST).href);`,
      ].join('\n'),
    });
    try {
      const run = await runNode(
        path.join(work, 'pgfence.mjs'),
        ['analyze', '--ci', 'bad.sql'],
        work,
        { PGFENCE_DIST: distCliPath },
      );

      expect(run.stderr).toContain('refusing to exit 0 without analyzing anything');
      expect(run.stderr).toContain('launched as "pgfence"');
      expect(run.stderr).toContain('argv[1]');
      expect(run.stderr).toContain('import.meta.url');
      expect(run.stderr).toContain('https://github.com/flvmnt/pgfence/issues');
      expect(run.code).toBe(2);
    } finally {
      await cleanupWorkspace(work);
    }
  });

  it('exits 2 when launched as "pgfence-lsp" but not the entry module', async () => {
    const work = await makeWorkspace({
      'pgfence-lsp.mjs': [
        `import { pathToFileURL } from 'node:url';`,
        `await import(pathToFileURL(process.env.PGFENCE_LSP).href);`,
      ].join('\n'),
    });
    try {
      const run = await runNode(
        path.join(work, 'pgfence-lsp.mjs'),
        ['--stdio'],
        work,
        { PGFENCE_LSP: distLspPath },
      );

      expect(run.stderr).toContain('refusing to exit 0 without analyzing anything');
      // The bin name, not just the path: an editor that spawns pgfence-lsp has to learn
      // which of the two guards refused, and argv[1] alone would say that by accident.
      expect(run.stderr).toContain('launched as "pgfence-lsp"');
      expect(run.code).toBe(2);
    } finally {
      await cleanupWorkspace(work);
    }
  });
});

interface LspResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: { capabilities?: Record<string, unknown> };
  error?: { code?: number; message?: string };
}

interface LspProbe {
  /** The first complete LSP frame's JSON body, or null if none arrived. */
  body: string | null;
  stderr: string;
  exited: boolean;
}

/** Read one complete Content-Length framed message, or null while it is still partial. */
function readFrame(buf: Buffer): string | null {
  const separator = buf.indexOf('\r\n\r\n');
  if (separator === -1) return null;
  const header = buf.subarray(0, separator).toString('ascii');
  const match = /content-length:\s*(\d+)/i.exec(header);
  if (match === null) return null;
  const length = Number(match[1]);
  const start = separator + 4;
  // Content-Length counts BYTES, so the buffer is measured before any utf8 decode.
  if (buf.length < start + length) return null;
  return buf.subarray(start, start + length).toString('utf8');
}

/**
 * Spawn the LSP server and send a real `initialize` request over stdio.
 *
 * stdin is written to and then deliberately HELD OPEN. Ending it makes the server see
 * EOF and exit before it can answer, which would make every run of this probe look like
 * the very bug being tested.
 */
function lspInitialize(serverPath: string): Promise<LspProbe> {
  return new Promise<LspProbe>((resolve) => {
    const child = spawn(process.execPath, [serverPath, '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: CLEAN_ENV,
    });
    let out = Buffer.alloc(0);
    let errText = '';
    let settled = false;
    const finish = (body: string | null, exited: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve({ body, stderr: errText, exited });
    };
    const timer = setTimeout(() => finish(readFrame(out), false), 10000);
    // Optional chaining, because spawn types these as nullable. A missing stream would
    // surface as the timeout below with its own explicit message, never as a pass.
    child.stdout?.on('data', (chunk: Buffer) => {
      out = Buffer.concat([out, chunk]);
      const body = readFrame(out);
      if (body !== null) finish(body, false);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      errText += chunk.toString('utf8');
    });
    child.on('error', (err: Error) => {
      // Spawn failure (a missing binary) is a result, not a throw: the assertions below
      // report it with far more context than an unhandled rejection would.
      errText += `spawn error: ${err.message}`;
      finish(null, true);
    });
    child.on('exit', () => finish(readFrame(out), true));
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { capabilities: {}, rootUri: null, processId: null },
    });
    child.stdin?.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
  });
}

function expectInitializeAnswer(probe: LspProbe, label: string): void {
  // The failure this guards against is a server that exits 0 having written nothing, so
  // the diagnostic has to say so rather than fail on `null.capabilities`.
  if (probe.body === null) {
    throw new Error(
      `${label}: the LSP server answered nothing (exited=${probe.exited}). ` +
      `stderr: ${probe.stderr || '(empty)'}`,
    );
  }
  const response = parseJson<LspResponse>(probe.body, label);
  expect(response.id).toBe(1);
  expect(response.error).toBeUndefined();
  expect(response.result).toBeDefined();
  expect(response.result?.capabilities).toBeDefined();
}

describe.skipIf(!hasBuiltCli)('LSP entry through symlinked launchers', () => {
  it('answers initialize when launched by its real path (control)', async () => {
    // The control. Without it, a broken probe and a broken server look identical.
    expectInitializeAnswer(await lspInitialize(distLspPath), 'real path');
  }, 15000);

  it.skipIf(!canSymlink)('answers initialize when launched through a bin file symlink', async () => {
    const work = await makeWorkspace();
    const link = path.join(work, 'bin', 'pgfence-lsp');
    try {
      await mkdir(path.dirname(link), { recursive: true });
      await symlink(distLspPath, link);
      expectInitializeAnswer(await lspInitialize(link), 'bin symlink');
    } finally {
      await cleanupWorkspace(work, [link]);
    }
  }, 15000);

  it.skipIf(!canSymlink)('answers initialize through a pnpm-shaped package symlink', async () => {
    const work = await makeWorkspace();
    const storePkg = path.join(
      work, 'node_modules', '.pnpm', '@flvmnt+pgfence@0.8.0', 'node_modules', '@flvmnt', 'pgfence',
    );
    const storeDistLink = path.join(storePkg, 'dist');
    const pkgLink = path.join(work, 'node_modules', '@flvmnt', 'pgfence');
    try {
      await mkdir(storePkg, { recursive: true });
      await symlink(distDir, storeDistLink, 'dir');
      await mkdir(path.dirname(pkgLink), { recursive: true });
      await symlink(path.relative(path.dirname(pkgLink), storePkg), pkgLink, 'dir');

      const entry = path.join(pkgLink, 'dist', 'lsp', 'server.js');
      expectInitializeAnswer(await lspInitialize(entry), 'pnpm package symlink');
    } finally {
      await cleanupWorkspace(work, [pkgLink, storeDistLink]);
    }
  }, 15000);
});

describe.skipIf(!hasBuiltCli)('zero-analysis gate', () => {
  it('exits 2 with a clear message on an empty .sql file', async () => {
    const work = await makeWorkspace({ 'empty.sql': '' });
    try {
      const run = await runNode(distCliPath, ['analyze', '--ci', 'empty.sql'], work);

      // What the user must NOT be told.
      expect(run.stdout).not.toContain('No dangerous statements detected.');
      expect(run.stdout).not.toContain('Coverage: 100%');
      // What the user IS told, in the report and then in the fatal diagnostic.
      expect(run.stdout).toContain('[NO STATEMENTS]');
      expect(run.stdout).toContain('0 SQL statements found. Nothing in this file was checked.');
      expect(run.stdout).toContain('Coverage: n/a (no SQL statements found)');
      expect(run.stderr).toContain('pgfence error: nothing was analyzed.');
      expect(run.stderr).toContain('pgfence read 1 file and found 0 SQL statements');
      expect(run.stderr).toContain('This is a failure, not a pass.');
      expect(run.stderr).toContain('empty.sql');
      expect(run.stderr).toContain('https://pgfence.com/docs/ci-cd#nothing-analyzed');
      expect(run.code).toBe(2);
    } finally {
      await cleanupWorkspace(work);
    }
  });

  it('exits 2 on a comment-only .sql file, with no --ci', async () => {
    const work = await makeWorkspace({ 'comments.sql': '-- placeholder\n-- nothing here yet\n' });
    try {
      // No --ci on purpose: the gate is not conditional on it, because the documented
      // SARIF and GitLab jobs run without --ci and would otherwise keep the silent door
      // open through a different output format.
      const run = await runNode(distCliPath, ['analyze', 'comments.sql'], work);

      expect(run.stdout).toContain('[NO STATEMENTS]');
      expect(run.stderr).toContain('pgfence error: nothing was analyzed.');
      expect(run.code).toBe(2);
    } finally {
      await cleanupWorkspace(work);
    }
  });

  it('exits 2 and names every file when a whole multi-file run is empty', async () => {
    const work = await makeWorkspace({ 'a.sql': '', 'b.sql': '   \n\t\n', 'c.sql': '-- nope\n' });
    try {
      const run = await runNode(distCliPath, ['analyze', '--ci', 'a.sql', 'b.sql', 'c.sql'], work);

      expect(run.stderr).toContain('pgfence read 3 files and found 0 SQL statements');
      expect(run.stderr).toContain('a.sql');
      expect(run.stderr).toContain('b.sql');
      expect(run.stderr).toContain('c.sql');
      expect(run.code).toBe(2);
    } finally {
      await cleanupWorkspace(work);
    }
  });

  it('still reports the CRITICAL finding when only some files are empty', async () => {
    const work = await makeWorkspace({ 'empty.sql': '' });
    try {
      const run = await runNode(distCliPath, ['analyze', '--ci', 'empty.sql', 'bad.sql'], work);

      // The gate keys on the WHOLE run, so one placeholder among real migrations must
      // not turn a genuine CRITICAL finding into an exit 2 that sends the reader to
      // their workflow file instead of to the SQL.
      expect(run.stdout).toContain('[CRITICAL]');
      expect(run.stdout).toContain('drop-table');
      expect(run.stdout).toContain('[NO STATEMENTS]');
      expect(run.stdout).toContain('0 SQL statements found. Nothing in this file was checked.');
      expect(run.stderr).toBe(
        'pgfence: Enforce this as a required check that cannot be bypassed locally: https://pgfence.com\n',
      );
      expect(run.code).toBe(1);
    } finally {
      await cleanupWorkspace(work);
    }
  });

  it('keeps --output json parseable and carries the machine-readable signal', async () => {
    const work = await makeWorkspace({ 'empty.sql': '' });
    try {
      const run = await runNode(distCliPath, ['analyze', '--ci', '--output', 'json', 'empty.sql'], work);

      // Parsed before the exit code is checked: the report has to survive the failure,
      // because `> pgfence-report.json` is a documented job and a truncated artifact
      // fails its consumer for a reason that has nothing to do with pgfence.
      const parsed = parseJson<JsonReport>(run.stdout, 'json zero-analysis');
      expect(parsed.version).toBe('1.1');
      expect(parsed.coverage.analyzedNothing).toBe(true);
      expect(parsed.coverage.totalStatements).toBe(0);
      expect(parsed.coverage.coveragePercent).toBeNull();
      expect(parsed.coverage.filesWithNoStatements).toEqual(['empty.sql']);
      expect(parsed.results[0].statementCount).toBe(0);
      expect(run.stderr).toContain('pgfence error: nothing was analyzed.');
      expect(run.code).toBe(2);
    } finally {
      await cleanupWorkspace(work);
    }
  });

  it('reports analyzedNothing false and a numeric coverage on a real analysis', async () => {
    const work = await makeWorkspace();
    try {
      const run = await runNode(distCliPath, ['analyze', '--output', 'json', 'bad.sql'], work);

      const parsed = parseJson<JsonReport>(run.stdout, 'json control');
      expect(parsed.coverage.analyzedNothing).toBe(false);
      expect(parsed.coverage.coveragePercent).toBe(100);
      expect(parsed.coverage.filesWithNoStatements).toEqual([]);
      expect(run.code).toBe(0);
    } finally {
      await cleanupWorkspace(work);
    }
  });

  it('warns on stderr, not in stdout, when only some files produced no SQL in json output', async () => {
    const work = await makeWorkspace({ 'empty.sql': '' });
    try {
      const run = await runNode(distCliPath, ['analyze', '--output', 'json', 'empty.sql', 'bad.sql'], work);

      const parsed = parseJson<JsonReport>(run.stdout, 'json partial');
      expect(parsed.coverage.analyzedNothing).toBe(false);
      expect(parsed.coverage.filesWithNoStatements).toEqual(['empty.sql']);
      expect(run.stderr).toContain('1 of 2 files produced no SQL statements');
      expect(run.stderr).toContain('empty.sql');
      expect(run.code).toBe(0);
    } finally {
      await cleanupWorkspace(work);
    }
  });

  it('writes a complete SARIF report before exiting 2, with no --ci', async () => {
    const work = await makeWorkspace({ 'empty.sql': '' });
    try {
      // `analyze --output sarif migrations/*.sql > pgfence.sarif` is a documented job and
      // runs without --ci. The upload must not look like a clean scan, and the artifact
      // must still parse.
      const run = await runNode(distCliPath, ['analyze', '--output', 'sarif', 'empty.sql'], work);

      const parsed = parseJson<SarifReport>(run.stdout, 'sarif zero-analysis');
      expect(parsed.version).toBe('2.1.0');
      const sarifRun = parsed.runs[0];
      expect(sarifRun.results.some((r) => r.ruleId === 'pgfence-no-statements' && r.level === 'error')).toBe(true);
      expect(sarifRun.tool.driver.rules.some(
        (r) => r.id === 'pgfence-no-statements' && r.helpUri === 'https://pgfence.com/docs/ci-cd#nothing-analyzed',
      )).toBe(true);
      expect(sarifRun.properties.coverageSummary.analyzedNothing).toBe(true);
      expect(sarifRun.properties.coverageSummary.coveragePercent).toBeNull();
      expect(run.stderr).toContain('pgfence error: nothing was analyzed.');
      expect(run.code).toBe(2);
    } finally {
      await cleanupWorkspace(work);
    }
  });

  it('writes a complete GitLab Code Quality report before exiting 2, with no --ci', async () => {
    const work = await makeWorkspace({ 'empty.sql': '' });
    try {
      const run = await runNode(distCliPath, ['analyze', '--output', 'gitlab', 'empty.sql'], work);

      const parsed = parseJson<GitLabViolation[]>(run.stdout, 'gitlab zero-analysis');
      const noStatements = parsed.find((v) => v.check_name === 'pgfence-no-statements');
      expect(noStatements).toBeDefined();
      expect(noStatements?.severity).toBe('major');
      expect(noStatements?.description).toContain('Nothing in this file was checked.');
      const summary = parsed.find((v) => v.check_name === 'pgfence-coverage-summary');
      expect(summary?.severity).toBe('major');
      expect(summary?.description).toContain('Coverage: n/a (no SQL statements found)');
      expect(run.code).toBe(2);
    } finally {
      await cleanupWorkspace(work);
    }
  });

  it('does not hijack the --unknown policy for SQL it could not parse', async () => {
    const work = await makeWorkspace({ 'broken.sql': 'THIS IS NOT SQL AT ALL ((( ;\n' });
    try {
      // 0 analyzed but 1 unanalyzable is a DIFFERENT condition: "there was SQL I could
      // not read", governed by the documented --unknown warn|block policy. The gate keys
      // on total statements, so warn still warns and block still blocks. If this test
      // turns into exit 2, the gate was keyed on analyzed statements: fix the code.
      const warn = await runNode(distCliPath, ['analyze', '--ci', 'broken.sql'], work);
      expect(warn.stdout).toContain('[UNANALYZABLE]');
      expect(warn.stdout).toContain('Coverage: 0%');
      expect(warn.stderr).not.toContain('nothing was analyzed');
      expect(warn.code).toBe(0);

      const block = await runNode(distCliPath, ['analyze', '--ci', '--unknown', 'block', 'broken.sql'], work);
      expect(block.stdout).toContain('[UNANALYZABLE]');
      expect(block.code).toBe(1);
    } finally {
      await cleanupWorkspace(work);
    }
  });

  it('treats an ORM migration with no recognized query call as unanalyzable, not as nothing', async () => {
    const work = await makeWorkspace({
      'silent.ts': [
        `import { MigrationInterface, QueryRunner } from 'typeorm';`,
        ``,
        `export class Silent1700000000000 implements MigrationInterface {`,
        `  public async up(queryRunner: QueryRunner): Promise<void> {`,
        `    await helper.applyMigration(queryRunner);`,
        `  }`,
        ``,
        `  public async down(): Promise<void> {}`,
        `}`,
      ].join('\n'),
    });
    try {
      // An up() with no recognized query call is not an empty migration, it is SQL
      // pgfence could not see. It has to land in the --unknown policy rather than in the
      // zero-analysis gate, because the two say different things to the user: "I could
      // not read this" versus "there was nothing here".
      const warn = await runNode(distCliPath, ['analyze', '--ci', '--format', 'typeorm', 'silent.ts'], work);
      expect(warn.stdout).toContain('[UNANALYZABLE]');
      expect(warn.stdout).toContain('No queryRunner.query() calls found');
      expect(warn.stdout).toContain('Coverage: 0%');
      expect(warn.stdout).not.toContain('[SAFE]');
      expect(warn.stderr).not.toContain('nothing was analyzed');
      expect(warn.code).toBe(0);

      const block = await runNode(
        distCliPath, ['analyze', '--ci', '--unknown', 'block', '--format', 'typeorm', 'silent.ts'], work,
      );
      expect(block.code).toBe(1);
    } finally {
      await cleanupWorkspace(work);
    }
  });

  it('is not bypassed by --fix', async () => {
    const work = await makeWorkspace({ 'empty.sql': '' });
    try {
      // --fix re-analyzes from disk, so the gate must run on the POST-fix results.
      const run = await runNode(distCliPath, ['analyze', '--ci', '--fix', 'empty.sql'], work);

      expect(run.stderr).toContain('pgfence error: nothing was analyzed.');
      expect(run.code).toBe(2);
    } finally {
      await cleanupWorkspace(work);
    }
  });
});

describe.skipIf(!hasBuiltCli)('CI exit contract against the real process', () => {
  it('exits 1 on a policy error, measured on the process rather than on a copy of the rule', async () => {
    // tests/cli.test.ts verifies the --ci contract through wouldCiFail, a deliberate
    // REIMPLEMENTATION of shouldFailCI living in the test file. That is why no test here
    // could ever have caught issue #2: the contract was checked against a copy, never
    // against the process. This checks the process.
    const work = await makeWorkspace({ 'nolock.sql': 'ALTER TABLE users ADD COLUMN nickname text;\n' });
    try {
      const run = await runNode(distCliPath, ['analyze', '--ci', '--max-risk', 'critical', 'nolock.sql'], work);

      // Risk is LOW and --max-risk is critical, so the only thing that can fail this run
      // is the error-severity policy violation.
      expect(run.stdout).toContain('ERROR Missing SET lock_timeout');
      expect(run.stdout).toContain('Analyzed 1 SQL statement');
      expect(run.code).toBe(1);

      const json = await runNode(
        distCliPath, ['analyze', '--output', 'json', '--max-risk', 'critical', 'nolock.sql'], work,
      );
      const parsed = parseJson<JsonReport>(json.stdout, 'policy json');
      expect(parsed.results[0].policyViolations.some(
        (v) => v.ruleId === 'missing-lock-timeout' && v.severity === 'error',
      )).toBe(true);
    } finally {
      await cleanupWorkspace(work);
    }
  });
});
