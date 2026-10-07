#!/usr/bin/env bash
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# vps/backup.sh â€” daily SQLite backup for Kelete VPS (ZRA Ref 11)
#
# What it backs up:
#   - backend/kelete.db      (HQ mirror)
#   - master.db              (tenants + licenses + branches)
#   - tenants/*.db           (every registered branch)
#
# Where it lands:
#   /var/backups/kelete/YYYY-MM-DD/
#     â”œâ”€â”€ master.db
#     â”œâ”€â”€ kelete.db
#     â”œâ”€â”€ tenants/
#     â”‚   â”œâ”€â”€ buseko.db
#     â”‚   â”œâ”€â”€ garden.db
#     â”‚   â””â”€â”€ ...
#     â””â”€â”€ backup.log      (per-file status + sizes)
#
# Rotation: prunes backup dirs older than KEEP_DAYS (default 14).
#
# Uses `sqlite3 .backup` (not raw cp) so the copy is consistent even while
# the app is writing â€” SQLite handles WAL correctly through this command.
#
# Install (one-time):
#   sudo mkdir -p /var/backups/kelete
#   chmod +x /var/www/kelete-pos-tenant/vps/backup.sh
#   crontab -e
#   # Add this line (runs every night at 02:00):
#   0 2 * * * /var/www/kelete-pos-tenant/vps/backup.sh >> /var/log/kelete-backup.log 2>&1
#
# Manual run (test):
#   /var/www/kelete-pos-tenant/vps/backup.sh
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
set -u  # error on unset vars; not -e because we want to continue past
        # a single failing branch DB and still back up the others.

APP_DIR="${APP_DIR:-/var/www/kelete-pos-tenant}"
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/kelete}"
KEEP_DAYS="${KEEP_DAYS:-14}"

STAMP="$(date +%Y-%m-%d_%H%M%S)"
DAY_DIR="$BACKUP_ROOT/$(date +%Y-%m-%d)"
LOG="$DAY_DIR/backup.log"

mkdir -p "$DAY_DIR/tenants"

log() { echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

log "â–¶ Kelete backup starting (APP_DIR=$APP_DIR, BACKUP_ROOT=$BACKUP_ROOT, KEEP_DAYS=$KEEP_DAYS)"

if ! command -v sqlite3 >/dev/null 2>&1; then
  log "âœ– sqlite3 command not found. Install with: apt-get install -y sqlite3"
  exit 1
fi

backup_one() {
  local SRC="$1"
  local DST="$2"
  local NAME
  NAME="$(basename "$SRC")"

  if [ ! -f "$SRC" ]; then
    log "  Â· $NAME  SKIP (source not found: $SRC)"
    return 0
  fi

  # `.backup` is atomic under SQLite even while the source is being written.
  if sqlite3 "$SRC" ".backup '$DST'" 2>>"$LOG"; then
    local SIZE
    SIZE="$(du -h "$DST" 2>/dev/null | awk '{print $1}')"
    log "  âœ“ $NAME  â†’ $DST  ($SIZE)"
  else
    log "  âœ– $NAME  FAILED (source $SRC)"
    return 1
  fi
}

# HQ + master
backup_one "$APP_DIR/backend/kelete.db" "$DAY_DIR/kelete.db"
backup_one "$APP_DIR/master.db"         "$DAY_DIR/master.db"

# All registered branches
if [ -d "$APP_DIR/tenants" ]; then
  for TDB in "$APP_DIR/tenants/"*.db; do
    [ -e "$TDB" ] || continue
    backup_one "$TDB" "$DAY_DIR/tenants/$(basename "$TDB")"
  done
else
  log "  Â· tenants/ directory not found, skipping branch DBs"
fi

# â”€â”€ Rotation: drop day-dirs older than KEEP_DAYS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
log "â–¶ Rotation (keeping last $KEEP_DAYS days)"
find "$BACKUP_ROOT" -maxdepth 1 -type d -mtime "+$KEEP_DAYS" -print -exec rm -rf {} \; 2>>"$LOG" \
  | while IFS= read -r D; do log "  âˆ’ pruned $D"; done

TOTAL_SIZE="$(du -sh "$DAY_DIR" 2>/dev/null | awk '{print $1}')"
log "âœ“ Backup complete: $DAY_DIR ($TOTAL_SIZE)"
