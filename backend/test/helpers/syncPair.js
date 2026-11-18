// D5 — start a VPS process and a till process that syncs to it, both on
// loopback with throwaway databases, and drive sync cycles on demand.
const { spawn } = require('child_process');
const path = require('path');
const { request } = require('./app');

function launch(role, extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'syncNode.js')], {
      env: { ...process.env, SYNC_ROLE: role, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '', log = '';
    const timer = setTimeout(() => reject(new Error(`${role} did not start:\n${log}`)), 60000);
    child.stdout.on('data', (d) => {
      buf += d; log += d;
      const m = buf.match(/READY (\{.*\})\n/);
      if (m) {
        clearTimeout(timer);
        const { port, token } = JSON.parse(m[1]);
        const base = `http://127.0.0.1:${port}`;
        resolve({
          role, child, base, token,
          api: (method, p, opts = {}) => request(base, method, p, { token, ...opts }),
          sql: async (sql, params = [], dbName) => {
            const r = await request(base, 'POST', '/__test/sql', { body: { sql, params, db: dbName } });
            if (r.status !== 200) throw new Error(`${role} sql: ${r.text}`);
            return r.body.rows || r.body.info;
          },
          log: () => log,
        });
      }
    });
    child.stderr.on('data', (d) => { log += d; });
    child.on('exit', (code) => { if (code) reject(new Error(`${role} exited ${code}:\n${log}`)); });
  });
}

async function startPair({ tenant = 'T-SYNC-TEST' } = {}) {
  const vps = await launch('vps', { SYNC_TENANT: tenant, SYNC_BRANCH: 'B-VPS' });
  const till = await launch('till', { SYNC_TENANT: tenant, SYNC_BRANCH: 'B-TILL', SYNC_VPS_URL: vps.base });

  // Run one full till sync cycle (push then pull) and wait for it to finish.
  async function syncNow() {
    const before = (await till.api('GET', '/api/sync/current-status')).body?.lastSynced || null;
    const t = await till.api('POST', '/api/sync/run-now');
    if (!t.body?.triggered) await new Promise((r) => setTimeout(r, 300)); // a cycle was already running
    for (let i = 0; i < 200; i++) {
      const s = (await till.api('GET', '/api/sync/current-status')).body || {};
      if (s.state === 'error') throw new Error(`sync error: ${s.error}`);
      if (s.lastSynced && s.lastSynced !== before && s.state === 'synced') return s;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`sync did not complete:\n${till.log().slice(-3000)}`);
  }

  // SIGTERM lets each child remove its temporary folder (harness cleanup).
  const stop = () => Promise.all([till, vps].map((p) => new Promise((resolve) => {
    if (p.child.exitCode !== null) return resolve();
    p.child.once('exit', resolve);
    try { p.child.kill('SIGTERM'); } catch (_) { resolve(); }
  })));
  return { vps, till, syncNow, stop, tenant };
}

module.exports = { startPair };
