// cli/state.ts and cli/galaxy.ts: the chat's behaviour without a terminal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { galaxyFrame, reducedMotion } from '../cli/galaxy.ts';
import {
  backspace,
  browse,
  emptyInput,
  filterLines,
  foldedText,
  insert,
  menuOf,
  moveCursor,
  statusLine,
  submit,
} from '../cli/state.ts';
import type { StatusBrief } from '../cli/state.ts';

const BRIEF: StatusBrief = {
  core: { state: 'paused', reason: 'memory-down' },
  memory: { path: 'claude', model: 'opus', probe: 'failed', checkedAt: 1000 },
  interfaces: [
    { name: 'discord', enabled: true, connected: false },
    { name: 'telegram', enabled: false, connected: false },
  ],
};

test('a multiline paste with non-Latin text stays whole and backspace removes one whole character', () => {
  // Bug: a pasted newline sends the line early, or backspace cuts an emoji in half.
  const pasted = insert(emptyInput(), 'γεια\nσου 🙂');
  assert.equal(pasted.text, 'γεια\nσου 🙂');
  assert.equal(backspace(pasted).text, 'γεια\nσου ');
  const left = moveCursor(pasted, -1);
  assert.equal(left.cursor, pasted.text.length - 2);
  assert.equal(insert(left, 'x').text, 'γεια\nσου x🙂');
});

test('history comes back newest first, and a secret never enters it', () => {
  // Bug: a typed key lands in the history file, or up and down walk the wrong way.
  let state = insert(emptyInput(['two', 'one']), 'three');
  const sent = submit(state, { secret: false });
  assert.deepEqual(sent.next.history, ['three', 'two', 'one']);
  state = browse(sent.next, -1);
  assert.equal(state.text, 'three');
  state = browse(browse(state, -1), 1);
  assert.equal(state.text, 'three');
  assert.equal(browse(state, 1).text, '');
  const secret = submit(insert(emptyInput(['two']), 'sk-or-secret'), { secret: true });
  assert.equal(secret.line, 'sk-or-secret');
  assert.deepEqual(secret.next.history, ['two']);
});

test('the slash menu lists names first, then a match in the help, and closes on a space', () => {
  // Bug: the menu stays open over an argument, or finds nothing for a word of a command's description.
  const commands = [
    { name: 'status', help: 'the short summary' },
    { name: 'keys', help: 'the model keys' },
    { name: 'skills', help: 'her status of skills' },
  ];
  assert.deepEqual(
    menuOf('/s', commands).map((one) => one.name),
    ['status', 'skills', 'keys']
  );
  assert.deepEqual(menuOf('/status x', commands), []);
  assert.deepEqual(menuOf('hello', commands), []);
});

test('a long answer folds with a count and expands whole', () => {
  // Bug: a long report pushes the whole chat off the screen, or the folded part cannot be reached.
  const text = Array.from({ length: 25 }, (_, i) => `l${i}`).join('\n');
  assert.equal(foldedText(text, false).hidden, 5);
  assert.equal(foldedText(text, true).text, text);
  assert.deepEqual(filterLines(['a key', 'b'], 'KEY'), ['a key']);
});

test('the status line separates link, core and memory, and marks what is lost or stale', () => {
  // Bug: a dropped link or an old poll still reads as healthy, or the reason of a pause is hidden.
  const live = statusLine(BRIEF, { connected: true, polledAt: 1000, now: 2000 });
  assert.equal(live, 'link: up · core: paused (memory-down) · memory: claude opus: failed · discord: down');
  assert.match(statusLine(BRIEF, { connected: true, polledAt: 1000, now: 100_000 }), /· stale$/);
  assert.match(statusLine(BRIEF, { connected: false, polledAt: 1000, now: 2000 }), /^link: lost · core: unknown/);
  assert.match(statusLine(null, { connected: true, polledAt: null, now: 2000 }), /core: unknown/);
  const recovered = { ...BRIEF, core: { state: 'running', reason: null } } as const;
  assert.match(statusLine(recovered, { connected: true, polledAt: 1000, now: 2000 }), /core: running ·/);
});

test('the galaxy turns tick by tick, repeats, and stands still under reduced motion', () => {
  // Bug: frames change size and flicker the input below them, or motion ignores the owner's setting.
  const first = galaxyFrame(0);
  assert.equal(first.length, 5);
  assert.ok(first.every((row) => row.length === 13));
  assert.notDeepEqual(galaxyFrame(1), first);
  assert.deepEqual(galaxyFrame(24), first);
  assert.equal(reducedMotion({ NEPTUNIA_REDUCED_MOTION: '1' }), true);
  assert.equal(reducedMotion({ TERM: 'xterm' }), false);
});
