#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${1:-soft}"

if [[ "$MODE" != "soft" && "$MODE" != "strict" ]]; then
  echo "Usage: bash scripts/forward-compat.sh [soft|strict] [--use-local-ref] [--openclaw-bin <path>]"
  exit 1
fi
[[ $# -gt 0 ]] && shift

USE_LOCAL_REF=0
OPENCLAW_BIN=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --use-local-ref)
      USE_LOCAL_REF=1
      shift
      ;;
    --openclaw-bin)
      if [[ $# -lt 2 ]]; then
        echo "[forward-compat] failed: --openclaw-bin requires a path"
        exit 1
      fi
      OPENCLAW_BIN="$2"
      shift 2
      ;;
    *)
      echo "[forward-compat] failed: unknown option '$1'"
      echo "Usage: bash scripts/forward-compat.sh [soft|strict] [--use-local-ref] [--openclaw-bin <path>]"
      exit 1
      ;;
  esac
done

echo "[forward-compat] manifest checks"
node "$ROOT/scripts/check-clawlens-manifest.mjs"

if [[ "$USE_LOCAL_REF" -eq 1 ]]; then
  echo "[forward-compat] local import verification (projects-ref/openclaw)"
  if ! node "$ROOT/scripts/verify-local-imports.mjs"; then
    if [[ "$MODE" == "soft" ]]; then
      echo "[forward-compat] warning: local import verification failed (soft mode)"
    else
      echo "[forward-compat] failed: local import verification failed (strict mode)"
      exit 1
    fi
  fi
fi

if [[ -n "$OPENCLAW_BIN" ]]; then
  INSPECT_BIN="$OPENCLAW_BIN"
  echo "[forward-compat] openclaw binary override: $INSPECT_BIN"
else
  if ! command -v openclaw >/dev/null 2>&1; then
    if [[ "$MODE" == "soft" ]]; then
      echo "[forward-compat] skipped: openclaw CLI not found (soft mode)"
      exit 0
    fi
    echo "[forward-compat] failed: openclaw CLI not found (strict mode)"
    exit 1
  fi
  INSPECT_BIN="openclaw"
fi

echo "[forward-compat] openclaw plugins inspect clawlens"
if ! "$INSPECT_BIN" plugins inspect clawlens; then
  if [[ "$MODE" == "soft" ]]; then
    echo "[forward-compat] warning: inspect failed (soft mode)"
    exit 0
  fi
  echo "[forward-compat] failed: inspect failed (strict mode)"
  exit 1
fi

echo "[forward-compat] passed"
