/**
 * chat.js â€” in-app Messages (2026-09-14).
 *
 * Conversations, members and messages live in master.db, so HQ and every depot
 * read the same chat. A person is "<slug>:<username>": the depot slug from the
 * host the request came in on ("hq" for the bare HQ domain â€” X-Branch is
 * ignored, so an HQ user stays an HQ user while viewing a branch) plus the
 * login username from the JWT. User ids are NOT used: every depot database
 * numbers its users on its own.
 *
 * Rules agreed with Red Sea:
 *   - depot staff can start chats with their own depot and HQ; HQ with anyone
 *   - only HQ administrators create groups and change their members
 *   - only members can read a conversation (no admin read-all)
 *   - a sender can delete their own message within 15 minutes
 *   - files: photos, PDF, Excel, Word, CSV, text â€” up to 10 MB each, kept in ONE
 *     shared folder (CHAT_FILES_DIR) and served only through
 *     GET /files/:messageId after a membership check. Never a per-depot
 *     /uploads path, so a file opens the same from HQ or any depot.
 *
 * New messages reach other screens by polling (no websocket in this stack).
 */
const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { randomUUID } = require('crypto');
const { auth } = require('../middleware/auth');
const { masterDb, listTenants } = require('../config/masterDb');
const { getTenantDb } = require('../config/tenantDb');
const { defaultDb } = require('../config/database');

// Hosts that are NOT a depot â€” the same list the tenant middleware skips.
const HQ_HOSTS   = new Set(['', 'www', 'kelete', 'keletedistributionzm', 'localhost', 'api', '127', 'sidanitsolutions']);
const NOT_DEPOTS = new Set(['hq', 'keletedistributionzm']);
const DELETE_WINDOW_MS = 15 * 60 * 1000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_BODY = 4000;
const FILES_DIR = path.resolve(process.env.CHAT_FILES_DIR || path.join(__dirname, '..', '..', 'chat-files'));
const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.heif',
                             '.pdf', '.xls', '.xlsx', '.csv', '.doc', '.docx', '.txt']);
// 2026-09-14 â€” voice notes. Browsers record webm/ogg (Chrome, Firefox, Android)
// or mp4 audio (iPhone). These are only accepted with an audio/* type, so a
// .webm video cannot come in dressed as a voice note.
const AUDIO_EXT = new Set(['.webm', '.ogg', '.oga', '.opus', '.m4a', '.mp3', '.aac', '.wav']);

// â”€â”€ Schema (master.db) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
if (masterDb) {
  try {
    masterDb.exec(`
      CREATE TABLE IF NOT EXISTS chat_conversations (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        kind            TEXT NOT NULL CHECK (kind IN ('direct', 'group')),
        title           TEXT,
        direct_key      TEXT UNIQUE,
        created_by      TEXT NOT NULL,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        last_message_at TEXT
      );
      CREATE TABLE IF NOT EXISTS chat_members (
        conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id),
        person          TEXT NOT NULL,
        name            TEXT,
        slug            TEXT,
        added_at        TEXT NOT NULL DEFAULT (datetime('now')),
        last_read_id    INTEGER NOT NULL DEFAULT 0,
        removed_at      TEXT,
        PRIMARY KEY (conversation_id, person)
      );
      CREATE INDEX IF NOT EXISTS idx_chat_members_person ON chat_members (person);
      CREATE TABLE IF NOT EXISTS chat_messages (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id),
        sender          TEXT NOT NULL,
        sender_name     TEXT,
        sender_slug     TEXT,
        body            TEXT,
        file_path       TEXT,
        file_name       TEXT,
        file_mime       TEXT,
        file_size       INTEGER,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        deleted_at      TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_chat_messages_conv ON chat_messages (conversation_id, id);
    `);
  } catch (e) {
    console.error('[chat] schema:', e.message);
  }
  // 2026-09-14 â€” system groups. 'everyone' = every active user, kept in step
  // with the directory; only HQ administrators post in it (announcements).
  try {
    const cols = masterDb.prepare('PRAGMA table_info(chat_conversations)').all().map(c => c.name);
    if (!cols.includes('system_key')) masterDb.exec('ALTER TABLE chat_conversations ADD COLUMN system_key TEXT');
    masterDb.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_conv_system ON chat_conversations (system_key) WHERE system_key IS NOT NULL');
  } catch (e) {
    console.error('[chat] system groups:', e.message);
  }
}
const EVERYONE = 'everyone';

const parseUtc = (s) => Date.parse(String(s || '').replace(' ', 'T') + 'Z');

// â”€â”€ Who is asking â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function whoAmI(req) {
  const host = String(req.headers['x-tenant'] || req.hostname || '').toLowerCase();
  const first = host.split('.')[0];
  const slug = HQ_HOSTS.has(first) ? 'hq' : first;
  const username = String(req.user?.email || '').trim().toLowerCase();
  return {
    person: `${slug}:${username}`,
    slug,
    username,
    name: req.user?.name || username,
    isHqAdmin: slug === 'hq' && req.user?.role === 'Administrator',
  };
}

// â”€â”€ Directory: every active user at HQ and at each active depot â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let dirCache = { at: 0, list: [], places: {} };

function usersOf(db) {
  try {
    return db.prepare(`SELECT first_name, last_name, email, role FROM users
                        WHERE deleted_at IS NULL AND COALESCE(status, 'Active') = 'Active'
                        ORDER BY first_name, last_name`).all();
  } catch (_) {
    return db.prepare('SELECT first_name, last_name, email, role FROM users ORDER BY first_name, last_name').all();
  }
}

const DIR_TTL_MS = Number(process.env.CHAT_DIR_TTL_MS ?? 60_000);

function directory() {
  if (Date.now() - dirCache.at < DIR_TTL_MS) return dirCache;
  const list = [];
  const places = { hq: 'HQ' };
  const loaded = new Set(); // places whose users were read successfully
  const add = (slug, place, rows) => {
    for (const u of rows) {
      const username = String(u.email || '').trim().toLowerCase();
      if (!username) continue;
      const name = `${u.first_name || ''} ${u.last_name || ''}`.trim() || username;
      list.push({ person: `${slug}:${username}`, name, role: u.role || '', slug, place });
    }
  };
  try { add('hq', 'HQ', usersOf(defaultDb)); loaded.add('hq'); } catch (e) { console.error('[chat] HQ users:', e.message); }
  for (const t of listTenants()) {
    const slug = String(t.slug || '').toLowerCase();
    if (!slug || NOT_DEPOTS.has(slug) || Number(t.is_active ?? 1) === 0) continue;
    const place = t.business_name || slug;
    places[slug] = place;
    try { add(slug, place, usersOf(getTenantDb(slug))); loaded.add(slug); } catch (e) { console.error(`[chat] users of ${slug}:`, e.message); }
  }
  const seen = new Set();
  dirCache = { at: Date.now(), list: list.filter(p => !seen.has(p.person) && seen.add(p.person)), places };
  try { syncEveryone(dirCache.list, loaded); } catch (e) { console.error('[chat] everyone sync:', e.message); }
  return dirCache;
}

// The "Everyone" group: created once, then kept in step with the directory.
// A person who joins starts with everything before them marked read, so a
// new user is not handed a pile of old announcements as unread. People are
// only dropped when their place's users were actually read â€” a depot DB that
// fails to open must not empty its staff out of the group.
function syncEveryone(list, loaded) {
  let conv = masterDb.prepare('SELECT id FROM chat_conversations WHERE system_key = ?').get(EVERYONE);
  if (!conv) {
    const id = masterDb.prepare(
      "INSERT INTO chat_conversations (kind, title, created_by, system_key) VALUES ('group', 'Everyone', 'system', ?)"
    ).run(EVERYONE).lastInsertRowid;
    conv = { id };
  }
  const current = new Map(masterDb.prepare(
    'SELECT person, removed_at FROM chat_members WHERE conversation_id = ?'
  ).all(conv.id).map(r => [r.person, r]));
  const top = masterDb.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM chat_messages WHERE conversation_id = ?').get(conv.id).n;
  const wanted = new Set(list.map(p => p.person));
  masterDb.transaction(() => {
    const insert = masterDb.prepare(
      'INSERT INTO chat_members (conversation_id, person, name, slug, last_read_id) VALUES (?, ?, ?, ?, ?)');
    const revive = masterDb.prepare(
      'UPDATE chat_members SET removed_at = NULL, name = ?, slug = ?, last_read_id = MAX(last_read_id, ?) WHERE conversation_id = ? AND person = ?');
    const drop = masterDb.prepare(
      "UPDATE chat_members SET removed_at = datetime('now') WHERE conversation_id = ? AND person = ? AND removed_at IS NULL");
    for (const p of list) {
      const row = current.get(p.person);
      if (!row) insert.run(conv.id, p.person, p.name, p.slug, top);
      else if (row.removed_at) revive.run(p.name, p.slug, top, conv.id, p.person);
    }
    for (const [person, row] of current) {
      const slug = person.split(':')[0];
      if (!row.removed_at && !wanted.has(person) && loaded.has(slug)) drop.run(conv.id, person);
    }
  })();
}

const findPerson = (person) => directory().list.find(p => p.person === person);
const placeOf = (slug) => directory().places[slug] || slug;
// Depot staff reach their own depot and HQ; HQ reaches everyone.
const canReach = (me, other) => me.slug === 'hq' || other.slug === 'hq' || other.slug === me.slug;

// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function activeMember(convId, person) {
  return masterDb.prepare(
    'SELECT * FROM chat_members WHERE conversation_id = ? AND person = ? AND removed_at IS NULL'
  ).get(convId, person);
}

// Loads the conversation and checks the caller is a current member.
// Answers the request itself and returns null when they are not.
function memberGuard(req, res) {
  const id = parseInt(req.params.id, 10);
  const conv = id ? masterDb.prepare('SELECT * FROM chat_conversations WHERE id = ?').get(id) : null;
  if (!conv) { res.status(404).json({ error: 'Conversation not found.' }); return null; }
  if (!activeMember(conv.id, req.me.person)) {
    res.status(403).json({ error: 'You are not a member of this conversation.' });
    return null;
  }
  return conv;
}

function membersOf(convId) {
  return masterDb.prepare(
    'SELECT person, name, slug FROM chat_members WHERE conversation_id = ? AND removed_at IS NULL ORDER BY name'
  ).all(convId).map(m => ({ ...m, place: placeOf(m.slug) }));
}

function titleFor(conv, me) {
  if (conv.kind === 'group') return { title: conv.title || 'Group', place: null };
  const other = masterDb.prepare(
    'SELECT person, name, slug FROM chat_members WHERE conversation_id = ? AND person <> ? LIMIT 1'
  ).get(conv.id, me.person);
  return { title: other?.name || 'Chat', place: other ? placeOf(other.slug) : null, other: other?.person || null };
}

function shapeMessage(m, me) {
  const deleted = !!m.deleted_at;
  return {
    id: m.id,
    conversation_id: m.conversation_id,
    sender: m.sender,
    sender_name: m.sender_name,
    sender_place: placeOf(m.sender_slug),
    mine: m.sender === me.person,
    body: deleted ? null : m.body,
    file: deleted || !m.file_path ? null : { name: m.file_name, mime: m.file_mime, size: m.file_size },
    created_at: m.created_at,
    deleted,
  };
}

function removeFile(rel) {
  if (!rel) return;
  try {
    const abs = path.resolve(FILES_DIR, rel);
    if (abs.startsWith(FILES_DIR + path.sep) && fs.existsSync(abs)) fs.unlinkSync(abs);
  } catch (_) { /* a stray file is harmless */ }
}

// â”€â”€ Upload â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const month = new Date().toISOString().slice(0, 7);
    const dir = path.join(FILES_DIR, month);
    try { fs.mkdirSync(dir, { recursive: true }); cb(null, dir); } catch (e) { cb(e); }
  },
  filename: (_req, file, cb) => cb(null, `${randomUUID()}${path.extname(file.originalname || '').toLowerCase()}`),
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_BYTES },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (ALLOWED_EXT.has(ext)) cb(null, true);
    else if (AUDIO_EXT.has(ext) && /^audio\//i.test(file.mimetype || '')) cb(null, true);
    else cb(new Error('Only photos, voice notes, PDF, Excel, Word, CSV or text files can be sent.'));
  },
});
const uploadMw = (req, res, next) => upload.single('file')(req, res, (err) => {
  if (!err) return next();
  const tooBig = err.code === 'LIMIT_FILE_SIZE';
  res.status(tooBig ? 413 : 400).json({ error: tooBig ? 'The file is larger than 10 MB.' : (err.message || 'Upload failed.') });
});

// â”€â”€ Routes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.use(auth);
router.use((req, res, next) => {
  if (!masterDb) return res.status(503).json({ error: 'Messages are not available on this server.' });
  try { directory(); } catch (e) { console.error('[chat] directory:', e.message); } // keeps "Everyone" current
  req.me = whoAmI(req);
  if (!req.me.username) return res.status(400).json({ error: 'Your login has no username. Log out and log in again.' });
  next();
});

router.get('/me', (req, res) => {
  const { person, slug, isHqAdmin } = req.me;
  res.json({ person, slug, place: placeOf(slug), name: findPerson(person)?.name || req.me.name, isHqAdmin });
});

// People the caller may start a chat with.
router.get('/people', (req, res) => {
  try {
    const me = req.me;
    res.json(directory().list.filter(p => p.person !== me.person && canReach(me, p)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/conversations', (req, res) => {
  try {
    const me = req.me;
    const rows = masterDb.prepare(`
      SELECT c.*, m.last_read_id,
             (SELECT COUNT(*) FROM chat_members x WHERE x.conversation_id = c.id AND x.removed_at IS NULL) AS member_count,
             (SELECT COUNT(*) FROM chat_messages x
               WHERE x.conversation_id = c.id AND x.id > m.last_read_id
                 AND x.sender <> m.person AND x.deleted_at IS NULL) AS unread
        FROM chat_members m
        JOIN chat_conversations c ON c.id = m.conversation_id
       WHERE m.person = ? AND m.removed_at IS NULL
       ORDER BY COALESCE(c.last_message_at, c.created_at) DESC
    `).all(me.person);
    const lastStmt = masterDb.prepare(
      'SELECT sender, sender_name, body, file_name, file_mime, deleted_at, created_at FROM chat_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1');
    res.json(rows.map(c => {
      const last = lastStmt.get(c.id);
      const t = titleFor(c, me);
      let preview = '';
      if (last) {
        const who = last.sender === me.person ? 'You' : (c.kind === 'group' ? String(last.sender_name || '').split(' ')[0] : '');
        const fileLabel = /^audio\//i.test(last.file_mime || '') ? 'ðŸŽ¤ Voice note' : (last.file_name ? `ðŸ“Ž ${last.file_name}` : '');
        const text = last.deleted_at ? 'Message deleted' : (last.body || fileLabel);
        preview = who ? `${who}: ${text}` : text;
      }
      return {
        id: c.id, kind: c.kind, title: t.title, place: t.place, system: c.system_key || null,
        member_count: c.member_count, unread: c.unread,
        preview, last_at: last?.created_at || c.created_at,
      };
    }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Open (or reuse) a one-to-one chat.
router.post('/conversations/direct', (req, res) => {
  try {
    const me = req.me;
    const target = findPerson(String(req.body?.person || '').trim().toLowerCase());
    if (!target) return res.status(404).json({ error: 'That person was not found.' });
    if (target.person === me.person) return res.status(400).json({ error: 'You cannot start a chat with yourself.' });
    if (!canReach(me, target)) return res.status(403).json({ error: 'You can message people in your own depot and HQ.' });

    const key = [me.person, target.person].sort().join('|');
    let conv = masterDb.prepare('SELECT id FROM chat_conversations WHERE direct_key = ?').get(key);
    if (!conv) {
      const addMember = masterDb.prepare('INSERT INTO chat_members (conversation_id, person, name, slug) VALUES (?, ?, ?, ?)');
      conv = masterDb.transaction(() => {
        const id = masterDb.prepare(
          "INSERT INTO chat_conversations (kind, direct_key, created_by) VALUES ('direct', ?, ?)"
        ).run(key, me.person).lastInsertRowid;
        addMember.run(id, me.person, findPerson(me.person)?.name || me.name, me.slug);
        addMember.run(id, target.person, target.name, target.slug);
        return { id };
      })();
    }
    res.json({ id: Number(conv.id) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// HQ administrators create groups.
router.post('/conversations/group', (req, res) => {
  try {
    const me = req.me;
    if (!me.isHqAdmin) return res.status(403).json({ error: 'Only HQ administrators can create groups.' });
    const title = String(req.body?.title || '').trim();
    if (!title) return res.status(400).json({ error: 'Give the group a name.' });
    if (title.length > 80) return res.status(400).json({ error: 'The group name is too long (80 characters at most).' });
    const wanted = [...new Set((Array.isArray(req.body?.members) ? req.body.members : [])
      .map(p => String(p || '').trim().toLowerCase()).filter(p => p && p !== me.person))];
    const people = wanted.map(findPerson);
    if (people.some(p => !p)) return res.status(400).json({ error: 'One of the chosen people was not found. Refresh and try again.' });
    if (people.length === 0) return res.status(400).json({ error: 'Add at least one member.' });

    const addMember = masterDb.prepare('INSERT INTO chat_members (conversation_id, person, name, slug) VALUES (?, ?, ?, ?)');
    const id = masterDb.transaction(() => {
      const convId = masterDb.prepare(
        "INSERT INTO chat_conversations (kind, title, created_by) VALUES ('group', ?, ?)"
      ).run(title, me.person).lastInsertRowid;
      addMember.run(convId, me.person, findPerson(me.person)?.name || me.name, me.slug);
      for (const p of people) addMember.run(convId, p.person, p.name, p.slug);
      return convId;
    })();
    res.status(201).json({ id: Number(id) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// HQ administrators who are in a group add or remove its members.
router.put('/conversations/:id/members', (req, res) => {
  try {
    const conv = memberGuard(req, res);
    if (!conv) return;
    const me = req.me;
    if (conv.kind !== 'group') return res.status(400).json({ error: 'Members can only be changed on a group.' });
    if (conv.system_key) return res.status(400).json({ error: 'Everyone is kept up to date automatically â€” members cannot be changed.' });
    if (!me.isHqAdmin) return res.status(403).json({ error: 'Only HQ administrators can change group members.' });

    const add = [...new Set((req.body?.add || []).map(p => String(p || '').trim().toLowerCase()))].filter(Boolean);
    const remove = [...new Set((req.body?.remove || []).map(p => String(p || '').trim().toLowerCase()))].filter(Boolean);
    if (remove.includes(me.person)) return res.status(400).json({ error: 'You cannot remove yourself.' });
    const people = add.map(findPerson);
    if (people.some(p => !p)) return res.status(400).json({ error: 'One of the chosen people was not found. Refresh and try again.' });

    masterDb.transaction(() => {
      const upsert = masterDb.prepare(`
        INSERT INTO chat_members (conversation_id, person, name, slug) VALUES (?, ?, ?, ?)
        ON CONFLICT(conversation_id, person) DO UPDATE SET removed_at = NULL, name = excluded.name, slug = excluded.slug`);
      for (const p of people) upsert.run(conv.id, p.person, p.name, p.slug);
      const drop = masterDb.prepare(
        "UPDATE chat_members SET removed_at = datetime('now') WHERE conversation_id = ? AND person = ? AND removed_at IS NULL");
      for (const p of remove) drop.run(conv.id, p);
    })();
    res.json({ members: membersOf(conv.id) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Messages. No `after`: the latest page (plus the conversation and members).
// `after=<id>`: only newer messages â€” what the open screen polls for.
router.get('/conversations/:id/messages', (req, res) => {
  try {
    const conv = memberGuard(req, res);
    if (!conv) return;
    const me = req.me;
    const after = parseInt(req.query.after, 10) || 0;
    const before = parseInt(req.query.before, 10) || 0;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);

    let rows;
    if (after) {
      rows = masterDb.prepare(
        'SELECT * FROM chat_messages WHERE conversation_id = ? AND id > ? ORDER BY id ASC LIMIT 200'
      ).all(conv.id, after);
    } else {
      rows = masterDb.prepare(
        `SELECT * FROM chat_messages WHERE conversation_id = ? ${before ? 'AND id < ?' : ''} ORDER BY id DESC LIMIT ?`
      ).all(...[conv.id, ...(before ? [before] : []), limit]).reverse();
    }
    const out = { messages: rows.map(m => shapeMessage(m, me)), server_now: new Date().toISOString() };
    if (!after) {
      const t = titleFor(conv, me);
      out.conversation = {
        id: conv.id, kind: conv.kind, title: t.title, place: t.place,
        system: conv.system_key || null,
        // System groups manage their own members; only HQ admins post in Everyone.
        can_manage: conv.kind === 'group' && !conv.system_key && me.isHqAdmin,
        can_post: conv.system_key === EVERYONE ? me.isHqAdmin : true,
      };
      out.members = membersOf(conv.id);
      out.has_more = rows.length === limit;
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/conversations/:id/messages', uploadMw, (req, res) => {
  const uploaded = req.file ? path.relative(FILES_DIR, req.file.path).split(path.sep).join('/') : null;
  try {
    const conv = memberGuard(req, res);
    if (!conv) { removeFile(uploaded); return; }
    const me = req.me;
    if (conv.system_key === EVERYONE && !me.isHqAdmin) {
      removeFile(uploaded);
      return res.status(403).json({ error: 'Only HQ administrators can post in Everyone.' });
    }
    const body = String(req.body?.body || '').trim();
    if (body.length > MAX_BODY) { removeFile(uploaded); return res.status(400).json({ error: 'The message is too long (4,000 characters at most).' }); }
    if (!body && !uploaded) return res.status(400).json({ error: 'Write a message or attach a file.' });

    const id = masterDb.transaction(() => {
      const msgId = masterDb.prepare(`
        INSERT INTO chat_messages (conversation_id, sender, sender_name, sender_slug, body, file_path, file_name, file_mime, file_size)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(conv.id, me.person, findPerson(me.person)?.name || me.name, me.slug, body || null,
             uploaded, req.file ? String(req.file.originalname || 'file').slice(0, 200) : null,
             req.file ? req.file.mimetype : null, req.file ? req.file.size : null).lastInsertRowid;
      masterDb.prepare("UPDATE chat_conversations SET last_message_at = datetime('now') WHERE id = ?").run(conv.id);
      masterDb.prepare('UPDATE chat_members SET last_read_id = ? WHERE conversation_id = ? AND person = ?').run(msgId, conv.id, me.person);
      return msgId;
    })();
    const row = masterDb.prepare('SELECT * FROM chat_messages WHERE id = ?').get(id);
    res.status(201).json(shapeMessage(row, me));
  } catch (e) {
    removeFile(uploaded);
    res.status(500).json({ error: e.message });
  }
});

// A sender deletes their own message, within 15 minutes of sending it.
router.delete('/messages/:id', (req, res) => {
  try {
    const me = req.me;
    const m = masterDb.prepare('SELECT * FROM chat_messages WHERE id = ?').get(parseInt(req.params.id, 10) || 0);
    if (!m || !activeMember(m.conversation_id, me.person)) return res.status(404).json({ error: 'Message not found.' });
    if (m.sender !== me.person) return res.status(403).json({ error: 'You can only delete your own messages.' });
    if (m.deleted_at) return res.json({ ok: true });
    if (Date.now() - parseUtc(m.created_at) > DELETE_WINDOW_MS) {
      return res.status(400).json({ error: 'Messages can only be deleted within 15 minutes of sending.' });
    }
    masterDb.prepare(`
      UPDATE chat_messages SET deleted_at = datetime('now'), body = NULL,
             file_path = NULL, file_name = NULL, file_mime = NULL, file_size = NULL
       WHERE id = ?`).run(m.id);
    removeFile(m.file_path);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/conversations/:id/read', (req, res) => {
  try {
    const conv = memberGuard(req, res);
    if (!conv) return;
    const top = masterDb.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM chat_messages WHERE conversation_id = ?').get(conv.id).n;
    const lastId = Math.min(parseInt(req.body?.last_id, 10) || top, top);
    masterDb.prepare(
      'UPDATE chat_members SET last_read_id = MAX(last_read_id, ?) WHERE conversation_id = ? AND person = ?'
    ).run(lastId, conv.id, req.me.person);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// "Kelete Distribution - KABWE" â†’ "Kabwe"; "HQ" stays.
const shortPlace = (name) => (String(name || '') === 'HQ' ? 'HQ' : String(name || '')
  .split(/\s+-\s+/).pop().replace(/\s+Depo$/i, '')
  .toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()));

// Total unread for the badge, bell and tab title â€” plus the newest unread
// message, which the app announces (pop-up, sound, desktop notification).
router.get('/unread', (req, res) => {
  try {
    const where = `m.person = ? AND m.removed_at IS NULL
         AND x.id > m.last_read_id AND x.sender <> m.person AND x.deleted_at IS NULL`;
    const row = masterDb.prepare(`
      SELECT COUNT(*) AS n
        FROM chat_members m
        JOIN chat_messages x ON x.conversation_id = m.conversation_id
       WHERE ${where}
    `).get(req.me.person);
    const last = masterDb.prepare(`
      SELECT x.id, x.conversation_id, x.sender_name, x.sender_slug, x.body, x.file_name, x.file_mime, c.kind, c.title
        FROM chat_members m
        JOIN chat_messages x ON x.conversation_id = m.conversation_id
        JOIN chat_conversations c ON c.id = m.conversation_id
       WHERE ${where}
       ORDER BY x.id DESC LIMIT 1
    `).get(req.me.person);
    const latest = last ? {
      id: last.id,
      conversation_id: last.conversation_id,
      from: last.sender_name,
      place: shortPlace(placeOf(last.sender_slug)),
      group: last.kind === 'group' ? last.title : null,
      preview: last.body
        ? String(last.body).slice(0, 140)
        : (/^audio\//i.test(last.file_mime || '') ? 'ðŸŽ¤ Voice note' : `ðŸ“Ž ${last.file_name || 'File'}`),
    } : null;
    res.json({ total: row.n, latest });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// A message's file, for members of its conversation only.
router.get('/files/:messageId', (req, res) => {
  try {
    const m = masterDb.prepare('SELECT * FROM chat_messages WHERE id = ?').get(parseInt(req.params.messageId, 10) || 0);
    if (!m || m.deleted_at || !m.file_path || !activeMember(m.conversation_id, req.me.person)) {
      return res.status(404).json({ error: 'File not found.' });
    }
    const abs = path.resolve(FILES_DIR, m.file_path);
    if (!abs.startsWith(FILES_DIR + path.sep) || !fs.existsSync(abs)) return res.status(404).json({ error: 'File not found.' });
    res.setHeader('Content-Type', m.file_mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(m.file_name || 'file')}`);
    res.sendFile(abs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
