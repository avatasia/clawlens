#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "[stable-gate] docs governance checks"
node "$ROOT/scripts/check-docs-governance.mjs"

echo "[stable-gate] manifest checks"
node "$ROOT/scripts/check-clawlens-manifest.mjs"

if [[ "${CLAWLENS_GATE_SKIP_TYPECHECK:-0}" == "1" ]]; then
  echo "[stable-gate] skipped type checks (CLAWLENS_GATE_SKIP_TYPECHECK=1)"
else
  echo "[stable-gate] type checks"
  cd "$ROOT/extensions/clawlens"
  if [[ -f node_modules/.bin/tsc ]]; then
    node_modules/.bin/tsc --noEmit
  elif command -v npx >/dev/null 2>&1; then
    npx -p typescript@~5.8 tsc --noEmit
  else
    echo "[stable-gate] ERROR: tsc not available — install devDependencies or set CLAWLENS_GATE_SKIP_TYPECHECK=1"
    exit 1
  fi
fi

if [[ "${CLAWLENS_GATE_SKIP_TESTS:-0}" == "1" ]]; then
  echo "[stable-gate] skipped tests (CLAWLENS_GATE_SKIP_TESTS=1)"
else
  echo "[stable-gate] clawlens tests"
  pnpm test
fi

echo "[stable-gate] passed"
