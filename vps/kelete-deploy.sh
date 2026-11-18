#!/usr/bin/env bash

# ─── S5 (security remediation): RETIRED ─────────────────────────────────────
# This script deployed every push to `main` within a minute, with
# `git reset --hard` and a PM2 restart, and no review, backup or rollback.
# It is replaced by vps/kelete-release.sh (manual, tagged, backed-up).
# It now refuses to run. Remove its cron entry (see vps/RELEASE.md).
echo "kelete-deploy.sh is retired — use vps/kelete-release.sh. Nothing was done." >&2
exit 0
# ────────────────────────────────────────────────────────────────────────────
# /usr/local/bin/kelete-deploy.sh
#
# Pull-deploy script for Kelete POS. Runs every minute via cron:
#   * * * * * /usr/local/bin/kelete-deploy.sh >> /var/log/kelete-deploy.log 2>&1
#
# Behaviour:
#  - git pull from main
#  - if backend changed → npm install + pm2 restart kelete-tenant
#  - if frontend changed → npm install + npm run build:web
#  - if nothing changed → exit silently
#
# Same pattern as liquor-deploy.sh; pull-deploy avoids the SCP-from-CI
# headache (GitHub Actions IPs filtered at Hostinger's edge).

set -e

REPO=/var/www/kelete-fuel
BRANCH=main
PM2_PROCESS=kelete-fuel
LOCK=/tmp/kelete-deploy.lock

# Only one instance at a time — cron can fire while a previous run is
# still installing. Skip silently if locked.
exec 9>"$LOCK"
flock -n 9 || exit 0

cd "$REPO"

OLD_HEAD=$(git rev-parse HEAD)
git fetch --quiet origin "$BRANCH"
NEW_HEAD=$(git rev-parse "origin/$BRANCH")

if [ "$OLD_HEAD" = "$NEW_HEAD" ]; then
  exit 0  # no new commits
fi

echo "─── [$(date)] new commits ${OLD_HEAD:0:7}..${NEW_HEAD:0:7} ───"

# What changed between the old HEAD and the new one?
CHANGED=$(git diff --name-only "$OLD_HEAD" "$NEW_HEAD")
echo "$CHANGED"

git reset --hard "$NEW_HEAD"

BACKEND_CHANGED=0
FRONTEND_CHANGED=0
echo "$CHANGED" | grep -q '^backend/'  && BACKEND_CHANGED=1 || true
echo "$CHANGED" | grep -q '^frontend/' && FRONTEND_CHANGED=1 || true

# ── Backend deps + restart ─────────────────────────────────────────────
if [ "$BACKEND_CHANGED" = "1" ]; then
  echo "→ backend changed, installing deps + restarting PM2"
  cd backend
  if echo "$CHANGED" | grep -qE '^backend/(package\.json|package-lock\.json)$'; then
    npm install --production
  fi
  pm2 restart "$PM2_PROCESS" || pm2 start server.js --name "$PM2_PROCESS"
  cd ..
fi

# ── Frontend rebuild (web bundle) ──────────────────────────────────────
if [ "$FRONTEND_CHANGED" = "1" ]; then
  echo "→ frontend changed, building web bundle"
  cd frontend
  if echo "$CHANGED" | grep -qE '^frontend/(package\.json|package-lock\.json)$'; then
    npm install
  fi
  npm run build:web
  cd ..
fi

echo "─── done ───"
