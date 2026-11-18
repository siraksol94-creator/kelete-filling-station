# Till sync tokens (S1 stages 2 and 3)

Each till now holds its own sync token. The VPS keeps only a hash of it, in the
`sync_device_tokens` table of the database the till syncs with. A token works
only for its own account and branch, and can be revoked on its own.

## Stage 2 (the default, `KELETE_SYNC_AUTH` unset or `accept`)

Nothing stops working.

- A new till gets its token when it registers or joins a branch. Both steps
  check the licence key.
- A till installed earlier asks for its token on its next sync.
- A till without a token is still served, and the VPS logs
  `[deviceAuth] sync WITHOUT a device token`.
- A revoked token is refused.

## Before switching to stage 3

1. Leave stage 2 running until every till has synced at least once with the
   new version.
2. As an Administrator, open `GET /api/system/sync-devices`. Check that every
   real till appears with a recent `last_seen_at`.
3. Revoke anything you don't recognise with
   `POST /api/system/sync-devices/<id>/revoke`.
4. Check the server log: no recent `sync WITHOUT a device token` lines.

## Stage 3 (`KELETE_SYNC_AUTH=require` in the VPS service environment)

- **Push, pull and the master endpoints** need a valid token. Without one, no
  data is served, so password hashes can no longer be pulled anonymously.
- **Automatic enrolment closes.** A till that loses its token, or a new PC,
  links through Setup → Join existing branch with the licence key.
- **To undo:** remove the setting and restart the service. This returns to
  stage 2.

## Notes

- **LAN Mother and children:** children talk to the Mother, which checks the
  LAN sync key. Only the Mother needs a token for the VPS.
- **VPS database restored:** if a restore drops the tokens, then in stage 2
  each till is told its token is unknown and links itself again. In stage 3
  the tills must re-join, so restore in stage 2 or re-join the tills.
