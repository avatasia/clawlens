#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/run-clawlens-qa-smoke.sh [options]

Runs a minimal ClawLens QA smoke check against an already-running OpenClaw gateway.

Options:
  --repo-root <path>       OpenClaw repo root. Default: projects-ref/openclaw
  --gateway-port <port>    Gateway port. Default: 18789
  --session-id <id>        Explicit session id. Default: qa-smoke-<epoch>
  --message <text>         Agent message. Default: use session_status once then reply OK
  --timeout <seconds>      Audit polling timeout. Default: 30
  --limit <n>              Audit fetch limit. Default: 20
  -h, --help               Show help
EOF
}

REPO_ROOT="projects-ref/openclaw"
GATEWAY_PORT="18789"
SESSION_ID=""
MESSAGE="Use the session_status tool exactly once, then reply with exactly OK."
TIMEOUT_SECONDS="30"
AUDIT_LIMIT="20"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-root)
      REPO_ROOT="${2:?missing value for --repo-root}"
      shift 2
      ;;
    --gateway-port)
      GATEWAY_PORT="${2:?missing value for --gateway-port}"
      shift 2
      ;;
    --session-id)
      SESSION_ID="${2:?missing value for --session-id}"
      shift 2
      ;;
    --message)
      MESSAGE="${2:?missing value for --message}"
      shift 2
      ;;
    --timeout)
      TIMEOUT_SECONDS="${2:?missing value for --timeout}"
      shift 2
      ;;
    --limit)
      AUDIT_LIMIT="${2:?missing value for --limit}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$SESSION_ID" ]]; then
  SESSION_ID="qa-smoke-$(date +%s)"
fi

if [[ ! -d "$REPO_ROOT" ]]; then
  echo "repo root not found: $REPO_ROOT" >&2
  exit 2
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 2
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required" >&2
  exit 2
fi

GATEWAY_BASE="http://127.0.0.1:${GATEWAY_PORT}"
SESSION_KEY="agent:main:explicit:${SESSION_ID}"
SESSION_KEY_URI="$(jq -nr --arg value "$SESSION_KEY" '$value|@uri')"

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

fetch_json() {
  local url="$1"
  curl -fsS "$url"
}

write_json() {
  local path="$1"
  local url="$2"
  fetch_json "$url" >"$path"
}

write_json "$TMP_DIR/ready.txt" "${GATEWAY_BASE}/readyz"
ready_ok=false
if [[ "$(cat "$TMP_DIR/ready.txt")" == "ok" ]]; then
  ready_ok=true
elif jq -e '.ready == true' "$TMP_DIR/ready.txt" >/dev/null 2>&1; then
  ready_ok=true
fi
if [[ "$ready_ok" != true ]]; then
  echo "gateway not ready on ${GATEWAY_BASE}" >&2
  exit 1
fi

write_json "$TMP_DIR/pre_overview.json" "${GATEWAY_BASE}/plugins/clawlens/api/overview"
jq -e 'has("activeRuns") and has("totalRuns24h") and has("totalTokens24h")' \
  "$TMP_DIR/pre_overview.json" >/dev/null

(
  set +e
  cd "$REPO_ROOT"
  node dist/entry.js agent \
    --session-id "$SESSION_ID" \
    --channel qa-channel \
    --json \
    --message "$MESSAGE" \
    >"$TMP_DIR/agent.json" \
    2>"$TMP_DIR/agent.stderr"
  echo $? >"$TMP_DIR/agent.exit"
)

write_json "$TMP_DIR/post_overview.json" "${GATEWAY_BASE}/plugins/clawlens/api/overview"
write_json "$TMP_DIR/sessions.json" "${GATEWAY_BASE}/plugins/clawlens/api/sessions?limit=50&offset=0"

echo '{"sessionKey":"","runs":[]}' > "$TMP_DIR/audit.json"
deadline=$(( $(date +%s) + TIMEOUT_SECONDS ))
while true; do
  set +e
  write_json "$TMP_DIR/audit_tmp.json" \
    "${GATEWAY_BASE}/plugins/clawlens/api/audit/session/${SESSION_KEY_URI}?limit=${AUDIT_LIMIT}" 2>/dev/null
  fetch_rc=$?
  set -e
  if [[ $fetch_rc -eq 0 ]] && jq -e . "$TMP_DIR/audit_tmp.json" >/dev/null 2>&1; then
    cp "$TMP_DIR/audit_tmp.json" "$TMP_DIR/audit.json"
  fi
  if [[ $fetch_rc -eq 0 ]]; then
    if jq -e '.runs | length > 0' "$TMP_DIR/audit.json" >/dev/null 2>&1; then
      if jq -e '.runs[0].status == "completed"' "$TMP_DIR/audit.json" >/dev/null 2>&1; then
        break
      fi
    fi
  fi
  if (( $(date +%s) >= deadline )); then
    break
  fi
  sleep 2
done

pre_runs="$(jq -r '.totalRuns24h // 0' "$TMP_DIR/pre_overview.json")"
post_runs="$(jq -r '.totalRuns24h // 0' "$TMP_DIR/post_overview.json")"
overview_increment=false
if (( post_runs > pre_runs )); then
  overview_increment=true
fi

session_present=false
if jq -e --arg key "$SESSION_KEY" '.[] | select(.session_key == $key)' "$TMP_DIR/sessions.json" >/dev/null 2>&1; then
  session_present=true
fi

audit_run_present=false
if jq -e '.runs | length > 0' "$TMP_DIR/audit.json" >/dev/null 2>&1; then
  audit_run_present=true
fi

audit_completed=false
if jq -e '.runs[0].status == "completed"' "$TMP_DIR/audit.json" >/dev/null 2>&1; then
  audit_completed=true
fi

tool_call_observed=false
if jq -e '.runs[0].summary.toolCalls >= 1 or ([.runs[0].turns[]? | select(.role=="assistant") | .toolCallsCount] | any(. > 0))' \
  "$TMP_DIR/audit.json" >/dev/null 2>&1; then
  tool_call_observed=true
fi

agent_ok=false
agent_exit_code="$(cat "$TMP_DIR/agent.exit")"
if [[ "$agent_exit_code" == "0" ]] && jq -e '.status == "ok"' "$TMP_DIR/agent.json" >/dev/null 2>&1; then
  agent_ok=true
fi

result="pass"
if [[ "$overview_increment" != true || "$session_present" != true || "$audit_run_present" != true || "$audit_completed" != true || "$tool_call_observed" != true || "$agent_ok" != true ]]; then
  result="fail"
fi

jq -n \
  --arg result "$result" \
  --arg repoRoot "$REPO_ROOT" \
  --arg gatewayBase "$GATEWAY_BASE" \
  --arg sessionId "$SESSION_ID" \
  --arg sessionKey "$SESSION_KEY" \
  --arg message "$MESSAGE" \
  --arg agentStderr "$(cat "$TMP_DIR/agent.stderr")" \
  --argjson agentExitCode "$agent_exit_code" \
  --argjson preOverview "$(cat "$TMP_DIR/pre_overview.json")" \
  --argjson postOverview "$(cat "$TMP_DIR/post_overview.json")" \
  --argjson agent "$(if [[ -s "$TMP_DIR/agent.json" ]]; then cat "$TMP_DIR/agent.json"; else echo 'null'; fi)" \
  --argjson session "$(jq --arg key "$SESSION_KEY" '[.[] | select(.session_key == $key)] | .[0] // null' "$TMP_DIR/sessions.json")" \
  --argjson audit "$(cat "$TMP_DIR/audit.json")" \
  --argjson overviewIncrement "$overview_increment" \
  --argjson sessionPresent "$session_present" \
  --argjson auditRunPresent "$audit_run_present" \
  --argjson auditCompleted "$audit_completed" \
  --argjson toolCallObserved "$tool_call_observed" \
  --argjson agentOk "$agent_ok" \
  '{
    result: $result,
    repoRoot: $repoRoot,
    gatewayBase: $gatewayBase,
    sessionId: $sessionId,
    sessionKey: $sessionKey,
    message: $message,
    agentExitCode: $agentExitCode,
    agentStderr: $agentStderr,
    checks: {
      agentOk: $agentOk,
      overviewIncrement: $overviewIncrement,
      sessionPresent: $sessionPresent,
      auditRunPresent: $auditRunPresent,
      auditCompleted: $auditCompleted,
      toolCallObserved: $toolCallObserved
    },
    preOverview: $preOverview,
    postOverview: $postOverview,
    session: $session,
    audit: {
      runCount: ($audit.runs | length),
      latestRun: ($audit.runs[0] // null)
    },
    agent: $agent
  }'

if [[ "$result" != "pass" ]]; then
  exit 1
fi
