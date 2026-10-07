#!/bin/bash
# Kelete auto-deploy â€” pulled by cron every minute.
# No-op when origin/main hasn't advanced; full deploy when it has.
# Robust against cron's limited PATH (sources NVM if installed) and
# overlapping runs (flock lock).
set -u

export HOME=/root
# Source NVM so node/npm/pm2 land on PATH inside cron's stripped env
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
# Belt + braces: expand any NVM-installed node bin dirs into PATH too
NVM_BINS=$(ls -d $HOME/.nvm/versions/node/*/bin 2>/dev/null | tr '\n' ':')
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:${NVM_BINS}${PATH:-}"

DIR=/var/www/kelete-pos-tenant
LOG=/var/log/kelete-deploy.log
LOCK=/tmp/kelete-deploy.lock

# Prevent overlapping runs while a long install/build is in flight.
exec 9>"$LOCK"
flock -n 9 || exit 0

exec >> "$LOG" 2>&1

stamp() { date '+%Y-%m-%d %H:%M:%S'; }
fail()  { echo "[$(stamp)] ERROR: $*"; exit 1; }

cd "$DIR" 2>/dev/null || fail "cannot cd to $DIR"
command -v git >/dev/null || fail "git not on PATH (PATH=$PATH)"
command -v pm2 >/dev/null || fail "pm2 not on PATH (PATH=$PATH)"
command -v npm >/dev/null || fail "npm not on PATH (PATH=$PATH)"

git fetch origin main --quiet || fail "git fetch"
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
[ "$LOCAL" = "$REMOTE" ] && exit 0

echo "[$(stamp)] deploying ${LOCAL:0:7} -> ${REMOTE:0:7}"
git checkout -- frontend/package-lock.json 2>/dev/null || true
git pull --ff-only origin main || fail "git pull"
pm2 restart kelete-tenant --update-env || echo "[$(stamp)] WARN: pm2 restart returned non-zero"
cd frontend || fail "cd frontend"
npm install --no-audit --no-fund --silent || fail "npm install"
npm run build:web || fail "npm run build:web"
echo "[$(stamp)] deploy complete (${REMOTE:0:7})"
