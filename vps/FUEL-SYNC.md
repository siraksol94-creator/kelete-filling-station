# Fuel sync (F1)

Fuel records now travel between tills and the VPS like the rest of the data.
That covers grades, tanks, pumps, nozzles, fleet, shifts, readings, dips, credit
and 1Card tickets, deliveries, the tank ledger, approvals and deletions. See
`backend/config/fuelSync.js` for how it works.

## What happens on upgrade

Migration 6 is additive. It adds sync columns to every fuel table, gives each
existing fuel row its sync ID and its links' sync IDs, and queues the row to be
sent once. No row is deleted or rewritten.

The first sync after upgrading therefore sends **all existing fuel history**
from each till to the VPS.

## Check before go-live (Phase 2b, read-only)

Run these on the VPS branch database and on each till snapshot:

1. **Where the fuel data is.** Count the rows in `fuel_grades`, `tanks`,
   `pumps`, `nozzles` and `attendant_shifts`.
   - If the station's fuel setup exists in only one place, sync simply
     copies it across.
2. **The same code on both sides.** Check whether any code (for example
   grade `ULP` or tank `T1`) exists on both the VPS and a till as separate
   records.
   - The sync will **not** merge these, and will not drop either. The till's
     copy is reported as `duplicate`, stays pending, and its dependent records
     wait.
   - Someone must decide which copy is the real one before go-live. Doing
     that safely needs a small, reviewed data fix.
3. **Two tills at one station.** If two tills each have their own fuel setup,
   the same applies between them.

## Behaviour to know

- **Links.** Every link (tank → grade, nozzle → tank, reading → shift and
  so on) is re-pointed to the receiving side's own row. A row whose parent
  hasn't arrived yet is held back and retried. It is never stored with a
  broken link.
- **Tank ledger.** Ledger rows are never rewritten on either side (F4). Each
  tank's volume is recalculated from its own ledger after every sync.
- **Simultaneous edits.** When two sides edit the same record, the later edit
  wins for the whole record, as for all other data.
- **Switching it off.** Setting `KELETE_FUEL_SYNC=off` on a machine leaves
  fuel out of that machine's sync. Restart after changing it.
