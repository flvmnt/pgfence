/**
 * Entry-point detection for pgfence's two bin targets.
 *
 * dist/index.js and dist/lsp/server.js are each simultaneously a bin entry and
 * an export target, so each needs to know whether it was launched or imported.
 * Getting that wrong in the "launched" direction makes a safety linter exit 0
 * having analyzed nothing, which is the failure this module exists to prevent.
 */

import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * realpathSync.native also canonicalizes case on macOS and Windows; the JS
 * implementation only resolves symlinks. Bind once, and fall back if a runtime
 * does not expose it rather than throwing from inside the guard.
 */
const resolveReal: (p: string) => string =
  typeof realpathSync.native === 'function' ? realpathSync.native : realpathSync;

function isFsError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string';
}

/**
 * Absolute path with symlinks and junctions resolved. Falls back to the lexical
 * absolute path when the entry cannot be resolved on disk (deleted file, virtual
 * filesystem, Yarn PnP zip). Only filesystem errors are tolerated: anything else
 * is a programming error and is rethrown rather than silently swallowed.
 */
function canonical(p: string): string {
  const abs = path.resolve(p);
  try {
    return resolveReal(abs);
  } catch (err) {
    // A missing or unreadable entry is an environment condition, not a bug: degrade to
    // the lexical path, which is exactly the comparison pgfence used before this module.
    // Never degrade to false, which is the silent skip this module exists to prevent.
    if (!isFsError(err)) throw err;
    return abs;
  }
}

function samePath(a: string, b: string): boolean {
  const x = canonical(a);
  const y = canonical(b);
  // win32 and darwin default to case-insensitive filesystems. toLowerCase, never
  // toLocaleLowerCase: the tr-TR locale maps 'I' to a different code point.
  return process.platform === 'win32' || process.platform === 'darwin'
    ? x.toLowerCase() === y.toLowerCase()
    : x === y;
}

/**
 * The "main" field of <dir>/package.json, or null when there is no usable one.
 *
 * Node falls back to index.js for a missing, unreadable or malformed package.json and
 * for a non-string main, so every one of those cases returns null here and the caller
 * uses the same fallback Node does.
 */
function readPackageMain(dir: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(path.join(dir, 'package.json'), 'utf8');
  } catch (err) {
    // No package.json, or it cannot be read. That is Node's index.js case, not an error:
    // returning null selects exactly the fallback Node itself would take.
    if (!isFsError(err)) throw err;
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const main = (parsed as { main?: unknown }).main;
    return typeof main === 'string' && main.length > 0 ? main : null;
  } catch (err) {
    // A malformed package.json belongs to the package, and Node reports it separately.
    // Here it only means "no usable main", which is again Node's own fallback.
    if (!(err instanceof SyntaxError)) throw err;
    return null;
  }
}

/**
 * True when argv[1] is a DIRECTORY that Node resolved to this module.
 *
 * `node ./node_modules/@flvmnt/pgfence` and `node ./dist` are both legal. Node resolves
 * the directory through package.json "main" (or index.js) and only then derives
 * import.meta.url, so argv[1] is a directory while the module path is a file: no amount
 * of canonicalizing can make those equal, and without this the guard says "not the entry
 * point" and the CLI exits 0 having analyzed nothing. Re-run the resolution Node did.
 *
 * Deliberately narrow, covering exactly the shapes Node's directory resolution produces
 * for an ES module: "main" as spelled, "main" with the .js that Node appends to an
 * extensionless main, "main" treated as a folder, and the index.js fallback. "exports"
 * is NOT consulted, because Node ignores it for a directory entry point (verified: a
 * package with only "exports" and no index.js refuses to start at all). .json and .node,
 * the other extensions Node would try, can never be the module asking this question.
 *
 * This can only turn a false into a true. It never rejects a launcher the plain
 * comparison already accepted, so it cannot regress any working shape.
 */
function resolvesToModule(entry: string, modulePath: string): boolean {
  let isDirectory: boolean;
  try {
    isDirectory = statSync(entry).isDirectory();
  } catch (err) {
    // A missing or unreadable argv[1] simply is not the directory case. Swallowed here,
    // never turned into a throw out of the guard, and never into a silent skip either:
    // the caller has already made its own decision from the path comparison.
    if (!isFsError(err)) throw err;
    return false;
  }
  if (!isDirectory) return false;

  const candidates: string[] = [];
  const main = readPackageMain(entry);
  if (main !== null) {
    candidates.push(
      path.resolve(entry, main),
      path.resolve(entry, `${main}.js`),
      path.resolve(entry, main, 'index.js'),
    );
  }
  candidates.push(path.resolve(entry, 'index.js'));

  return candidates.some((candidate) => samePath(candidate, modulePath));
}

/**
 * True when the given module is the one the process was started with.
 *
 * Node resolves the entry point's realpath before deriving import.meta.url but
 * leaves process.argv[1] exactly as the launcher spelled it, so a lexical
 * comparison is false for every symlinked launcher: npm and yarn classic
 * node_modules/.bin, the npx cache, a global prefix bin, a Windows directory
 * junction, and pnpm's node_modules/<pkg> package symlink.
 *
 * argv[1] can also be a directory rather than a file, which no comparison of two
 * paths can reconcile; see resolvesToModule.
 */
export function isEntryPoint(meta: ImportMeta): boolean {
  // Node >= 24.2.0 / >= 22.18.0 and Bun answer this directly. It is Stability 1.0,
  // and it is undefined on Node 20, so a true short-circuits and anything else
  // falls through to the path comparison. Never treat a missing or false value as
  // proof that this is not the entry point.
  if ((meta as ImportMeta & { main?: boolean }).main === true) return true;
  const entry = process.argv[1];
  if (entry == null) return false;
  const modulePath = fileURLToPath(meta.url);
  if (samePath(entry, modulePath)) return true;
  // `node <dir>`: argv[1] is a directory and this module is the file Node resolved it to.
  return resolvesToModule(entry, modulePath);
}

/**
 * True when argv[1] names this package's bin, whatever the entry-point guard concluded.
 *
 * Basename only, deliberately. An "argv[2] is a known subcommand" signal looks like a
 * free extra net and is not: during investigation it killed a legitimate host script
 * whose own argv[2] happened to be `analyze`.
 *
 * Two shapes it does not cover, both stated in CHANGELOG.md because a caller cannot infer
 * them. On Windows the .cmd shim makes the basename `index`, and for a directory entry it
 * is the directory's name, so neither reaches this. Both are shapes isEntryPoint resolves
 * correctly on its own; this is a net under the guard, never a substitute for it.
 */
export function launchedAs(binName: string): boolean {
  const entry = process.argv[1];
  if (entry == null) return false;
  const base = path
    .basename(entry)
    .toLowerCase()
    .replace(/\.(js|mjs|cjs|cmd|ps1|exe)$/, '');
  return base === binName.toLowerCase();
}

/**
 * The guard said "not the entry point" but argv says "launched as the CLI". That is a
 * contradiction, and for a safety tool the one outcome we must never produce is a
 * silent exit 0 that looks like a clean analysis.
 *
 * The false-positive surface is small rather than empty: a host process whose own entry
 * file is named `pgfence` or `pgfence-lsp` and which imports this package for side
 * effects is killed here before its first statement. The root export is `export {}`, so
 * nothing has a reason to import it, and the outcome is loud and recoverable rather than
 * a silent pass, which is the right way round for a safety tool. Narrowing it further by
 * confirming the module belongs to this package would not help: the module already does.
 */
export function refuseSilentExit(meta: ImportMeta, binName: string): never {
  process.stderr.write(
    `pgfence: refusing to exit 0 without analyzing anything.\n` +
      `pgfence: this process was launched as "${binName}", but pgfence could not confirm it is the entry module, so no files were analyzed.\n` +
      `pgfence: please report this at https://github.com/flvmnt/pgfence/issues with:\n` +
      `  argv[1]         = ${String(process.argv[1])}\n` +
      `  import.meta.url = ${meta.url}\n` +
      `  platform        = ${process.platform} ${process.arch}\n` +
      `  runtime         = ${process.version}\n`,
  );
  process.exit(2);
}
