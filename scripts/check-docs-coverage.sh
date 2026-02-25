#!/usr/bin/env bash
#
# Checks that every rule in src/rules/ has a corresponding entry in the website docs.
# Run from repo root: ./scripts/check-docs-coverage.sh
# Add to CI: exits 1 if any rule is missing from docs.
#
set -euo pipefail

RULES_DIR="src/rules"
DOCS_DIR="website/src/pages/docs"
README="README.md"
EXIT_CODE=0

echo "Checking docs coverage for pgfence rules..."
echo ""

for rule_file in "$RULES_DIR"/*.ts; do
  # Extract "Rule: <name>" from the first 5 lines
  rule_name=$(head -5 "$rule_file" | sed -n 's/.*Rule: \(.*\)/\1/p' | head -1)
  if [ -z "$rule_name" ]; then
    continue
  fi

  # Extract the first detection keyword (e.g., "ALTER TYPE", "ATTACH PARTITION")
  keyword=$(head -10 "$rule_file" | sed -n 's/.*- \([A-Z][A-Z_ ]*[A-Z]\).*/\1/p' | head -1)
  if [ -z "$keyword" ]; then
    keyword="$rule_name"
  fi
  # Use first two words for search
  search_term=$(echo "$keyword" | awk '{print $1, $2}')

  # Check all docs pages
  if ! grep -rqi "$search_term" "$DOCS_DIR" 2>/dev/null; then
    echo "  MISSING in docs:  $rule_name  ($rule_file)"
    EXIT_CODE=1
  fi

  # Check README
  if ! grep -qi "$search_term" "$README" 2>/dev/null; then
    echo "  MISSING in README: $rule_name  ($rule_file)"
    EXIT_CODE=1
  fi
done

echo ""
if [ "$EXIT_CODE" -eq 0 ]; then
  echo "All rules are documented in both docs and README."
else
  echo "Some rules are missing. Please update the files listed above."
fi

exit "$EXIT_CODE"
