# Kelete ERP — Handover

*For whoever deploys and continues this system. Written 20 November 2026,
at the end of the review-and-finish work on the code inherited from Sidan IT
(originally Red Sea Distribution).*

---

## 1. Where things stand

- **The code is finished for this release and is in `main` of
  `paulmarwizi/kelete-erp`.** It is 56 reviewed changes on top of the code
  as received, listed in `ops/go-live/release-manifest.json`.
- **Nothing has been deployed.** All the work was done and tested on copies
  with test data.
  - Nobody on this work touched the live VPS, the live tills or any business
    record.
  - The live server still runs the old code.
- **Tests at hand-over:**
  - Backend: 315 pass, 0 fail.
  - Screen tests: 90 pass.
  - Every screen parses and every import resolves.
  - 0 text below the contrast minimum on the 29 previewed screens.
  - No new lint warnings compared with the code as received.
  - `node ops/go-live/check-release.js` passes.
- **The database goes from its current version to version 13 at first
  start.** Every migration only *adds* (tables, columns, indexes). Nothing is
  dropped or rewritten, and migrations are not reversed.

### Documents to read, in this order

| File | What it is |
|---|---|
| `HANDOVER.md` (this file) | The overview: what was done, what wasn't, and what to decide |
| `ops/go-live/README.md` | **The deployment guide.** Gates, read-only checks, decisions G0–G5, rehearsal, deployment day, rollback |
| `vps/RELEASE.md` | How `kelete-release` deploys a tag on the VPS and reverts by itself if the health check fails |
| `vps/SYNC-DEVICES.md`, `vps/FUEL-SYNC.md` | Till ↔ VPS sync, device tokens, fuel sync |
| `ops/go-live/release-manifest.json` | The 56 changes in order, with the migrations each one brings |

---

## 2. What was done

The numbers in brackets are the change numbers in the release manifest.

### Security
- **The anonymous Administrator sign-up is closed (26) — urgent, see G0.**
  - In the code as received, anyone could create an Administrator account
    through `/api/auth/register`.
  - Until this release is live, check the Administrators list for accounts
    nobody recognises.
- **Security remediation S1–S5 (1).**
- **Per-till sync tokens (12).** Stage 2 is on by default; stage 3 is a
  switch, for later.
- **The server enforces the screens' permissions (11).**
  - `KELETE_PERMISSIONS=log` for the first week, then `enforce`.
  - The matrix is `backend/config/permissionMatrix.json`. Rebuild it with
    `node ops/permissions/build-matrix.js`.
- **Backups are Administrator-only (6).** Backups are verified, and there is
  a guarded restore tool (9).

### Data integrity
- **Versioned migrations and an audit trail (2).**
- **Dates follow Zambian time (UTC+2)** for fuel (14), and for shop,
  accounting and customers (19).
- **Sync no longer loses data:**
  - same-second changes (7);
  - master tables (10);
  - fuel data kept pending when the VPS refuses it (24).
- **Fuel ledger and shift controls (5).** Fuel credit lines carry sync links
  (8).
- **Fuel delivery fixes:** numbers never repeat (16), and deleting a delivery
  reverses its effect on the average cost (17).
- **Shift close keeps the "Other" payment (18, 21).**
- **Fleet customers merged into Customers (23)**, so there is one receivables
  ledger.

### Fuel ↔ VPS
- **Fuel data syncs between the tills and the VPS (13).**
- **Fuel revenue appears in the Dashboard and the Cash Book.** Fuel stock is
  valued at weighted-average cost (22).

### Reports and money (this last stretch)
- **Profit Report: Shop | Fuel | Station (45).**
  - Fuel margin per litre, by grade.
  - Credit-ticket fuel is counted once, under Fuel.
  - The fuel cost per litre is **frozen at shift close** (migration 13).
    Shifts closed before this release use today's average cost and are
    marked "estimated".
- **HQ Consolidated Profit (46):** the same split for every branch and for
  the group.
- **Cash Book (47):**
  - shows where the money is (Cash / MoMo / Bank);
  - money in and out by day;
  - transfers counted once;
  - the export works (it used to export empty money columns).
- **Sales Report (48, 49):**
  - a calmer headline, how customers paid, and sales through the day;
  - it loads only the dates on screen. One day went from 37 MB to 132 KB.
- **Cash Report: blind count (51).** The counted boxes start empty, and
  Expected and Difference only appear after the count is saved.
- **Money that was counted twice:**
  - MoMo and Bank drawer expenses (50);
  - the fuel day receipt, counted again as Bank in the receipt totals (52).
- **Sales Inventory, Stock Card, Bin Card and VAT Report** have the same look,
  and show K instead of $ (53).

### Look and feel (UX-1 … UX-17)
- **Forecourt screens:**
  - Station Dashboard cockpit, 3D tanks, and weather with fuel advice;
  - dip rings and variance bands;
  - deliveries timeline, pumps and nozzles, and the fuel grades price board;
  - Credit and 1Card tickets;
  - the station day ring and dip streak (27–40).
- **Account Receivables** shows debt by age and who to chase first (39–41).
- **Shop till:**
  - the Pay box in the till's red, with quick cash and a large "change due"
    (43);
  - a Point of Sale shortcut on the Dashboard (44).
- **One theme across the app (55):**
  - one neutral colour family (slate);
  - one font for figures and codes;
  - money always reads **K12,345.00 / −K12.00**;
  - GRN, SIV and Receivables prints show K, not $.
- **No browser pop-ups.** Every alert, confirm and prompt on the screens that
  were reworked is an in-app box (42, 55). The Electron tills block some
  browser pop-ups.

### Go-live tooling
- **The Go-Live Pack (25):**
  - a read-only pre-flight for the VPS (`ops/go-live/vps-preflight.sh`);
  - snapshot inspection;
  - the release checker;
  - the deployment and rollback plan.
- **CI checks (20, 3):** every screen file parses and every import resolves,
  plus an automated backend test suite.

### Migrations in this release

| # | Name | What it adds |
|---|---|---|
| 1 | baseline | Version tracking |
| 2 | audit_log | Audit trail |
| 3 | fuel_ledger_guards | Fuel ledger controls |
| 4 | credit_ticket_order_sync_link | Sync link from credit tickets to orders |
| 5 | sync_device_tokens | Per-till sync tokens |
| 6 | fuel_sync | Fuel sync bookkeeping |
| 7 | shift_business_date | Shift trading day |
| 8 | delivery_cost_trail | Delivery cost history |
| 9 | shift_credit_total_column | Credit total on shifts |
| 10 | business_date_orders_stock | Trading day on orders and stock |
| 11 | fleet_customer_merge | Fleet customers in Customers |
| 12 | station_weather_location | Weather location |
| 13 | fuel_cost_at_close | Fuel cost per litre frozen at shift close |

---

## 3. How to deploy (short version)

The full procedure is `ops/go-live/README.md`, sections 1–10. In outline:

1. **Run the read-only pre-flight on the VPS** (section 2, P0). It reports:
   - the live folder, the PM2 name and the port;
   - the live database versions;
   - whether the live code differs from the code we received;
   - the secrets status;
   - which version the till update feed offers.
2. **Make the decisions in section 4 of this file.**
3. **Rehearse on a test machine with a copy of the live databases**
   (README section 6). Every database must end at **version 13**, with no
   `FAILED` lines.
4. **Deploy the VPS at a quiet time, when no shift is being closed**
   (README section 8).
   - Release name: **`kelete-YYYYMMDD-N`** (for example `kelete-20261126-1`).
   - **Never use a tag that starts with `v` or `mobile-v`.** Those start the
     old workflows, which publish to the previous developer's GitHub. Check a
     name first with `node ops/go-live/check-release.js --tag <name>`.
5. **Tills, one at a time** (README section 8).
   - The tills do **not** update from the VPS deploy.
   - Build the installer from the release commit with
     `cd frontend && npm ci && npm run dist`. Use `dist`, **not**
     `dist:publish`.
   - Install it by hand on each till.
   - Staff log in again once.
6. **Test on a till after the deploy:**
   - POS: the Pay box quick cash and the change due.
   - Cash Report: a new report starts with empty counted boxes, and Expected
     appears only after you save.
   - Profit Report: close a test shift, then check Shop / Fuel / Station.
   - Sales Report: changing the dates and searching are fast.
   - Cash Book and Cash Receipts: MoMo and Bank are not counted twice.
7. **The first week:**
   - Watch the `WOULD DENY` permission log, then switch
     `KELETE_PERMISSIONS` to `enforce`.
   - Rollback is README section 10.

---

## 4. Decisions only the person with VPS access can make

| | Decision | Where |
|---|---|---|
| **G0** | Check for unknown Administrators. Block `/api/auth/register` in nginx now if the full release isn't going out today | README §4 |
| **G1** | Release name `kelete-YYYYMMDD-N`. Disable `deploy.yml` in GitHub Actions (reversible) | README §4 |
| **G2** | **The till installer version.** `frontend/package.json` says `1.0.0`. It must be **higher** than what the tills show now (About) and than what the update feed offers. Otherwise the tills offer the old build as an "update". Also decide where future till updates come from (`GH_OWNER`/`GH_REPO`/`GH_TOKEN`). Until then, staff decline update prompts | README §4 |
| **G3** | If the live server has changes the received code didn't, port each one or drop it knowingly | README §4, P0-7 |
| **G4** | Fuel codes that exist twice (only if the checks find any) | README §4 |
| **G5** | `JWT_SECRET` must be a long random value, or the new version won't start. Set a strong `ADMIN_PASSWORD` | README §4, §7 |

**Secrets** (`.env`, the admin password, server logins) are not in the
repository and must never be committed. They stay on the VPS and are handed
over in person or through a password manager.

---

## 5. What was not done (open work, in suggested order)

| Item | State | What's needed |
|---|---|---|
| **Deployment itself** | Not started | VPS access, then sections 3–4 above |
| **Till installer version (G2)** | Not set | Read the version a till runs now, set a higher number in `frontend/package.json`, build with `npm run dist` |
| **Phone as barcode scanner** | Built and tested, **on hold** at the owner's request. It is **not in `main`**. It's in `WIP-phone-scanner-not-for-main.patch` (handed over separately) | Apply on a branch, then test on a real Android phone and a till. Notes below |
| **Kelete branding** | Waiting for the logo file (PNG or SVG) | Logo on the sign-in screen, receipts and the menu |
| **Fuel stock losses** | Not built: needs an accounting decision | How evaporation and dip losses are booked (expense, or cost of sales) and who approves them |
| **Hiding the distribution screens** | Not done: needs the owner's OK | Cashier, Dispatch, Route Selling and possibly Empty Vouchers are inherited from the distribution business. Hide them from the menu; don't delete them |
| **Sign-in button in amber** | Proposed, not confirmed | Two-line change so the cover page matches the app's main buttons |
| **Index on `stock_movements.reference_sync_id`** | Not done (it would be a migration) | Only if stock screens get slow as data grows |
| **Sync stage 3** (`KELETE_SYNC_AUTH=require`) | Later | After every till has fetched its token |
| **Permissions `enforce`** | After the first week in `log` | Review the `WOULD DENY` log first |

### Known issues left as they are (all from before this work)
- **Cash Report "over-collected" rows.** They call a function that doesn't
  exist on that page (`toSqliteUTC`). It fails quietly, and it only matters on
  three-currency branches, not Kelete's K-only book.
- **Older screens keep their own fixed sizes and corner roundings.** The
  colours are unified; the sizes are not.
- **The Inter font comes from Google Fonts.** Offline tills show Segoe UI
  instead, which still looks fine.
- **The till installer build on GitHub Actions** (`deploy.yml`) runs with
  `CI=true`, and React's build then treats lint warnings as errors. The
  inherited code already has lint warnings, so that workflow may fail. It
  shouldn't be used anyway (G1). Build installers with `npm run dist` on a
  Windows machine.
- **USD and FRA screens** (Kassumbalesa tri-currency) were left as they are.

### The phone scanner, for whoever picks it up
- **How it works:**
  - The POS shows "Link phone", with a 6-digit code and a QR.
  - The phone opens `/scan` in Chrome on the branch's web address, signs in
    and uses the camera. It needs Chrome's built-in barcode reader; nothing
    is installed on the phone.
  - Scans go phone → VPS → till. The till collects them once a second, and
    the POS adds them with its own prices and stock rules. The result and the
    cart total go back to the phone.
- **Limits:**
  - It needs internet at the station.
  - Links live in the server's memory: no database change, and a restart
    means linking again.
  - It assumes **one VPS process per branch address**. With PM2 in cluster
    mode, links would need shared storage.
- **Code:**
  - backend: `routes/phoneScan.js`, `services/phoneScan.js`;
  - frontend: `pages/PhoneScanner.js`, `ux/PhoneLink.js`,
    `ux/phoneScanModel.js`;
  - tests: `backend/test/31-phone-scan.test.js` (9 pass) and
    `frontend/tests/ux/phoneScan.test.js`.
- **Not tested yet:** a real phone camera, and a real till over the internet.
- **The simple alternative that needs no code:** a USB or Bluetooth scanner.
  The POS already accepts any scanner that types the code plus Enter.

---

## 6. Rules this work followed (please keep them)

- **Protect business data.**
  - Never commit or copy `.db`, `-wal` or `-shm` files, `.env`,
    `firebase-service-account.json` or keys.
  - Migrations only add.
- **Remove nothing that's inherited.** Hide it if it isn't needed.
- **Money is always shown in full**, never rounded away or turned into a
  game: `K12,345.00`, `−K50.00`. Attendants are never ranked.
- **Readability:**
  - WCAG AA contrast;
  - respect the "reduce motion" setting;
  - in-app boxes, never browser pop-ups.
- **Every change is reviewed before it's applied.**
  - `git am --keep-cr <patch>`, then `git push origin main`.
  - **No tags** until G1 is decided.

## 7. Working on the code

```bash
# backend
cd backend && npm ci && npm test            # 315 pass expected
# frontend
cd frontend && npm ci
npm run check:screens                       # every screen parses, imports resolve
npm run test:ux                             # 90 pass expected
npm start                                   # dev server
# release checks
node ops/go-live/check-release.js           # patches, migrations, versions
node ops/permissions/build-matrix.js        # after adding a screen or an API call
```

- GitHub runs the tests on every push to any branch (`.github/workflows/test.yml`).
- Check the **Actions** tab is green after pushing.
- `deploy.yml` (on `v*` tags) and `release-apk.yml` (on `mobile-v*` tags)
  are the inherited workflows that G1 is about.
