// UX-1 — keyboard shortcut matching. The key rule: single-key shortcuts never
// fire while someone is typing in a field (a "t" in a name box must stay a "t").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchHotkey, pickBinding, isTypingTarget, comboLabel, parseCombo } from '../../src/ux/hotkeys';

const ev = (key, mods = {}, target = { tagName: 'BODY' }) => ({ key, code: mods.code, ctrlKey: !!mods.ctrl, metaKey: !!mods.meta, altKey: !!mods.alt, shiftKey: !!mods.shift, target });
const input = { tagName: 'INPUT', type: 'text' };

test('matching: modifiers must match exactly; "mod" is Ctrl or ⌘', () => {
  assert.equal(matchHotkey(ev('Enter', { ctrl: true }), 'mod+enter'), true);
  assert.equal(matchHotkey(ev('Enter', { meta: true }), 'mod+enter'), true);
  assert.equal(matchHotkey(ev('Enter'), 'mod+enter'), false);
  assert.equal(matchHotkey(ev('Enter', { ctrl: true, shift: true }), 'mod+enter'), false);
  assert.equal(matchHotkey(ev('n', { alt: true }), 'alt+n'), true);
  assert.equal(matchHotkey(ev('n'), 'alt+n'), false);
  assert.equal(matchHotkey(ev('n', { alt: true, ctrl: true }), 'alt+n'), false);
  assert.equal(matchHotkey(ev('˜', { alt: true, code: 'KeyN' }), 'alt+n'), true, 'Mac Alt+N types "˜"');
  assert.equal(matchHotkey(ev('?', { shift: true }), '?'), true);
  assert.equal(matchHotkey(ev('Escape'), 'esc'), true);
  assert.equal(matchHotkey(ev('['), '['), true);
  assert.deepEqual(parseCombo('Mod+Shift+K'), { key: 'k', mod: true, ctrl: false, alt: false, shift: true, meta: false });
});

test('typing: single keys are ignored in fields; Ctrl/Alt combos only where allowed', () => {
  const run = () => {};
  const list = [
    { combo: 't', run },
    { combo: 'mod+enter', run, allowInInputs: true },
    { combo: 'alt+n', run },
    { combo: 'escape', run, allowInInputs: true },
  ];
  assert.equal(pickBinding(ev('t', {}, input), list), null, '"t" typed in a box stays a letter');
  assert.equal(pickBinding(ev('t'), list), list[0]);
  assert.equal(pickBinding(ev('Enter', { ctrl: true }, input), list), list[1]);
  assert.equal(pickBinding(ev('n', { alt: true }, input), list), null, 'not allowed in inputs unless asked');
  assert.equal(pickBinding(ev('Escape', {}, input), list), list[3]);
  assert.equal(pickBinding(ev('t', {}, { tagName: 'INPUT', type: 'checkbox' }), list), list[0], 'a checkbox is not typing');
});

test('disabled bindings never run (role or state hides the action)', () => {
  const list = [{ combo: 'alt+n', run: () => {}, enabled: false }];
  assert.equal(pickBinding(ev('n', { alt: true }), list), null);
});

test('typing targets', () => {
  assert.equal(isTypingTarget({ tagName: 'TEXTAREA' }), true);
  assert.equal(isTypingTarget({ tagName: 'SELECT' }), true);
  assert.equal(isTypingTarget({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isTypingTarget({ tagName: 'BUTTON' }), false);
  assert.equal(isTypingTarget(null), false);
});

test('labels', () => {
  assert.equal(comboLabel('mod+enter', false), 'Ctrl + Enter');
  assert.equal(comboLabel('mod+enter', true), '⌘ + Enter');
  assert.equal(comboLabel('alt+n', false), 'Alt + N');
  assert.equal(comboLabel('escape', false), 'Esc');
});
