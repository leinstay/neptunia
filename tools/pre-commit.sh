#!/bin/sh
# Pre-commit check on the staged files only: Prettier's format check on what it handles, ESLint (with
# eslint-suppressions.json) on the staged .js, .mjs and .ts files. The type check is too slow for a hook and runs in CI.
# The script does not install itself. Call it from .git/hooks/pre-commit, for example: sh tools/pre-commit.sh
# Exits non-zero when a check fails.

set -eu

root=$(git rev-parse --show-toplevel)
cd "$root"

staged=$(git diff --cached --name-only --diff-filter=ACMR)
[ -n "$staged" ] || exit 0

format_files=$(printf '%s\n' "$staged" | grep -E '\.(js|mjs|cjs|ts|json|ya?ml)$' || true)
lint_files=$(printf '%s\n' "$staged" | grep -E '\.(js|mjs|ts)$' || true)
status=0

if [ -n "$format_files" ]; then
  # Prettier skips the files in .prettierignore even when they are named.
  printf '%s\n' "$format_files" | tr '\n' '\0' | xargs -0 node_modules/.bin/prettier --check || status=1
fi

if [ -n "$lint_files" ]; then
  printf '%s\n' "$lint_files" | tr '\n' '\0' | xargs -0 node_modules/.bin/eslint --no-warn-ignored || status=1
fi

exit "$status"
