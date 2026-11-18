// D5 — one sync participant ("vps" or "till") in its own child process, with
// its own temporary databases. Started by helpers/syncPair.js; never by the app.
//
// Env in: SYNC_ROLE, SYNC_TENANT, SYNC_BRANCH, SYNC_VPS_URL (till only).
// Prints one line to stdout:  READY {"port":..,"token":".."}
// Test-only endpoint (exists only in this child): POST /__test/sql {sql, params}
// runs a statement on this participant's own database and returns rows.
const { setupEnv } = require('./harness');
setupEnv();
if (process.env.SYNC_ROLE === 'till') process.env.VPS_URL = process.env.SYNC_VPS_URL;

const http = require('http');
const { app } = require('../../server.js');
const db = require('../../config/database');
const syncConfig = require('../../config/syncConfig');
const { createUser } = require('./fixtures');

app.post('/__test/sql', (req, res) => {
  try {
    const st = db.prepare(req.body.sql);
    const params = req.body.params || [];
    res.json(/^\s*(select|pragma|with)/i.test(req.body.sql) ? { rows: st.all(...params) } : { info: st.run(...params) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

(async () => {
  syncConfig.setRegistration(process.env.SYNC_TENANT, process.env.SYNC_BRANCH);
  const email = `${process.env.SYNC_ROLE}-owner`;
  await createUser(db, { email, role: 'Administrator', permissions: ['All'] });
  if (process.env.SYNC_ROLE === 'till') {
    require('../../services/syncService').start(db, syncConfig);
  }
  const server = http.createServer(app).listen(0, '127.0.0.1', async () => {
    const port = server.address().port;
    const r = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: require('./fixtures').PASSWORD }),
    });
    const { token } = await r.json();
    process.stdout.write(`READY ${JSON.stringify({ port, token })}\n`);
  });
})().catch((e) => { process.stderr.write(`syncNode failed: ${e.stack}\n`); process.exit(1); });
