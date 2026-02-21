#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOOKS_DIR="$REPO_ROOT/.git/hooks"

if [ ! -d "$HOOKS_DIR" ]; then
  echo "Error: .git/hooks directory not found. Are you in a git repository?"
  exit 1
fi

ln -sf "$SCRIPT_DIR/pre-push" "$HOOKS_DIR/pre-push"
echo "Installed pre-push hook -> scripts/pre-push"
