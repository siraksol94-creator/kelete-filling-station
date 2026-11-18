#!/usr/bin/env bash
# kelete-release.sh — manual, tagged release for the Kelete VPS (S5).
#
# Replaces the old cron job that ran kelete-deploy.sh every minute and did
# `git reset --hard origin/main` + a PM2 restart on ANY push to main.
#
# This script only ever deploys a named, existing git TAG, and only when a
# person runs it. Before switching code it:
#   1. refuses if the server's checkout has local, uncommitted edits;
#   2. takes a SQLite `.backup` of every Kelete database and checks each copy
#      with `PRAGMA integrity_check` — any failure stops the release;
#   3. records the commit it is replacing, so `rollback` can return to it.
# After switching it restarts PM2 and waits for /api/health; if the app does
# not come up healthy, it puts the previous code back automatically.
#
# It does NOT restore databases automatically: that would discard every sale
# made since the backup. If data needs restoring, that is a human decision,
# using the backup folder this script prints.
#
# Usage (as the user that owns APP_DIR):
#   kelete-release.sh status
#   kelete-release.sh deploy v1.14.0
#   kelete-release.sh rollback
#
# Required settings — no defaults on purpose, because Phase 1 found the live
# directory, PM2 name and port contradicting each other. Put them in
# /etc/kelete-release.conf (sourced if present) or the environment:
#   APP_DIR       e.g. /var/www/kelete-fuel          (the LIVE checkout)
#   PM2_PROCESS   e.g. kelete-fuel                   (from `pm2 list`)
#   HEALTH_URL    e.g. http://127.0.0.1:5301/api/health
# Optional:
#   GIT_REMOTE    default: origin
#   BACKUP_ROOT   default: /var/backups/kelete/pre-release
#   BUILD_FRONTEND  default: auto   (auto | yes | no)

set -euo pipefail

CONF=/etc/kelete-release.conf
# shellcheck disable=SC1090
[ -f "$CONF" ] && . "$CONF"

: "${APP_DIR:?Set APP_DIR (the live checkout) in $CONF or the environment}"
: "${PM2_PROCESS:?Set PM2_PROCESS (from pm2 list) in $CONF or the environment}"
: "${HEALTH_URL:?Set HEALTH_URL (e.g. http://127.0.0.1:5301/api/health) in $CONF or the environment}"
GIT_REMOTE="${GIT_REMOTE:-origin}"
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/kelete/pre-release}"
BUILD_FRONTEND="${BUILD_FRONTEND:-auto}"

STATE_DIR="$APP_DIR/.kelete-release"
HISTORY="$STATE_DIR/history.log"
PREV_REF_FILE="$STATE_DIR/previous_ref"

log()  { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
die()  { echo "ERROR: $*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "'$1' is not installed."; }
need git; need sqlite3; need pm2; need curl; need npm; need flock

exec 9>/tmp/kelete-release.lock
flock -n 9 || die "Another release is already running."

[ -d "$APP_DIR/.git" ] || die "$APP_DIR is not a git checkout."
mkdir -p "$STATE_DIR"

current_ref() { git -C "$APP_DIR" rev-parse HEAD; }
describe_ref() { git -C "$APP_DIR" describe --tags --exact-match "$1" 2>/dev/null || echo "${1:0:12}"; }

require_clean_tree() {
  local dirty
  dirty="$(git -C "$APP_DIR" status --porcelain --untracked-files=no)"
  if [ -n "$dirty" ]; then
    echo "$dirty" >&2
    die "The live checkout has local edits (listed above). Nothing was changed. Save or discard them deliberately first — the old auto-deploy would have silently destroyed them."
  fi
}

# Read only these three keys from backend/.env — never print anything else.
env_value() {
  local key="$1" file="$APP_DIR/backend/.env"
  [ -f "$file" ] || return 0
  grep -E "^${key}=" "$file" | tail -n1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

list_databases() {
  local db_path master_path tenants_dir
  db_path="$(env_value DB_PATH)";          db_path="${db_path:-$APP_DIR/backend/kelete.db}"
  master_path="$(env_value MASTER_DB_PATH)"; master_path="${master_path:-$APP_DIR/master.db}"
  tenants_dir="$(env_value TENANTS_DIR)"
  if [ -z "$tenants_dir" ]; then tenants_dir="$APP_DIR/tenants"
  elif [ "${tenants_dir:0:1}" != "/" ]; then tenants_dir="$APP_DIR/backend/$tenants_dir"; fi
  [ -f "$db_path" ] && echo "$db_path"
  [ -f "$master_path" ] && echo "$master_path"
  if [ -d "$tenants_dir" ]; then
    find "$tenants_dir" -maxdepth 1 -type f -name '*.db' | sort
  fi
}

backup_databases() {
  local dest="$1" count=0 name out
  mkdir -p "$dest"
  chmod 700 "$dest"
  while IFS= read -r src; do
    [ -n "$src" ] || continue
    name="$(echo "$src" | sed "s#^$APP_DIR/##; s#/#__#g")"
    out="$dest/$name"
    sqlite3 "file:$src?mode=ro" ".backup '$out'" || die "Backup FAILED for $src — release stopped, nothing changed."
    [ "$(sqlite3 "$out" 'PRAGMA integrity_check;')" = "ok" ] || die "Integrity check FAILED on the backup of $src — release stopped, nothing changed."
    log "  backed up $src -> $out ($(du -h "$out" | cut -f1))"
    count=$((count + 1))
  done < <(list_databases)
  [ "$count" -gt 0 ] || die "No databases found under $APP_DIR — check APP_DIR before releasing."
  log "  $count database(s) backed up and verified."
}

health_ok() {
  local i
  for i in $(seq 1 45); do
    if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

build_frontend() {
  # Build into a side folder, then swap, so a failed build never leaves the
  # site without a frontend. Old build kept as build.prev for rollback.
  log "  building web frontend"
  ( cd "$APP_DIR/frontend" && npm ci && BUILD_PATH=build.next npm run build:web )
  rm -rf "$APP_DIR/frontend/build.prev"
  [ -d "$APP_DIR/frontend/build" ] && mv "$APP_DIR/frontend/build" "$APP_DIR/frontend/build.prev"
  mv "$APP_DIR/frontend/build.next" "$APP_DIR/frontend/build"
}

switch_to() {
  # $1 = commit/tag to check out, $2 = commit currently running
  local target="$1" from="$2" changed
  changed="$(git -C "$APP_DIR" diff --name-only "$from" "$target")"
  git -C "$APP_DIR" checkout --quiet --detach "$target"
  if echo "$changed" | grep -qE '^backend/(package\.json|package-lock\.json)$'; then
    log "  backend dependencies changed — npm ci"
    ( cd "$APP_DIR/backend" && npm ci --omit=dev )
  fi
  case "$BUILD_FRONTEND" in
    yes) build_frontend ;;
    no)  log "  frontend build skipped (BUILD_FRONTEND=no)" ;;
    *)   if echo "$changed" | grep -q '^frontend/'; then build_frontend; else log "  frontend unchanged"; fi ;;
  esac
  pm2 restart "$PM2_PROCESS" --update-env
}

cmd_status() {
  local head; head="$(current_ref)"
  echo "Live checkout : $APP_DIR"
  echo "Running       : $(describe_ref "$head")  ($head)"
  [ -f "$PREV_REF_FILE" ] && echo "Rollback to   : $(describe_ref "$(cat "$PREV_REF_FILE")")"
  echo "Recent releases:"; tail -n 10 "$HISTORY" 2>/dev/null || echo "  (none recorded yet)"
}

cmd_deploy() {
  local tag="${1:-}" from target stamp backup_dir
  [ -n "$tag" ] || die "Usage: $0 deploy <tag>"
  require_clean_tree
  log "Fetching tags from $GIT_REMOTE"
  git -C "$APP_DIR" fetch --quiet --tags "$GIT_REMOTE"
  target="$(git -C "$APP_DIR" rev-parse -q --verify "refs/tags/$tag^{commit}")" || die "Tag '$tag' does not exist on $GIT_REMOTE. Only tagged releases can be deployed."
  from="$(current_ref)"
  [ "$from" != "$target" ] || die "$tag is already running. Nothing to do."

  stamp="$(date +%Y-%m-%d_%H%M%S)"
  backup_dir="$BACKUP_ROOT/$stamp-before-$tag-$$"
  log "Step 1/3 — backing up databases to $backup_dir"
  backup_databases "$backup_dir"

  log "Step 2/3 — switching $(describe_ref "$from") -> $tag"
  echo "$from" > "$PREV_REF_FILE"
  switch_to "$target" "$from"

  log "Step 3/3 — waiting for $HEALTH_URL"
  if health_ok; then
    echo "$(date '+%F %T')  deployed $tag ($target) replacing $(describe_ref "$from") ($from)  backup=$backup_dir" >> "$HISTORY"
    log "Release $tag is live and healthy. Roll back with: $0 rollback"
  else
    log "Health check FAILED — putting $(describe_ref "$from") back."
    git -C "$APP_DIR" checkout --quiet --detach "$from"
    if [ -d "$APP_DIR/frontend/build.prev" ]; then
      rm -rf "$APP_DIR/frontend/build.failed"; mv "$APP_DIR/frontend/build" "$APP_DIR/frontend/build.failed"
      mv "$APP_DIR/frontend/build.prev" "$APP_DIR/frontend/build"
    fi
    pm2 restart "$PM2_PROCESS" --update-env
    echo "$(date '+%F %T')  FAILED $tag ($target) — auto-reverted to $from  backup=$backup_dir" >> "$HISTORY"
    die "Release $tag did not come up healthy and was reverted. Databases were NOT restored; the pre-release backup is in $backup_dir. Check: pm2 logs $PM2_PROCESS"
  fi
}

cmd_rollback() {
  local prev from
  [ -f "$PREV_REF_FILE" ] || die "No previous release recorded — nothing to roll back to."
  prev="$(cat "$PREV_REF_FILE")"
  from="$(current_ref)"
  [ "$prev" != "$from" ] || die "Already running the recorded previous release."
  require_clean_tree
  log "Rolling back $(describe_ref "$from") -> $(describe_ref "$prev")"
  git -C "$APP_DIR" checkout --quiet --detach "$prev"
  if echo "$(git -C "$APP_DIR" diff --name-only "$from" "$prev")" | grep -qE '^backend/(package\.json|package-lock\.json)$'; then
    ( cd "$APP_DIR/backend" && npm ci --omit=dev )
  fi
  if [ -d "$APP_DIR/frontend/build.prev" ]; then
    rm -rf "$APP_DIR/frontend/build.rolledback"; mv "$APP_DIR/frontend/build" "$APP_DIR/frontend/build.rolledback"
    mv "$APP_DIR/frontend/build.prev" "$APP_DIR/frontend/build"
  fi
  pm2 restart "$PM2_PROCESS" --update-env
  if health_ok; then
    echo "$(date '+%F %T')  rolled back to $prev from $from" >> "$HISTORY"
    log "Rolled back and healthy. Databases were not touched."
  else
    die "Rolled back code but the health check still fails — check: pm2 logs $PM2_PROCESS"
  fi
}

case "${1:-}" in
  status)   cmd_status ;;
  deploy)   cmd_deploy "${2:-}" ;;
  rollback) cmd_rollback ;;
  *) echo "Usage: $0 status | deploy <tag> | rollback" >&2; exit 2 ;;
esac
