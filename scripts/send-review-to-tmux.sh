#!/usr/bin/env bash
# send-review-to-tmux.sh
# Dispatch an assembled cross-tool review package to a tmux session running
# an external reviewer CLI (codex, gemini, ...).
#
# Flow:
#   1. send `/clear` + Enter to reset the reviewer conversation context
#   2. paste the package body via bracketed paste (tmux paste-buffer -p)
#      — newlines inside the buffer are delivered as newlines, not Enter/submit
#   3. send Enter to submit
#
# Usage:
#   bash scripts/send-review-to-tmux.sh <session> <package-file>
#
# Arguments:
#   session       tmux session name (e.g. codex, gemini1).
#   package-file  path to assembled review package
#                 (e.g. /tmp/codex-review-d11-round-2.txt, produced by
#                 scripts/assemble-review-package.sh).
#
# See docs/PLAYBOOK_CROSS_TOOL_REVIEW_LOOP.md for the full workflow.

set -euo pipefail

if [ $# -lt 2 ]; then
    cat >&2 <<USAGE
Usage: $0 <session> <package-file>
  session       tmux session name.
  package-file  path to assembled review package.
USAGE
    exit 2
fi

SESSION="$1"
PKG="$2"

if ! tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "ERROR: tmux session '$SESSION' not found" >&2
    exit 1
fi
if [ -n "${TMUX:-}" ]; then
    CURRENT_SESSION="$(tmux display-message -p '#S' 2>/dev/null || true)"
    if [ -n "$CURRENT_SESSION" ] && [ "$CURRENT_SESSION" = "$SESSION" ]; then
        echo "ERROR: refusing to send review package to the current tmux session '$SESSION'" >&2
        exit 1
    fi
fi
if [ ! -f "$PKG" ]; then
    echo "ERROR: package file '$PKG' not found" >&2
    exit 1
fi

LOCK_SESSION="$(printf '%s' "$SESSION" | tr -c 'A-Za-z0-9_.-' '_')"
LOCK_FILE="${TMPDIR:-/tmp}/clawlens-review-${LOCK_SESSION}.lock"
exec 9>"$LOCK_FILE"
if ! flock -w 60 9; then
    echo "ERROR: timed out waiting for review dispatch lock for '$SESSION'" >&2
    exit 1
fi
trap 'rm -f "$LOCK_FILE"' EXIT

# 1. clear reviewer conversation context
tmux send-keys -t "$SESSION" "/clear" Enter
deadline=$((SECONDS + 30))
while [ "$SECONDS" -lt "$deadline" ]; do
    pane_text="$(tmux capture-pane -pt "$SESSION" -S -120 2>/dev/null || true)"
    if printf '%s\n' "$pane_text" | grep -Eq 'Type your message or @path/to/file|^[[:space:]]*[›❯>][[:space:]]*$'; then
        break
    fi
    sleep 1
done

# 2. paste package body via bracketed paste
BUFFER="send-review-$$"
tmux load-buffer -b "$BUFFER" "$PKG"
tmux paste-buffer -p -b "$BUFFER" -t "$SESSION"
tmux delete-buffer -b "$BUFFER"
sleep 1

# 3. submit
tmux send-keys -t "$SESSION" Enter

LINES=$(wc -l < "$PKG")
cat <<SUMMARY
Dispatched review package to tmux session.
  Session:  $SESSION
  Package:  $PKG ($LINES lines)
  Steps:    /clear → paste (bracketed) → Enter
SUMMARY
