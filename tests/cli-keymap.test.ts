// interfaces/cli/keymap.ts: one action registry for dispatch and help, resolved against the focus context first, and interfaces/cli/mouse.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildKeymap } from '../interfaces/cli/keymap.ts';
import type { FocusContext } from '../interfaces/cli/keymap.ts';
import { caretFromCell, mouseAvailable, parseMouse } from '../interfaces/cli/mouse.ts';

const CONTEXTS: ReadonlyArray<FocusContext> = ['composer', 'menu', 'secret', 'attachment', 'panel', 'search'];

test('Enter, Escape and the paste channel resolve to one action in every focus context', () => {
  // Bug: a hidden composer and an open menu both take the same Enter.
  const keymap = buildKeymap();
  for (const context of CONTEXTS) {
    assert.ok(keymap.resolve(context, 'enter'), `enter in ${context}`);
    assert.ok(keymap.resolve(context, 'escape'), `escape in ${context}`);
    assert.ok(keymap.resolve(context, 'paste'), `paste in ${context}`);
  }
  assert.equal(new Set(CONTEXTS.map((context) => keymap.resolve(context, 'enter'))).size > 1, true);
  assert.deepEqual(keymap.conflicts, []);
});

test('a secret dialog binds no history, stash, undo, external editor or attachment action', () => {
  // Bug: Ctrl+Z, Ctrl+S or the editor copies a typed key into a store that outlives the dialog.
  const keymap = buildKeymap();
  for (const key of ['ctrl+r', 'ctrl+s', 'ctrl+z', 'ctrl+y', 'ctrl+g', 'ctrl+v', 'up', 'down'])
    assert.equal(keymap.resolve('secret', key), null, key);
  assert.ok(keymap.resolve('composer', 'ctrl+z'));
});

test('an override rebinds a key, and the action moves in help and in dispatch alike', () => {
  // Bug: help lists the old key while dispatch follows the new one.
  const keymap = buildKeymap([{ context: 'composer', key: 'ctrl+t', action: 'history.search' }]);
  assert.equal(keymap.resolve('composer', 'ctrl+t'), 'history.search');
  const row = keymap.help('composer').filter((one) => one.action === 'history.search');
  assert.ok(row.some((one) => one.key === 'ctrl+t'));
});

test('every help row of every context resolves back to its own action', () => {
  // Bug: help and dispatch are two tables that drift apart.
  const keymap = buildKeymap();
  for (const context of CONTEXTS)
    for (const row of keymap.help(context)) assert.equal(keymap.resolve(context, row.key), row.action);
});

test('two bindings for one key in one context are reported, and the default stays in force', () => {
  // Bug: the last override silently wins, and Enter stops submitting with no word why.
  const keymap = buildKeymap([{ context: 'composer', key: 'enter', action: 'history.search' }]);
  assert.equal(keymap.conflicts.length, 1);
  assert.equal(keymap.conflicts[0]?.context, 'composer');
  assert.equal(keymap.conflicts[0]?.key, 'enter');
  assert.equal(keymap.resolve('composer', 'enter'), buildKeymap().resolve('composer', 'enter'));
});

test('an override naming an unknown action, or one not allowed in the context, is reported and not bound', () => {
  // Bug: a configuration can bind the external editor inside the secret dialog.
  const keymap = buildKeymap([
    { context: 'composer', key: 'ctrl+t', action: 'no.such.action' },
    { context: 'secret', key: 'ctrl+t', action: 'editor.external' },
  ]);
  assert.equal(keymap.resolve('composer', 'ctrl+t'), null);
  assert.equal(keymap.resolve('secret', 'ctrl+t'), null);
  assert.equal(keymap.conflicts.length, 2);
});

test('an SGR mouse report parses to its button and one-based cell, and other input is no report', () => {
  // Bug: a wheel report lands in the draft as text, or a typed `[<` is eaten.
  assert.deepEqual(parseMouse('\u001b[<0;5;7M'), { kind: 'press', button: 0, column: 5, row: 7 });
  assert.deepEqual(parseMouse('\u001b[<0;5;7m'), { kind: 'release', button: 0, column: 5, row: 7 });
  assert.deepEqual(parseMouse('\u001b[<64;2;3M'), { kind: 'wheel-up', button: 64, column: 2, row: 3 });
  assert.deepEqual(parseMouse('\u001b[<65;2;3M'), { kind: 'wheel-down', button: 65, column: 2, row: 3 });
  assert.equal(parseMouse('[<0;5;7M'), null);
  assert.equal(parseMouse('\u001b[<0;5M'), null);
  assert.equal(parseMouse(''), null);
});

test('a motion report with the left button held parses as a drag of that button', () => {
  // Bug: a drag read as a new press, so a selection restarted on every cell the mouse crossed.
  assert.deepEqual(parseMouse('\u001b[<32;6;7M'), { kind: 'drag', button: 0, column: 6, row: 7 });
});

test('mouse tracking is on only for a capable terminal outside the plain and linear modes', () => {
  // Bug: tracking on a dumb terminal or over a screen reader takes away native selection.
  const capable = { tty: true, term: 'xterm-256color', linear: false, plain: false };
  assert.equal(mouseAvailable(capable), true);
  assert.equal(mouseAvailable({ ...capable, tty: false }), false);
  assert.equal(mouseAvailable({ ...capable, term: 'dumb' }), false);
  assert.equal(mouseAvailable({ ...capable, linear: true }), false);
  assert.equal(mouseAvailable({ ...capable, plain: true }), false);
});

test('a click maps to a cursor offset on a grapheme boundary, past-the-end clamped', () => {
  // Bug: a click on the right half of a wide glyph puts the cursor inside it.
  assert.equal(caretFromCell('あいう', { row: 0, col: 2 }, 80), 'あ'.length);
  assert.equal(caretFromCell('あいう', { row: 0, col: 3 }, 80), 'あ'.length);
  assert.equal(caretFromCell('ab\ncd', { row: 1, col: 1 }, 80), 4);
  assert.equal(caretFromCell('ab', { row: 5, col: 9 }, 80), 2);
  assert.equal(caretFromCell('abcd', { row: 1, col: 0 }, 2), 2);
  assert.equal(caretFromCell('', { row: 0, col: 0 }, 80), 0);
});
