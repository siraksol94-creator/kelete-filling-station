#!/usr/bin/env bash
# Copy a branch's ZRA device identity to another branch, without calling ZRA.
# 2026-09-01
#
#   ./backend/scripts/clone_zra_identity.sh garden training
#
# WHY THIS EXISTS. A device serial registers with ZRA exactly once. Garden
# holds MP1CYBEV, so pointing a second branch at the same VSDC and pressing
# Initialize gets 902 "this device is installed" — the right answer, but the
# second branch still ends up with no SDC ID. routes/zra.js recovers from 902
# by fetching the identity from the proxy HOST, which needs a proxy URL to ask;
# a plain localhost:8080 URL has nobody to ask, which is why it just errors.
#
# This copies the identity across directly instead. Same result, no ZRA call.
#
# SANDBOX ONLY. Two branches sharing one fiscal identity is fine while nothing
# is filed for real. Do NOT do this in production — invoices from both branches
# would land under one device, and the invoice counters would fight.
set -euo pipefail

SRC="${1:-}"; DST="${2:-}"
if [ -z "$SRC" ] || [ -z "$DST" ]; then
  echo "usage: $0 <source-branch> <target-branch>   e.g. $0 garden training" >&2
  exit 1
fi

cd "$(dirname "$0")/../.."
for b in "$SRC" "$DST"; do
  [ -f "tenants/$b.db" ] || { echo "no such branch database: tenants/$b.db" >&2; exit 1; }
done

env_of() { sqlite3 "tenants/$1.db" "SELECT COALESCE(zra_env,'') FROM business_settings LIMIT 1;"; }
SRC_ENV="$(env_of "$SRC")"
if [ "$SRC_ENV" != "sandbox" ]; then
  echo "REFUSING: $SRC is on '$SRC_ENV', not sandbox." >&2
  echo "Sharing one device identity across two branches is only safe while nothing is filed." >&2
  exit 1
fi

echo
echo "--- $SRC (source) ---"
sqlite3 -header -column "tenants/$SRC.db" \
  "SELECT zra_env, zra_sdc_id, zra_mrc_no, zra_dvc_srl_no FROM business_settings;"

echo "--- $DST (before) ---"
sqlite3 -header -column "tenants/$DST.db" \
  "SELECT zra_enabled, zra_env, COALESCE(zra_sdc_id,'(none)') AS zra_sdc_id FROM business_settings;"

cp "tenants/$DST.db" "tenants/$DST.db.bak-$(date +%F-zraid)"

# The same columns routes/zra.js writes on a successful Initialize, so the
# target ends up in the state the button would have left it in.
COLS="zra_sdc_id zra_mrc_no zra_taxpr_nm zra_vat_ty_cd \
zra_last_invc_no zra_last_sale_invc_no zra_last_pchs_invc_no \
zra_last_sale_rcpt_no zra_last_train_invc_no zra_last_profrm_invc_no \
zra_last_copy_invc_no zra_vsdc_url zra_tpin zra_bhf_id zra_dvc_srl_no \
zra_proxy_secret zra_env"

SETS=""
for c in $COLS; do
  v="$(sqlite3 "tenants/$SRC.db" "SELECT COALESCE($c,'') FROM business_settings LIMIT 1;" 2>/dev/null || echo '')"
  [ -z "$v" ] && continue
  esc="$(printf '%s' "$v" | sed "s/'/''/g")"
  SETS="$SETS$c='$esc', "
done

sqlite3 "tenants/$DST.db" "
  UPDATE business_settings
     SET ${SETS}
         zra_enabled = 1,
         zra_initialized_at = datetime('now'),
         updated_at = datetime('now'),
         synced = 0;"

echo "--- $DST (after) ---"
sqlite3 -header -column "tenants/$DST.db" \
  "SELECT zra_enabled, zra_env, zra_sdc_id, zra_mrc_no, zra_dvc_srl_no,
          substr(zra_initialized_at,1,19) AS initialized_at
     FROM business_settings;"

echo
echo "$DST now shares $SRC's sandbox identity. Reload its ZRA page — the pill"
echo "should read SANDBOX and Device Identity should be filled in."
echo "Backup: tenants/$DST.db.bak-$(date +%F-zraid)"
