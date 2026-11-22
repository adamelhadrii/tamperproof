#!/usr/bin/env bash
# Dev checks: tsconfig resolves, types check, the plugin validates, the tests pass.
set -euo pipefail
cd "$(dirname "$0")/.."

# TypeScript is pinned because a bare `npx tsc` runs the unrelated, deprecated `tsc` package.
run_tsc() { npx --yes --prefer-offline --loglevel=error -p typescript@5.9.3 -- tsc "$@"; }

echo '1/4 tsconfig.json resolves'
out=$(run_tsc --showConfig -p . 2>&1) || { printf '%s\n' "$out"; exit 1; }

if [ -f .claude-plugin/types/claude-code/index.d.ts ]; then
  echo '2/4 tsc --noEmit'
  out=$(run_tsc --noEmit -p . 2>&1) || { printf '%s\n' "$out"; exit 1; }
else
  echo "2/4 tsc --noEmit skipped: no .claude-plugin/types/ yet. An interactive 'claude --plugin-dir .' writes it; step 3 type-checks without it."
fi

echo '3/4 claude plugin validate --strict'
out=$(claude plugin validate --strict . 2>&1) || { printf '%s\n' "$out"; exit 1; }
echo '    ok'

echo '4/4 claude plugin test'
claude plugin test .

echo 'All checks passed.'
