#!/usr/bin/env bash
set -euo pipefail

INTERNAL_NETWORK=${PHASE50_SANDBOX_NETWORK_NAME:-${AGENT_RUNNER_SANDBOX_NETWORK_NAME:-phase50-conformance-egress}}
UPLINK_NETWORK=${PHASE50_SANDBOX_UPLINK_NETWORK_NAME:-phase50-conformance-uplink}
PROXY_CONTAINER=${PHASE50_SANDBOX_PROXY_CONTAINER:-${AGENT_RUNNER_SANDBOX_PROXY_CONTAINER:-phase50-conformance-egress-proxy}}
ALLOWED_ORIGIN_CONTAINER=${PHASE50_SANDBOX_ALLOWED_ORIGIN_CONTAINER:-phase50-conformance-allowed-origin}
DENIED_ORIGIN_CONTAINER=${PHASE50_SANDBOX_DENIED_ORIGIN_CONTAINER:-phase50-conformance-denied-origin}
ENV_FILE=${PHASE50_SANDBOX_ENV_FILE:-${TMPDIR:-/tmp}/ai-agent-runner-phase50-sandbox.env}

docker rm -f "$PROXY_CONTAINER" "$ALLOWED_ORIGIN_CONTAINER" "$DENIED_ORIGIN_CONTAINER" >/dev/null 2>&1 || true
docker network rm "$INTERNAL_NETWORK" "$UPLINK_NETWORK" >/dev/null 2>&1 || true
rm -f "$ENV_FILE"

printf 'Phase 50 sandbox conformance fixture removed.\n'
