#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 3 ]]; then
  echo "Usage: bash scripts/remote-gateway-restart-verify.sh <ssh-target> [max-age-seconds] [wait-ready-seconds]"
  echo "Example: bash scripts/remote-gateway-restart-verify.sh szhdy 120 600"
  exit 1
fi

TARGET="$1"
MAX_AGE_SECONDS="${2:-120}"
WAIT_READY_SECONDS="${3:-600}"
READY_POLL_INTERVAL_SECONDS=5
READY_REQUIRED_STREAK=3
REMOTE_PATH='export PATH="/home/openclaw/.nvm/versions/node/v24.14.0/bin:/home/openclaw/.local/share/pnpm:$PATH"'

ssh_exec() {
  ssh "$TARGET" "$@"
}

before_pid="$(ssh_exec 'systemctl --user show openclaw-gateway.service -p MainPID --value' | tr -d '\r')"

echo "[restart-verify] target=$TARGET"
echo "[restart-verify] before MainPID=${before_pid:-unknown}"
echo "[restart-verify] restart command"
ssh_exec "$REMOTE_PATH && openclaw gateway restart"

status_raw="$(ssh_exec 'systemctl --user show openclaw-gateway.service -p ActiveEnterTimestamp -p MainPID -p SubState')"
active_ts="$(printf '%s\n' "$status_raw" | sed -n 's/^ActiveEnterTimestamp=//p')"
after_pid="$(printf '%s\n' "$status_raw" | sed -n 's/^MainPID=//p')"
substate="$(printf '%s\n' "$status_raw" | sed -n 's/^SubState=//p')"

active_epoch="$(ssh_exec "date -u -d '$active_ts' +%s" | tr -d '\r')"
now_epoch="$(ssh_exec 'date -u +%s' | tr -d '\r')"
age_seconds=$((now_epoch - active_epoch))

echo "[restart-verify] ActiveEnterTimestamp=$active_ts"
echo "[restart-verify] after MainPID=$after_pid"
echo "[restart-verify] SubState=$substate"
echo "[restart-verify] active age=${age_seconds}s (threshold=${MAX_AGE_SECONDS}s)"

if [[ "$substate" != "running" ]]; then
  echo "[restart-verify] failed: gateway is not running"
  exit 1
fi

if (( age_seconds > MAX_AGE_SECONDS )); then
  echo "[restart-verify] failed: ActiveEnterTimestamp is too old"
  exit 1
fi

if [[ -n "$before_pid" && -n "$after_pid" && "$before_pid" == "$after_pid" ]]; then
  echo "[restart-verify] warning: MainPID unchanged ($after_pid)"
else
  echo "[restart-verify] pid changed: ${before_pid:-unknown} -> ${after_pid:-unknown}"
fi

if (( WAIT_READY_SECONDS <= 0 )); then
  echo "[restart-verify] readiness wait disabled (wait-ready-seconds <= 0)"
  echo "[restart-verify] passed"
  exit 0
fi

echo "[restart-verify] phase=readiness timeout=${WAIT_READY_SECONDS}s interval=${READY_POLL_INTERVAL_SECONDS}s required-streak=${READY_REQUIRED_STREAK}"
ready_deadline=$((now_epoch + WAIT_READY_SECONDS))
ready_streak=0

while true; do
  if ! current_epoch="$(ssh_exec 'date -u +%s' | tr -d '\r')" 2>/dev/null; then
    echo "[restart-verify] readiness poll: ssh failed (transient), retrying"
    sleep "$READY_POLL_INTERVAL_SECONDS"
    continue
  fi
  if (( current_epoch > ready_deadline )); then
    break
  fi

  check_result=""
  if ! check_result="$(ssh_exec "$REMOTE_PATH && health_ok=1; root_ok=1; plugin_ok=1; openclaw gateway health >/dev/null 2>&1 || health_ok=0; curl -fsS http://127.0.0.1:18789/ >/dev/null 2>&1 || root_ok=0; curl -fsS http://127.0.0.1:18789/plugins/clawlens/api/overview >/dev/null 2>&1 || plugin_ok=0; echo \"health=\${health_ok} root=\${root_ok} plugin=\${plugin_ok}\"")"; then
    echo "[restart-verify] readiness poll: ssh command failed, retrying"
    sleep "$READY_POLL_INTERVAL_SECONDS"
    continue
  fi

  health_ok=0
  root_ok=0
  plugin_ok=0
  [[ "$check_result" == *"health=1"* ]] && health_ok=1
  [[ "$check_result" == *"root=1"* ]] && root_ok=1
  [[ "$check_result" == *"plugin=1"* ]] && plugin_ok=1

  if (( health_ok == 1 && root_ok == 1 && plugin_ok == 1 )); then
    ready_streak=$((ready_streak + 1))
    echo "[restart-verify] readiness ok (${ready_streak}/${READY_REQUIRED_STREAK})"
    if (( ready_streak >= READY_REQUIRED_STREAK )); then
      echo "[restart-verify] passed"
      exit 0
    fi
  else
    if (( ready_streak > 0 )); then
      echo "[restart-verify] readiness streak reset"
    fi
    echo "[restart-verify] readiness fail: health=${health_ok} root=${root_ok} plugin=${plugin_ok}"
    ready_streak=0
  fi

  sleep "$READY_POLL_INTERVAL_SECONDS"
done

echo "[restart-verify] failed: readiness timeout after ${WAIT_READY_SECONDS}s"
echo "[restart-verify] diagnostics: gateway status"
ssh_exec "$REMOTE_PATH && openclaw gateway status" || true
echo "[restart-verify] diagnostics: gateway logs (tail 100)"
ssh_exec "$REMOTE_PATH && (openclaw gateway logs --tail 100 2>/dev/null || echo 'no gateway logs command')" || true
echo "[restart-verify] diagnostics: systemd unit status"
ssh_exec "systemctl --user status openclaw-gateway.service --no-pager -l" || true
echo "[restart-verify] diagnostics: current MainPID"
ssh_exec "systemctl --user show openclaw-gateway.service -p MainPID --value" || true
echo "[restart-verify] diagnostics: dashboard endpoint"
ssh_exec "curl -sS -D - -o /dev/null http://127.0.0.1:18789/ || true"
echo "[restart-verify] diagnostics: clawlens overview endpoint"
ssh_exec "curl -sS -D - -o /dev/null http://127.0.0.1:18789/plugins/clawlens/api/overview || true"
exit 1
