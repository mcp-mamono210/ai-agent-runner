#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
INTERNAL_NETWORK=${PHASE50_SANDBOX_NETWORK_NAME:-phase50-conformance-egress}
UPLINK_NETWORK=${PHASE50_SANDBOX_UPLINK_NETWORK_NAME:-phase50-conformance-uplink}
PROXY_CONTAINER=${PHASE50_SANDBOX_PROXY_CONTAINER:-phase50-conformance-egress-proxy}
ALLOWED_ORIGIN_CONTAINER=${PHASE50_SANDBOX_ALLOWED_ORIGIN_CONTAINER:-phase50-conformance-allowed-origin}
DENIED_ORIGIN_CONTAINER=${PHASE50_SANDBOX_DENIED_ORIGIN_CONTAINER:-phase50-conformance-denied-origin}
PROBE_IMAGE=${PHASE50_SANDBOX_PROBE_IMAGE:-node:24.19.0-alpine3.24}
PROXY_IMAGE=${PHASE50_SANDBOX_PROXY_IMAGE:-ai-agent-runner-phase50-proxy:local}
PROXY_PORT=${PHASE50_SANDBOX_PROXY_PORT:-3128}
ENV_FILE=${PHASE50_SANDBOX_ENV_FILE:-${TMPDIR:-/tmp}/ai-agent-runner-phase50-sandbox.env}
POLICY_LABEL=io.mcp.agent-runner.egress-policy-sha256
PROXY_ROLE_LABEL=io.mcp.agent-runner.egress-proxy
FIXTURE_LABEL=io.mcp.agent-runner.phase50-conformance

ALLOWED_ORIGIN="http://${ALLOWED_ORIGIN_CONTAINER}:8080"
DENIED_ORIGIN="http://${DENIED_ORIGIN_CONTAINER}:8080"
PROXY_URL="http://${PROXY_CONTAINER}:${PROXY_PORT}"
POLICY_JSON=$(cat <<JSON
{"agent-provider":{"classification":"required","endpoints":["${ALLOWED_ORIGIN}"]},"package-registry":{"classification":"denied","endpoints":[]},"required-runtime-dependency":{"classification":"denied","endpoints":[]},"source-repository":{"classification":"denied","endpoints":[]},"other-external-endpoint":{"classification":"denied","endpoints":[]}}
JSON
)

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'required command not found: %s\n' "$1" >&2
    exit 1
  }
}

cleanup_named_resources() {
  docker rm -f "$PROXY_CONTAINER" "$ALLOWED_ORIGIN_CONTAINER" "$DENIED_ORIGIN_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$INTERNAL_NETWORK" "$UPLINK_NETWORK" >/dev/null 2>&1 || true
}

wait_for_proxy() {
  local attempt
  for attempt in $(seq 1 30); do
    if docker container inspect "$PROXY_CONTAINER" --format '{{.State.Running}}' 2>/dev/null | grep -qx true; then
      if docker run --rm --network "$INTERNAL_NETWORK" "$PROBE_IMAGE" node -e '
        const http=require("node:http");
        const proxy=new URL(process.argv[1]);
        const target=process.argv[2];
        const req=http.request({host:proxy.hostname,port:proxy.port,method:"GET",path:target,headers:{Host:new URL(target).host}},res=>{res.resume();process.exit(res.statusCode===200?0:2)});
        req.setTimeout(1000,()=>req.destroy(new Error("timeout")));
        req.on("error",()=>process.exit(3));
        req.end();
      ' "$PROXY_URL" "$ALLOWED_ORIGIN" >/dev/null 2>&1; then
        return
      fi
    fi
    sleep 1
  done
  docker logs "$PROXY_CONTAINER" >&2 || true
  printf 'phase50 proxy did not become ready\n' >&2
  exit 1
}

write_env_file() {
  mkdir -p "$(dirname "$ENV_FILE")"
  {
    printf 'export PHASE50_SANDBOX_CONFORMANCE=1\n'
    printf 'export PHASE50_SANDBOX_NETWORK_NAME=%q\n' "$INTERNAL_NETWORK"
    printf 'export PHASE50_SANDBOX_UPLINK_NETWORK_NAME=%q\n' "$UPLINK_NETWORK"
    printf 'export PHASE50_SANDBOX_PROXY_CONTAINER=%q\n' "$PROXY_CONTAINER"
    printf 'export PHASE50_SANDBOX_ALLOWED_ORIGIN_CONTAINER=%q\n' "$ALLOWED_ORIGIN_CONTAINER"
    printf 'export PHASE50_SANDBOX_DENIED_ORIGIN_CONTAINER=%q\n' "$DENIED_ORIGIN_CONTAINER"
    printf 'export AGENT_RUNNER_SANDBOX_NETWORK_NAME=%q\n' "$INTERNAL_NETWORK"
    printf 'export AGENT_RUNNER_SANDBOX_PROXY_CONTAINER=%q\n' "$PROXY_CONTAINER"
    printf 'export AGENT_RUNNER_SANDBOX_PROXY_URL=%q\n' "$PROXY_URL"
    printf 'export AGENT_RUNNER_SANDBOX_NETWORK_POLICY_JSON=%q\n' "$POLICY_JSON"
    printf 'export PHASE50_SANDBOX_POLICY_DIGEST=%q\n' "$POLICY_DIGEST"
    printf 'export PHASE50_SANDBOX_ALLOWED_PROBE_URL=%q\n' "$ALLOWED_ORIGIN"
    printf 'export PHASE50_SANDBOX_DENIED_PROBE_URL=%q\n' "$DENIED_ORIGIN"
    printf 'export PHASE50_SANDBOX_PROBE_IMAGE=%q\n' "$PROBE_IMAGE"
  } > "$ENV_FILE"
}

require_command docker
require_command node

docker info >/dev/null

POLICY_DIGEST=$(PHASE50_POLICY_JSON="$POLICY_JSON" node <<'NODE'
const crypto = require("node:crypto");
const categories = [
  "agent-provider",
  "package-registry",
  "required-runtime-dependency",
  "source-repository",
  "other-external-endpoint",
];
const root = JSON.parse(process.env.PHASE50_POLICY_JSON);
const ordered = categories.map((category) => {
  const entry = root[category];
  if (entry === undefined) {
    throw new Error(`missing policy category: ${category}`);
  }
  return {
    category,
    classification: entry.classification,
    endpoints: [...entry.endpoints].sort(),
  };
});
process.stdout.write(`sha256:${crypto.createHash("sha256").update(JSON.stringify(ordered)).digest("hex")}`);
NODE
)

cleanup_named_resources

docker build --quiet \
  --file "$ROOT_DIR/scripts/phase50/proxy/Dockerfile" \
  --tag "$PROXY_IMAGE" \
  "$ROOT_DIR" >/dev/null

docker network create \
  --internal \
  --label "${POLICY_LABEL}=${POLICY_DIGEST}" \
  --label "${FIXTURE_LABEL}=true" \
  "$INTERNAL_NETWORK" >/dev/null

docker network create \
  --label "${FIXTURE_LABEL}=true" \
  "$UPLINK_NETWORK" >/dev/null

docker run -d --rm \
  --name "$ALLOWED_ORIGIN_CONTAINER" \
  --network "$UPLINK_NETWORK" \
  --label "${FIXTURE_LABEL}=true" \
  "$PROBE_IMAGE" \
  node -e 'require("node:http").createServer((req,res)=>{res.writeHead(200,{"content-type":"text/plain"});res.end("phase50-allowed\n")}).listen(8080,"0.0.0.0")' >/dev/null

docker run -d --rm \
  --name "$DENIED_ORIGIN_CONTAINER" \
  --network "$UPLINK_NETWORK" \
  --label "${FIXTURE_LABEL}=true" \
  "$PROBE_IMAGE" \
  node -e 'require("node:http").createServer((req,res)=>{res.writeHead(200,{"content-type":"text/plain"});res.end("phase50-denied-origin\n")}).listen(8080,"0.0.0.0")' >/dev/null

docker run -d --rm \
  --name "$PROXY_CONTAINER" \
  --network "$UPLINK_NETWORK" \
  --label "${PROXY_ROLE_LABEL}=true" \
  --label "${POLICY_LABEL}=${POLICY_DIGEST}" \
  --label "${FIXTURE_LABEL}=true" \
  --env "PHASE50_PROXY_ALLOWED_ORIGINS=${ALLOWED_ORIGIN}" \
  --env "PHASE50_PROXY_PORT=${PROXY_PORT}" \
  "$PROXY_IMAGE" >/dev/null

docker network connect --alias "$PROXY_CONTAINER" "$INTERNAL_NETWORK" "$PROXY_CONTAINER"

wait_for_proxy
write_env_file

printf 'Phase 50 sandbox conformance fixture is ready.\n'
printf 'Policy digest: %s\n' "$POLICY_DIGEST"
printf 'Environment file: %s\n' "$ENV_FILE"
printf 'For manual use: source %q\n' "$ENV_FILE"
