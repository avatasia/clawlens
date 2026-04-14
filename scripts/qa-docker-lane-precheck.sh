#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME="${1:-openclaw:qa-local-prebaked}"
BASE_IMAGE="${2:-node:24-bookworm}"

echo "[qa-docker-precheck] image=${IMAGE_NAME} base=${BASE_IMAGE}"

if ! command -v docker >/dev/null 2>&1; then
  echo "FAIL: docker command not found"
  exit 2
fi

# Proxy visibility (shell vs daemon can differ)
SHELL_PROXY="${https_proxy:-${HTTPS_PROXY:-}}"
if [[ -n "$SHELL_PROXY" ]]; then
  echo "shell_https_proxy: ${SHELL_PROXY}"
else
  echo "shell_https_proxy: <empty>"
fi

DAEMON_ENV="$(systemctl show docker --property=Environment --no-pager 2>/dev/null || true)"
if [[ "$DAEMON_ENV" == "Environment=" ]]; then
  echo "daemon_proxy_env: <empty>"
elif [[ -n "$DAEMON_ENV" ]]; then
  echo "daemon_proxy_env: ${DAEMON_ENV#Environment=}"
else
  echo "daemon_proxy_env: <unknown>"
fi

# 1) Docker daemon and mirror visibility
if ! MIRRORS="$(docker info --format '{{json .RegistryConfig.Mirrors}}' 2>/dev/null || true)"; then
  MIRRORS="[]"
fi
echo "mirror: ${MIRRORS:-[]}" 

# 2) Prebuilt image presence
if docker image inspect "$IMAGE_NAME" >/dev/null 2>&1; then
  echo "image_present: true"
else
  echo "image_present: false"
fi

# 3) Residual network conflict check
if docker network ls --format '{{.Name}}' | grep -xF 'qa-docker_default' >/dev/null 2>&1; then
  echo "qa_network_residual: true"
else
  echo "qa_network_residual: false"
fi

# 4) Base image pull reachability (non-fatal probe, 60s cap)
set +e
PULL_OUTPUT="$(timeout 60 docker pull "$BASE_IMAGE" 2>&1)"
PULL_CODE=$?
set -e

if [[ $PULL_CODE -eq 0 ]]; then
  echo "base_pull_ok: true"
else
  echo "base_pull_ok: false"
  echo "base_pull_error: ${PULL_OUTPUT//$'\n'/ | }"
fi

# 5) Final recommendation
if docker image inspect "$IMAGE_NAME" >/dev/null 2>&1 && [[ $PULL_CODE -eq 0 ]]; then
  echo "recommendation: docker_lane_ready"
  exit 0
fi

echo "recommendation: stay_on_qa_ui_lane"
exit 1
