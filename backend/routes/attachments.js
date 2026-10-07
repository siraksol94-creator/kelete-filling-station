// Generic invoice attachment upload â€” used by GRN and Payment Vouchers.
// Stores PDFs / images (incl. camera captures, which arrive as image/jpeg or image/png) under
// uploads/invoices/. Returns the relative path; the form then submits that path in invoice_attachment.
//
// Tenant-aware: on the multi-tenant server, files land in TENANTS_DIR/<slug>/uploads/invoices/.
// On the default Electron server, they land in the regular uploads dir.
const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { auth, withTenantDb } = require('../middleware/auth');
const { randomUUID } = require('crypto');

// Resolve where to drop uploaded files for the incoming request. Tenant server sets
// X-Tenant on every request; default server has no such header.
function resolveInvoiceDir(req) {
  // v1.10.3 â€” fall back to req.hostname when Nginx didn't pass X-Tenant. Without
  // this, files silently landed in backend/uploads/ instead of TENANTS_DIR/<slug>/,
  // and the tenant static handler served 404 for the recorded URL.
  const host = (req.headers['x-tenant'] || req.hostname || '').toLowerCase();
  const slug = host.split('.')[0];
  const TENANT_SKIP = new Set(['', 'www', 'kelete', 'keletedistributionzm', 'localhost', 'api', '127', 'sidanitsolutions']);
  if (slug && !TENANT_SKIP.has(slug)) {
    const base = process.env.TENANTS_DIR || path.join(__dirname, '..', '..', 'tenants');
    const dir = path.join(base, slug, 'uploads', 'invoices');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  const defaultRoot = process.env.UPLOADS_DIR
    || (process.env.ELECTRON_USER_DATA ? path.join(process.env.ELECTRON_USER_DATA, 'uploads') : path.join(__dirname, '..', 'uploads'));
  const dir = path.join(defaultRoot, 'invoices');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const ALLOWED = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

const storage = multer.diskStorage({
  destination: (req, _file, cb) => cb(null, resolveInvoiceDir(req)),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase() || (file.mimetype === 'application/pdf' ? '.pdf' : '.jpg');
    const tag = (req.body.kind || 'invoice').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'invoice';
    cb(null, `${tag}_${Date.now()}_${randomUUID().slice(0, 8)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED.has(file.mimetype)) cb(null, true);
    else cb(new Error('Only PDF or image files are allowed'));
  },
});

// Wrap multer so its errors (file too big, wrong mime, write failure) come back as JSON
// instead of falling through to the global handler and surfacing as opaque 500s.
const uploadMw = (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      // eslint-disable-next-line no-console
      console.error('[attachments] multer error:', err.message);
      const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      return res.status(status).json({ error: err.message || 'Upload failed' });
    }
    next();
  });
};

router.post('/', auth, uploadMw, withTenantDb, (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const rel = `invoices/${req.file.filename}`;
  // eslint-disable-next-line no-console
  console.log('[attachments] saved', rel, `(${req.file.size} bytes, ${req.file.mimetype})`);
  res.status(201).json({
    path: rel,
    url: `/uploads/${rel}`,
    mime: req.file.mimetype,
    size: req.file.size,
    original: req.file.originalname,
  });
});

router.delete('/', auth, (req, res) => {
  const rel = (req.body?.path || req.query?.path || '').toString();
  if (!rel.startsWith('invoices/')) return res.status(400).json({ error: 'Invalid path' });
  const dir = resolveInvoiceDir(req);
  const abs = path.join(dir, '..', rel);
  if (!abs.startsWith(path.dirname(dir))) return res.status(400).json({ error: 'Invalid path' });
  try { if (fs.existsSync(abs)) fs.unlinkSync(abs); } catch { /* ignore */ }
  res.json({ ok: true });
});

module.exports = router;
