#!/usr/bin/env bash
# Pull a private GitHub repository over SSH, then rebuild and restart VibeWork MAX.
#
# Run from an interactive root shell on the VPS:
#   cd /opt/vibeworkmax && bash deploy/vps-native-pull-and-update.sh
#
# The deploy key must be passphrase-protected. Its passphrase is requested for
# every run and is deliberately not loaded into ssh-agent.
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_KEY="${VIBEWORK_MAX_DEPLOY_KEY:-/root/.ssh/id_ed25519_vibeworkmax}"
BRANCH="${VIBEWORK_MAX_BRANCH:-main}"

if [[ ${EUID} -ne 0 ]]; then
  echo "ERROR: run this script as root from an interactive VPS shell." >&2
  exit 1
fi

if [[ ! -t 0 || ! -t 1 ]]; then
  echo "ERROR: an interactive terminal is required to enter the deploy-key passphrase." >&2
  exit 1
fi

if [[ ! -r "$DEPLOY_KEY" ]]; then
  echo "ERROR: deploy key is missing or unreadable: $DEPLOY_KEY" >&2
  exit 1
fi

cd "$REPO_ROOT"
unset SSH_AUTH_SOCK

echo "=== Pulling $BRANCH from the private repository ==="
git -c core.sshCommand="ssh -i $DEPLOY_KEY -o IdentitiesOnly=yes -o BatchMode=no" \
  pull --ff-only origin "$BRANCH"

exec bash "$REPO_ROOT/deploy/vps-native-update.sh"
