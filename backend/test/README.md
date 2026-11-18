# Backend tests (D5)

```bash
cd backend
npm ci
npm test
```

Uses Node's built-in test runner. No extra packages.

## Safety

Every test file runs in its own process with its own temporary folder for
**all** databases, uploads and backups, deleted afterwards
(`helpers/harness.js`). The app is loaded with `KELETE_NO_AUTOSTART=1`, so it
never listens on a fixed port or starts sync, ZRA retries or backups. A
**network guard** makes any connection to anything other than this machine
throw. The tests cannot reach `keletezm.com`, the licence server, ZRA,
Firebase or any live database.

## Suites

| File | Suite | Covers |
|---|---|---|
| `01-security` | 1 | S1–S3: nginx block rule, login lockout, inactive users, admin-only user edits, last-admin guard, admin-password check, forged tokens, secrets |
| `02-till-network` | 1 | S3 in till mode: per-till secret, remote callers refused except sync |
| `03-migrations` | 2 | D1: versioned migrations, one-time tasks, upgrade from the original schema, `cash_reports` rebuild, live schema fixtures |
| `04-audit` | 3 | D2: triggers (what changed) and request log (who), redaction, append-only, admin endpoints |
| `05-fuel-shift` | 4 | Shift lifecycle: open, credit/1Card tickets, close, dips, approval, reopen, delete |
| `06-fuel-deliveries-tanks` | 5 | Deliveries, weighted cost, tank edits, legacy fuel-sales endpoint, nozzle meters |
| `07-sync` | 6 | Real till ↔ VPS processes: push, pull, deletes, numbering, conflicts |
| `08-fuel-accounting` | 7 | One trading day: what the financial screens show vs what the forecourt took |

## Known defects

Tests named `[KNOWN DEFECT → <item>]` assert what the system does **today**,
even though it is wrong, and name the remediation item that will fix it
(`helpers/knownDefect.js`). When that fix lands, the test fails on purpose
and is rewritten to assert the corrected behaviour. No behaviour change in
Priority 2 can then happen silently.

## Live schema fixtures

Schema-only `.sql` files from the VPS and tills (Phase 2a instructions) go in
`fixtures/live-schemas/`. Each one becomes a test that the database it
describes upgrades cleanly. `fixtures/legacy-baseline-schema.sql` is the
schema the original code builds, used for upgrade tests.
