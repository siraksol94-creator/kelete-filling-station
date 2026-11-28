# Kelete Go-Live Pack

Prepared 2026-11-19 for review. **Nothing in this pack has been run on the
VPS, a till or any live data.** Every step that touches a live machine is for
you to run, at a time you choose, after the gates in section 1 are met.

| File | What it is | Where it runs |
|---|---|---|
| `README.md` | This plan | — |
| `release-manifest.json` | The exact ordered patch list and migrations | — |
| `check-release.js` | Checks a checkout holds every patch, once, in order, and that a proposed tag is safe | Test machine |
| `vps-preflight.sh` | Read-only facts about the live VPS (P0-3). Prints no secrets | VPS (read-only) |
| `../p0/inspect.js` | Read-only snapshot inspection, now with the go-live checks and an upgrade rehearsal | Test machine |
| `../backup/restore.js`, `verify.js` | Guarded restore and backup check (S6) | VPS / technician PC |
| `../../vps/kelete-release.sh` | Tagged release with automatic pre-release backup and automatic revert (S5) | VPS |

---

## 0. The sequence at a glance

```
P0 snapshots + pre-flight ──► Phase 2b checks ──► decisions G1–G5 ──► rehearsal on the test machine
        │                                                                     │
        └──────────── nothing on the live side changes until here ────────────┘
                                                                              ▼
            VPS release (log-only permissions) ──► tills one at a time ──► fleet merge review
                                                                              ▼
                     log week (daily WOULD DENY review) ──► enforce ──► later: sync tokens stage 3
```

## 1. Go / no-go gates

Deploy only when every line is ✓.

| # | Gate | How it's checked |
|---|---|---|
| 1 | P0 snapshots taken, checksummed, stored read-only off the VPS | Section 2 |
| 2 | Phase 2b report: every database `integrity: ok`, every upgrade rehearsal `ok` | Section 3 |
| 3 | Decisions G1–G5 made (section 4) | You |
| 4 | Release commit passes CI (both jobs) and `check-release.js` passes with the chosen tag | Section 5 |
| 5 | Rehearsal on the test machine done with copies of the snapshots | Section 6 |
| 6 | `JWT_SECRET` on the VPS is set and not a public placeholder (or a new one is ready to set in the window) | Pre-flight report |
| 7 | The till installer is built from the release commit with a version number above the live one (G2), and the current till install is saved before each upgrade | Sections 4, 8 |
| 8 | A quiet window is agreed, with a named person at each station | You |

---

## 2. P0 — snapshots and facts (read-only)

The aim is a pristine copy of every database and the facts about how the live
system runs, taken without changing anything.

**P0-1 · Agree the window and freeze changes.** No admin changes, price
changes or set-up edits on the VPS or tills while snapshots are taken. Trading
can continue: `.backup` copies are consistent while the app runs.

**P0-2 · Snapshot every VPS database** (SQLite's online backup, never `cp`):

```bash
STAMP=$(date +%Y%m%d-%H%M); OUT=~/kelete-p0/pristine/$STAMP; mkdir -p "$OUT/tenants"
APP_DIR=/var/www/<live-folder>             # from the pre-flight report
sqlite3 "file:$APP_DIR/master.db?mode=ro"          ".backup '$OUT/master.db'"
sqlite3 "file:$APP_DIR/backend/kelete.db?mode=ro"  ".backup '$OUT/kelete.db'"
for f in "$APP_DIR"/tenants/*.db; do sqlite3 "file:$f?mode=ro" ".backup '$OUT/tenants/$(basename "$f")'"; done
for f in "$OUT"/*.db "$OUT"/tenants/*.db; do echo "$(sqlite3 "$f" 'PRAGMA integrity_check;')  $f"; done
( cd "$OUT" && sha256sum *.db tenants/*.db > SHA256SUMS )
```

Use the paths the pre-flight report lists (if `DB_PATH`, `MASTER_DB_PATH` or
`TENANTS_DIR` are set, they win). Every integrity line must read `ok`.

**P0-3 · Record the facts** with the read-only pre-flight:

```bash
bash ops/go-live/vps-preflight.sh /var/www/<live-folder> <pm2-name> > ~/kelete-p0/preflight-$STAMP.txt
```

It records which commit is running, the remotes (credentials masked), whether
the old auto-deploy cron is active, tools (`sqlite3` is needed by the release
and backup scripts), disk space, the settings in `backend/.env` and in PM2,
the database files (listed, never opened), existing backups, and the version
the till update feed offers. For `JWT_SECRET`, `ADMIN_PASSWORD`, tokens and
any unknown key, it prints only a verdict such as `set (64 chars) — ok`. Add
`--no-env` if you'd rather it didn't read settings at all.

**P0-4 · Snapshot each till.** At each till, between shifts:

1. In Kelete, note the version (About / the installer name) and the
   machine's name.
2. Close Kelete completely, including from the tray.
3. Check `%APPDATA%\Kelete\`. If `kelete.db-wal` is there and is not 0 KB,
   start and close Kelete once more. If it's still there, don't copy anything.
   Ask for help instead.
4. Copy `%APPDATA%\Kelete\kelete.db` to the USB drive as
   `<station>-<machine>-kelete.db`.
5. **Also copy the whole install folder**, usually
   `%LOCALAPPDATA%\Programs\Kelete`, to the drive. This is the till's
   rollback copy (section 10).
6. Start Kelete again.

**P0-5 · Move everything to the test machine**, then check the checksums
there: `cd <stamp> && sha256sum -c SHA256SUMS`.

**P0-6 · Make the pristine folder read-only:**
`chmod -R a-w ~/kelete-p0/pristine`. Every later step works on copies.

**P0-7 · Compare the live code with the code we received.** The patches were
built on `kelete-filling-station-main.zip` (the baseline commit). From the
pre-flight's `HEAD`, export the live tree with
`git -C <APP_DIR> archive HEAD | gzip > live-code.tgz` (this writes only to
the file you name). On the test machine, unpack it and run:

```bash
diff -rq --exclude=node_modules --exclude=build --exclude='*.db' live-code/ <baseline-checkout>/
```

If the live code has changes that aren't in the baseline, deploying would
remove them. That's decision G3.

## 3. Phase 2b — checks on the snapshots (test machine, read-only)

```bash
cd kelete-erp && (cd backend && npm ci) && git checkout <release-commit>
node ops/p0/inspect.js --out ~/kelete-p0/reports/2b \
    ~/kelete-p0/pristine/<stamp>/master.db ~/kelete-p0/pristine/<stamp>/kelete.db \
    ~/kelete-p0/pristine/<stamp>/tenants/*.db ~/kelete-p0/pristine/tills/*.db
```

The tool copies each file before opening it, opens the copy read-only, and
proves the originals didn't change. Read `summary.md`.

| Line in summary.md | Go | Stop / decide |
|---|---|---|
| `integrity` | `ok` | Anything else: **stop**. Take a fresh snapshot; if it's still not ok, investigate before anything else |
| `Upgrade rehearsal on a scratch copy` | `ok — version N → 16` | `FAILED`: **stop**. Send me the migration number and error; that database would not upgrade |
| `Duplicate sync_ids` | absent | Present: **stop** and review. Sync would treat two records as one |
| `Fuel codes held as separate records in more than one database` | `0` | `> 0`: decision **G4** before the tills are upgraded |
| `Fleet merge review` | Any | `need a decision > 0` is fine. You resolve these in the merge screen after go-live (section 9) |
| `machines writing in the last 30 days` | — | The number of tills to upgrade and enrol. Check it matches your list |
| `rows made 00:00–02:00 Zambian time` | — | For information: these sales now land on the right day; history isn't moved |
| `Schema vs code` | Missing tables/columns on older databases are expected (migrations add them) | `different columns` or unexpected `extra tables`: review in `report.json` |
| `Tanks off-ledger`, `products with stock ≠ movements` | For information | Large numbers: worth a look, not a blocker |

**Phase 2c needs your approval.** It lists names: fleet balances, the
proposed merge for each fleet account, the clashing fuel codes and account
checks. Run the same command with `--include-2c --out ~/kelete-p0/reports/2c`.
Treat the CSV files as business data.

## 4. Decisions needed before go-live

These came up while preparing this pack. None is decided here, except G0, which is a fix to ship.

**G1 — Release tags vs the inherited workflows.** `vps/kelete-release.sh`
deploys only tags, but in kelete-erp a tag matching `v*` starts `deploy.yml`.
That workflow builds the Windows installer and publishes it to
`siraksol94-creator/kelete-filling-station`, and `mobile-v*` starts the APK
workflow. Recommendation: name releases `kelete-YYYYMMDD-N` (for example
`kelete-20261126-1`), which starts neither, and also disable `deploy.yml` in
GitHub (Actions → deploy.yml → ⋯ → Disable workflow). That is reversible and
removes nothing. `check-release.js --tag <name>` confirms a name is safe. Until
you decide, no tags are pushed.

**G2 — How the tills get this version, and its version number.** The tills
check `https://keletezm.com/api/updates` at start-up. The VPS answers from the
GitHub releases of `GH_OWNER/GH_REPO`, which default to
`siraksol94-creator/kelete-pos-tenant`. The pre-flight shows the live values
and the version currently offered. Two consequences:
- The installer for go-live must be built from the release commit with
  `npm run dist` (not `dist:publish`) and installed by hand on each till.
- Its version (`frontend/package.json`, now `1.0.0`) must be **higher** than
  the version the tills run and the one the feed offers. Otherwise the tills
  will offer staff the old build as an "update". Choose the number after P0
  (one-line change, reviewed like the others). Also choose where future till
  updates come from: a release repository you control, set through
  `GH_OWNER`/`GH_REPO`/`GH_TOKEN` on the VPS. Until then, staff should decline
  any update prompt.

**G3 — Live code vs the code we received.** Act on P0-7. If the live server
has changes the zip didn't have, decide for each one whether it's ported into
kelete-erp first or knowingly dropped.

**G4 — Fuel codes held separately in two places** (only if Phase 2b counts
any). Fuel sync won't merge or drop them. The till's copy is reported as
`duplicate` and kept pending, and its shifts and readings wait. For each code,
decide which record is the real one. Fixing that is a small data fix that
needs its own review. Until then, the VPS can still go live; the affected till
just doesn't send that fuel data.

**G0 — Anonymous Administrator sign-up (found 2026-11-19; urgent).** In the
code as received, `POST /api/auth/register` needs no login and accepts any
role. Anyone who can reach the server can create an Administrator and log in.
Patch 26 closes it. Until it's deployed:
- check the Administrators list in the app (or the Phase 2c report) for
  accounts nobody recognises;
- if VPS access arrives before the full release, this one fix can be
  deployed on its own, or blocked in nginx with
  `location = /api/auth/register { return 403; }` (no screen uses it).

**G5 — Secrets on the VPS** (only if the pre-flight flags them). If
`JWT_SECRET` is missing or a public placeholder, the new version **will not
start** (then `kelete-release` reverts by itself). Set a new value in the
window: `openssl rand -hex 32`. This logs web users out once. Tills are
unaffected, because they sync with their licence and device token, not this
secret. If `ADMIN_PASSWORD` is weak or a default, the `/admin` licence panel
login stays disabled until it's changed. Nothing else is affected.

## 5. The release: patches in order

All patches go out together, as one VPS release and one till installer. They
were applied in kelete-erp in this order, and `release-manifest.json` holds
the exact subjects. Migrations are additive (they add tables, columns,
indexes and triggers; they delete or rewrite no business data) and run
automatically at start-up, once, each in its own transaction.

| # | Covers | What changes | Migration |
|---|---|---|---|
| 1 | S1 stage 1, S2, S3, S4, S5 | No default secrets; tills accept requests only from themselves (or their LAN children); legacy scripts quarantined; manual tagged releases | — |
| 2 | D1, D2 | Versioned migrations; audit trail | 1 baseline, 2 audit_log |
| 3 | D5, A2 | Automated tests; testable app | — |
| 4 | P0 | Read-only inspection tool (ops only) | — |
| 5 | F4 | Fuel ledger and shift controls | 3 fuel_ledger_guards |
| 6 | S7 part 1 | Backups Administrator-only; reopen/meter edits for Managers, Supervisors, Administrators | — |
| 7 | Sync defect | Same-second edits and edits during a push no longer lost | — |
| 8 | F2 | Fuel credit lines carry sync links; Credit tickets need a customer | 4 credit_ticket_order_sync_link |
| 9 | S6 | Verified backups; guarded restore tool | — |
| 10 | Sync defect (master) | Same-timestamp change on a master table no longer dropped | — |
| 11 | S7 full matrix | Server applies the screens' permissions | — |
| 12 | S1 stages 2/3 | Per-till sync tokens | 5 sync_device_tokens |
| 13 | F1 | Fuel data syncs between tills and the VPS | 6 fuel_sync |
| 14 | Date defect (fuel) | Fuel dates in Zambian time | 7 shift_business_date |
| 15 | Access decision | Fuel set-up for Administrators; deliveries for Managers/Supervisors | — |
| 16 | Fuel defect | Delivery numbers never repeat | — |
| 17 | Fuel defect | Deleting a delivery reverses its average-cost effect | 8 delivery_cost_trail |
| 18 | Fuel defect | Shift close keeps "Other"; credit total column | 9 shift_credit_total_column |
| 19 | Date defect (shop) | Shop, accounting and customer dates in Zambian time | 10 business_date_orders_stock |
| 20 | CI | Screen parse/import check (no runtime effect) | — |
| 21 | Decision: "Other" tender | "Other" field reduces expected cash | — |
| 22 | F5 | Fuel revenue in the Dashboard and cash book; fuel stock at weighted-average cost | — |
| 23 | F3 | Fleet customers merge into Customers (Administrator review) | 11 fleet_customer_merge |
| 24 | Fuel sync defect | Till keeps fuel pending when the VPS doesn't take it (rollback safety) | — |
| 25 | Go-Live Pack | Documents and read-only tools (no runtime effect) | — |
| 26 | Security defect | `/api/auth/register` needs an Administrator's login: before, anyone could create an Administrator account | — |
| 27 | UX-1 | Forecourt workflows: progress, fast entry, phone layouts (no data changes) | — |
| 28 | UX-2 | Loaders, attendant avatars, sign-in page, WCAG AA colours | — |
| 29 | UX-3 | Station block on the Dashboard; masked password dialog; Fuel POS fleet fix | — |
| 30 | UX-4 | Weather and fuel advice (MET Norway; needs internet), tank days of cover, Shop & stock, HQ Overview by branch | 12 station_weather_location |
| 31 | UX-5 | Weather location from the device (it asks first); connected tanks joined by a pipe; live 3D sign-in | — |
| 32 | UX-5 fix | Weather location saves on a fresh install; asks for the business email when it's missing | — |
| 33 | UX-6 | Side menu: Find a screen (Ctrl K), recently used, follows the page, full icon menu, keyboard and phone polish | — |
| 34 | UX-6 fix | Build fix: eslint comments that stopped `npm start`; the screen check catches them | — |
| 35 | UX-7 | Forecourt kit for the fuel screens; Tanks: 3D cards, dip ring and ±0.5%/1% bands, ledger chart (read-only `/api/tanks/insights`) | — |
| 36 | UX-8 | Deliveries: timeline, three-way check, will-it-fit; Pumps: forecourt view, meters, who is on shift (read-only extras on two GETs) | — |
| 37 | UX-9 | Fuel Grades price board and margin; Credit / 1Card summary, calculator, credit-limit warning (frontend only) | — |
| 38 | UX-10 | Station day ring and dip streak (read-only `/api/station-day`); Shifts and Cash Report finished; in-app dialogs on all fuel screens | — |
| 39 | UX-11 | Account Receivables: debt by age, credit used, oldest-debt chips; ageing counts opening balances | — |
| 40 | UX-11b | Account Receivables rebuilt; Fuel Cash Report cards as a money flow (frontend only) | — |
| 41 | Fix | Account Receivables in the menu at head office; `{{count}}` in translated texts filled in | — |
| 42 | Fix | Reason and date boxes on HQ Deposits, GRN Archive and Payment Voucher work on the tills (no `window.prompt`) | — |
| 43 | UX-12 | Pay box on the shop till in the till's red; "Customer gave" quick cash; large change due; Empty Vouchers shortcut on the Dashboard | — |
| 44 | UX-12b | Point of Sale shortcut on the Dashboard (also at head office) | — |
| 45 | Profit | Profit Report Shop \| Fuel \| Station; fuel margin per litre by grade; credit-ticket fuel counted once; fuel cost frozen at shift close | 13 fuel_cost_at_close |
| 46 | HQ Profit | HQ Consolidated Profit Shop \| Fuel \| Station per branch and group; fuel margin per litre across branches; money in full | — |
| 47 | UX-13 | Cash Book: balances by account, money in/out by day, transfers once, plain names, working export | — |
| 48 | UX-14 | Sales Report: headline, how they paid, sales through the day, clearer rows, quiet Reverse; Reset-to-today error fixed | — |
| 49 | Perf | Sales Report loads only the dates on screen; invoice search runs on the server | — |
| 50 | Fix | MoMo and Bank drawer expenses counted once (Cash Report, voucher totals) | — |
| 51 | UX-15 | Cash Report: blind count, in-app confirm, kit header, readable colours | — |
| 52 | Fix | Cash receipt totals: each receipt once per method (fuel day receipt no longer counted again as Bank) | — |
| 53 | UX-16 | Sales Inventory, Stock Card, Bin Card, VAT Report in the same look; K not $ | — |
| 54 | Docs | Go-live checks expect schema version 13 (was 11) | — |
| 55 | UX-17 | One theme: slate greys, one mono font, K12.00 / −K12.00 on every screen, $ → K on GRN/SIV/Receivables prints, in-app boxes on Sales Report, Cash Receipt, POS and HQ screens | — |
| 56 | Fix | Sales Report: over-collected split by currency (USD · FRA · K) back on tri-currency branches; nothing changes on Kelete's K-only book | — |
| 57 | Docs | `HANDOVER.md`: overview for the person deploying and continuing the work | — |
| 58 | Theme | Brand colours from red to forecourt gold (frontend only). | — |
| 59 | Business type | business_settings.business_type; sidebar groups by type. | 14 |
| 60 | 1Card | A 1Card ticket names the fuel-card supplier and posts an ap_payments offset. | 15 |
| 61 | Repair | Tests, permission list and release list brought up to date after the owner's commits | — |
| 62 | Money | 1Card offsets out of the Cash Book; fuel deliveries in Account Payables and Suppliers; AP opens on new tills | 16 |
| 63 | Branch types | HQ never fuel; fuel station = Fuel + Sales + Store; shop = Sales + Store; dashboards and HQ Overview by type; fuel teal, shop violet | — |
| 64 | Categories | Every category says where it is sold; items need a category; fuel ticket products out of Item Details | 17 |

Before tagging, on the test machine:

```bash
git checkout main && git pull
node ops/go-live/check-release.js --tag kelete-YYYYMMDD-N      # must end "All checks passed."
```

The checker also reports the installer version and where installers are
published (G2). Confirm both CI jobs are green on that commit.

## 6. Rehearsal on the test machine

This runs the release on **copies** of the P0 snapshots, never the pristine
folder.

1. `cp -r ~/kelete-p0/pristine/<stamp> ~/kelete-rehearsal && chmod -R u+w ~/kelete-rehearsal`
2. In a release checkout, start the VPS server against the copies:
   ```bash
   cd backend && npm ci
   JWT_SECRET=$(openssl rand -hex 32) KELETE_PERMISSIONS=log PORT=5399 \
   MASTER_DB_PATH=~/kelete-rehearsal/master.db DB_PATH=~/kelete-rehearsal/kelete.db \
   TENANTS_DIR=~/kelete-rehearsal/tenants node server-tenant.js
   ```
   Every database should log `[migrate] … applied 1 … 16` (or only the
   missing ones), with no `FAILED`.
3. Build the frontend (`cd frontend && npm ci && npm run build`) and open it
   against port 5399, logged in as your own Administrator. Check, without
   saving anything you'd mind losing (it's a copy):
   - the Dashboard with fuel takings
   - a closed shift's Fuel Cash Report
   - Customers and Accounts Receivable
   - the Fleet Customers merge review
   - Fuel Deliveries
   - log in as a cashier: cashiers see no fuel set-up
4. Close a test shift on the copy. Check expected cash, the daily fuel receipt
   in the cash book, and the tank ledger.
5. Install the go-live till installer on a spare PC (not a station till),
   join it to the rehearsal server, and sync once.
6. Delete `~/kelete-rehearsal` when you're done.

## 7. Runtime configuration

### VPS (PM2 environment or `backend/.env`; PM2's value wins where both are set)

| Setting | Go-live value | Notes |
|---|---|---|
| `JWT_SECRET` | Long random value (≥ 32 chars) | **Required.** Missing or placeholder → the server refuses to start (G5) |
| `KELETE_PERMISSIONS` | **`log`** | First week (decided 2026-11-18). Refuses nothing at page level, logs `WOULD DENY`. Remove after the week (default `enforce`). `off` disables the gate (emergency only) |
| `KELETE_SYNC_AUTH` | leave unset (= `accept`) | Stage 2: tills get tokens, tills without one still sync. `require` = stage 3, later (section 9) |
| `KELETE_FUEL_SYNC` | leave unset (= `on`) | `off` leaves fuel out of sync on that machine |
| `KELETE_UTC_OFFSET_MINUTES` | **leave unset** (= 120) | Changes only the JS side; the SQL side is fixed at +120. Don't set it |
| `ADMIN_PASSWORD` | Strong value | Only for the `/admin` licence panel; weak/default → panel login disabled |
| `GH_OWNER`, `GH_REPO`, `GH_TOKEN` | Unchanged until G2 is decided | Source of till updates |
| `KELETE_BACKUP_KEEP_DAYS` | Optional (default 14) | Backup rotation |
| `KELETE_BIND_HOST`, `KELETE_ALLOW_REMOTE_UI` | Not used on the VPS | Till-only (S3) |
| `KELETE_TEST_NOW`, `KELETE_NO_AUTOSTART` | **Never set on live** | Test-only (the simulated clock works only when `NODE_ENV=test`) |

`/etc/kelete-release.conf` (root-owned, no secrets):

```bash
APP_DIR=/var/www/<live-folder>
PM2_PROCESS=<name from the pre-flight>
HEALTH_URL=http://127.0.0.1:<port>/api/health
GIT_REMOTE=kelete            # the kelete-erp remote added at cutover (section 8)
```

### Tills

Nothing to set. Each till makes its own token-signing secret on first start
(users log in again once), listens only on itself (or on the LAN if it's a
LAN Mother), and fetches its sync token on its first sync.

## 8. Deployment day

**Before the window (any day):** gates 1–7 met. The tag is created on the
release commit with the name chosen in G1 and pushed only once G1 is decided.
The installer is built. The cutover steps 1–4 in `vps/RELEASE.md` are read
through.

### VPS (about 30 minutes, at a quiet time with no shift being closed)

1. **Cutover (first release only)**, per `vps/RELEASE.md`:
   - save the crontab and remove the `kelete-deploy.sh` line
   - check the checkout is clean
   - write `/etc/kelete-release.conf`
   - install `kelete-release`
   - give the VPS read access to kelete-erp with a **read-only deploy key**, then
     `git -C <APP_DIR> remote add kelete git@github.com:paulmarwizi/kelete-erp.git`
2. **Settings:** add `KELETE_PERMISSIONS=log`; set `JWT_SECRET` if G5 says
   so. Restarting isn't needed yet; the release restarts.
3. **Release:** `kelete-release deploy <tag>`. It backs up and
   integrity-checks every database, switches to the tag, builds, restarts and
   waits for `/api/health`. If the app isn't healthy, it puts the previous
   version back by itself.
4. **Check** (about 10 minutes):
   - `pm2 logs <name> --lines 300 | grep -E "\[migrate\]|FAILED|refuse"`: each
     database applied its migrations, and there's no `FAILED`
   - as Administrator: `GET /api/system/schema-status` for each branch shows
     version 17
   - log in as Administrator, a supervisor and a cashier, and open each one's
     usual screens
   - `pm2 logs | grep "WOULD DENY"`: lines for legitimate work go on the list
     to fix before enforcing
   - a till still on the old version syncs normally. Expected log lines:
     `sync WITHOUT a device token` (stage 2)
   - `kelete-release status` shows the release and its backup folder
5. **Write down** the backup folder path from `kelete-release status`.

### Each till, one at a time

1. Pick a moment with no shift being closed on that till. Let it **sync once
   on the old version**, so nothing it holds is left unsent.
2. Close Kelete. Copy `%APPDATA%\Kelete` **and** the install folder to the
   USB drive (rollback copy), unless P0-4 was taken today.
3. Run the new installer. Start Kelete and log in (users log in again once).
4. Check:
   - Sync shows a successful cycle.
   - On the VPS, `GET /api/system/sync-devices` lists this till with a recent
     `last_seen_at`.
   - The station's fuel set-up and recent shifts appear on the VPS. If the
     till's sync log shows `duplicate`, that's G4.
   - The sales screen and the shift screen open normally.
5. Only then move to the next till. With **two tills at a station**, upgrade
   the LAN Mother first.

## 9. After go-live

- **Fleet merge (per branch, Administrator):** Fleet Customers → *Merge
  fleet accounts into Customers*.
  - Review the matches and resolve the "needs a decision" rows.
  - Apply.
  - Check Accounts Receivable shows one balance per customer.
  - Nothing merges until you apply. *Undo* reverses it, and is clean as long
    as no payments have been recorded against the merged accounts.
- **Fuel in the cash book (F5):** from go-live, each day with closed shifts
  gets one `FUEL-<date>` receipt (cash, mobile money and bank), updated when
  a shift is closed, finalised, reopened or deleted. **Past days are not
  backfilled.** The Dashboard's fuel figures do include history. A backfill of
  past receipts can be prepared separately if you want one.
- **The log week:** every day, run `pm2 logs <name> --lines 5000 | grep "WOULD DENY"`
  (per `vps/RELEASE.md`). Fix the permissions behind any legitimate lines.
  After a clean week, remove `KELETE_PERMISSIONS`, restart through
  `kelete-release`, and check that nobody's daily work is blocked.
- **Sync tokens stage 3 (later):** once every till has synced on the new
  version and `sync-devices` shows them all with no `WITHOUT a device token`
  lines, follow `vps/SYNC-DEVICES.md`.
- **Backups:** the next morning, run `node ops/backup/verify.js /var/backups/kelete/<date>`.
  Every file should pass.

## 10. Rollback plan

Choose the smallest step that fixes the problem. Steps 1–3 lose no data. Step
4 is the only one that does.

**When to roll back:**
- the release doesn't come up healthy (step 1 happens by itself)
- a migration reports `FAILED` on a branch
- shifts can't be closed, or sales can't be made
- sync stops working for a till
- a figure is wrong in a way that would mislead the business today

A `WOULD DENY` line is **not** a reason. In log mode it blocks nothing.

If `kelete-release deploy` **stops with an error part-way** (for example
`npm ci` or the frontend build fails), the code may already be switched while
the old process still runs. Run `kelete-release rollback` straight away. The
previous version was recorded before the switch.

**1. VPS code back to the previous version** (no data loss):
`kelete-release rollback`. It switches back to the commit that ran before,
restores the previous frontend build, restarts and checks health. Databases
are not touched and stay at version 11. This was tested for this pack: the
code as received was started on a database already at version 11 (with fuel
and shift data made by the new code), and logins, lists, creating customers
and fleet accounts, and closing a fuel shift all worked, with integrity `ok`.
The new code then started again on the same database without problems (the
roll-forward). While rolled back:
- page-level permissions, sync tokens and fuel sync are off
- new rows use the old (UTC) dates
- tills on the new version keep their fuel records pending (patch 24) and send
  them after the roll-forward
- old tills are unaffected

**2. A till back to the previous version** (no data loss): close Kelete,
replace the install folder with the rollback copy (or run the previous
installer), and start it. The data folder stays, and its database works with
the old code (same check as step 1). Users log in again. Fuel rows made since
the upgrade stay pending and go once the till is upgraded again. Decline any
update prompt until G2 is settled.

**3. Undo the fleet merge** (no data loss): Fleet Customers → merge panel →
*Undo* (one entry or all). It restores the fleet balances, unlinks the
tickets, and voids the customers the merge created if they haven't been used.
Do this before payments are recorded against merged accounts.

**4. Restore a database** (last resort; **loses everything entered on that
database since the backup**). Use this only if data is damaged.
1. Stop the app.
2. Pick the pre-release backup folder from `kelete-release status`.
3. Dry run, then confirm:
   ```bash
   node ops/backup/restore.js --from <backup>/tenants/<branch>.db --to <APP_DIR>/tenants/<branch>.db
   node ops/backup/restore.js --from … --to … --confirm
   ```
   The tool keeps an exact copy of the current database in `pre-restore/`
   first, and refuses if the database is in use or the backup doesn't verify.
4. Roll the code back as well (step 1) if the restored database is from
   before the release. The new code would simply migrate it again on start-up.
5. Tills re-send what they still hold as pending. Their sync tokens are
   re-issued automatically in stage 2.
6. Records the tills had **already sent** after the backup was taken are not
   re-sent by themselves. They are still on the tills, and getting them back
   onto the VPS needs a separate, reviewed step.
   **Do not press Force Resync on a till after a VPS restore.** It pulls the
   VPS's copy and overwrites the till's newer records with it.

**What can't be undone:** migrations aren't reversed (by design). The only
way back to the old schema is restoring a backup, and the old code doesn't
need it (step 1). Data entered after go-live is kept by steps 1–3.

### Mixed versions during the rollout

| Till ↓ / VPS → | Old VPS | New VPS |
|---|---|---|
| **Old till** | As today | Works. Stage 2 accepts tills without a token. The old till ignores fuel tables and columns it doesn't know (checked in the code; not covered by an automated test) |
| **New till** | Works. Fuel stays pending until the VPS takes fuel (automated test, patch 24). The token request fails quietly and is retried every 10 minutes | Full function |

## 11. What was verified for this pack

On the development machine, with throwaway databases and invented data:

- The full backend suite (see the commit message for counts), and the
  screen-parse CI check over all screen files.
- `check-release.js` against the release commit and against an older commit
  (it reports the missing patches and the missing migration, and refuses a
  `v*` tag).
- Upgrade rehearsal: a database built by the **original** code's schema
  upgraded from version 0 to 11 with integrity `ok` (test 09).
- Rollback and roll-forward on a version-11 database (section 10, step 1).
- Fuel sync against a VPS that doesn't take fuel (test 19, which fails on the
  previous code).
- The pre-flight on a fake VPS folder with planted secrets: none printed,
  nothing changed (test 20).

Not verified, because it needs the real systems:
- timings on the real database sizes (the Phase 2b rehearsal reports them)
- the Windows till upgrade and restore (sections 8 and 10.2)
- the live update feed's behaviour (G2)
