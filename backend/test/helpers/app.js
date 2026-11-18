// D5 — start the real Express app (server.js or server-tenant.js) on an
// ephemeral loopback port and give tests a small HTTP client for it.
// Requires helpers/harness.js to have run setupEnv() first.

const http = require('http');

async function startApp({ which = 'server', host = '127.0.0.1' } = {}) {
  const mod = require(which === 'tenant' ? '../../server-tenant.js' : '../../server.js');
  const server = http.createServer(mod.app);
  await new Promise((resolve) => server.listen(0, host, resolve));
  const { port } = server.address();
  const base = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
  const db = require('../../config/database');
  return {
    base, port, db, server, module: mod,
    request: (method, path, opts) => request(base, method, path, opts),
    close: () => new Promise((r) => server.close(() => r())),
  };
}

async function request(base, method, path, { token, body, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { /* not JSON */ }
  return { status: res.status, body: json, text, headers: res.headers };
}

module.exports = { startApp, request };
