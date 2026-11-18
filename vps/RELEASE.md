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
