#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK_DIR="$ROOT/.git/hooks"
PRE_COMMIT_HOOK="$HOOK_DIR/pre-commit"
PRE_PUSH_HOOK="$HOOK_DIR/pre-push"

if [[ ! -d "$HOOK_DIR" ]]; then
  echo "Missing .git/hooks under $ROOT"
  exit 1
fi

for hook in "$PRE_COMMIT_HOOK" "$PRE_PUSH_HOOK"; do
  if [[ -f "$hook" ]]; then
    echo "Overwriting existing hook: $hook"
  fi
done

cat > "$PRE_COMMIT_HOOK" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

node scripts/check-docs-governance.mjs
EOF

cat > "$PRE_PUSH_HOOK" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

bash scripts/stable-gate.sh
bash scripts/forward-compat.sh soft
EOF

chmod +x "$PRE_COMMIT_HOOK" "$PRE_PUSH_HOOK"
echo "Installed pre-commit hook: $PRE_COMMIT_HOOK"
echo "Installed pre-push hook: $PRE_PUSH_HOOK"
