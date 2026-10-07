-- Create or reset a branch login, directly in a branch database.
-- 2026-09-01
--
--   username : sirak
--   password : sirak123
--
-- RUN AGAINST THE BRANCH DATABASE:
--   cd /var/www/kelete-pos-tenant
--   cp tenants/mandevu.db tenants/mandevu.db.bak-$(date +%F-user)
--   sqlite3 tenants/mandevu.db < backend/scripts/create_branch_user.sql
--
-- Change the two literals in _u below for a different person or password. The
-- password CANNOT be typed in plain text â€” routes/auth.js line 29 does
-- bcrypt.compare(password, user.password), so the column must hold a bcrypt
-- hash. The one below is a real cost-10 hash of "sirak123", generated with the
-- same bcrypt module the server uses and verified to compare true. Putting the
-- plain word there instead produces a row that exists but can never log in.
--
-- TWO THINGS CAUSE "Invalid credentials" ON A BRANCH SUBDOMAIN, and this
-- script handles both:
--
--   1. The form field is labelled USERNAME but auth.js reads req.body.email
--      and queries WHERE email = ?. So the username IS the email column. It
--      does not have to look like an address.
--
--   2. The query is WHERE email = ? AND tenant_id = ?, where tenant_id comes
--      from sync_config key 'tenant:<slug>'. A user row with tenant_id NULL
--      is invisible to login on the branch subdomain even though the password
--      is right â€” the exact failure noted in routes/auth.js v1.13.3. So the
--      tenant_id is READ FROM THIS DATABASE rather than typed in.
--
-- role='Administrator' grants every page: middleware/auth.js line 52 returns
-- early for that role before any per-page permission is consulted. Change it
-- to a narrower role if this person should not see everything.
--
-- Re-running updates the existing row rather than creating a second one.

CREATE TEMP TABLE _u (email TEXT, first TEXT, last TEXT, pw_hash TEXT, role TEXT);
INSERT INTO _u VALUES (
  'sirak',
  'Sirak', 'Solomon',
  '$2b$10$66mtchF2nBgDmDRAp2OJT.mXZJfLzOzvjG1pmiXhg6CM/9wJqzPwq',   -- sirak123
  'Administrator'
);

-- The tenant this database belongs to. sync_config holds one 'tenant:<slug>'
-- row; falling back to an existing user's tenant_id covers a branch where that
-- key is absent.
CREATE TEMP TABLE _t AS
  SELECT value AS tenant_id FROM sync_config
   WHERE key LIKE 'tenant:%' AND value IS NOT NULL AND value != '' LIMIT 1;
INSERT INTO _t
  SELECT tenant_id FROM users
   WHERE tenant_id IS NOT NULL AND tenant_id != '' AND deleted_at IS NULL LIMIT 1;
INSERT INTO _t
  SELECT tenant_id FROM products
   WHERE tenant_id IS NOT NULL AND tenant_id != '' AND deleted_at IS NULL LIMIT 1;

SELECT '--- tenant this database belongs to (must NOT be blank) ---';
SELECT COALESCE((SELECT tenant_id FROM _t LIMIT 1), '*** NONE FOUND â€” STOP ***') AS tenant_id;

SELECT '--- users already here ---';
SELECT id, email, first_name, last_name, role, tenant_id,
       CASE WHEN deleted_at IS NULL THEN 'live' ELSE 'deleted' END AS state
  FROM users ORDER BY id;

-- Update the row if that email already exists, so a re-run resets the password
-- instead of colliding on the UNIQUE email index.
UPDATE users
   SET password   = (SELECT pw_hash FROM _u),
       first_name = (SELECT first FROM _u),
       last_name  = (SELECT last  FROM _u),
       role       = (SELECT role  FROM _u),
       permissions = '["All"]',
       status     = 'Active',
       deleted_at = NULL,
       tenant_id  = (SELECT tenant_id FROM _t LIMIT 1),
       updated_at = datetime('now'),
       synced     = 0
 WHERE email = (SELECT email FROM _u);

INSERT INTO users (first_name, last_name, email, password, phone, role, permissions,
                   status, sync_id, tenant_id, device_id, synced, created_at, updated_at)
SELECT u.first, u.last, u.email, u.pw_hash, '', u.role, '["All"]', 'Active',
       lower(substr(hex(randomblob(4)),1,8) || '-' || substr(hex(randomblob(2)),1,4) || '-4' ||
             substr(hex(randomblob(2)),2,3) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) ||
             substr(hex(randomblob(2)),2,3) || '-' || substr(hex(randomblob(6)),1,12)),
       (SELECT tenant_id FROM _t LIMIT 1),
       (SELECT device_id FROM users WHERE device_id IS NOT NULL LIMIT 1),
       0, datetime('now'), datetime('now')
  FROM _u u
 WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = u.email);

SELECT '--- RESULT: this row must show a tenant_id and role Administrator ---';
SELECT id, email, first_name, last_name, role, status, tenant_id,
       CASE WHEN password LIKE '$2%' THEN 'bcrypt hash ok' ELSE '*** NOT HASHED ***' END AS password_state
  FROM users WHERE email = (SELECT email FROM _u);

SELECT '--- does its tenant_id match this database? (must be 1) ---';
SELECT COUNT(*) AS will_login
  FROM users
 WHERE email = (SELECT email FROM _u)
   AND deleted_at IS NULL
   AND tenant_id = (SELECT tenant_id FROM _t LIMIT 1);

DROP TABLE _u;
DROP TABLE _t;
