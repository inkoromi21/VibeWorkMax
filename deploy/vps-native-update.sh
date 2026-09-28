#!/usr/bin/env bash
# Update a native (non-Docker) VibeWork MAX deployment.
# Run as root after `git pull`:
#   cd /opt/vibeworkmax && bash deploy/vps-native-update.sh
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${VIBEWORK_MAX_ENV_FILE:-/etc/vibework-max/vibework-max.env}"
NODE_MEMORY_LIMIT="${VIBEWORK_MAX_BUILD_MEMORY_MB:-384}"

if [[ ${EUID} -ne 0 ]]; then
  echo "ERROR: run this script as root." >&2
  exit 1
fi

for command in node corepack systemctl psql redis-cli nginx; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "ERROR: missing required command: $command" >&2
    exit 1
  }
done

if [[ ! -r "$ENV_FILE" ]]; then
  echo "ERROR: missing environment file: $ENV_FILE" >&2
  exit 1
fi

cd "$REPO_ROOT"
echo "=== VibeWork MAX native update $(date -Is) ==="

echo "[1/5] Install locked Node dependencies"
corepack enable
pnpm install --frozen-lockfile

echo "[2/5] Build application (Node heap limit: ${NODE_MEMORY_LIMIT} MB)"
NODE_OPTIONS="--max-old-space-size=$NODE_MEMORY_LIMIT" pnpm build

echo "[3/5] Apply database migrations"
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
pnpm migrate

echo "[4/5] Restart API and worker"
systemctl restart vibework-max-api vibework-max-worker

echo "[5/5] Verify services and Nginx configuration"
systemctl --no-pager --full status vibework-max-api vibework-max-worker
nginx -t
systemctl reload nginx
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:3000/health
echo
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:3001/health
echo
echo "=== VibeWork MAX native update complete $(date -Is) ==="
