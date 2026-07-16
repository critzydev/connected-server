#!/usr/bin/env bash
# One-command update for a self-hosted Connected server:
#
#   cd connected-server && ./update.sh
#
# Published at the ROOT of the connected-server distribution. The public
# repo's history is rewritten on every release, so this uses fetch + reset
# (a plain `git pull` would refuse the divergence). deploy.env, uploads, and
# docker volumes are untracked and survive.
set -euo pipefail
# The brace group is load-bearing: it makes bash parse the WHOLE script before
# running it, so the git reset overwriting this very file mid-run is safe.
{
  cd "$(dirname "$0")"
  if [ ! -f server/infra/setup.sh ]; then
    echo "update.sh must run from the connected-server repo root." >&2
    exit 1
  fi
  echo "==> Fetching the latest Connected release…"
  git fetch origin
  git reset --hard origin/main
  exec ./server/infra/setup.sh
}
