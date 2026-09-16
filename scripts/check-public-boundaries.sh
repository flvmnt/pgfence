#!/usr/bin/env bash
set -euo pipefail

echo "Checking public repo boundaries..."

filter_paths() {
  local pattern="$1"
  if command -v rg >/dev/null 2>&1; then
    rg "$pattern" || true
  else
    grep -E "$pattern" || true
  fi
}

FORBIDDEN_TRACKED=$(git ls-files | filter_paths '^(src/cloud/|src/agent/|tests/cloud/|tests/agent/|packages/vscode-pgfence/)')
if [ -n "$FORBIDDEN_TRACKED" ]; then
  echo "ERROR: tracked cloud or agent files were found:"
  echo "$FORBIDDEN_TRACKED"
  exit 1
fi

if command -v rg >/dev/null 2>&1; then
  FORBIDDEN_REFERENCES=$(rg -n "(from|import)[[:space:]]+['\"]\.\.?/(cloud|agent)(/|['\"])|import\(['\"]\.\.?/(cloud|agent)(/|['\"])|require\(['\"]\.\.?/(cloud|agent)(/|['\"])" src --glob '!src/cloud/**' --glob '!src/agent/**' || true)
else
  FORBIDDEN_REFERENCES=$(grep -REn "(from|import)[[:space:]]+['\"]\.\.?/(cloud|agent)(/|['\"])|import\(['\"]\.\.?/(cloud|agent)(/|['\"])|require\(['\"]\.\.?/(cloud|agent)(/|['\"])" src --exclude-dir=cloud --exclude-dir=agent || true)
fi

if [ -n "$FORBIDDEN_REFERENCES" ]; then
  echo "ERROR: public source files reference local-only cloud or agent modules:"
  echo "$FORBIDDEN_REFERENCES"
  exit 1
fi

if [ ! -d dist ]; then
  echo "ERROR: dist/ is missing. Run pnpm build before checking package boundaries."
  exit 1
fi

PACK_JSON=$(npm pack --dry-run --json)

PACK_JSON="$PACK_JSON" node <<'NODE'
function parsePackJson(raw) {
  const jsonStart = raw.search(/\[\s*{/s);
  if (jsonStart === -1) {
    throw new Error('npm pack --json did not emit a JSON payload');
  }
  return JSON.parse(raw.slice(jsonStart));
}

const pack = parsePackJson(process.env.PACK_JSON ?? '[]');
const files = pack.flatMap((entry) => entry.files ?? []).map((file) => file.path);
const forbidden = files.filter((file) => /^(src\/cloud\/|src\/agent\/|dist\/cloud\/|dist\/agent\/|tests\/cloud\/|tests\/agent\/|packages\/vscode-pgfence\/)/.test(file));
if (forbidden.length > 0) {
  console.error('ERROR: npm package contains forbidden cloud or agent files:');
  for (const file of forbidden) console.error(file);
  process.exit(1);
}

const required = ['dist/index.js', 'dist/lsp/server.js', 'RULES.md'];
const missing = required.filter((file) => !files.includes(file));
if (missing.length > 0) {
  console.error('ERROR: npm package is missing required release files:');
  for (const file of missing) console.error(file);
  process.exit(1);
}

const { execSync } = require('node:child_process');
const publicSources = new Set(
  execSync('git ls-files src && git ls-files --others --exclude-standard src', { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.ts')),
);

const distArtifacts = files.filter((file) => /^dist\/.+\.(?:js|js\.map|d\.ts|d\.ts\.map)$/.test(file));
const orphanArtifacts = distArtifacts.filter((file) => {
  const sourcePath = file
    .replace(/^dist\//, 'src/')
    .replace(/\.d\.ts\.map$/, '.ts')
    .replace(/\.d\.ts$/, '.ts')
    .replace(/\.js\.map$/, '.ts')
    .replace(/\.js$/, '.ts');
  return !publicSources.has(sourcePath);
});

if (orphanArtifacts.length > 0) {
  console.error('ERROR: npm package contains dist artifacts without public source files:');
  for (const file of orphanArtifacts) console.error(file);
  process.exit(1);
}
NODE

# src/telemetry must import only node: builtins and its own siblings. The payload can only
# stay a closed vocabulary if the module is structurally incapable of reading an analysis
# result, a check or a file path, and that property is an import graph, not a promise.
TELEMETRY_BAD_IMPORTS=$(grep -REn "^[[:space:]]*(import|export|\}|import\()[^;]*from[[:space:]]+['\"](\.|\.\.)/" src/telemetry || true)
if [ -n "$TELEMETRY_BAD_IMPORTS" ]; then
  # Sibling imports inside src/telemetry itself are the only relative ones allowed. The
  # closing-brace form is matched above because multi-line imports put `} from` on its own
  # line, and both store.ts and session.ts use them.
  TELEMETRY_BAD_IMPORTS=$(printf '%s\n' "$TELEMETRY_BAD_IMPORTS" | grep -Ev "from[[:space:]]+['\"]\./(types|env|store|post)\.js['\"]" || true)
fi
if [ -n "$TELEMETRY_BAD_IMPORTS" ]; then
  echo "ERROR: src/telemetry must import only node: builtins and its own siblings:"
  echo "$TELEMETRY_BAD_IMPORTS"
  exit 1
fi

TELEMETRY_BAD_DYNAMIC=$(grep -REn "import\([[:space:]]*['\"](\.|\.\.)/" src/telemetry | grep -Ev "import\([[:space:]]*['\"]\./(types|env|store|post)\.js['\"]" || true)
if [ -n "$TELEMETRY_BAD_DYNAMIC" ]; then
  echo "ERROR: src/telemetry must import only node: builtins and its own siblings:"
  echo "$TELEMETRY_BAD_DYNAMIC"
  exit 1
fi

# The LSP server's stdout is the JSON-RPC transport, so one stray byte corrupts a protocol
# frame. The editor path is covered by the absence of the import, never by a runtime flag.
LSP_TELEMETRY=$(grep -REn "telemetry" src/lsp || true)
if [ -n "$LSP_TELEMETRY" ]; then
  echo "ERROR: src/lsp must not reference telemetry (stdout is the LSP transport):"
  echo "$LSP_TELEMETRY"
  exit 1
fi

echo "Public repo boundaries look good."
