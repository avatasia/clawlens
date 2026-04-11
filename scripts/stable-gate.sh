#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "[stable-gate] docs governance checks"
node "$ROOT/scripts/check-docs-governance.mjs"

echo "[stable-gate] manifest checks"
node "$ROOT/scripts/check-clawlens-manifest.mjs"

if [[ "${CLAWLENS_GATE_SKIP_TESTS:-0}" == "1" ]]; then
  echo "[stable-gate] skipped tests (CLAWLENS_GATE_SKIP_TESTS=1)"
else
  echo "[stable-gate] clawlens tests"
  cd "$ROOT/extensions/clawlens"
  pnpm test
fi

echo "[stable-gate] passed"
