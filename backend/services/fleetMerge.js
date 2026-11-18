/**
 * fleetMerge.js — F3: merge fuel fleet accounts into ordinary Customers.
 * Business decision 2026-11-18: one accounts-receivable list — match fleet
 * customers to Customers by name / phone.
 *
 * Until now the fuel module kept its own customer list (fleet_customers) with
 * its own running balance (current_balance, built by the legacy fleet sales
 * and the shift-close credit batch), separate from Customers / Accounts
 * Receivable. Credit tickets already use Customers (F2).
 *
 * plan(db)  — read-only. For every fleet account not merged yet:
 *   • matched: one Customer has the same phone (digits only, last 9 — so
 *     "+260 97…" and "097…" agree) and/or the same name (case, spaces and
 *     punctuation ignored), and nothing points elsewhere;
 *   • ambiguous: the phone points to one Customer and the name to another, or
 *     several Customers fit — a person must choose (resolve: { fleetId:
 *     customerId | 'new' });
 *   • create: no Customer fits → a new Credit customer is created from it.
 * apply(db, { resolve, userId… }) — one transaction:
 *   • creates / links the Customer; the fleet account's outstanding balance
 *     (current_balance — money owed that is in no order) is ADDED to the
 *     Customer's opening_balance, so AR shows one figure;
 *   • credit tickets that named only the fleet account get the Customer too
 *     (no new orders: their amount is already in the carried balance);
 *   • the fleet account keeps its row, vehicles and history, marked merged;
 *   • every step is logged in fleet_merge_log.
 * undo(db, { logId? }) — reverses logged merges: takes the carried balance
 *   back off, unlinks fleet account and tickets, and voids a Customer the
 *   merge created if nothing else has used it since.
 */
const { randomUUID } = require('crypto');

const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const normPhone = (s) => { const d = String(s || '').replace(/\D+/g, ''); return d.length >= 9 ? d.slice(-9) : ''; };

function customersIndex(db) {
  const rows = db.prepare("SELECT id, sync_id, name, phone, type, opening_balance FROM customers WHERE deleted_at IS NULL").all();
  const byName = new Map(), byPhone = new Map();
  for (const c of rows) {
    const n = normName(c.name); if (n) (byName.get(n) || byName.set(n, []).get(n)).push(c);
    const p = normPhone(c.phone); if (p) (byPhone.get(p) || byPhone.set(p, []).get(p)).push(c);
  }
  return { byName, byPhone };
}

function plan(db) {
  const idx = customersIndex(db);
  const fleets = db.prepare('SELECT * FROM fleet_customers WHERE merged_at IS NULL ORDER BY name').all();
  const out = { matched: [], ambiguous: [], create: [], already_merged: db.prepare('SELECT COUNT(*) AS n FROM fleet_customers WHERE merged_at IS NOT NULL').get().n };
  for (const f of fleets) {
    const view = { fleet_id: f.id, name: f.name, phone: f.phone || '', balance: Number(f.current_balance) || 0,
                   credit_limit: Number(f.credit_limit) || 0,
                   tickets: db.prepare('SELECT COUNT(*) AS n FROM shift_credit_sales WHERE fleet_customer_id = ? AND customer_id IS NULL').get(f.id).n };
    const byP = idx.byPhone.get(normPhone(f.phone)) || [];
    const byN = idx.byName.get(normName(f.name)) || [];
    const ids = new Set([...byP, ...byN].map(c => c.id));
    if (ids.size === 0) { out.create.push(view); continue; }
    if (ids.size === 1) {
      const c = byP[0] || byN[0];
      out.matched.push({ ...view, customer: { id: c.id, name: c.name, phone: c.phone || '' }, by: byP.length && byN.length ? 'phone+name' : (byP.length ? 'phone' : 'name') });
      continue;
    }
    out.ambiguous.push({ ...view, candidates: [...new Map([...byP, ...byN].map(c => [c.id, { id: c.id, name: c.name, phone: c.phone || '', by: byP.includes(c) ? 'phone' : 'name' }])).values()] });
  }
  out.summary = {
    to_merge: out.matched.length + out.create.length, matched: out.matched.length, create: out.create.length,
    ambiguous: out.ambiguous.length, balance_to_carry: [...out.matched, ...out.create].reduce((s, x) => s + x.balance, 0),
  };
  return out;
}

// only: limit to these fleet ids (used for a single new account).
function apply(db, { resolve = {}, only = null, userId = null, userLabel = null, tenantId = null, branchId = null, deviceId = null } = {}) {
  const p = plan(db);
  const keep = (x) => !only || only.includes(x.fleet_id);
  p.matched = p.matched.filter(keep); p.create = p.create.filter(keep); p.ambiguous = p.ambiguous.filter(keep);
  const chosen = [];
  for (const m of p.matched) chosen.push({ fleetId: m.fleet_id, customerId: m.customer.id, by: m.by });
  for (const c of p.create) chosen.push({ fleetId: c.fleet_id, customerId: null, by: 'created' });
  const skipped = [];
  for (const a of p.ambiguous) {
    const r = resolve[a.fleet_id] ?? resolve[String(a.fleet_id)];
    if (r === 'new') chosen.push({ fleetId: a.fleet_id, customerId: null, by: 'created' });
    else if (r != null && a.candidates.some(c => c.id === Number(r))) chosen.push({ fleetId: a.fleet_id, customerId: Number(r), by: 'chosen' });
    else skipped.push({ fleet_id: a.fleet_id, name: a.name, reason: 'ambiguous — choose a customer (or "new")' });
  }

  const results = [];
  db.transaction(() => {
    for (const ch of chosen) {
      const f = db.prepare('SELECT * FROM fleet_customers WHERE id = ? AND merged_at IS NULL').get(ch.fleetId);
      if (!f) continue;
      let customer, created = 0;
      if (ch.customerId) {
        customer = db.prepare('SELECT * FROM customers WHERE id = ? AND deleted_at IS NULL').get(ch.customerId);
        if (!customer) throw new Error(`Customer #${ch.customerId} not found`);
      } else {
        const info = db.prepare(`INSERT INTO customers (name, type, phone, email, address, credit_limit, payment_terms_days, credit_status,
                                                        opening_balance, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
                                 VALUES (?, 'Credit', ?, ?, ?, ?, 30, 'Active', 0, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))`)
          .run(f.name, f.phone || '', f.email || '', f.address || '', Number(f.credit_limit) || 0, randomUUID(), tenantId, branchId, deviceId);
        customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(info.lastInsertRowid);
        created = 1;
      }
      const balance = Number(f.current_balance) || 0;
      if (balance) {
        db.prepare("UPDATE customers SET opening_balance = COALESCE(opening_balance, 0) + ?, updated_at = datetime('now'), synced = 0 WHERE id = ?")
          .run(balance, customer.id);
      }
      const tickets = db.prepare('SELECT id FROM shift_credit_sales WHERE fleet_customer_id = ? AND customer_id IS NULL').all(f.id).map(r => r.id);
      const setTicket = db.prepare('UPDATE shift_credit_sales SET customer_id = ?, customer_sync_id = ? WHERE id = ?');
      for (const id of tickets) setTicket.run(customer.id, customer.sync_id, id);
      db.prepare("UPDATE fleet_customers SET customer_id = ?, customer_sync_id = ?, merged_at = datetime('now') WHERE id = ?")
        .run(customer.id, customer.sync_id, f.id);
      db.prepare(`INSERT INTO fleet_merge_log (fleet_customer_id, fleet_sync_id, fleet_name, customer_id, customer_sync_id, customer_name,
                                              matched_by, created_customer, balance_carried, ticket_ids, merged_by)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(f.id, f.sync_id || null, f.name, customer.id, customer.sync_id, customer.name, ch.by, created, balance, JSON.stringify(tickets), userLabel || (userId != null ? String(userId) : null));
      results.push({ fleet_id: f.id, fleet_name: f.name, customer_id: customer.id, customer_name: customer.name, matched_by: ch.by, created_customer: !!created, balance_carried: balance, tickets: tickets.length });
    }
  })();
  return { merged: results, skipped };
}

function undo(db, { logId = null, userLabel = null } = {}) {
  const rows = db.prepare(`SELECT * FROM fleet_merge_log WHERE undone_at IS NULL ${logId ? 'AND id = ?' : ''} ORDER BY id DESC`).all(...(logId ? [logId] : []));
  const out = [];
  db.transaction(() => {
    for (const l of rows) {
      if (l.balance_carried) {
        db.prepare("UPDATE customers SET opening_balance = COALESCE(opening_balance, 0) - ?, updated_at = datetime('now'), synced = 0 WHERE id = ?")
          .run(l.balance_carried, l.customer_id);
      }
      const ids = JSON.parse(l.ticket_ids || '[]');
      const clear = db.prepare('UPDATE shift_credit_sales SET customer_id = NULL, customer_sync_id = NULL WHERE id = ? AND customer_id = ?');
      for (const id of ids) clear.run(id, l.customer_id);
      db.prepare('UPDATE fleet_customers SET customer_id = NULL, customer_sync_id = NULL, merged_at = NULL WHERE id = ?').run(l.fleet_customer_id);
      let voided = false;
      if (l.created_customer) {
        const c = db.prepare('SELECT sync_id FROM customers WHERE id = ?').get(l.customer_id);
        const used = c && (db.prepare('SELECT 1 FROM orders WHERE customer_sync_id = ? AND deleted_at IS NULL LIMIT 1').get(c.sync_id)
                        || db.prepare('SELECT 1 FROM customer_payments WHERE customer_sync_id = ? LIMIT 1').get(c.sync_id)
                        || db.prepare('SELECT 1 FROM shift_credit_sales WHERE customer_id = ? LIMIT 1').get(l.customer_id));
        if (!used) {
          db.prepare("UPDATE customers SET deleted_at = datetime('now'), updated_at = datetime('now'), synced = 0 WHERE id = ?").run(l.customer_id);
          voided = true;
        }
      }
      db.prepare("UPDATE fleet_merge_log SET undone_at = datetime('now'), undone_by = ? WHERE id = ?").run(userLabel, l.id);
      out.push({ log_id: l.id, fleet_name: l.fleet_name, customer_name: l.customer_name, balance_removed: l.balance_carried, customer_voided: voided });
    }
  })();
  return { undone: out };
}

// New fleet accounts are Customers from the start (after the merge): link to
// the single matching Customer, or create one. Returns the customer row.
function linkNewFleet(db, fleetId, ctx = {}) {
  const f = db.prepare('SELECT * FROM fleet_customers WHERE id = ?').get(fleetId);
  if (!f || f.merged_at) return null;
  const idx = customersIndex(db);
  const cand = new Map([...(idx.byPhone.get(normPhone(f.phone)) || []), ...(idx.byName.get(normName(f.name)) || [])].map(c => [c.id, c]));
  if (cand.size > 1) return null; // ambiguous: left for the merge review
  const r = apply(db, { ...ctx, resolve: {}, only: [fleetId] });
  return r.merged.find(m => m.fleet_id === fleetId) || null;
}

module.exports = { plan, apply, undo, linkNewFleet, normName, normPhone };
