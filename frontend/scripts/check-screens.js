#!/usr/bin/env node
// CI — catch broken screen files before they are merged.
//
//   node scripts/check-screens.js            (from frontend/)
//
// 1. Bundles from src/index.js the way the app loads: every JSX file reachable
//    from the app must parse, every relative import must resolve to a file,
//    and every named import must exist (e.g. a typo'd or removed export).
//    npm packages are left out (not installed in this check), as are images,
//    fonts and CSS.
// 2. Parses every other .js file under src/ on its own, so a broken file that
//    is not linked from the app yet is caught too.
// Needs only Node + esbuild (fetched by npx; pinned below). It is not a full
// `react-scripts build` (which would need the whole frontend install,
// Electron and Capacitor included) — it catches what breaks screens.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ESBUILD_VERSION = '0.28.2';
const root = path.resolve(__dirname, '..');
const bin = process.env.ESBUILD_BIN; // optional local binary
const run = (args) => spawnSync(bin || 'npx', bin ? args : ['--yes', `esbuild@${ESBUILD_VERSION}`, ...args],
  { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });

const assets = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'webp', 'css', 'woff', 'woff2', 'ttf', 'eot', 'mp3', 'wav']
  .map(e => `--loader:.${e}=empty`);

let failed = false;
const bundle = run(['src/index.js', '--bundle', '--packages=external', '--loader:.js=jsx', ...assets,
  '--log-level=error', '--outfile=' + (process.platform === 'win32' ? 'NUL' : '/dev/null')]);
if (bundle.status !== 0) { failed = true; process.stderr.write(bundle.stderr || bundle.stdout || 'esbuild failed\n'); }
else console.log('✓ app bundle: every reachable screen parses and every import resolves');

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.jsx?$/.test(e.name)) files.push(path.relative(root, p));
  }
})(path.join(root, 'src'));
const parse = run([...files, '--loader:.js=jsx', '--log-level=error', '--outdir=' + path.join(require('os').tmpdir(), 'kelete-screen-check')]);
if (parse.status !== 0) { failed = true; process.stderr.write(parse.stderr || parse.stdout || 'esbuild failed\n'); }
else console.log(`✓ all ${files.length} files under src/ parse`);

// 3. ESLint rule names the project doesn't load. The react-hooks plugin is not
//    registered in this app's ESLint config, so a comment naming one of its
//    rules is itself an error and stops `npm start` / `npm run build`.
//    Use the bare form: // eslint-disable-line   or   // eslint-disable-next-line
{
  const fs = require('fs');
  const bad = [];
  for (const f of files) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (/eslint-(disable|enable)[\w-]*\s+react-hooks\//.test(line)) bad.push(`${path.relative(process.cwd(), f)}:${i + 1}`);
    });
  }
  if (bad.length) { failed = true; process.stderr.write(`✗ eslint comments name a rule this project doesn't load (use the bare form):\n  ${bad.join('\n  ')}\n`); }
  else console.log('✓ no eslint comments name unknown react-hooks rules');
}

process.exit(failed ? 1 : 0);
