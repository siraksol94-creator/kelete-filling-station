#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# vps/backup.sh — daily SQLite backup for Kelete VPS (ZRA Ref 11)
#
# What it backs up:
#   - backend/kelete.db      (HQ mirror)
#   - master.db              (tenants + licenses + branches)
#   - tenants/*.db           (every registered branch)
#
# Where it lands:
#   /var/backups/kelete/YYYY-MM-DD/
#     ├── master.db
#     ├── kelete.db
#     ├── tenants/
#     │   ├── buseko.db
#     │   ├── garden.db
#     │   └── ...
#     └── backup.log      (per-file status + sizes)
#
# Rotation: prunes backup dirs older than KEEP_DAYS (default 14).
#
# Uses `sqlite3 .backup` (not raw cp) so the copy is consistent even while
# the app is writing — SQLite handles WAL correctly through this command.
# S6: every copy is integrity-checked before it replaces anything; results go
# to manifest.json; the script exits 1 if any copy failed. To restore, see
# ops/backup/README.md (never copy a backup over a running database).
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
# ─────────────────────────────────────────────────────────────────────────────
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

log "▶ Kelete backup starting (APP_DIR=$APP_DIR, BACKUP_ROOT=$BACKUP_ROOT, KEEP_DAYS=$KEEP_DAYS)"

if ! command -v sqlite3 >/dev/null 2>&1; then
  log "✖ sqlite3 command not found. Install with: apt-get install -y sqlite3"
  exit 1
fi

# S6: copy to "<name>.partial", check it with PRAGMA integrity_check, and only
# then move it to "<name>". A copy that fails is kept as "<name>.FAILED" (for
# investigation) and the run exits non-zero, so cron mail / the "Create Backup
# Now" button report it instead of quietly keeping a broken backup.
FAILS=0

backup_one() {
  local SRC="$1"
  local DST="$2"
  local NAME
  NAME="$(basename "$SRC")"

  if [ ! -f "$SRC" ]; then
    log "  · $NAME  SKIP (source not found: $SRC)"
    return 0
  fi

  rm -f "$DST.partial" "$DST.partial-wal" "$DST.partial-shm"
  # `.backup` is SQLite's online backup: consistent even while the source is
  # being written, including anything still in the -wal file.
  if ! sqlite3 "$SRC" ".backup '$DST.partial'" 2>>"$LOG"; then
    log "  ✖ $NAME  FAILED to copy (source $SRC)"
    rm -f "$DST.partial"
    FAILS=$((FAILS + 1))
    return 1
  fi
  # One self-contained file: no -wal/-shm needed to open the backup.
  sqlite3 "$DST.partial" "PRAGMA journal_mode=DELETE;" >/dev/null 2>>"$LOG"
  rm -f "$DST.partial-wal" "$DST.partial-shm"

  local CHECK
  CHECK="$(sqlite3 "$DST.partial" "PRAGMA integrity_check;" 2>>"$LOG")"
  if [ "$CHECK" = "ok" ]; then
    mv -f "$DST.partial" "$DST"
    rm -f "$DST.FAILED"
    local SIZE
    SIZE="$(du -h "$DST" 2>/dev/null | awk '{print $1}')"
    log "  ✓ $NAME  → $DST  ($SIZE, integrity ok)"
  else
    mv -f "$DST.partial" "$DST.FAILED"
    log "  ✖ $NAME  FAILED integrity check — kept as $DST.FAILED: $(echo "$CHECK" | head -3 | tr '\n' ' ')"
    FAILS=$((FAILS + 1))
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
  log "  · tenants/ directory not found, skipping branch DBs"
fi

# ── Rotation: drop day-dirs older than KEEP_DAYS ─────────────────────────────
log "▶ Rotation (keeping last $KEEP_DAYS days)"
find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -name "20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]*" -mtime "+$KEEP_DAYS" -print -exec rm -rf {} \; 2>>"$LOG" \
  | while IFS= read -r D; do log "  − pruned $D"; done

# ── S6: record what was checked (row counts, sizes, SHA-256) in manifest.json ─
VERIFY_JS="${KELETE_VERIFY_SCRIPT:-$APP_DIR/ops/backup/verify.js}"
if command -v node >/dev/null 2>&1 && [ -f "$VERIFY_JS" ]; then
  if node "$VERIFY_JS" "$DAY_DIR" --write-manifest --method vps-nightly >>"$LOG" 2>&1; then
    log "  ✓ manifest.json written (all copies verified)"
  else
    log "  ✖ verify.js reported a failure — see $LOG and $DAY_DIR/manifest.json"
    FAILS=$((FAILS + 1))
  fi
else
  log "  · verify.js not available — integrity was checked, manifest.json not written"
fi

TOTAL_SIZE="$(du -sh "$DAY_DIR" 2>/dev/null | awk '{print $1}')"
if [ "$FAILS" -gt 0 ]; then
  log "✖ Backup finished with $FAILS FAILURE(S): $DAY_DIR ($TOTAL_SIZE)"
  exit 1
fi
log "✓ Backup complete: $DAY_DIR ($TOTAL_SIZE)"
