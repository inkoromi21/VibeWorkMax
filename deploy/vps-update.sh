#!/usr/bin/env bash
# Update VibeWork MAX on the VPS after `git pull`.
#
#   cd /opt/vibeworkmax && git pull origin main && sudo bash deploy/vps-update.sh
#
# The stack is managed by Docker Compose; it contains its own API, worker,
# web server and proxy. Persistent database/cache volumes are not removed.
set -Eeuo pipefail

COMPOSE_PROFILE="${VIBEWORK_MAX_COMPOSE_PROFILE:-production}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: Docker Engine is not installed or unavailable." >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "ERROR: Docker Compose v2 is required (command: docker compose)." >&2
  exit 1
fi

cd "$REPO_ROOT"

echo "=== VibeWork MAX update $(date -Is) ==="
echo "[1/4] Repository: $REPO_ROOT"
echo "[2/4] Build and start the '$COMPOSE_PROFILE' stack"
docker compose --profile "$COMPOSE_PROFILE" up --build --wait --remove-orphans

echo "[3/4] Verify the local proxy health endpoint"
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:8080/health
echo

echo "[4/4] Container status"
docker compose --profile "$COMPOSE_PROFILE" ps

echo
echo "=== Recent service logs ==="
docker compose --profile "$COMPOSE_PROFILE" logs --tail=50 api worker web proxy || true
echo "=== VibeWork MAX update complete $(date -Is) ==="
