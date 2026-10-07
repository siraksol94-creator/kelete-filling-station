const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const { randomUUID } = require('crypto');
const path = require('path');

const dbPath = path.join(__dirname, 'kelete.db');
const db = new Database(dbPath);

const username = 'sirak';
const password = '123';
const hash = bcrypt.hashSync(password, 10);

const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(username);
if (existing) {
  db.prepare('UPDATE users SET password = ?, role = ?, permissions = ?, deleted_at = NULL WHERE email = ?')
    .run(hash, 'Administrator', JSON.stringify(['All Access']), username);
  console.log(`User '${username}' already existed â€” password reset, full access granted.`);
} else {
  db.prepare(
    'INSERT INTO users (first_name, last_name, email, password, phone, role, permissions, sync_id, device_id, synced) VALUES (?,?,?,?,?,?,?,?,?,0)'
  ).run('Sirak', 'Admin', username, hash, '', 'Administrator', JSON.stringify(['All Access']), randomUUID(), 'local-dev');
  console.log(`User '${username}' created with password '${password}'.`);
}
