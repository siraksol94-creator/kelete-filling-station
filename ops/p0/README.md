# ops/p0: read-only inspection of database snapshots

`inspect.js` produces the Phase 2b report and, only when you pass
`--include-2c` (approval needed), the Phase 2c report, from **snapshots**
taken with the P0 procedure (`sqlite3 … ".backup …"`).

```bash
cd backend && npm ci && cd ..
node ops/p0/inspect.js --out ~/kelete-p0/reports/2b  ~/kelete-p0/pristine/<stamp>/master.db \
     ~/kelete-p0/pristine/<stamp>/backend/kelete.db ~/kelete-p0/pristine/<stamp>/tenants/*.db \
     ~/kelete-p0/pristine/tills/*/kelete.db
# Phase 2c, after approval:
node ops/p0/inspect.js --include-2c --out ~/kelete-p0/reports/2c  <same files>
```

Outputs: `summary.md` (read this first), `report.json` (full detail), and, for
2c only, `phase2c-fleet-balances.csv` and `phase2c-fleet-merge-review.csv`
(customer names and amounts; handle as business data).

## Go-live checks (in the 2b report)

- **Upgrade rehearsal.** Each branch/till database is copied a second time and
  upgraded with this code's start-up migrations. The report shows the version
  before and after, any migration that failed, the time taken, and the
  integrity of the result. A failure here means **do not deploy**. The copy is
  deleted straight afterwards. Use `--no-rehearsal` to skip it.
- **Fleet merge review.** Counts from the rehearsed copy: how many fleet
  accounts would merge, be created as Customers, or need a decision, plus the
  balance that would move into Accounts Receivable. Names appear only in the
  2c file.
- **Fuel codes held separately in two places.** The same grade, tank, pump or
  nozzle code held as separate records in more than one database. Fuel sync
  (F1) holds these back as `duplicate`, so each one needs a decision before go-live.
  The codes themselves are listed with `--include-2c`.
- **Machines writing data** in the last 30 days: the number of tills to enrol
  for sync tokens (S1).
- **Rows made between 00:00 and 02:00 Zambian time** in the last 30 days: the
  sales the old code filed under the previous day. New ones will land on the
  right day.

## Guarantees

- Never opens the files you give it. Each is copied to a private temporary
  folder, the copy is opened with `query_only = ON`, and the copy is deleted.
- Hashes each original before and after, and aborts if anything changed.
- Refuses a file with a non-empty `-wal` beside it (a live database or an
  unsafe copy).
- No network access. Builds the schema the code expects on throwaway files
  to compare against.
- Never outputs password hashes, secrets, URLs or tokens. The default-password
  check reports only yes/no.

Run it on the **test machine**, never on the VPS or a till.
