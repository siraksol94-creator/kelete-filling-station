// System admin routes â€” backup management.
//
// Kelete's daily backup is a cron script that writes SQLite copies to
// /var/backups/kelete/YYYY-MM-DD/ on the VPS. This file surfaces those
// backups to the admin UI so operators (and ZRA auditors) can see the
// list, trigger a manual backup, and download an archive.
//
// Env override: set KELETE_BACKUP_DIR to point at a different folder.

const router = require('express').Router();
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { auth } = require('../middleware/auth');

const BACKUP_ROOT = process.env.KELETE_BACKUP_DIR || '/var/backups/kelete';

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function dirSize(dirPath) {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const p = path.join(dirPath, entry.name);
      if (entry.isDirectory()) total += dirSize(p);
      else if (entry.isFile()) {
        try { total += fs.statSync(p).size; } catch (_) {}
      }
    }
  } catch (_) {}
  return total;
}

// GET /api/system/backups â€” list all backup snapshots on disk.
router.get('/backups', auth, (req, res) => {
  try {
    if (!fs.existsSync(BACKUP_ROOT)) {
      return res.json({ ok: true, backups: [], root: BACKUP_ROOT, note: 'backup directory not present' });
    }
    const entries = fs.readdirSync(BACKUP_ROOT, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => {
        const p = path.join(BACKUP_ROOT, e.name);
        const st = fs.statSync(p);
        let dbCount = 0;
        try { dbCount = fs.readdirSync(p).filter(f => f.endsWith('.db')).length; } catch (_) {}
        const size = dirSize(p);
        return {
          name: e.name,
          created_at: st.mtime.toISOString(),
          db_count: dbCount,
          size_bytes: size,
          size_human: humanSize(size),
        };
      })
      .sort((a, b) => b.name.localeCompare(a.name));
    res.json({ ok: true, root: BACKUP_ROOT, count: entries.length, backups: entries });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/system/backup â€” trigger an immediate backup by shelling out
// to the same script cron uses. Falls back to a JS-level SQLite copy if
// the script isn't present, so this endpoint works even on a fresh
// install where the cron hasn't been wired yet.
router.post('/backup', auth, (req, res) => {
  const scriptPath = process.env.KELETE_BACKUP_SCRIPT || '/usr/local/bin/kelete-backup.sh';
  const useScript = fs.existsSync(scriptPath);

  if (useScript) {
    const child = spawn('bash', [scriptPath], { detached: false });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', code => {
      if (code === 0) return res.json({ ok: true, method: 'script', script: scriptPath });
      res.status(500).json({ error: `backup script exited ${code}`, stderr });
    });
    child.on('error', e => res.status(500).json({ error: e.message }));
    return;
  }

  // Fallback â€” inline copy of every .db file we can find under the
  // Kelete install root. Slower but reliable.
  try {
    const stamp = new Date().toISOString().slice(0, 10);
    const dest = path.join(BACKUP_ROOT, `${stamp}-manual`);
    fs.mkdirSync(dest, { recursive: true });
    const roots = [
      path.join(__dirname, '..', 'kelete.db'),
      path.join(__dirname, '..', '..', 'tenants'),
    ];
    let copied = 0;
    for (const r of roots) {
      if (!fs.existsSync(r)) continue;
      const st = fs.statSync(r);
      if (st.isFile()) {
        fs.copyFileSync(r, path.join(dest, path.basename(r)));
        copied++;
      } else if (st.isDirectory()) {
        for (const f of fs.readdirSync(r)) {
          if (!f.endsWith('.db')) continue;
          fs.copyFileSync(path.join(r, f), path.join(dest, f));
          copied++;
        }
      }
    }
    res.json({ ok: true, method: 'inline', dest, files_copied: copied });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/system/backups/:name/download â€” stream a .tar.gz of one snapshot
// to the browser. Uses `tar` under the hood (present on any Linux VPS).
router.get('/backups/:name/download', auth, (req, res) => {
  const name = String(req.params.name || '').replace(/[^0-9A-Za-z_\-]/g, '');
  if (!name) return res.status(400).json({ error: 'invalid backup name' });
  const dir = path.join(BACKUP_ROOT, name);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'not found' });

  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="kelete-backup-${name}.tar.gz"`);

  const tar = spawn('tar', ['-czf', '-', '-C', BACKUP_ROOT, name]);
  tar.stdout.pipe(res);
  tar.stderr.on('data', d => console.warn('[backup tar]', d.toString()));
  tar.on('error', e => {
    console.error('[backup tar spawn error]', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  });
});

module.exports = router;
