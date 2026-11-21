#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

run_check() {
  local name="$1"
  shift
  printf '\n==> %s\n' "$name"
  if "$@"; then
    printf 'Passed: %s\n' "$name"
  else
    local status=$?
    printf 'Failed: %s (exit %s)\n' "$name" "$status" >&2
    exit "$status"
  fi
}

run_check lint npm run lint
run_check typecheck npm run typecheck
run_check 'unit tests' npm test
run_check 'provider tests' npm run test:providers
run_check build npm run build
if command -v xvfb-run >/dev/null 2>&1; then
  run_check 'desktop smoke' xvfb-run --auto-servernum -- npx playwright test --workers=1
elif [[ -n "${DISPLAY:-}" ]]; then
  run_check 'desktop smoke' npx playwright test --workers=1
else
  printf 'Failed: desktop smoke requires Xvfb or DISPLAY\n' >&2
  exit 1
fi
