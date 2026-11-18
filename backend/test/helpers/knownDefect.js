// D5 — characterization of KNOWN DEFECTS.
//
// A known-defect test asserts what the system does TODAY, even though it is
// wrong, and names the remediation item that will change it. When that item
// is implemented, the test fails on purpose — and is then rewritten to assert
// the corrected behaviour. So every behaviour change in Priority 2 shows up as
// a deliberate, reviewed test change, never a silent side effect.
//
//   knownDefect('F4', 'approved shift can still be reopened', async () => { ... })

const { test } = require('node:test');

function knownDefect(item, description, fn) {
  return test(`[KNOWN DEFECT → ${item}] ${description}`, fn);
}

module.exports = { knownDefect };
