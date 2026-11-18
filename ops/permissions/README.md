# ops/permissions: the server-side permission matrix (S7)

`backend/middleware/permissions.js` lets a logged-in user who is not an
Administrator, and does not hold the `All` or `Full Access` permission, make
only the API calls of the screens they can open. It reads
`backend/config/permissionMatrix.json`, a list of every API call the screens
make and which screens make it.

That file is **generated, not hand-written**:

```bash
node ops/permissions/build-matrix.js          # after changing screens or services/*.js
node ops/permissions/build-matrix.js --check  # what the test suite runs
```

The script reads `frontend/src`:

- each `<Route>` in `App.js` and its `PermRoute` gate
- every component, helper and API wrapper each screen imports, directly or
  through `import('…')`
- the `LEGACY_MAP` of one-word permissions in `context/AuthContext.js`

## Rules

| Request | Result |
|---|---|
| No login, or an invalid token | passed to the route, which decides (normally a 401) |
| `/api/auth`, `/api/sync`, `/api/updates`, `/api/tenant-admin`, `/api/health` | not checked here, because they have their own authentication |
| Administrator, or `All` / `Full Access` | allowed |
| Account inactive or deleted, even with an unexpired token | 403 |
| A call made by a screen open to every logged-in user (menu bar, Messages, the Fuel Station screens) | allowed |
| A call made by a screen with a `PermRoute` | allowed if the user holds one of that screen's permissions, by the same rules as the screens, legacy one-word permissions included |
| A call that no screen makes | administrators only |

A refusal returns `403 { code: 'PERMISSION_DENIED' }` and is written to the
audit log as `permission.denied`.

Add, Edit and Delete within a screen are still checked by the screens, as
before, except where a route checks them itself: S2 users, S7 backups, shift
reopen and meter edits, and F4.

## Rolling out

`KELETE_PERMISSIONS` can be set to `enforce` (the default), `log` or `off`.

- `log` never blocks. It writes `[permissions] WOULD DENY …` lines to the
  server log instead.
- Suggested rollout: run one live week with `log`, review those lines, then
  switch to `enforce`.
