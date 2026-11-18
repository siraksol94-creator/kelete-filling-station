# ops/backup: checking and restoring Kelete backups (S6)

Kelete takes backups in three ways. All three now use SQLite's online backup,
check each copy, and record the result in `manifest.json` in the backup's folder.

| Where | When | Folder |
|---|---|---|
| VPS | nightly cron, `vps/backup.sh` | `/var/backups/kelete/YYYY-MM-DD/` |
| VPS or till | **Create Backup Now** (Administrators) | `…/YYYY-MM-DD_HHMMSS-manual/` |
| Till | daily, inside the app | `%APPDATA%\Kelete\Backups\YYYY-MM-DD\` |

For each database, `manifest.json` records:

- whether it passed `PRAGMA integrity_check`
- the row count of every table and the total
- the schema version
- the size and SHA-256 of the file
- the number of foreign-key orphans (for information only)

A copy that fails its check is kept as `<name>.FAILED` and never replaces a good
one. The Backups page list now shows `verified` for each backup:
`true`, `false`, or `null` for older backups that have no manifest.

## Check a backup

```bash
node ops/backup/verify.js /var/backups/kelete/2026-11-18
```

This command is read-only. Add `--write-manifest` to record the result. The exit
code is 0 when every file passed and 1 when any file failed.

## Restore one database

**Never copy a backup over a database the app has open.** Use the tool. It
runs in two steps.

```bash
# 1. Dry run: checks the backup and the target, changes nothing.
node ops/backup/restore.js --from /var/backups/kelete/2026-11-18/tenants/buseko.db \
                           --to   /var/www/kelete-pos-tenant/tenants/buseko.db

# 2. Stop the app, then run the same command with --confirm.
node ops/backup/restore.js --from … --to … --confirm
```

With `--confirm`, the tool refuses if any of these is true:

- the backup fails `integrity_check`
- the backup was recorded as FAILED
- the backup no longer matches the SHA-256 in its manifest
- there is an unfinished `.partial` file or a live `-wal` file next to the backup
- something still has the target open (`TARGET_IN_USE`)
- the backup's tables barely match the target's. This usually means the wrong file
  was picked. Override with `--allow-different-database`.

When none of these apply, the tool restores in this order:

1. It keeps an exact copy of the current database, including any `-wal` and
   `-shm` files, in `<target folder>/pre-restore/<time>-<name>/`. Each copy is
   checked against the original by SHA-256. Pre-restore folders are never
   removed by rotation.
2. It copies the backup next to the target, checks it, renames it into place,
   and checks the restored file.
3. It writes `restore-record.json` into the pre-restore folder.

If the current database is too damaged to open, it can still be preserved and
replaced with `--allow-unreadable-target`. The tool still refuses if the
database is in use.

Backups taken before S6 have no manifest. They can still be restored, but only
the integrity check applies to them.

### Not tested on a till yet

The Windows procedure needs a till to try it on: close Kelete, then run the tool
with the files under `%APPDATA%\Kelete`. The tool needs Node and the backend's
`better-sqlite3`. Until that has been tried, restore a till by copying its files
to a technician machine.
