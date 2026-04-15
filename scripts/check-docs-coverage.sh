#!/usr/bin/env bash
#
# Checks that every rule in src/rules/ has a corresponding entry in tracked docs
# plus the main README. If the private website docs checkout exists locally, it is
# included as an extra source, but public CI does not depend on it.
#
set -euo pipefail

RULES_DIR="src/rules"
README="README.md"
EXIT_CODE=0

DOC_TARGETS=()

is_tracked_path() {
  git ls-files -- "$1" | grep -q .
}

add_doc_target() {
  local candidate="$1"

  if [ ! -e "$candidate" ]; then
    return
  fi

  if is_tracked_path "$candidate"; then
    DOC_TARGETS+=("$candidate")
    return
  fi

  if [[ "$candidate" == website/* ]]; then
    DOC_TARGETS+=("$candidate")
  fi
}

echo "Checking docs coverage for pgfence rules..."
echo ""

add_doc_target "CHANGELOG.md"
add_doc_target "proof-points.md"
add_doc_target "blog"
add_doc_target "docs"
add_doc_target "press-releases"
add_doc_target "packages/vscode-pgfence/README.md"
add_doc_target "website/src/pages/docs"

if [ "${#DOC_TARGETS[@]}" -eq 0 ]; then
  echo "No tracked docs sources found for coverage checks."
  exit 1
fi

matches_any() {
  local target="$1"
  shift

  local candidate
  for candidate in "$@"; do
    if [ -n "$candidate" ] && grep -RqiF "$candidate" "$target" 2>/dev/null; then
      return 0
    fi
  done

  return 1
}

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
  rule_prefix=$(echo "$rule_name" | awk '{print $1, $2}')
  search_candidates=("$rule_name" "$rule_prefix" "$keyword" "$search_term")

  found_in_docs=0
  for doc_target in "${DOC_TARGETS[@]}"; do
    if matches_any "$doc_target" "${search_candidates[@]}"; then
      found_in_docs=1
      break
    fi
  done

  if [ "$found_in_docs" -ne 1 ]; then
    echo "  MISSING in docs:  $rule_name  ($rule_file)"
    EXIT_CODE=1
  fi

  # Check README
  if ! matches_any "$README" "${search_candidates[@]}"; then
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
