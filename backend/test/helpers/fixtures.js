// D5 — test data. Invented, never real business data.

const bcrypt = require('bcrypt');
const { randomUUID } = require('crypto');

const PASSWORD = 'Test-Pass-123';

// Insert a user directly (fast, independent of the Users API under test).
async function createUser(db, { email, role = 'Cashier', status = 'Active', permissions = [], first = 'Test', last = null, password = PASSWORD }) {
  const tenantId = db.prepare("SELECT value FROM sync_config WHERE key = 'tenant_id'").get()?.value || null;
  const hash = await bcrypt.hash(password, 10);
  const info = db.prepare(`
    INSERT INTO users (first_name, last_name, email, password, role, status, permissions, sync_id, tenant_id, synced)
    VALUES (?,?,?,?,?,?,?,?,?,0)
  `).run(first, last || role, email, hash, role, status, JSON.stringify(permissions), randomUUID(), tenantId);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
}

async function login(app, email, password = PASSWORD) {
  const r = await app.request('POST', '/api/auth/login', { body: { email, password } });
  if (r.status !== 200) throw new Error(`login ${email} failed: ${r.status} ${r.text}`);
  return r.body.token;
}

// The standard cast: owner (Administrator), supervisor, cashier, attendants.
async function seedStaff(app) {
  const db = app.db;
  const users = {
    owner:      await createUser(db, { email: 'owner',      role: 'Administrator', permissions: ['All'] }),
    supervisor: await createUser(db, { email: 'supervisor', role: 'Manager' }),
    cashier:    await createUser(db, { email: 'cashier',    role: 'Cashier' }),
    att1:       await createUser(db, { email: 'att1',       role: 'Cashier', first: 'Attendant', last: 'One' }),
    att2:       await createUser(db, { email: 'att2',       role: 'Cashier', first: 'Attendant', last: 'Two' }),
  };
  const tokens = {};
  for (const k of Object.keys(users)) tokens[k] = await login(app, users[k].email);
  return { users, tokens };
}

// Fuel setup through the real API: 2 grades, 2 tanks, 1 pump with 2 nozzles.
async function seedFuel(app, adminToken, { petrolPrice = 25, dieselPrice = 24, opening = 10000 } = {}) {
  const ok = (r, what) => { if (r.status >= 300) throw new Error(`${what}: ${r.status} ${r.text}`); return r.body; };
  const petrol = ok(await app.request('POST', '/api/fuel-grades', { token: adminToken, body: { code: 'ULP', name: 'Petrol', selling_price: petrolPrice, cost_price: 20 } }), 'grade ULP');
  const diesel = ok(await app.request('POST', '/api/fuel-grades', { token: adminToken, body: { code: 'DSL', name: 'Diesel', selling_price: dieselPrice, cost_price: 19 } }), 'grade DSL');
  const t1 = ok(await app.request('POST', '/api/tanks', { token: adminToken, body: { code: 'T1', name: 'Tank 1', fuel_grade_id: petrol.id, capacity_litres: 30000, current_volume: opening } }), 'tank T1');
  const t2 = ok(await app.request('POST', '/api/tanks', { token: adminToken, body: { code: 'T2', name: 'Tank 2', fuel_grade_id: diesel.id, capacity_litres: 30000, current_volume: opening } }), 'tank T2');
  const pump = ok(await app.request('POST', '/api/pumps', { token: adminToken, body: { code: 'P1', name: 'Pump 1' } }), 'pump');
  const n1 = ok(await app.request('POST', '/api/pumps/nozzles', { token: adminToken, body: { pump_id: pump.id, tank_id: t1.id, code: 'P1-ULP', current_meter_reading: 100000 } }), 'nozzle 1');
  const n2 = ok(await app.request('POST', '/api/pumps/nozzles', { token: adminToken, body: { pump_id: pump.id, tank_id: t2.id, code: 'P1-DSL', current_meter_reading: 50000 } }), 'nozzle 2');
  return { petrol, diesel, t1, t2, pump, n1, n2 };
}

async function createCustomer(app, token, name = 'Fleet Transport Ltd') {
  const r = await app.request('POST', '/api/customers', { token, body: { name, type: 'Credit', phone: '', email: '', address: '', tpin: '', credit_limit: 100000, payment_terms_days: 30, credit_status: 'Active' } });
  if (r.status >= 300) throw new Error(`customer: ${r.status} ${r.text}`);
  return r.body;
}

module.exports = { PASSWORD, createUser, login, seedStaff, seedFuel, createCustomer };
