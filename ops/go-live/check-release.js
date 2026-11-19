#!/usr/bin/env node
// ops/go-live/check-release.js — is this checkout the release we reviewed?
//
//   node ops/go-live/check-release.js [--ref <commit-or-tag>] [--tag <proposed-tag-name>]
//
// Run on the TEST machine in a kelete-erp checkout (never on the VPS or a
// till). Read-only: it only runs `git log` / `git show` and reads files.
// Checks:
//   1. every patch in release-manifest.json is in the history of <ref>
//      (default HEAD), once, and in the listed order;
//   2. the migrations in <ref> are exactly versions 1..N with the listed names;
//   3. the proposed release tag (if given) does not match a tag pattern that
//      fires the inherited GitHub workflows (deploy.yml publishes installers
//      to the previous developer's GitHub account);
//   4. reports the till installer's version number and where installers are
//      published, which the go-live decisions depend on.
// Exit code 0 = all checks passed, 1 = a check failed, 2 = usage error.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const ref = opt('--ref') || 'HEAD';
const tag = opt('--tag');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'release-manifest.json'), 'utf8'));
const git = (...a) => execFileSync('git', ['-C', ROOT, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const show = (file) => { try { return git('show', `${ref}:${file}`); } catch (_) { return null; } };

let failed = 0;
const fail = (m) => { failed++; console.log(`  ✗ ${m}`); };
const pass = (m) => console.log(`  ✓ ${m}`);
const note = (m) => console.log(`  • ${m}`);

try { git('rev-parse', '--verify', `${ref}^{commit}`); } catch (_) { console.error(`Unknown ref: ${ref}`); process.exit(2); }
console.log(`Release check for ${ref} (${git('rev-parse', '--short', `${ref}^{commit}`).trim()})\n`);

// 1 — patches, once each, in order
console.log('1. Patches');
const history = git('log', '--reverse', '--format=%s', ref).split('\n').filter(Boolean);
const positions = manifest.patches.map(p => ({ p, at: history.reduce((a, s, i) => (s === p.subject ? [...a, i] : a), []) }));
for (const { p, at } of positions) {
  if (at.length === 0) fail(`#${p.n} missing: ${p.subject}`);
  else if (at.length > 1) fail(`#${p.n} applied ${at.length} times: ${p.subject}`);
}
const order = positions.filter(x => x.at.length === 1).map(x => x.at[0]);
const outOfOrder = order.some((v, i) => i && v < order[i - 1]);
if (outOfOrder) fail('patches are not in the listed order');
const known = new Set(manifest.patches.map(p => p.subject));
const firstAt = Math.min(...order);
const extra = Number.isFinite(firstAt) ? history.slice(firstAt).filter(s => !known.has(s)) : [];
if (!positions.some(x => x.at.length !== 1) && !outOfOrder) pass(`all ${manifest.patches.length} patches present, once each, in order`);
if (extra.length) note(`${extra.length} other commit(s) among them (review that they belong in this release):\n      - ${extra.join('\n      - ')}`);

// 2 — migrations
console.log('\n2. Migrations');
const migSrc = show('backend/config/versionedMigrations.js');
if (!migSrc) fail('backend/config/versionedMigrations.js not found in this ref');
else {
  const found = [...migSrc.matchAll(/version:\s*(\d+),\s*\n?\s*name:\s*'([^']+)'/g)].map(m => ({ version: +m[1], name: m[2] }));
  const want = manifest.migrations;
  const same = found.length === want.length && want.every((m, i) => found[i] && found[i].version === m.version && found[i].name === m.name);
  if (same) pass(`versions 1–${want.length} as listed (${want.map(m => m.name).join(', ')})`);
  else fail(`expected ${want.map(m => `${m.version} ${m.name}`).join(', ')}; found ${found.map(m => `${m.version} ${m.name}`).join(', ') || 'none'}`);
}

// 3 — release tag vs the inherited workflows
console.log('\n3. Release tag');
const patterns = [];
for (const wf of ['deploy.yml', 'release-apk.yml', 'test.yml']) {
  const y = show(`.github/workflows/${wf}`);
  if (!y) continue;
  const block = y.split(/\n(?=\S)/).find(b => /^on:/.test(b)) || '';
  const tagsLine = block.match(/tags(?:-ignore)?:\s*(\[[^\]]*\]|\n(?:\s+-\s*.+\n?)+)/);
  if (tagsLine && !/tags-ignore/.test(tagsLine[0])) {
    const list = tagsLine[1].startsWith('[') ? tagsLine[1].slice(1, -1).split(',') : tagsLine[1].split('\n').map(l => l.replace(/^\s*-\s*/, ''));
    for (const raw of list) { const pat = raw.trim().replace(/^['"]|['"]$/g, ''); if (pat) patterns.push({ wf, pat }); }
  }
}
note(`tags that start a workflow: ${patterns.map(x => `${x.pat} (${x.wf})`).join(', ') || 'none'}`);
const glob = (pat) => new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*') + '$');
if (tag) {
  const hits = patterns.filter(x => glob(x.pat).test(tag));
  if (hits.length) fail(`tag "${tag}" would start ${hits.map(h => h.wf).join(', ')} — choose a name like ${manifest.suggested_release_tag}`);
  else pass(`tag "${tag}" starts none of the inherited workflows`);
} else note(`pass --tag <name> to check a proposed tag (suggested form: ${manifest.suggested_release_tag})`);

// 4 — till installer facts
console.log('\n4. Till installer');
const fe = show('frontend/package.json');
if (fe) {
  const pkg = JSON.parse(fe);
  note(`installer version in frontend/package.json: ${pkg.version} — must be HIGHER than the version the live tills run and than the one the update feed offers (go-live decision G2)`);
  const pub = pkg.build && pkg.build.publish;
  if (pub) note(`electron-builder publishes to: ${pub.provider} ${pub.owner || ''}/${pub.repo || ''} (deploy.yml uses this; build the go-live installer with "npm run dist", not dist:publish)`);
}
const upd = show('backend/routes/updates.js');
if (upd) {
  const o = upd.match(/GH_OWNER\s*\|\|\s*'([^']+)'/), r = upd.match(/GH_REPO\s*\|\|\s*'([^']+)'/);
  note(`VPS update feed reads releases from GH_OWNER/GH_REPO (defaults ${o && o[1]}/${r && r[1]}) — see the pre-flight report for the live values`);
}

console.log(failed ? `\n${failed} check(s) FAILED — do not tag or deploy this ref.` : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
