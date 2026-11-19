#!/usr/bin/env node
// Runs the frontend logic tests in frontend/tests/ (UX-1 onwards) with Node's
// built-in test runner. The source files are ES modules written for the React
// build, so each test file is first bundled to CommonJS with esbuild (the same
// pinned esbuild as scripts/check-screens.js; ESBUILD_BIN overrides it).
// No browser, no React render and no npm install: these tests cover pure logic.
//
//   node scripts/test-ux.js
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TESTS = path.join(ROOT, 'tests');
const ESBUILD_VERSION = '0.28.2';

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.test\.js$/.test(e.name)) files.push(p);
  }
})(TESTS);
if (!files.length) { console.error('no tests found under frontend/tests'); process.exit(1); }

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'kelete-ux-tests-'));
const esbuild = process.env.ESBUILD_BIN
  ? [process.env.ESBUILD_BIN]
  : [process.platform === 'win32' ? 'npx.cmd' : 'npx', '--yes', `esbuild@${ESBUILD_VERSION}`];
try {
  const bundles = files.map((f) => {
    const dest = path.join(out, path.relative(TESTS, f).replace(/[\\/]/g, '__'));
    execFileSync(esbuild[0], [...esbuild.slice(1), f, '--bundle', '--platform=node', '--format=cjs',
      '--loader:.js=jsx', '--external:node:*', `--outfile=${dest}`, '--log-level=warning'], { stdio: 'inherit' });
    return dest;
  });
  const r = spawnSync(process.execPath, ['--test', ...bundles], { stdio: 'inherit' });
  process.exitCode = r.status === null ? 1 : r.status;
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}
