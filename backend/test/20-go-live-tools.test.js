// Go-Live Pack tools: the release manifest matches the code, and the VPS
// pre-flight is read-only and never prints a secret (run on a fake VPS folder
// with planted secrets; nothing real is touched).
const { setupEnv, makeTempDir } = require('./helpers/harness');
setupEnv();

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const GO = path.resolve(__dirname, '../../ops/go-live');
const manifest = JSON.parse(fs.readFileSync(path.join(GO, 'release-manifest.json'), 'utf8'));

test('release manifest: migrations are exactly the ones in the code (update the manifest when adding one)', () => {
  const code = require('../config/versionedMigrations').map(m => ({ version: m.version, name: m.name }));
  assert.deepEqual(manifest.migrations, code);
  const listed = manifest.patches.flatMap(p => p.migrations).sort((a, b) => a - b);
  assert.deepEqual(listed, code.map(m => m.version), 'every migration is attributed to exactly one patch');
  assert.deepEqual(manifest.patches.map(p => p.n), manifest.patches.map((_, i) => i + 1));
});

test('release manifest: the suggested tag form starts none of the inherited workflows', () => {
  const example = manifest.suggested_release_tag.replace('YYYYMMDD', '20261126').replace('N', '1');
  for (const pat of manifest.tag_patterns_that_trigger_old_workflows) {
    const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    assert.ok(!re.test(example), `${example} vs ${pat}`);
  }
});

const hasBash = spawnSync('bash', ['--version']).status === 0;
test('vps-preflight: changes nothing, prints no secret, flags a placeholder JWT secret', { skip: !hasBash && 'bash not available' }, () => {
  const root = makeTempDir('kelete-preflight');
  const app = path.join(root, 'app');
  fs.mkdirSync(path.join(app, 'backend'), { recursive: true });
  fs.mkdirSync(path.join(app, 'tenants'));
  const g = (...a) => execFileSync('git', ['-C', app, ...a], { stdio: 'ignore' });
  g('init', '-q'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'live');
  g('remote', 'add', 'origin', 'https://someone:PlantedUrlToken@example.invalid/repo.git');
  fs.writeFileSync(path.join(app, 'backend/.env'), [
    'JWT_SECRET=kelete-pro-secret-key-2026', 'ADMIN_PASSWORD="Planted-Admin-Pass"', 'GH_TOKEN=ghp_PlantedToken',
    'OTHER_SECRET=PlantedOther', 'GH_OWNER=someone', 'KELETE_PERMISSIONS=log', 'PORT=1'].join('\n'));
  fs.writeFileSync(path.join(app, 'backend/kelete.db'), 'x');
  fs.writeFileSync(path.join(app, 'tenants/b1.db'), 'y');
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'pm2'), `#!/bin/sh\n[ "$1" = jlist ] && echo '[{"name":"k","pm2_env":{"status":"online","env":{"JWT_SECRET":"PlantedPm2Secret-0123456789-0123456789","NODE_ENV":"production"}}}]'\n`, { mode: 0o755 });
  const hashAll = () => crypto.createHash('sha256').update(JSON.stringify(
    fs.readdirSync(app, { recursive: true }).filter(f => !String(f).startsWith('.git')).sort()
      .map(f => { const p = path.join(app, f); return fs.statSync(p).isFile() ? [f, fs.readFileSync(p, 'base64')] : [f]; }))).digest('hex');
  const before = hashAll();
  const out = execFileSync('bash', [path.join(GO, 'vps-preflight.sh'), app, 'k'], {
    encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(hashAll(), before, 'nothing in the checkout changed');
  for (const s of ['PlantedUrlToken', 'Planted-Admin-Pass', 'ghp_PlantedToken', 'PlantedOther', 'PlantedPm2Secret', 'kelete-pro-secret-key-2026']) {
    assert.ok(!out.includes(s), `must not print ${s}`);
  }
  assert.match(out, /JWT_SECRET = PUBLIC PLACEHOLDER/);
  assert.match(out, /JWT_SECRET = set \(38 chars\) — ok/, 'the PM2 value is judged separately');
  assert.match(out, /KELETE_PERMISSIONS = log/);
  assert.match(out, /GH_OWNER = someone/);
  assert.match(out, /tenants\/b1\.db/);
  assert.match(out, /Nothing was changed/);
});
