#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
ENV_FILE=${PHASE50_SANDBOX_ENV_FILE:-${TMPDIR:-/tmp}/ai-agent-runner-phase50-sandbox.env}
KEEP_FIXTURE=${PHASE50_KEEP_SANDBOX_FIXTURE:-0}

cleanup() {
  if [[ "$KEEP_FIXTURE" != "1" ]]; then
    "$ROOT_DIR/scripts/phase50/teardown-sandbox-conformance.sh" >/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

"$ROOT_DIR/scripts/phase50/setup-sandbox-conformance.sh"
# shellcheck disable=SC1090
source "$ENV_FILE"

cd "$ROOT_DIR"
npm run lint
npm run typecheck
npm run test:unit
npm run test:integration:phase50
npm run verify:phase50:conformance
