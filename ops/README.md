# ops/ — quarantined maintenance scripts (do not run casually)

`legacy-backend-scripts/` holds the one-off scripts inherited from the previous
developer. Until S4 (security remediation) they lived in `backend/scripts/`,
`backend/create-user.js` and `backend/reset-sync.js`, which meant:

- they were **copied into every till installer** (the electron-builder filter
  shipped the whole `backend/` folder), and
- they sat next to the live code on the VPS, one `node …` away from running.

Several of them **delete or rewrite business data** across one or every
branch database — for example `factoryReset.js`, `wipe_branch.js`,
`clear-test-data.js`, `delete_test_suppliers.js`, the `*_ob_load.js` /
`*_repair.js` scripts and the `.sql` repair files. Many were written for
another business's data (Chipata, Livingstone, Buseko, Red Sea depots).
`create-user.js` creates or resets an Administrator `sirak` with password `123`.

## They no longer run from here — on purpose

They use paths relative to `backend/` (e.g. `require('../config/database')`),
so from this folder they fail to start. That is the quarantine: nothing can be
run by accident.

## If one is genuinely needed

1. Get explicit approval for that specific script and the specific database.
2. Take a fresh SQLite `.backup` of every database it can touch, and record
   where the backup is.
3. Run it against a **copy** in the test environment first; keep its output.
4. Only then, during an agreed quiet window, copy that one script back under
   `backend/scripts/`, run it (report/dry-run mode first where it has one),
   and remove it again afterwards.

`create-user.js` and `reset-sync.js` must never be run on a live system.
