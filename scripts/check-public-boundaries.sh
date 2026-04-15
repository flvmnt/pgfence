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

FORBIDDEN_TRACKED=$(git ls-files | filter_paths '^(src/cloud/|src/agent/|tests/cloud/)')
if [ -n "$FORBIDDEN_TRACKED" ]; then
  echo "ERROR: tracked cloud or agent files were found:"
  echo "$FORBIDDEN_TRACKED"
  exit 1
fi

if command -v rg >/dev/null 2>&1; then
  FORBIDDEN_REFERENCES=$(rg -n "from ['\"]\.\.?/(cloud|agent)/|import\(['\"]\.\.?/(cloud|agent)/|require\(['\"]\.\.?/(cloud|agent)/" src --glob '!src/cloud/**' --glob '!src/agent/**' || true)
else
  FORBIDDEN_REFERENCES=$(grep -REn "from ['\"]\.\.?/(cloud|agent)/|import\(['\"]\.\.?/(cloud|agent)/|require\(['\"]\.\.?/(cloud|agent)/" src --exclude-dir=cloud --exclude-dir=agent || true)
fi

if [ -n "$FORBIDDEN_REFERENCES" ]; then
  echo "ERROR: public source files reference local-only cloud or agent modules:"
  echo "$FORBIDDEN_REFERENCES"
  exit 1
fi

if [ ! -d dist ]; then
  echo "Skipping package boundary check because dist/ is missing."
  exit 0
fi

PACK_JSON=$(npm pack --dry-run --json)

PACK_JSON="$PACK_JSON" node <<'NODE'
const pack = JSON.parse(process.env.PACK_JSON ?? '[]');
const files = pack.flatMap((entry) => entry.files ?? []).map((file) => file.path);
const forbidden = files.filter((file) => /^(src\/cloud\/|src\/agent\/|dist\/cloud\/|dist\/agent\/|tests\/cloud\/)/.test(file));
if (forbidden.length > 0) {
  console.error('ERROR: npm package contains forbidden cloud or agent files:');
  for (const file of forbidden) console.error(file);
  process.exit(1);
}

const required = ['dist/index.js', 'dist/lsp/server.js'];
const missing = required.filter((file) => !files.includes(file));
if (missing.length > 0) {
  console.error('ERROR: npm package is missing required release files:');
  for (const file of missing) console.error(file);
  process.exit(1);
}
NODE

echo "Public repo boundaries look good."
