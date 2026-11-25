// interfaces/cli/mouse.ts: the mouse reports of a terminal, when tracking is on, and a click as a cursor offset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { caretFromCell, mouseAvailable, parseMouse } from '../../../interfaces/cli/mouse.ts';
import { KEY, chatEnv, pause, press, shows, until, withChat } from '../../fixtures/chat-rig.ts';
import type { Rig } from '../../fixtures/chat-rig.ts';

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

const text = (rig: Rig): string => rig.screen().join('\n');

test('a mouse report on a terminal without mouse support never enters the draft', async () => {
  // Bug: a stray wheel report appends `[<64;2;3M` to the message.
  const { env, sent } = chatEnv({ mouse: false });
  await withChat(env, async (rig) => {
    await press(rig, 'clean', shows(rig, '> clean'));
    for (const report of ['\u001b[<64;2;3M', '\u001b[<0;5;7M', '\u001b[<0;5;7m']) {
      rig.type(report);
      // A swallowed report changes nothing on the screen, so only a fixed wait lets a leaked one show.
      await pause();
    }
    await press(rig, KEY.enter, () => sent.length === 1);
  });
  assert.deepEqual(sent, ['clean']);
});

test('a wheel report scrolls the transcript when the mouse is on, and leaves the draft', async () => {
  // Bug: scrolling with the wheel submits or edits the message.
  const { env, sent, entry } = chatEnv({ mouse: true });
  await withChat(env, async (rig) => {
    for (let index = 0; index < 100; index += 1) entry({ who: 'her', text: `entry-${index}` });
    await press(rig, 'draft', () => text(rig).includes('entry-99') && text(rig).includes('> draft'));
    assert.ok(rig.screen().join('\n').includes('entry-99'));
    for (let tick = 0; tick < 10; tick += 1) rig.type('\u001b[<64;2;3M');
    await until(() => !text(rig).includes('entry-99'));
    assert.equal(rig.screen().join('\n').includes('entry-99'), false);
    await press(rig, KEY.enter, () => sent.length === 1);
  });
  assert.deepEqual(sent, ['draft']);
});
