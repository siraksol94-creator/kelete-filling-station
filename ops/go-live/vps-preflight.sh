#!/usr/bin/env bash
# ops/go-live/vps-preflight.sh — READ-ONLY facts about the live VPS (P0-3).
#
#   bash vps-preflight.sh <APP_DIR> [PM2_PROCESS] [--no-env] > preflight.txt
#
# What it does: prints the facts the go-live pack needs — which code is
# running, how it is started, which settings are present, where the databases
# are, whether the old auto-deploy is active, and whether the release tools
# are in place.
#
# What it never does:
#   • change, start, stop, fetch, pull or write anything (no git fetch, no pm2
#     restart, no file writes — redirect its output yourself);
#   • open a database (it only lists files, sizes and dates);
#   • print a secret. For JWT_SECRET, ADMIN_PASSWORD, GH_TOKEN and any other
#     key it does not recognise, it prints only "set / not set" or a verdict.
#     Remote URLs are printed with any embedded credentials masked.
# --no-env skips reading backend/.env and the PM2 environment entirely.
set -u
APP_DIR="${1:-}"
[ -n "$APP_DIR" ] && [ -d "$APP_DIR" ] || { echo "usage: $0 <APP_DIR> [PM2_PROCESS] [--no-env]" >&2; exit 2; }
PM2_PROCESS=""; NO_ENV=0
for a in "${@:2}"; do case "$a" in --no-env) NO_ENV=1 ;; *) PM2_PROCESS="$a" ;; esac; done
APP_DIR="$(cd "$APP_DIR" && pwd)"
section() { printf '\n== %s\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }
mask_urls() { sed -E 's#(https?://)[^/@[:space:]]+@#\1***@#g'; }

echo "Kelete VPS pre-flight (read-only) — $(date '+%F %T %Z') — host $(hostname)"

section "Code that is running"
if [ -d "$APP_DIR/.git" ]; then
  echo "checkout   : $APP_DIR"
  echo "HEAD       : $(git -C "$APP_DIR" rev-parse HEAD 2>/dev/null)"
  echo "describe   : $(git -C "$APP_DIR" describe --tags --always 2>/dev/null)"
  echo "last commit: $(git -C "$APP_DIR" log -1 --format='%ci  %s' 2>/dev/null)"
  echo "branch     : $(git -C "$APP_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  echo "remotes    :"; git -C "$APP_DIR" remote -v 2>/dev/null | mask_urls | sort -u | sed 's/^/  /'
  changed="$(git -C "$APP_DIR" status --porcelain --untracked-files=no 2>/dev/null)"
  echo "tracked files changed by hand: $(printf '%s' "$changed" | grep -c . )"
  [ -n "$changed" ] && printf '%s\n' "$changed" | sed 's/^/  /' | head -40
  echo "untracked files (count only): $(git -C "$APP_DIR" status --porcelain 2>/dev/null | grep -c '^??')"
else
  echo "$APP_DIR is NOT a git checkout"
fi

section "Old auto-deploy (must be removed at cutover — vps/RELEASE.md)"
echo "user crontab lines mentioning kelete-deploy: $(crontab -l 2>/dev/null | grep -c kelete-deploy)"
for f in /etc/cron.d/* /etc/crontab; do [ -f "$f" ] && grep -q kelete-deploy "$f" 2>/dev/null && echo "also in: $f"; done
[ -e /usr/local/bin/kelete-deploy.sh ] && echo "/usr/local/bin/kelete-deploy.sh exists (sha256 $(sha256sum /usr/local/bin/kelete-deploy.sh | cut -c1-16)…)"

section "Release tooling (S5)"
[ -x /usr/local/bin/kelete-release ] && echo "kelete-release installed" || echo "kelete-release NOT installed"
if [ -f /etc/kelete-release.conf ]; then echo "/etc/kelete-release.conf (holds no secrets):"; sed 's/^/  /' /etc/kelete-release.conf | mask_urls
else echo "/etc/kelete-release.conf not present"; fi

section "Tools"
for t in node npm pm2 sqlite3 git nginx certbot; do
  if have "$t"; then v="$("$t" --version 2>/dev/null | head -1)"; [ "$t" = sqlite3 ] && v="$(sqlite3 -version | cut -d' ' -f1)"; echo "$t: $v"; else echo "$t: MISSING"; fi
done
have sqlite3 || echo "  → kelete-release and vps/backup.sh need sqlite3 (apt install sqlite3)"

section "Disk"
df -h "$APP_DIR" /var/backups 2>/dev/null | awk 'NR==1 || !seen[$0]++'

# ── settings: names and safe values only ─────────────────────────────────────
VERDICT_FN='
const SAFE = new Set(["NODE_ENV","PORT","DB_PATH","TENANTS_DIR","MASTER_DB_PATH","UPLOADS_DIR","GH_OWNER","GH_REPO","VPS_URL"]);
const JWT_BAD = new Set(["kelete-pro-secret-key-2026","dev-secret","your_jwt_secret_here","changeme","change-me","secret"]);
const ADMIN_BAD = new Set(["admin-change-me","admin","admin123","password","changeme"]);
function verdict(k, v) {
  v = String(v || "").trim().replace(/^["\x27]|["\x27]$/g, "");
  if (k === "JWT_SECRET") return !v ? "NOT SET — the new version will refuse to start" : JWT_BAD.has(v) ? "PUBLIC PLACEHOLDER — the new version will refuse to start; set a new value" : v.length < 32 ? `set, short (${v.length} chars) — accepted with a warning; rotate later` : `set (${v.length} chars) — ok`;
  if (k === "ADMIN_PASSWORD") return !v ? "not set — /admin licence panel login disabled" : ADMIN_BAD.has(v) ? "WEAK/DEFAULT — the new version disables the panel login until changed" : "set";
  if (SAFE.has(k) || k.startsWith("KELETE_")) return v === "" ? "(empty)" : v;
  return v ? "set" : "(empty)";
}
const show = (o) => console.log(Object.keys(o).sort().map(k => `  ${k} = ${verdict(k, o[k])}`).join("\n") || "  (none)");
'
if [ "$NO_ENV" = 1 ]; then
  section "Settings: skipped (--no-env)"
else
  section "Settings in backend/.env (secret values are never printed)"
  if [ -f "$APP_DIR/backend/.env" ]; then
    node -e "$VERDICT_FN"'
      const o = {};
      for (const l of require("fs").readFileSync(process.argv[1], "utf8").split(/\r?\n/)) {
        const m = l.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/); if (m) o[m[1]] = m[2];
      }
      show(o);' "$APP_DIR/backend/.env"
  else echo "  no backend/.env"; fi

  section "PM2 process (secret values are never printed)"
  echo "  (where PM2 and backend/.env both give a setting, the PM2 one is what the app uses: dotenv does not override)"
  if have pm2; then
    pm2 jlist 2>/dev/null | node -e "$VERDICT_FN"'
      let a; try { a = JSON.parse(require("fs").readFileSync(0, "utf8")); } catch (e) { console.log("  could not read pm2 jlist"); process.exit(0); }
      const want = process.argv[1];
      const SKIP = /^(PATH|HOME|USER|SHELL|PWD|LANG|LANGUAGE|TERM|LOGNAME|SHLVL|OLDPWD|MAIL|_|PM2_.*|NODE_APP_INSTANCE|SSH_.*|XDG_.*|LS_COLORS|HOSTNAME|MOTD_SHOWN|LC_.*)$/;
      for (const p of a) {
        if (want && p.name !== want) continue;
        const e = p.pm2_env || {};
        console.log(`process ${p.name}: ${e.status}, restarts ${e.restart_time}, cwd ${e.pm_cwd}, script ${e.pm_exec_path}, node ${e.node_version}, up since ${e.pm_uptime ? new Date(e.pm_uptime).toISOString() : "?"}`);
        const env = {};
        for (const [k, v] of Object.entries(e.env || {})) if (typeof v === "string" && /^[A-Z][A-Z0-9_]*$/.test(k) && !SKIP.test(k)) env[k] = v;
        console.log("  environment given by PM2:"); show(env);
      }' "$PM2_PROCESS"
  else echo "  pm2 not found"; fi
fi

section "Databases (listed, never opened)"
envval() { [ "$NO_ENV" = 1 ] && return 0; [ -f "$APP_DIR/backend/.env" ] || return 0; grep -E "^$1=" "$APP_DIR/backend/.env" | tail -n1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"; }
db_path="$(envval DB_PATH)"; db_path="${db_path:-$APP_DIR/backend/kelete.db}"
master_path="$(envval MASTER_DB_PATH)"; master_path="${master_path:-$APP_DIR/master.db}"
tenants_dir="$(envval TENANTS_DIR)"
if [ -z "$tenants_dir" ]; then tenants_dir="$APP_DIR/tenants"; elif [ "${tenants_dir:0:1}" != "/" ]; then tenants_dir="$APP_DIR/backend/$tenants_dir"; fi
list_db() { [ -f "$1" ] || return 0; local wal=0; [ -f "$1-wal" ] && wal=$(stat -c %s "$1-wal"); printf '  %-60s %10s bytes  modified %s  -wal %s bytes\n' "$1" "$(stat -c %s "$1")" "$(date -r "$1" '+%F %T')" "$wal"; }
list_db "$db_path"; list_db "$master_path"
[ -d "$tenants_dir" ] && for f in "$tenants_dir"/*.db; do list_db "$f"; done
echo "  other .db files under the checkout (not node_modules):"
find "$APP_DIR" -name '*.db' -not -path '*/node_modules/*' 2>/dev/null | grep -vxF -e "$db_path" -e "$master_path" | grep -v "^$tenants_dir/[^/]*\.db$" | sed 's/^/    /' | head -20

section "Backups already on the server"
for d in /var/backups/kelete /var/backups/kelete/pre-release; do [ -d "$d" ] && echo "  $d: $(ls -1 "$d" | wc -l) entries, newest $(ls -1t "$d" | head -1)"; done
crontab -l 2>/dev/null | grep -c backup.sh | sed 's/^/  user crontab lines for backup.sh: /'

section "Till update feed (what the tills will be offered)"
port="$(envval PORT)"; port="${port:-5300}"
if have curl; then
  # a plain GET to the running app, the same request every till makes at start-up
  resp="$(curl -s --max-time 10 -w '\n%{http_code}' "http://127.0.0.1:$port/api/updates/latest.yml")"
  code="$(printf '%s' "$resp" | tail -n1)"
  echo "  GET /api/updates/latest.yml → HTTP $code"
  [ "$code" = 200 ] && printf '%s\n' "$resp" | grep -E '^(version|releaseDate):' | sed 's/^/  /'
fi

printf '\nDone. Nothing was changed.\n'
