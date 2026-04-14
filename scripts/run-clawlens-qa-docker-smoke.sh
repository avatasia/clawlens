#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/run-clawlens-qa-docker-smoke.sh [options]

Bring up OpenClaw Docker QA lane, inject ClawLens plugin, run one smoke turn,
and verify overview/sessions/audit on the Docker gateway.

Options:
  --repo-root <path>       OpenClaw repo root. Default: projects-ref/openclaw
  --clawlens-path <path>   ClawLens extension path (relative to repo root if not absolute).
                           Default: ../../extensions/clawlens
  --image <name>           QA image tag. Default: openclaw:qa-local-prebaked
  --gateway-port <port>    Gateway host port. Default: 18790
  --qa-lab-port <port>     QA Lab host port. Default: 43125
  --session-id <id>        Smoke session id. Default: qa-docker-smoke-<epoch>
  --audit-timeout <sec>    Audit completion wait timeout. Default: 30
  --keep-up                Keep docker stack running (skip compose down)
  -h, --help               Show help
USAGE
}

REPO_ROOT="projects-ref/openclaw"
CLAWLENS_PATH="../../extensions/clawlens"
IMAGE="openclaw:qa-local-prebaked"
GATEWAY_PORT="18790"
QA_LAB_PORT="43125"
SESSION_ID=""
KEEP_UP=false
AUDIT_TIMEOUT_SECONDS="30"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-root)
      REPO_ROOT="${2:?missing value for --repo-root}"
      shift 2
      ;;
    --clawlens-path)
      CLAWLENS_PATH="${2:?missing value for --clawlens-path}"
      shift 2
      ;;
    --image)
      IMAGE="${2:?missing value for --image}"
      shift 2
      ;;
    --gateway-port)
      GATEWAY_PORT="${2:?missing value for --gateway-port}"
      shift 2
      ;;
    --qa-lab-port)
      QA_LAB_PORT="${2:?missing value for --qa-lab-port}"
      shift 2
      ;;
    --session-id)
      SESSION_ID="${2:?missing value for --session-id}"
      shift 2
      ;;
    --audit-timeout)
      AUDIT_TIMEOUT_SECONDS="${2:?missing value for --audit-timeout}"
      shift 2
      ;;
    --keep-up)
      KEEP_UP=true
      shift
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
  SESSION_ID="qa-docker-smoke-$(date +%s)"
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required" >&2
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
if [[ ! -d "$REPO_ROOT" ]]; then
  echo "repo root not found: $REPO_ROOT" >&2
  exit 2
fi

pushd "$REPO_ROOT" >/dev/null
COMPOSE_FILE=".artifacts/qa-docker/docker-compose.qa.yml"
GATEWAY_CONTAINER="qa-docker-openclaw-qa-gateway-1"
GATEWAY_BASE="http://127.0.0.1:${GATEWAY_PORT}"
SESSION_KEY="agent:main:explicit:${SESSION_ID}"
SESSION_KEY_URI="$(jq -nr --arg value "$SESSION_KEY" '$value|@uri')"

TMP_DIR="$(mktemp -d)"
if [[ "$KEEP_UP" != true ]]; then
  cleanup() {
    docker compose -f "$COMPOSE_FILE" down >/dev/null 2>&1 || true
    rm -rf "$TMP_DIR"
  }
  trap cleanup EXIT
else
  cleanup() {
    rm -rf "$TMP_DIR"
  }
  trap cleanup EXIT
fi

if [[ "$CLAWLENS_PATH" = /* ]]; then
  CLAWLENS_ABS="$CLAWLENS_PATH"
else
  CLAWLENS_ABS="$(realpath "$CLAWLENS_PATH")"
fi
if [[ ! -d "$CLAWLENS_ABS" ]]; then
  echo "clawlens path not found: $CLAWLENS_ABS" >&2
  exit 2
fi

node dist/entry.js qa up \
  --repo-root . \
  --skip-ui-build \
  --use-prebuilt-image \
  --image "$IMAGE" \
  --qa-lab-port "$QA_LAB_PORT" \
  --gateway-port "$GATEWAY_PORT" >"$TMP_DIR/qa-up.log" 2>&1

# Wait for gateway container + health
for _ in {1..30}; do
  if docker ps --format '{{.Names}}' | grep -qx "$GATEWAY_CONTAINER"; then
    if curl -fsS "$GATEWAY_BASE/readyz" >/dev/null 2>&1; then
      break
    fi
  fi
  sleep 1
done
if ! docker ps --format '{{.Names}}' | grep -qx "$GATEWAY_CONTAINER"; then
  echo "gateway container not running: $GATEWAY_CONTAINER" >&2
  exit 1
fi
if ! curl -fsS "$GATEWAY_BASE/readyz" >/dev/null 2>&1; then
  echo "gateway readyz failed: $GATEWAY_BASE/readyz" >&2
  exit 1
fi

# Inject clawlens into container and install

docker exec "$GATEWAY_CONTAINER" rm -rf /tmp/clawlens >/dev/null 2>&1 || true
docker cp "$CLAWLENS_ABS" "$GATEWAY_CONTAINER:/tmp/clawlens"
docker exec "$GATEWAY_CONTAINER" node dist/index.js plugins install -l /tmp/clawlens >"$TMP_DIR/plugin-install.log" 2>&1

# Wait for clawlens API to become available
overview_body=""
overview_ok=false
for _ in {1..90}; do
  set +e
  overview_body="$(curl -sS "$GATEWAY_BASE/plugins/clawlens/api/overview")"
  code=$?
  set -e
  if [[ $code -eq 0 ]] && jq -e 'has("activeRuns") and has("totalRuns24h")' <<<"$overview_body" >/dev/null 2>&1; then
    overview_ok=true
    break
  fi
  sleep 1
done
if [[ "$overview_ok" != true ]]; then
  echo "clawlens overview still unavailable" >&2
  echo "last_overview_response: ${overview_body:-<empty>}" >&2
  exit 1
fi

pre_overview="$overview_body"

# Run a smoke turn in-container

docker exec "$GATEWAY_CONTAINER" node dist/index.js agent \
  --session-id "$SESSION_ID" \
  --channel qa-channel \
  --json \
  --message "Reply with exactly OK and do not use any tools." \
  >"$TMP_DIR/agent.json" 2>"$TMP_DIR/agent.stderr"

# Collect evidence
post_overview="$(curl -sS "$GATEWAY_BASE/plugins/clawlens/api/overview")"
sessions_json="$(curl -sS "$GATEWAY_BASE/plugins/clawlens/api/sessions?limit=20&offset=0")"

# Poll audit endpoint until completed (or timeout)
deadline=$(( $(date +%s) + AUDIT_TIMEOUT_SECONDS ))
audit_json='{"sessionKey":"","runs":[]}'
while true; do
  set +e
  _body="$(curl -sS "$GATEWAY_BASE/plugins/clawlens/api/audit/session/${SESSION_KEY_URI}?limit=20")"
  code=$?
  set -e
  if [[ $code -eq 0 ]] && jq -e . <<<"$_body" >/dev/null 2>&1; then
    audit_json="$_body"
  fi
  if [[ $code -eq 0 ]]; then
    if jq -e '.runs | length > 0' <<<"$audit_json" >/dev/null 2>&1; then
      if jq -e '.runs[0].status == "completed"' <<<"$audit_json" >/dev/null 2>&1; then
        break
      fi
    fi
  fi
  if (( $(date +%s) >= deadline )); then
    break
  fi
  sleep 1
done

session_present=false
if jq -e --arg key "$SESSION_KEY" '.[] | select(.session_key == $key)' <<<"$sessions_json" >/dev/null 2>&1; then
  session_present=true
fi

audit_present=false
if jq -e '.runs | length > 0' <<<"$audit_json" >/dev/null 2>&1; then
  audit_present=true
fi

audit_completed=false
if jq -e '.runs[0].status == "completed"' <<<"$audit_json" >/dev/null 2>&1; then
  audit_completed=true
fi

agent_ok=false
if jq -e '.status == "ok"' "$TMP_DIR/agent.json" >/dev/null 2>&1; then
  agent_ok=true
fi

pre_runs="$(jq -r '.totalRuns24h // 0' <<<"$pre_overview")"
post_runs="$(jq -r '.totalRuns24h // 0' <<<"$post_overview")"
overview_increment=false
if (( post_runs > pre_runs )); then
  overview_increment=true
fi

result="pass"
if [[ "$overview_increment" != true || "$session_present" != true || "$audit_present" != true || "$audit_completed" != true || "$agent_ok" != true ]]; then
  result="fail"
fi

jq -n \
  --arg result "$result" \
  --arg repoRoot "$REPO_ROOT" \
  --arg image "$IMAGE" \
  --arg gatewayBase "$GATEWAY_BASE" \
  --arg sessionId "$SESSION_ID" \
  --arg sessionKey "$SESSION_KEY" \
  --arg clawlensPath "$CLAWLENS_ABS" \
  --argjson keepUp "$KEEP_UP" \
  --argjson agent "$(cat "$TMP_DIR/agent.json")" \
  --argjson preOverview "$pre_overview" \
  --argjson postOverview "$post_overview" \
  --argjson sessions "$sessions_json" \
  --argjson audit "$audit_json" \
  --argjson overviewIncrement "$overview_increment" \
  --argjson sessionPresent "$session_present" \
  --argjson auditPresent "$audit_present" \
  --argjson auditCompleted "$audit_completed" \
  --argjson agentOk "$agent_ok" \
  '{
    result: $result,
    repoRoot: $repoRoot,
    image: $image,
    gatewayBase: $gatewayBase,
    sessionId: $sessionId,
    sessionKey: $sessionKey,
    clawlensPath: $clawlensPath,
    keepUp: $keepUp,
    checks: {
      agentOk: $agentOk,
      overviewIncrement: $overviewIncrement,
      sessionPresent: $sessionPresent,
      auditPresent: $auditPresent,
      auditCompleted: $auditCompleted
    },
    preOverview: $preOverview,
    postOverview: $postOverview,
    session: ([ $sessions[] | select(.session_key == $sessionKey) ] | .[0] // null),
    audit: {
      runCount: ($audit.runs | length),
      latestRun: ($audit.runs[0] // null)
    },
    agent: $agent
  }'

if [[ "$result" != "pass" ]]; then
  exit 1
fi

popd >/dev/null
