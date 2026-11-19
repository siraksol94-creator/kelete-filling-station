// UX-2 — the app-wide activity indicator counts requests that follow a user
// action, and ignores background refreshes on timers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createActivity, installActivity, INTENT_WINDOW_MS } from '../../src/ux/activity';

test('requests right after a user action are counted; timer refreshes later are not', () => {
  let t = 0;
  const a = createActivity(() => t);
  const seen = [];
  a.subscribe((n) => seen.push(n));
  const k1 = a.begin({});                 // app start counts as an action
  assert.equal(k1, true);
  t = INTENT_WINDOW_MS + 500;
  const k2 = a.begin({});                 // a poll long after the last click
  assert.equal(k2, false);
  a.noteIntent();
  const k3 = a.begin({});
  assert.equal(k3, true);
  assert.equal(a.begin({ kSilent: true }), false, 'opt-out');
  a.end(k1); a.end(k2); a.end(k3);
  assert.equal(a.pending(), 0);
  assert.deepEqual(seen, [1, 2, 1, 0]);
  a.end(true);
  assert.equal(a.pending(), 0, 'never negative');
});

test('axios wiring: success and failure both finish the request', async () => {
  const handlers = { req: [], res: [] };
  const fake = { interceptors: { request: { use: (f) => handlers.req.push(f) }, response: { use: (ok, bad) => handlers.res.push([ok, bad]) } } };
  const a = createActivity(() => 0);
  installActivity(fake, a);
  installActivity(fake, a);               // installing twice is harmless
  assert.equal(handlers.req.length, 1);
  const c1 = handlers.req[0]({});
  const c2 = handlers.req[0]({});
  assert.equal(a.pending(), 2);
  handlers.res[0][0]({ config: c1 });
  await handlers.res[0][1]({ config: c2 }).catch(() => {});
  assert.equal(a.pending(), 0);
});
