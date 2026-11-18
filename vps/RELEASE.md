# Releasing Kelete to the VPS (S5)

Releases are manual and tagged. Nothing reaches the live server because
someone pushed to `main`.

## One-time cutover (needs live access — P0 steps first)

1. **Record, then remove, the old auto-deploy cron entry.**
   ```bash
   crontab -l > ~/crontab-before-S5.txt     # keep this copy for rollback
   crontab -e                               # delete the kelete-deploy.sh line
   ```
   If it is in `/etc/cron.d/` instead, copy that file aside and remove the line
   there. The live cron runs `/usr/local/bin/kelete-deploy.sh` — a copy made by
   hand, not the file in this repo — so removing the cron line is what actually
   stops it.
2. **Check the live checkout is clean** before the first release:
   `git -C <APP_DIR> status`. Any local edits must be saved or discarded
   deliberately; the release script refuses to run over them.
3. **Create `/etc/kelete-release.conf`** (root-owned, `chmod 644`; it holds no
   secrets) with the values established in P0-3:
   ```bash
   APP_DIR=/var/www/<live-folder>
   PM2_PROCESS=<name from pm2 list>
   HEALTH_URL=http://127.0.0.1:<port>/api/health
   ```
4. Install the script: `install -m 755 vps/kelete-release.sh /usr/local/bin/kelete-release`.

## First release with the server-side permissions (decided 2026-11-18)

The first live week runs the permission gate in **log-only** mode. It refuses
nothing and records who *would* have been refused:

1. Before the first release, add `KELETE_PERMISSIONS=log` to the app's
   environment. That's the PM2 ecosystem file or the service's environment,
   whichever P0-3 found the app uses. Then restart through the release script.
2. Every day that week, review the lines from that week:
   `pm2 logs <PM2_PROCESS> --lines 5000 | grep "WOULD DENY"`.
   - A line for a real, legitimate task means that user's permissions, or a
     screen, need fixing **before** enforcing.
   - Lines from people reaching data outside their screens are exactly what
     enforcement will stop.
3. After the week, remove the setting (the default is `enforce`), restart, and
   check that the `WOULD DENY` lines become `DENY` and that nobody's daily
   work is blocked.

These checks are separate and always enforced: Administrator-only actions,
the fuel set-up rules, supervisor-only actions, and deliveries for Managers
and Supervisors. The log-only setting covers only the page-level gate. Till
sync tokens have their own switch; see `vps/SYNC-DEVICES.md`.

## Every release

1. The change is reviewed and merged to `main`.
2. Tag it: `git tag v1.14.0 && git push origin v1.14.0`.
3. At a quiet time, on the VPS: `kelete-release deploy v1.14.0`.
   It backs up and integrity-checks every database, switches to the tag,
   restarts, and waits for `/api/health`. If the app is not healthy it puts
   the previous version back by itself.
4. Check the app, then `kelete-release status`.

## Rolling back

`kelete-release rollback` returns to the version that ran before the last
release. Databases are never restored automatically; the pre-release backup
folder for every release is listed by `kelete-release status`.

To restore the old auto-deploy (not recommended): reinstate the saved cron
line from `~/crontab-before-S5.txt`.
