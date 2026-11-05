// The mounted chat's geometry, measured in the frame it wrote. Fonts belong to the emulator, so nothing here speaks of
// pixels: rows, cells and which text stands where. The test process has no colour, so what shows here is what a terminal
// without colour shows: selection and message kinds have to carry a shape or text of their own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEY, chatEnv, pause, withChat } from './fixtures/chat-rig.ts';
import type { Rig } from './fixtures/chat-rig.ts';

/** Cells of a fixture line: hiragana is the only wide script the fixtures use. */
const cells = (line: string): number => [...line].reduce((sum, glyph) => sum + (/[぀-ゟ]/.test(glyph) ? 2 : 1), 0);

const assertFits = (rig: Rig, columns: number, rows: number): void => {
  const screen = rig.screen();
  assert.ok(screen.length <= rows, `${screen.length} rows in a terminal of ${rows}`);
  for (const line of screen) assert.ok(cells(line) <= columns, `"${line}" is wider than ${columns} cells`);
};

const lineNumbers = (rig: Rig, prefix: string): Array<number> =>
  rig.screen().flatMap((line) => {
    const found = new RegExp(`${prefix}(\\d+)`).exec(line);
    return found === null ? [] : [Number(found[1])];
  });

test('Backspace over a family emoji in the input removes it whole', async () => {
  // Bug: half a joined emoji goes to the core.
  const { env, sent } = chatEnv();
  await withChat(env, async (rig) => {
    rig.type('a👨‍👩‍👧');
    await pause();
    rig.type(KEY.backspace);
    await pause();
    rig.type(KEY.enter);
    await pause();
  });
  assert.deepEqual(sent, ['a']);
});

test('wide glyphs in a narrow terminal stay inside the frame, all of them shown', async () => {
  // Bug: a wide glyph at the last column breaks the border or drops off the row.
  const { env } = chatEnv();
  await withChat(
    env,
    async (rig) => {
      rig.type('あ'.repeat(30));
      await pause();
      assertFits(rig, 14, 24);
      assert.equal(rig.screen().join('').split('あ').length - 1, 30);
    },
    { columns: 14, rows: 24 }
  );
});

test('a near-minimum terminal keeps the input and fits its frame', async () => {
  // Bug: the fixed header and a minimum height push the input off a small terminal.
  const { env } = chatEnv();
  await withChat(
    env,
    async (rig) => {
      rig.type('typed-here');
      await pause();
      assertFits(rig, 20, 6);
      assert.match(rig.screen().join('\n'), /typed-here/);
    },
    { columns: 20, rows: 6 }
  );
});

test('a tall draft stops growing, keeps its last typed row and leaves the newest answer in view', async () => {
  // Bug: forty typed lines push the transcript and the header off the top, and the screen scrolls away.
  const { env, entry } = chatEnv();
  await withChat(env, async (rig) => {
    entry({ who: 'her', text: 'the-newest-answer' });
    await pause();
    for (let line = 0; line < 40; line += 1) rig.type(`draft-${line}${KEY.ctrlJ}`);
    rig.type('draft-last');
    await pause(100);
    assertFits(rig, 80, 24);
    const shown = rig.screen().join('\n');
    assert.match(shown, /draft-last/);
    assert.match(shown, /the-newest-answer/);
    assert.equal(shown.includes('draft-0\n'), false, 'the top of the draft scrolled inside the composer');
  });
});

test('the transcript gives rows back when the composer shrinks, with no stale rows', async () => {
  // Bug: deleting a tall draft leaves its old rows on the screen, and the transcript stays short.
  const { env, entry } = chatEnv();
  await withChat(env, async (rig) => {
    for (let index = 0; index < 60; index += 1) entry({ who: 'her', text: `entry-${index}` });
    await pause(100);
    const full = lineNumbers(rig, 'entry-').length;
    rig.type(`stale-row${KEY.ctrlJ}${KEY.ctrlJ}${KEY.ctrlJ}${KEY.ctrlJ}`);
    await pause();
    assert.ok(lineNumbers(rig, 'entry-').length < full, 'the taller composer took rows from the transcript');
    for (let index = 0; index < 'stale-row'.length + 4; index += 1) rig.type(KEY.backspace);
    await pause();
    assert.equal(lineNumbers(rig, 'entry-').length, full);
    assert.equal(rig.screen().join('\n').includes('stale-row'), false);
    assertFits(rig, 80, 24);
  });
});

test('a long session draws no more rows than fit, and Page Up reaches its first line', async () => {
  // Bug: every entry is rendered on each keystroke, or the early lines fall out of reach.
  const { env, entry } = chatEnv();
  await withChat(env, async (rig) => {
    for (let index = 0; index < 500; index += 1) entry({ who: 'her', text: `entry-${index}` });
    await pause(150);
    assertFits(rig, 80, 24);
    assert.ok(lineNumbers(rig, 'entry-').includes(499));
    assert.equal(lineNumbers(rig, 'entry-').includes(0), false);
    for (let page = 0; page < 80; page += 1) rig.type(KEY.pageUp);
    await pause(150);
    assert.ok(lineNumbers(rig, 'entry-').includes(0));
    for (let page = 0; page < 80; page += 1) rig.type(KEY.pageDown);
    await pause(150);
    assert.ok(lineNumbers(rig, 'entry-').includes(499));
  });
});

test('an answer arriving while the reader is scrolled up leaves the screen where it is', async () => {
  // Bug: a streaming answer pulls the reader to the bottom in the middle of a sentence.
  const { env, entry } = chatEnv();
  await withChat(env, async (rig) => {
    for (let index = 0; index < 100; index += 1) entry({ who: 'her', text: `entry-${index}` });
    await pause(100);
    rig.type(KEY.pageUp);
    await pause();
    const reading = lineNumbers(rig, 'entry-');
    entry({ who: 'her', text: 'entry-100' });
    await pause();
    assert.deepEqual(lineNumbers(rig, 'entry-'), reading);
    rig.type(KEY.pageDown);
    rig.type(KEY.pageDown);
    await pause();
    assert.ok(lineNumbers(rig, 'entry-').includes(100));
  });
});

test('a resize while scrolled up keeps the anchor entry in view and the draft unchanged', async () => {
  // Bug: a narrower window jumps to another part of the conversation, or resets the input.
  const { env, entry, sent } = chatEnv();
  await withChat(env, async (rig) => {
    for (let index = 0; index < 100; index += 1) entry({ who: 'her', text: `entry-${index}` });
    await pause(100);
    rig.type('keep-draft');
    await pause();
    rig.type(KEY.pageUp);
    await pause();
    const anchor = lineNumbers(rig, 'entry-')[0];
    rig.resize(40, 18);
    await pause();
    assert.ok(lineNumbers(rig, 'entry-').includes(Number(anchor)));
    assertFits(rig, 40, 18);
    rig.type(KEY.enter);
    await pause();
  });
  assert.deepEqual(sent, ['keep-draft']);
});

test('a reply, a command result and the owner line differ without colour', async () => {
  // Bug: a command's answer reads as something she said when the dim style is lost.
  const { env, entry } = chatEnv();
  await withChat(env, async (rig) => {
    entry({ who: 'owner', text: 'same-words' });
    entry({ who: 'her', text: 'same-words' });
    entry({ who: 'system', text: 'same-words' });
    await pause();
    const rows = rig.screen().filter((line) => line.includes('same-words'));
    assert.equal(rows.length, 3);
    assert.equal(new Set(rows).size, 3);
  });
});

test('the selected row of a menu has a mark of its own, and the mark moves', async () => {
  // Bug: selection is only inverse video, invisible to a screen reader and in a plain terminal.
  const { env } = chatEnv();
  await withChat(env, async (rig) => {
    rig.type('/');
    await pause();
    const markOf = (name: string): string => {
      const line = rig.screen().find((one) => one.includes(`/${name}`)) ?? '';
      return line.slice(0, line.indexOf('/'));
    };
    assert.notEqual(markOf('status'), markOf('help'));
    const selected = markOf('status');
    rig.type(KEY.down);
    await pause();
    assert.equal(markOf('help'), selected);
  });
});

test('a control character in an answer is shown as text, never sent raw and never dropped unseen', async () => {
  // Bug: a stored message writes the owner's clipboard through OSC 52, or the owner never learns it held one.
  const { env, entry } = chatEnv();
  await withChat(env, async (rig) => {
    entry({ who: 'her', text: 'before\u001b]52;c;QUJD\u0007after' });
    await pause();
    assert.equal(rig.frames().includes('\u001b]52'), false);
    assert.match(rig.screen().join('\n'), /before.+after/);
  });
});

test('the linear mode draws a plain column in reading order, with no borders and no animation', async () => {
  // Bug: a screen reader reads box-drawing characters and the galaxy on every frame.
  const { env, entry } = chatEnv({ linear: true, still: true });
  await withChat(env, async (rig) => {
    entry({ who: 'her', text: 'first-answer' });
    entry({ who: 'her', text: 'second-answer' });
    rig.type('my-draft');
    await pause();
    const shown = rig.screen().join('\n');
    assert.equal(/[╭╮╰╯│─]/.test(shown), false);
    assert.equal(/@/.test(shown), false, 'no galaxy');
    assert.ok(shown.indexOf('first-answer') < shown.indexOf('second-answer'));
    assert.ok(shown.indexOf('second-answer') < shown.indexOf('my-draft'));
  });
});
