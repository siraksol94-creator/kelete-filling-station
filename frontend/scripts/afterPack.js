const { execSync } = require('child_process');
const path = require('path');

exports.default = async function (context) {
  const electronRebuildBin = path.join(
    context.packager.info.projectDir,
    'node_modules', '.bin', 'electron-rebuild'
  );
  const backendPath = path.join(context.appOutDir, 'resources', 'backend');

  console.log('\n  • rebuilding better-sqlite3 for Electron Node.js in packed output...');
  try {
    execSync(
      `"${electronRebuildBin}" -f -w better-sqlite3 -m "${backendPath}"`,
      { stdio: 'inherit', cwd: context.packager.info.projectDir }
    );
    console.log('  • better-sqlite3 rebuilt OK\n');
  } catch (e) {
    console.error('  ✖ better-sqlite3 rebuild failed:', e.message);
    throw e;
  }
};
