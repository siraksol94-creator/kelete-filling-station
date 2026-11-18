// System admin routes — backup management.
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
const { auth, adminOnly } = require('../middleware/auth');
// S7 — the backup endpoints below were `auth` only: ANY logged-in user (a
// cashier, an attendant) could list backups, trigger one, and DOWNLOAD a full
// archive of every database — customers, financial records and staff password
// hashes. They are now Administrator-only, checked live against the database
// (adminOnly), matching the frontend where the Backups page is already
// `adminOnly` (App.js), so legitimate use is unchanged.
const db = require('../config/database');

const backupKit = require('../services/backupKit');
// On a till (no KELETE_BACKUP_DIR) this is %APPDATA%/Kelete/Backups, the same
// folder the till's daily backup uses — not C:\var\backups\kelete (S6).
const BACKUP_ROOT = backupKit.defaultBackupRoot();

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

// GET /api/system/backups — list all backup snapshots on disk.
router.get('/backups', auth, adminOnly, (req, res) => {
  try {
    if (!fs.existsSync(BACKUP_ROOT)) {
      return res.json({ ok: true, backups: [], root: BACKUP_ROOT, note: 'backup directory not present' });
    }
    const entries = fs.readdirSync(BACKUP_ROOT, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name !== 'pre-restore')
      .map(e => {
        const p = path.join(BACKUP_ROOT, e.name);
        const st = fs.statSync(p);
        let dbCount = 0;
        try { dbCount = fs.readdirSync(p).filter(f => f.endsWith('.db')).length; } catch (_) {}
        const size = dirSize(p);
        // S6: verification recorded when the backup was taken (null = older
        // backup with no manifest).
        const m = backupKit.readManifest(p);
        const failed = m ? Object.entries(m.files || {}).filter(([, f]) => !f.ok).map(([k]) => k) : [];
        return {
          name: e.name,
          created_at: st.mtime.toISOString(),
          db_count: m ? Object.keys(m.files || {}).length : dbCount,
          size_bytes: size,
          size_human: humanSize(size),
          verified: m ? !!m.ok : null,
          failed_files: failed,
        };
      })
      .sort((a, b) => b.name.localeCompare(a.name));
    res.json({ ok: true, root: BACKUP_ROOT, count: entries.length, backups: entries });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/system/backup — trigger an immediate backup by shelling out
// to the same script cron uses (vps/backup.sh — it verifies its copies and
// exits non-zero if any fail). Without the script (fresh install, a till)
// the backup is taken here.
//
// S6 — the in-app fallback used to copyFileSync() backend/kelete.db and a
// "tenants" folder next to the code: no master.db, the wrong folders on a till,
// and a plain file copy that can miss sales still in the -wal file. It now
// uses SQLite's online backup API on every live database (backupKit), checks
// each copy, and records the result in manifest.json. Any failed copy makes
// the request fail (500) so the operator knows.
router.post('/backup', auth, adminOnly, async (req, res) => {
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

  try {
    const dbs = backupKit.liveDatabases();
    if (!dbs.length) return res.status(500).json({ error: 'no databases found to back up' });
    // A new folder every time (two clicks in the same second never share one).
    let dest = path.join(BACKUP_ROOT, `${backupKit.stamp()}-manual`);
    for (let i = 2; fs.existsSync(dest); i++) dest = path.join(BACKUP_ROOT, `${backupKit.stamp()}-manual-${i}`);
    const r = await backupKit.backupSet(dbs, dest, { method: 'inline', reason: 'manual', requested_by: req.user && req.user.id });
    const files = Object.entries(r.results).map(([rel, x]) => ({
      file: rel, ok: x.ok, error: x.error || null, total_rows: x.total_rows ?? null, bytes: x.bytes ?? null,
    }));
    const body = { ok: r.ok, method: 'inline', dest, files_copied: files.filter(f => f.ok).length, files };
    if (!r.ok) return res.status(500).json({ ...body, error: `backup check failed for: ${files.filter(f => !f.ok).map(f => f.file).join(', ')}` });
    res.json(body);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/system/backups/:name/download — stream a .tar.gz of one snapshot
// to the browser. Uses `tar` under the hood (present on any Linux VPS).
router.get('/backups/:name/download', auth, adminOnly, (req, res) => {
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

// ─── D1: GET /api/system/schema-status ─────────────────────────────────────
// Which versioned migrations and one-time data tasks have run on THIS
// database (the branch the request is for). Read-only. Administrators only.
router.get('/schema-status', auth, adminOnly, (req, res) => {
  try {
    const { getStatus } = require('../config/migrationRunner');
    const migrations = require('../config/versionedMigrations');
    res.json({ ok: true, ...getStatus(db, migrations) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── D2: GET /api/system/audit-log ──────────────────────────────────────────
// Read-only view of audit_log for this database. Administrators only.
// Filters: from, to (ISO date/time), action (prefix), table, entity_id,
// actor_user_id, source. Paging: limit (max 500), before_id.
router.get('/audit-log', auth, adminOnly, (req, res) => {
  try {
    const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='audit_log'").get();
    if (!has) return res.json({ ok: true, rows: [], note: 'audit_log not present on this database yet' });
    const where = [];
    const args = [];
    const q = req.query || {};
    if (q.from)          { where.push('occurred_at >= ?');        args.push(String(q.from)); }
    if (q.to)            { where.push('occurred_at <= ?');        args.push(String(q.to)); }
    if (q.action)        { where.push('action LIKE ?');           args.push(String(q.action) + '%'); }
    if (q.table)         { where.push('entity_table = ?');        args.push(String(q.table)); }
    if (q.entity_id)     { where.push('entity_id = ?');           args.push(String(q.entity_id)); }
    if (q.actor_user_id) { where.push('actor_user_id = ?');       args.push(Number(q.actor_user_id)); }
    if (q.source)        { where.push('source = ?');              args.push(String(q.source)); }
    if (q.before_id)     { where.push('id < ?');                  args.push(Number(q.before_id)); }
    const limit = Math.min(Math.max(parseInt(q.limit, 10) || 100, 1), 500);
    const rows = db.prepare(
      `SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`
    ).all(...args, limit);
    res.json({ ok: true, rows, next_before_id: rows.length === limit ? rows[rows.length - 1].id : null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
