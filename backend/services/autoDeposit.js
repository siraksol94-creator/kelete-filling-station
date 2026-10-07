// autoDeposit â€” a saved Cash Report sends its counted money to HQ as deposits.
//
// 2026-09-11. Switched on per depot (System Settings â†’ Auto deposit, off by
// default) for the Lusaka depots, which run one cashier a day. When on:
//
//   Save report   â†’ one PENDING deposit per method with money counted
//                   (Cash / Mobile Money / Bank), dated the report's date.
//                   HQ confirms them in HQ Deposits exactly as before.
//   Edit report   â†’ those PENDING deposits follow the new amounts: a method
//                   that gains money gets a deposit, one that drops to 0
//                   loses it.
//   Delete report â†’ its PENDING deposits are soft-deleted, reason
//                   "Cash report deleted", so the record stays.
//   HQ confirmed  â†’ editing or deleting that report is refused.
//   HQ rejected   â†’ that deposit is left exactly as it is.
//
// The deposit is the money COUNTED â€” the CR is counted + PVs. Once HQ
// confirms, the depot's Cash Book nets that day to zero.
//
// Deposits live in master.db and are linked back by cash_report_sync_id, so
// an edit or delete finds exactly its own. Turning the switch off stops new
// deposits only; ones already made keep following their report.
//
// Online only. A desktop till keeps its own copy of master.db with nothing
// carrying it to HQ, so a deposit written there would never be seen. The
// HQ Deposits page has the same reach; this does not widen it.

const { randomUUID } = require('crypto');

// Looked up when used, not captured at load: config/masterDb sits in a
// require cycle, and a value destructured mid-cycle would stay undefined.
const mdb = () => require('../config/masterDb').masterDb;

// Kelete is K-only; on these branches the three counted slots are methods
// (the mapping used by the Cash Report cards, PVs and CRs).
const METHODS = [
  { method: 'Cash',         col: 'usd_received' },
  { method: 'Mobile Money', col: 'fra_received' },
  { method: 'Bank',         col: 'k_received'   },
];

const CONFIRMED_MSG = 'HQ has already confirmed the deposit from this cash report â€” ask HQ before changing it.';

const round2 = (n) => Math.round((parseFloat(n) || 0) * 100) / 100;
const nameOf = (u) => [u?.first_name, u?.last_name].filter(Boolean).join(' ') || u?.firstName || u?.email || null;

function available(slug) {
  try {
    return !!mdb() && !process.env.ELECTRON_USER_DATA && !!slug
      && require('../config/masterDb').isRegistered(slug);
  } catch (_) { return false; }
}

function linkedDeposits(reportSyncId) {
  const m = mdb();
  if (!m || !reportSyncId) return [];
  return m.prepare(
    'SELECT * FROM cash_deposits WHERE cash_report_sync_id = ? AND deleted_at IS NULL'
  ).all(reportSyncId);
}

// The message to refuse an edit/delete with, or null when it may go ahead.
function blockIfConfirmed(reportSyncId) {
  try {
    const d = linkedDeposits(reportSyncId).find(x => x.status === 'CONFIRMED');
    if (!d) return null;
    // 2026-09-15 â€” a deposit sent to another depot names that depot.
    return d.to_slug
      ? `${d.to_name || d.to_slug} has already confirmed the deposit from this cash report â€” ask them before changing it.`
      : CONFIRMED_MSG;
  } catch (_) { return null; }
}

// DEP-YYYYMMDD-NNNN, as cashDeposits.js mints them, stepping past any number
// already taken (the old hard DELETE left gaps that a plain COUNT can land on).
function nextDepositNumber(m) {
  const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  let seq = (m.prepare('SELECT COUNT(*) AS n FROM cash_deposits').get()?.n || 0) + 1;
  const taken = m.prepare('SELECT 1 FROM cash_deposits WHERE deposit_number = ?');
  let num;
  do { num = `DEP-${ymd}-${String(seq).padStart(4, '0')}`; seq += 1; } while (taken.get(num));
  return num;
}

// Bring the report's deposits in line with its counted amounts.
// Returns { created, updated, removed }, or null when there is nothing to do.
function syncFromReport({ report, slug, branchName, cashierName, user, enabled }) {
  if (!available(slug) || !report?.sync_id) return null;
  const m = mdb();
  const linked = linkedDeposits(report.sync_id);
  if (!enabled && linked.length === 0) return null;

  const date = String(report.date || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
  const who = nameOf(user);
  // 2026-09-15 â€” new deposits go where System Settings â†’ Deposit to says (HQ
  // by default). Deposits already made keep the destination they were sent to.
  const target = require('./depositTarget').depositTargetFor(slug);
  // items: what moved, per method, so the Cash Report can say it in words.
  const out = { created: 0, updated: 0, removed: 0, items: [], to: target ? target.name : 'HQ' };

  m.transaction(() => {
    for (const meth of METHODS) {
      const amt = round2(report[meth.col]);
      const dep = linked.find(d => d.from_method === meth.method);
      // Only PENDING deposits move. CONFIRMED was refused before the report
      // was saved; REJECTED is HQ's decision and stays as it is.
      if (dep && dep.status !== 'PENDING') continue;
      if (amt > 0) {
        if (dep) {
          if (round2(dep.amount) !== amt || dep.deposit_date !== date) {
            m.prepare('UPDATE cash_deposits SET amount = ?, deposit_date = ? WHERE id = ?')
              .run(amt, date, dep.id);
            out.updated += 1;
            out.items.push({ method: meth.method, amount: amt, action: 'updated' });
          }
        } else if (enabled) {
          m.prepare(`
            INSERT INTO cash_deposits (deposit_number, sync_id, from_slug, from_name,
                                       currency, amount, amount_usd, sell_rate, notes,
                                       deposit_date, attachment, from_method, to_slug, to_name,
                                       status, created_by, created_by_name, cash_report_sync_id)
            VALUES (?,?,?,?, 'K', ?, 0, NULL, ?, ?, NULL, ?, ?, ?, 'PENDING', ?, ?, ?)
          `).run(
            nextDepositNumber(m), randomUUID(), slug, branchName || slug,
            amt, `Auto from Cash Report ${date}${cashierName ? ` Â· ${cashierName}` : ''}`,
            date, meth.method,
            target ? target.slug : null, target ? target.name : null,
            user?.id ?? null, who, report.sync_id
          );
          out.created += 1;
          out.items.push({ method: meth.method, amount: amt, action: 'sent' });
        }
      } else if (dep) {
        m.prepare(`
          UPDATE cash_deposits
             SET deleted_at = datetime('now'), deleted_by = ?, deleted_by_name = ?, delete_reason = ?
           WHERE id = ?
        `).run(user?.id ?? null, who, `Cash report changed â€” nothing counted in ${meth.method}`, dep.id);
        out.removed += 1;
        out.items.push({ method: meth.method, amount: 0, action: 'removed' });
      }
    }
  })();

  return (out.created || out.updated || out.removed) ? out : null;
}

// The report was deleted: take its PENDING deposits with it.
function removeForReport({ reportSyncId, user }) {
  const m = mdb();
  if (!m || !reportSyncId) return 0;
  return m.prepare(`
    UPDATE cash_deposits
       SET deleted_at = datetime('now'), deleted_by = ?, deleted_by_name = ?, delete_reason = 'Cash report deleted'
     WHERE cash_report_sync_id = ? AND deleted_at IS NULL AND status = 'PENDING'
  `).run(user?.id ?? null, nameOf(user), reportSyncId).changes;
}

module.exports = { syncFromReport, removeForReport, blockIfConfirmed, CONFIRMED_MSG };
