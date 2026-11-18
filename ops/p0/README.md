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
2c only, `phase2c-fleet-balances.csv` (customer names and amounts; handle as
business data).

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
