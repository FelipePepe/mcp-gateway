#!/usr/bin/env bash
set -euo pipefail

# Start upstream MCP services first, then restart the gateway so it catalogs tools
# after its dependencies are available.

ROOT="${MCP_ROOT:-/mnt/nas/sources}"

compose_up() {
  local dir="$1"
  shift
  echo "==> docker compose up in ${dir}: $*"
  docker compose -f "${dir}/docker-compose.yml" up -d --build "$@"
}

wait_http() {
  local url="$1"
  local name="$2"
  local tries="${3:-30}"
  echo "==> waiting for ${name}: ${url}"
  for _ in $(seq 1 "$tries"); do
    if curl -fsS -m 3 "$url" >/dev/null 2>&1; then
      echo "==> ${name} ready"
      return 0
    fi
    sleep 2
  done
  echo "WARN: ${name} did not become ready at ${url}" >&2
  return 1
}

# 1) Base dependency for search MCP
compose_up "${ROOT}/infra/searxng"
wait_http "http://127.0.0.1:20005" "searxng" 30 || true

# 2) Upstream MCP containers
compose_up "${ROOT}/infra/mcp/searxng-mcp"
wait_http "http://127.0.0.1:28765/mcp" "searxng-mcp" 15 || true

compose_up "${ROOT}/infra/mcp/atlas-mcp" atlas-mcp

# analizetube-mcp ships as a prebuilt registry image and is orchestrated by the
# unified stack (infra/mcp/docker-compose.yml); bring just that service up here.
docker compose -f "${ROOT}/infra/mcp/docker-compose.yml" up -d analizetube-mcp

# Optional: SonarQube is expected externally at 192.168.1.56:9000.
# The gateway will report sonarqube degraded if that service is down.

# 3) Gateway LAST: force recreate so it reconnects/catalogs upstream tools.
compose_up "${ROOT}/infra/mcp/mcp-gateway" --force-recreate mcp-gateway
wait_http "http://127.0.0.1:20001/health" "mcp-gateway" 30

echo "==> MCP stack status"
curl -fsS http://127.0.0.1:20001/health
echo
