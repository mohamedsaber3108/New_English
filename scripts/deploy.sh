#!/usr/bin/env bash
# Release-based deployment for USAM Language on a Linux server (EC2 or any VM).
#
#   sudo -u usam-language DEPLOY_REF=main scripts/deploy.sh            # deploy a branch/tag/commit
#   sudo -u usam-language scripts/deploy.sh rollback                   # switch back to the previous release
#
# Layout:  $APP_ROOT/repo (git clone)  $APP_ROOT/releases/<timestamp>-<sha>  $APP_ROOT/current -> releases/...
# Steps: fetch -> export the ref into a new release dir -> npm ci (with dev deps, needed to build) -> build -> npm prune
# --omit=dev -> switch `current` -> restart the service -> wait for /api/ready -> keep the last 5 releases.
# If readiness fails, `current` is switched back automatically and the service restarted on the previous release.
# Database migrations run automatically when the server starts (advisory-locked; safe with several instances).
# Restarting needs: a sudoers rule allowing this user `systemctl restart usam-language` (see docs/DEPLOYMENT.md).
set -euo pipefail
APP_ROOT=${APP_ROOT:-/opt/usam-language}
SERVICE=${SERVICE:-usam-language}
PORT=${PORT:-4100}
KEEP=${KEEP_RELEASES:-5}
REF=${DEPLOY_REF:-main}
cd "$APP_ROOT"

ready() {
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:$PORT/api/ready" | grep -q '"ready":true'; then return 0; fi
    sleep 2
  done
  return 1
}
restart() { sudo systemctl restart "$SERVICE"; }

if [ "${1:-}" = "rollback" ]; then
  cur=$(readlink -f current)
  prev=$(ls -1dt releases/*/ | sed 's#/$##' | grep -vx "releases/$(basename "$cur")" | head -n1)
  [ -n "$prev" ] || { echo "No previous release to roll back to" >&2; exit 2; }
  ln -sfn "$APP_ROOT/$prev" current.tmp && mv -Tf current.tmp current
  restart
  ready && echo "Rolled back to $prev" || { echo "Rolled back to $prev but it is NOT ready - check journalctl -u $SERVICE" >&2; exit 1; }
  exit 0
fi

[ -d repo/.git ] || { echo "Missing $APP_ROOT/repo (git clone the repository there first)" >&2; exit 2; }
git -C repo fetch --tags --prune origin
sha=$(git -C repo rev-parse --verify "origin/$REF^{commit}" 2>/dev/null || git -C repo rev-parse --verify "$REF^{commit}")
rel="releases/$(date -u +%Y%m%dT%H%M%SZ)-${sha:0:8}"
mkdir -p "$rel"
git -C repo archive "$sha" | tar -x -C "$rel"
echo "$sha" > "$rel/REVISION"

( cd "$rel" && npm ci --no-audit --no-fund && npm run build:app && npm prune --omit=dev --no-audit --no-fund )

prev=$(readlink -f current 2>/dev/null || true)
ln -sfn "$APP_ROOT/$rel" current.tmp && mv -Tf current.tmp current
restart
if ready; then
  echo "Deployed ${sha:0:8} -> $rel"
else
  echo "New release failed its readiness check" >&2
  if [ -n "$prev" ]; then
    ln -sfn "$prev" current.tmp && mv -Tf current.tmp current
    restart
    ready && echo "Restored previous release $(basename "$prev")" >&2
  fi
  exit 1
fi

ls -1dt releases/*/ | tail -n +$((KEEP + 1)) | xargs -r rm -rf
