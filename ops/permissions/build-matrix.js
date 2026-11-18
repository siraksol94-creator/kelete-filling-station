#!/usr/bin/env node
// S7 (full matrix) — derive the server-side permission matrix from the screens.
//
//   node ops/permissions/build-matrix.js            # writes backend/config/permissionMatrix.json
//   node ops/permissions/build-matrix.js --check    # exit 1 if the checked-in file is out of date
//
// How: every screen (frontend/src/App.js <Route>) has a gate — PermRoute's
// perms list, allAccessOnly / adminOnly, or none (any logged-in user). Every
// API call a screen can make (directly, or through the components and helpers
// it imports, or via services/api.js) inherits that screen's gate. The Layout
// (menu bar, notifications, global search) is shown to every logged-in user,
// so its calls are open to any logged-in user.
//
// The server (backend/middleware/permissions.js) then allows an API request
// from a non-administrator only if they could open at least one screen that
// makes that call. This mirrors what the screens already allow; it changes
// nothing for legitimate use, and stops calls made outside the screens.
//
// Re-run after changing screens or services/api.js; CI runs --check.
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '../..');
const SRC = path.join(REPO, 'frontend/src');
const OUT = path.join(REPO, 'backend/config/permissionMatrix.json');
const rel = (f) => path.relative(SRC, f).split(path.sep).join('/');

// ─── files and imports ────────────────────────────────────────────────────
function listFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else if (/\.(js|jsx)$/.test(e.name) && !/\.test\.js$/.test(e.name)) out.push(p);
  }
  return out;
}
const files = listFiles(SRC);
const text = Object.fromEntries(files.map(f => [f, fs.readFileSync(f, 'utf8')]));

function resolveImport(from, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(from), spec);
  for (const c of [base, `${base}.js`, `${base}.jsx`, path.join(base, 'index.js')]) {
    if (text[c] !== undefined) return c;
  }
  return null;
}

const API_JS = path.join(SRC, 'services/api.js');
// Modules of small exported wrappers around the API (services/api.js,
// services/fuelApi.js): a screen gets only the functions it imports.
const API_MODULES = new Set(files.filter(f => rel(f).startsWith('services/')));
const IMPORT_RE = /import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
const imports = {};      // file → [files it imports]
const apiNames = {};     // file → [{ mod, local, orig }] imported from an API module
for (const f of files) {
  imports[f] = [];
  apiNames[f] = [];
  for (const m of text[f].matchAll(IMPORT_RE)) {
    const target = resolveImport(f, m[2]);
    if (!target) continue;
    if (API_MODULES.has(target)) {
      const named = /\{([\s\S]*?)\}/.exec(m[1]);
      if (named) {
        for (const part of named[1].split(',')) {
          const [orig, alias] = part.trim().split(/\s+as\s+/);
          if (orig) apiNames[f].push({ mod: target, local: (alias || orig).trim(), orig: orig.trim() });
        }
      }
      // `import api from '…/api'` (the axios instance): its direct api.get(…)
      // calls in this file are picked up by callsIn().
    } else {
      imports[f].push(target);
    }
  }
  // import('…') loaded on demand counts as an import too.
  for (const m of text[f].matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const target = resolveImport(f, m[1]);
    if (target && !API_MODULES.has(target)) imports[f].push(target);
  }
}

// ─── API calls: normalise a URL expression to a path pattern ──────────────
// Replace each ${…} (nested templates and braces included): filling a whole
// path segment → ':p'; glued onto text (a query string, a suffix) → dropped.
function stripTemplates(p) {
  let out = '';
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '$' && p[i + 1] === '{') {
      let depth = 1, j = i + 2;
      for (; j < p.length && depth; j++) { if (p[j] === '{') depth++; else if (p[j] === '}') depth--; }
      const next = p[j];
      const wholeSegment = out.endsWith('/') && (next === undefined || next === '/' || next === '?' || (next === '$' && p[j + 1] === '{'));
      out += wholeSegment ? ':p' : '\u0000';
      i = j - 1;
    } else out += p[i];
  }
  // anything after a glued template is a query/suffix built at run time
  return out.split('\u0000')[0];
}

function normalisePath(raw) {
  let p = raw.replace(/^\$\{(API_BASE|API_BASE_URL|API|BASE|base)\}/, '').replace(/^\/api(?=\/)/, '');
  p = stripTemplates(p).split('?')[0].replace(/\/+$/, '');
  if (!p.startsWith('/')) return null;
  return p || null;
}

// Calls made with the axios instance `api` (inside services/api.js and in the
// few pages that import it directly). The first argument may be a literal or
// an expression holding several (e.g. `cls ? '/zra/codes?cls=…' : '/zra/codes'`):
// every literal in it is taken. A call with no literal URL is reported.
const AXIOS_CALL = /\bapi\.(get|post|put|patch|delete)\(\s*((?:[^,()]|\([^()]*\))*)/g;
const LITERAL = /(['"`])((?:(?!\1)[\s\S])*?)\1/g;
const FETCH_CALL = /\b(?:fetch|axios\.(get|post|put|patch|delete))\(\s*(['"`])((?:(?!\2)[\s\S])*?)\2/g;

// The rest of a call's own arguments (up to its closing bracket) — where
// fetch's { method: 'POST' } lives. Never reads into the next call.
function restOfCall(src, from) {
  let depth = 1, i = from;
  for (; i < src.length && depth; i++) {
    const c = src[i];
    if (c === '(') depth++; else if (c === ')') depth--;
    else if (c === "'" || c === '"' || c === '`') { const q = c; i++; while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; } }
  }
  return src.slice(from, i);
}
const unresolved = [];

function callsIn(src, file) {
  const out = [];
  for (const m of src.matchAll(AXIOS_CALL)) {
    const lits = [...m[2].matchAll(LITERAL)].map(x => x[2]).filter(x => x.startsWith('/') || x.startsWith('${'));
    if (!lits.length) { unresolved.push(`${rel(file)}: api.${m[1]}(${m[2].trim().slice(0, 60)})`); continue; }
    for (const lit of lits) {
      const p = normalisePath(lit);
      if (p) out.push({ method: m[1].toUpperCase(), path: p });
      else unresolved.push(`${rel(file)}: api.${m[1]}(${lit})`);
    }
  }
  for (const m of src.matchAll(FETCH_CALL)) {
    const url = m[3];
    if (!/^(\/api\/|\$\{API_BASE|\$\{API_BASE_URL)/.test(url)) continue; // other hosts (VPS) are not this server's screens
    const p = normalisePath(url);
    if (!p) { unresolved.push(`${rel(file)}: fetch(${url})`); continue; }
    let method = (m[1] || '').toUpperCase();
    if (!method) { const mm = /method:\s*['"](\w+)['"]/.exec(restOfCall(src, m.index + m[0].length)); method = mm ? mm[1].toUpperCase() : 'GET'; }
    out.push({ method, path: p });
  }
  for (const m of src.matchAll(/\b(?:fetch|axios\.(?:get|post|put|patch|delete))\(\s*([^'"`\s][^,)]*)/g)) {
    unresolved.push(`${rel(file)}: ${m[0].slice(0, 70)}`);
  }
  return out;
}

// API modules: calls made by each exported function.
const exportCalls = {}; // mod → { name → calls }
const exportRe = /^export\s+(?:const|async function|function)\s+(\w+)/gm;
for (const mod of API_MODULES) {
  const src = text[mod];
  exportCalls[mod] = {};
  const starts = [...src.matchAll(exportRe)].map(m => ({ name: m[1], at: m.index }));
  starts.forEach((st, i) => {
    const block = src.slice(st.at, i + 1 < starts.length ? starts[i + 1].at : src.length);
    exportCalls[mod][st.name] = callsIn(block, mod);
  });
}

// Calls a file makes itself: api.js functions it uses + direct calls.
function ownCalls(f) {
  if (API_MODULES.has(f)) return [];
  const out = [];
  const body = text[f].replace(IMPORT_RE, '');
  for (const { mod, local, orig } of apiNames[f]) {
    if (!new RegExp(`\\b${local}\\b`).test(body)) continue;
    out.push(...((exportCalls[mod] || {})[orig] || []));
  }
  out.push(...callsIn(text[f], f));
  return out;
}

function reachable(f, seen = new Set(), stop = new Set()) {
  if (seen.has(f)) return seen;
  seen.add(f);
  for (const g of imports[f]) if (!stop.has(g)) reachable(g, seen, stop);
  return seen;
}

// ─── screens and their gates (App.js) ─────────────────────────────────────
const APP = path.join(SRC, 'App.js');
const appSrc = text[APP];
const compFile = {};
for (const m of appSrc.matchAll(/import\s+(\w+)\s+from\s+['"](\.[^'"]+)['"]/g)) {
  const f = resolveImport(APP, m[2]);
  if (f) compFile[m[1]] = f;
}

const gates = []; // { screen, file, gate }
const ROUTE_RE = /<Route\s+(?:path="([^"]*)"|index)\s+element=\{([\s\S]*?)\}\s*\/>/g;
for (const m of appSrc.matchAll(ROUTE_RE)) {
  const screen = m[1] || '(index)';
  const el = m[2];
  const comps = [...el.matchAll(/<([A-Z]\w*)/g)].map(x => x[1]).filter(c => compFile[c]);
  if (!comps.length) continue;
  const comp = comps[comps.length - 1];
  let gate = { any: true };
  const pr = /<PermRoute([^>]*)>/.exec(el);
  if (pr) {
    const attrs = pr[1];
    if (/adminOnly/.test(attrs)) gate = { admin: true };
    else if (/allAccessOnly/.test(attrs)) gate = { allAccess: true };
    else {
      const perms = /perms=\{\[([\s\S]*?)\]\}/.exec(attrs);
      gate = { perms: perms ? [...perms[1].matchAll(/'([^']+)'/g)].map(x => x[1]) : [] };
    }
  }
  gates.push({ screen, file: compFile[comp], gate });
}
// Shown to every logged-in user on every screen.
for (const c of ['Layout']) gates.push({ screen: '(menu bar / layout)', file: compFile[c], gate: { any: true } });
// Login, setup and the customer display work before or without a login.
for (const c of ['Login', 'Setup', 'CustomerDisplay', 'LicenseBanner']) {
  if (compFile[c]) gates.push({ screen: `(${c})`, file: compFile[c], gate: { any: true } });
}

// The app shell itself (index.js, App.js, the login context, push-notification
// registration…) runs for every logged-in user, outside any one screen.
const screenFiles = new Set(gates.map(g => g.file));
const shell = new Set();
for (const root of ['index.js', 'App.js']) reachable(path.join(SRC, root), shell, screenFiles);

// The legacy one-word permissions ('Stock', 'Sales'…) and the page keys they
// cover — copied from context/AuthContext.js so server and screens agree.
const authSrc = text[path.join(SRC, 'context/AuthContext.js')];
const legacyBlock = /const LEGACY_MAP = \{([\s\S]*?)\n\};/.exec(authSrc);
if (!legacyBlock) throw new Error('LEGACY_MAP not found in context/AuthContext.js');
const legacyMap = {};
for (const m of legacyBlock[1].matchAll(/^\s*(\w+):\s*'([^']+)'/gm)) legacyMap[m[1]] = m[2];

// ─── combine ──────────────────────────────────────────────────────────────
const endpoints = new Map(); // "METHOD path" → { method, path, gates: [...], screens: Set }
const gateKey = (g) => JSON.stringify(g);
const sources = [...gates.map(g => ({ ...g, files: reachable(g.file) })),
  { screen: '(app shell)', gate: { any: true }, files: shell }];
for (const { screen, files: reach, gate } of sources) {
  for (const f of reach) {
    for (const c of ownCalls(f)) {
      const k = `${c.method} ${c.path}`;
      if (!endpoints.has(k)) endpoints.set(k, { method: c.method, path: c.path, gates: new Map(), screens: new Set() });
      const e = endpoints.get(k);
      e.gates.set(gateKey(gate), gate);
      e.screens.add(screen);
    }
  }
}

// Simplify each endpoint's gates: "any" wins; otherwise keep the distinct ones.
const out = [...endpoints.values()].map(e => {
  const gs = [...e.gates.values()];
  let gate;
  if (gs.some(g => g.any)) gate = { any: true };
  else {
    const perms = [...new Set(gs.filter(g => g.perms).flatMap(g => g.perms))].sort();
    const allAccess = gs.some(g => g.allAccess);
    gate = perms.length ? { perms, ...(allAccess ? { allAccess: true } : {}) } : (allAccess ? { allAccess: true } : { admin: true });
  }
  return { method: e.method, path: e.path, ...gate, screens: [...e.screens].sort() };
}).sort((a, b) => (a.path + a.method).localeCompare(b.path + b.method));

const matrix = {
  generated_by: 'ops/permissions/build-matrix.js',
  note: 'Do not edit by hand: re-run the script after changing frontend screens or services/api.js.',
  legacy_map: legacyMap,
  endpoint_count: out.length,
  endpoints: out,
};
const json = `${JSON.stringify(matrix, null, 1)}\n`;

if (process.argv.includes('--check')) {
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (cur !== json) { console.error('permissionMatrix.json is out of date: run node ops/permissions/build-matrix.js'); process.exit(1); }
  console.log(`permissionMatrix.json is up to date (${out.length} endpoints)`);
  process.exit(0);
}
fs.writeFileSync(OUT, json);
console.log(`wrote ${path.relative(REPO, OUT)}: ${out.length} endpoints from ${gates.length} screens`);
const by = (k) => out.filter(e => e[k]).length;
console.log(`  any logged-in user: ${by('any')}, permission-gated: ${by('perms')}, all-access only: ${out.filter(e => e.allAccess && !e.perms).length}, administrator only: ${by('admin')}`);
if (unresolved.length) {
  console.log(`  ${unresolved.length} call(s) with a URL that is not a literal (cannot be mapped; the server treats them as unmapped):`);
  for (const u of [...new Set(unresolved)]) console.log(`    ${u}`);
}
