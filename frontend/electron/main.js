const { app, BrowserWindow, dialog, ipcMain, screen } = require('electron');
const http = require('http');
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { exec } = require('child_process');

const logFile = path.join(os.tmpdir(), 'kelete-startup.log');
function log(msg) {
  try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`); } catch (e) {}
}

log('main.js loaded');

// Kill any process using the backend port (prevents EADDRINUSE on restart)
function killPort(port) {
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32'
      ? `for /f "tokens=5" %a in ('netstat -ano ^| findstr :${port}') do taskkill /PID %a /F`
      : `lsof -ti:${port} | xargs kill -9`;
    exec(cmd, () => setTimeout(resolve, 500));
  });
}

let mainWindow;
let splashWindow;
let customerWindow;
let _autoUpdater = null;

// Update the status text shown on splash screen
function setSplashStatus(msg) {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents
      .executeJavaScript(`(function(){ var el = document.getElementById('status'); if(el) el.textContent = ${JSON.stringify(msg)}; })()`)
      .catch(() => {});
  }
}

// IPC: renderer can request a manual update check
ipcMain.handle('check-for-updates', () => {
  if (_autoUpdater) {
    _autoUpdater.checkForUpdates().catch(() => {});
    return { checking: true };
  }
  return { error: 'Auto-updater not available' };
});

// Fetch printer name from local backend
function getDrawerPort() {
  return new Promise((resolve) => {
    http.get('http://localhost:5301/api/settings/drawer-port', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data).port || 'POS-80'); } catch { resolve('POS-80'); }
      });
    }).on('error', () => resolve('POS-80'));
  });
}

// 2026-08-30 â€” the printer to print RECEIPTS on.
//
// This used to be getDrawerPort(), i.e. the cash-drawer setting, which
// defaults to the bare string 'POS-80'. Windows had no printer by that exact
// name (the till has 'POS-80 11.3.0.1' and 'POS-80 11.3.0.1 Dereje'), so
// webContents.print({ silent: true, deviceName: 'POS-80' }) could not find a
// target and the print dialog appeared on every single receipt.
//
// Prefer what the operator actually chose in System Settings > Receipt
// Printer; fall back to the drawer port, then to the old default, so a till
// that was working keeps working.
function getReceiptPrinter() {
  return new Promise((resolve) => {
    http.get('http://localhost:5301/api/settings/drawer-port', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          resolve(j.printer || j.port || 'POS-80');
        } catch { resolve('POS-80'); }
      });
    }).on('error', () => resolve('POS-80'));
  });
}

// IPC: silent print (Promise-based API required for Electron 28+)
ipcMain.handle('print-silent', async (_event, html) => {
  const printerName = await getReceiptPrinter();
  return new Promise((resolve) => {
    // Write HTML to a temp file â€” more reliable than data: URLs for large content
    const tmpFile = path.join(os.tmpdir(), 'kelete-print-' + Date.now() + '.html');
    try { fs.writeFileSync(tmpFile, html, 'utf8'); } catch (e) {
      log('print-silent: failed to write temp file: ' + e.message);
      return resolve({ success: false, reason: e.message });
    }

    const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false } });
    win.loadFile(tmpFile);
    win.webContents.once('did-finish-load', () => {
      const cleanup = () => { try { fs.unlinkSync(tmpFile); } catch (_) {} };
      // 2026-08-30 â€” pageSize and margins must be stated explicitly.
      //
      // Without them Electron prints at the printer's default page, which on
      // a freshly-installed queue is usually A4/Letter. The receipt then lands
      // on a huge sheet and an 80mm roll produces nothing you would recognise
      // as a receipt â€” the job "succeeds" and no paper comes out. That is what
      // v1.13.165 did: the dialog stopped appearing and so did the printing.
      //
      // Microns. 72mm is the print head's width (the driver reports the paper
      // as "80(72)"), 297mm is a generous roll length â€” the printer cuts at
      // the end of content, so this is a ceiling, not a fixed slip length.
      const opts = {
        silent: true,
        printBackground: true,
        deviceName: printerName,
        margins: { marginType: 'none' },
        pageSize: { width: 72000, height: 297000 },
      };
      log('print-silent: printing to "' + printerName + '"');
      win.webContents.print(opts, (success, failureReason) => {
        win.close();
        cleanup();
        log('print-silent: result success=' + success + ' reason=' + (failureReason || '-'));
        if (success) resolve({ success: true });
        else resolve({ success: false, reason: failureReason });
      });
    });
    win.webContents.once('did-fail-load', (_e, code, desc) => {
      log('print-silent: did-fail-load: ' + code + ' ' + desc);
      win.close();
      try { fs.unlinkSync(tmpFile); } catch (_) {}
      resolve({ success: false, reason: desc });
    });
  });
});

function startBackend() {
  log('startBackend called, isPackaged=' + app.isPackaged);
  process.env.ELECTRON_USER_DATA      = app.getPath('userData');
  process.env.ELECTRON_PACKAGED       = app.isPackaged ? '1' : '0';
  process.env.PORT                    = '5301';
  process.env.ELECTRON_FRONTEND_BUILD = app.isPackaged
    ? path.join(process.resourcesPath, 'frontend', 'build')
    : path.join(__dirname, '../../frontend/build');

  const backendPath = app.isPackaged
    ? path.join(process.resourcesPath, 'backend', 'server.js')
    : path.join(__dirname, '../../backend/server.js');

  log('backendPath: ' + backendPath);
  try {
    require(backendPath);
    log('backend loaded OK');
  } catch (e) {
    log('BACKEND ERROR: ' + e.message + '\n' + e.stack);
  }
}

// Promise that resolves when backend is healthy, or after timeout
function waitForBackend(retries = 30) {
  return new Promise((resolve) => {
    function check(remaining) {
      http.get('http://localhost:5301/api/health', (res) => {
        res.resume();
        if (res.statusCode === 200) { log('backend ready'); resolve(); }
        else retry(remaining);
      }).on('error', () => retry(remaining));
    }
    function retry(remaining) {
      if (remaining <= 0) { log('backend timeout â€” continuing anyway'); resolve(); return; }
      setTimeout(() => check(remaining - 1), 500);
    }
    check(retries);
  });
}

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 420,
    height: 380,
    frame: false,
    transparent: false,
    resizable: false,
    center: true,
    alwaysOnTop: true,
    webPreferences: { nodeIntegration: false },
  });
  // Pass the live app version to the splash via query string so the version
  // line stays in sync with package.json automatically â€” was previously a
  // hardcoded "v1.3.2" literal in splash.html that drifted years out of date.
  splashWindow.loadFile(path.join(__dirname, 'splash.html'), {
    query: { v: app.getVersion() },
  });
  splashWindow.on('closed', () => { splashWindow = null; });
}

function createWindow() {
  if (mainWindow) return;
  log('createWindow');
  const preloadPath = path.join(__dirname, 'preload.js');

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    center: true,
    show: false,
    title: 'Kelete Management System',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: preloadPath,
    },
  });

  mainWindow.loadURL('http://localhost:5301');
  mainWindow.webContents.on('did-finish-load', () => {
    log('page loaded OK');
    mainWindow.show();
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    log('page FAILED: ' + code + ' ' + desc);
    mainWindow.show();
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
  });
  mainWindow.on('closed', () => { log('window closed'); mainWindow = null; });
}

function openCustomerDisplay() {
  const displays = screen.getAllDisplays();
  const secondDisplay = displays.find(d => d.id !== screen.getPrimaryDisplay().id);
  if (!secondDisplay) return; // No second monitor â€” do nothing

  const { x, y, width, height } = secondDisplay.bounds;
  customerWindow = new BrowserWindow({
    x, y, width, height,
    fullscreen: true,
    title: 'Customer Display',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  customerWindow.loadURL('http://localhost:5301/customer-display');
  customerWindow.setMenuBarVisibility(false);
  customerWindow.on('closed', () => { customerWindow = null; });
}

// Check for updates â€” resolves with: 'no-update' | 'error' | 'timeout' | { type: 'update-available', info }
function checkForUpdate() {
  return new Promise((resolve) => {
    try {
      const { autoUpdater } = require('electron-updater');
      _autoUpdater = autoUpdater;
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = false;
      autoUpdater.logger = null;
      autoUpdater.setFeedURL({
        provider: 'generic',
        url: 'https://keletezm.com/api/updates',
      });

      // Short timeout (3s) so the splash isn't stuck waiting for VPS â€” if the
      // network has bad DNS or no internet, this fails fast and the app opens.
      const timer = setTimeout(() => { log('update check timed out'); resolve('timeout'); }, 3000);

      autoUpdater.once('update-not-available', () => {
        log('No update available');
        clearTimeout(timer);
        resolve('no-update');
      });

      autoUpdater.once('update-available', (info) => {
        log('Update available: ' + info.version);
        clearTimeout(timer);
        resolve({ type: 'update-available', info });
      });

      autoUpdater.once('error', (err) => {
        log('AutoUpdater error: ' + err.message);
        clearTimeout(timer);
        resolve('error');
      });

      autoUpdater.checkForUpdates().catch((err) => {
        log('checkForUpdates threw: ' + err.message);
        clearTimeout(timer);
        resolve('error');
      });

    } catch (e) {
      log('AutoUpdater load error: ' + e.message);
      resolve('error');
    }
  });
}

app.whenReady().then(async () => {
  log('app ready');
  createSplashWindow();

  // Attach listener immediately â€” before killPort/startBackend so we never miss the event
  const splashLoaded = new Promise(resolve => {
    if (splashWindow && !splashWindow.isDestroyed()) {
      if (splashWindow.webContents.isLoading()) {
        splashWindow.webContents.once('did-finish-load', resolve);
      } else {
        resolve(); // already loaded
      }
    } else {
      resolve();
    }
  });

  await killPort(5301);
  startBackend();

  // Minimum 8 seconds so company info on splash is readable
  const minDelay    = new Promise(resolve => setTimeout(resolve, 8000));
  const backendReady = waitForBackend(30);

  await splashLoaded;

  setSplashStatus('Starting backend...');

  let updateResult = 'no-update';

  if (app.isPackaged) {
    setSplashStatus('Checking for updates...');
    // Run all three in parallel â€” proceed only when all are done
    [, , updateResult] = await Promise.all([minDelay, backendReady, checkForUpdate()]);
  } else {
    setSplashStatus('Development mode');
    await Promise.all([minDelay, backendReady]);
  }

  // If update is available â€” show dialog BEFORE opening main window
  if (updateResult && updateResult.type === 'update-available') {
    setSplashStatus('Update available!');

    // Lower splash so dialogs appear on top of it
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.setAlwaysOnTop(false);

    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: 'Update Available',
      message: `Version ${updateResult.info.version} of Kelete is available.\nDo you want to download and install it now?`,
      buttons: ['Install Now', 'Skip for Now'],
      defaultId: 0,
      cancelId: 1,
    });

    if (response === 0) {
      setSplashStatus('Downloading update...');

      _autoUpdater.on('download-progress', (progress) => {
        setSplashStatus(`Downloading... ${Math.round(progress.percent)}%`);
      });

      _autoUpdater.once('update-downloaded', async (info) => {
        setSplashStatus('Restarting to apply update...');
        if (splashWindow && !splashWindow.isDestroyed()) splashWindow.setAlwaysOnTop(false);
        await dialog.showMessageBox({
          type: 'info',
          title: 'Update Ready',
          message: `Version ${info.version} is ready.\nThe app will now restart to apply the update.`,
          buttons: ['Restart Now'],
          defaultId: 0,
        });
        _autoUpdater.quitAndInstall();
      });

      _autoUpdater.downloadUpdate();
      return; // App will restart â€” don't open main window
    }
    // User chose Skip â€” fall through to open main window normally
  }

  setSplashStatus('Ready!');
  createWindow();
  openCustomerDisplay();
});

app.on('window-all-closed', () => {
  log('window-all-closed');
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});
