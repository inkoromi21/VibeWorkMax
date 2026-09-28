#!/usr/bin/env bash
# Pull VibeWork MAX from its private GitHub repository, then rebuild and restart.
#
# Run from an interactive VPS shell:
#   cd /opt/vibeworkmax && bash deploy/vps-native-pull-and-update.sh
#
# Git prompts for GitHub username and a fine-grained PAT on every run. The PAT
# is not saved on the VPS and is never included in the command line.
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPOSITORY_URL="https://github.com/inkoromi21/VibeWorkMax.git"
BRANCH="${VIBEWORK_MAX_BRANCH:-main}"

if [[ ! -t 0 || ! -t 1 ]]; then
  echo "ERROR: run this script from an interactive VPS terminal." >&2
  exit 1
fi

cd "$REPO_ROOT"

echo "=== Pulling $BRANCH from the private GitHub repository ==="
echo "When Git asks: enter your GitHub login, then a fine-grained PAT (github_pat_...)."
# An empty helper list prevents credentials from being stored or reused.
git -c credential.helper= -c credential.useHttpPath=true \
  pull --ff-only "$REPOSITORY_URL" "$BRANCH"

exec bash "$REPO_ROOT/deploy/vps-native-update.sh"
