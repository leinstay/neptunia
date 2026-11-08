// The mounted chat's geometry, measured in the frame it wrote. Fonts belong to the emulator, so nothing here speaks of
// pixels: rows, cells and which text stands where. The test process has no colour, so what shows here is what a terminal
// without colour shows: selection and message kinds have to carry a shape or text of their own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEY, chatEnv, pause, until, withChat } from './fixtures/chat-rig.ts';
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
    await until(() => rig.screen().join('').includes('👨‍👩‍👧'));
    rig.type(KEY.backspace);
    await until(() => !rig.screen().join('').includes('👨'));
    rig.type(KEY.enter);
    await until(() => sent.length === 1);
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
      await until(() => rig.screen().join('').split('あ').length - 1 === 30);
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
      await until(() => /typed-here/.test(rig.screen().join('\n')));
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
    await until(() => rig.screen().join('\n').includes('the-newest-answer'));
    for (let line = 0; line < 40; line += 1) rig.type(`draft-${line}${KEY.ctrlJ}`);
    rig.type('draft-last');
    await until(() => rig.screen().join('\n').includes('draft-last'));
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
    await until(() => lineNumbers(rig, 'entry-').includes(59));
    const full = lineNumbers(rig, 'entry-').length;
    rig.type(`stale-row${KEY.ctrlJ}${KEY.ctrlJ}${KEY.ctrlJ}${KEY.ctrlJ}`);
    await until(() => lineNumbers(rig, 'entry-').length < full);
    assert.ok(lineNumbers(rig, 'entry-').length < full, 'the taller composer took rows from the transcript');
    for (let index = 0; index < 'stale-row'.length + 4; index += 1) rig.type(KEY.backspace);
    await until(() => lineNumbers(rig, 'entry-').length === full && !rig.screen().join('\n').includes('stale-row'));
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
    await until(() => lineNumbers(rig, 'entry-').includes(499));
    assertFits(rig, 80, 24);
    assert.ok(lineNumbers(rig, 'entry-').includes(499));
    assert.equal(lineNumbers(rig, 'entry-').includes(0), false);
    for (let page = 0; page < 80; page += 1) rig.type(KEY.pageUp);
    await until(() => lineNumbers(rig, 'entry-').includes(0));
    assert.ok(lineNumbers(rig, 'entry-').includes(0));
    for (let page = 0; page < 80; page += 1) rig.type(KEY.pageDown);
    await until(() => lineNumbers(rig, 'entry-').includes(499));
    assert.ok(lineNumbers(rig, 'entry-').includes(499));
  });
});

test('an answer arriving while the reader is scrolled up leaves the screen where it is', async () => {
  // Bug: a streaming answer pulls the reader to the bottom in the middle of a sentence.
  const { env, entry } = chatEnv();
  await withChat(env, async (rig) => {
    for (let index = 0; index < 100; index += 1) entry({ who: 'her', text: `entry-${index}` });
    await until(() => lineNumbers(rig, 'entry-').includes(99));
    rig.type(KEY.pageUp);
    await until(() => !lineNumbers(rig, 'entry-').includes(99));
    const reading = lineNumbers(rig, 'entry-');
    entry({ who: 'her', text: 'entry-100' });
    // Nothing is expected to change here, so there is no condition to poll for: a fixed wait lets a wrong redraw show.
    await pause();
    assert.deepEqual(lineNumbers(rig, 'entry-'), reading);
    rig.type(KEY.pageDown);
    rig.type(KEY.pageDown);
    await until(() => lineNumbers(rig, 'entry-').includes(100));
    assert.ok(lineNumbers(rig, 'entry-').includes(100));
  });
});

test('a resize while scrolled up keeps the anchor entry in view and the draft unchanged', async () => {
  // Bug: a narrower window jumps to another part of the chat, or resets the input.
  const { env, entry, sent } = chatEnv();
  await withChat(env, async (rig) => {
    for (let index = 0; index < 100; index += 1) entry({ who: 'her', text: `entry-${index}` });
    await until(() => lineNumbers(rig, 'entry-').includes(99));
    rig.type('keep-draft');
    await until(() => rig.screen().join('\n').includes('keep-draft'));
    rig.type(KEY.pageUp);
    await until(() => !lineNumbers(rig, 'entry-').includes(99));
    const anchor = lineNumbers(rig, 'entry-')[0];
    rig.resize(40, 18);
    await until(() => rig.screen().length <= 18 && rig.screen().every((line) => cells(line) <= 40));
    assert.ok(lineNumbers(rig, 'entry-').includes(Number(anchor)));
    assertFits(rig, 40, 18);
    rig.type(KEY.enter);
    await until(() => sent.length === 1);
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
    await until(() => rig.screen().filter((line) => line.includes('same-words')).length === 3);
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
    await until(() => rig.screen().some((line) => line.includes('/help')));
    const markOf = (name: string): string => {
      const line = rig.screen().find((one) => one.includes(`/${name}`)) ?? '';
      return line.slice(0, line.indexOf('/'));
    };
    assert.notEqual(markOf('status'), markOf('help'));
    const selected = markOf('status');
    rig.type(KEY.down);
    await until(() => markOf('status') !== selected);
    assert.equal(markOf('help'), selected);
  });
});

test('a control character in an answer is shown as text, never sent raw and never dropped unseen', async () => {
  // Bug: a stored message writes the owner's clipboard through OSC 52, or the owner never learns it held one.
  const { env, entry } = chatEnv();
  await withChat(env, async (rig) => {
    entry({ who: 'her', text: 'before\u001b]52;c;QUJD\u0007after' });
    await until(() => /before.+after/.test(rig.screen().join('\n')));
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
    await until(() => rig.screen().join('\n').includes('my-draft'));
    const shown = rig.screen().join('\n');
    assert.equal(/[╭╮╰╯│─]/.test(shown), false);
    assert.equal(/@/.test(shown), false, 'no galaxy');
    assert.ok(shown.indexOf('first-answer') < shown.indexOf('second-answer'));
    assert.ok(shown.indexOf('second-answer') < shown.indexOf('my-draft'));
  });
});

test('the animated header keeps its height and the title its column when a status line is wider than the terminal', async () => {
  // Bug: a long memory line shrank the galaxy's box, so each frame wrapped differently: the title moved sideways and the
  // header grew past its rows, which pushed the frame over the viewport and left copies of the header in the scrollback.
  const brief = {
    core: {
      state: 'running' as const,
      reason: null,
      model: 'anthropic/claude-opus-4.6',
      route: 'direct-api',
      bound: true,
    },
    memory: {
      session: 'apply',
      model: 'a-model-name-long-enough-to-run-past-the-terminal-width/and-then-some-more-of-it-to-be-sure',
      route: 'claude-harness',
      bound: true,
      probe: 'ok' as const,
      checkedAt: 1,
    },
    analyzer: { model: 'google/flash', route: 'direct-api', bound: true },
    interfaces: [{ name: 'discord', enabled: true, connected: true }],
  };
  const { env } = chatEnv({ title: 'Project Neptunia', still: false, status: () => Promise.resolve(brief) });
  await withChat(
    env,
    async (rig) => {
      // The header of 2026-11-08 has a line for the analyzer and one state word, so the memory line and the interfaces
      // line moved: the row numbers and the word below follow it.
      await until(() => rig.screen().join('\n').includes('Memory: active'));
      const columns = new Set<number>();
      const galaxies = new Set<string>();
      for (let sample = 0; sample < 12; sample += 1) {
        const screen = rig.screen();
        assert.ok(screen.length <= 50, `${screen.length} rows in a terminal of 50`);
        columns.add(screen[0]?.indexOf('Project Neptunia') ?? -1);
        // The interfaces line names the command line first since the owner's word of 2026-11-08.
        assert.match(screen[4] ?? '', /Interfaces: CLI, Discord/, 'the header lines stay on their rows');
        galaxies.add(
          screen
            .slice(0, 5)
            .map((line) => line.slice(0, 15))
            .join('\n')
        );
        await pause(100);
      }
      assert.ok(galaxies.size > 1, 'the galaxy never moved, so this proves nothing');
      assert.deepEqual([...columns], [16]);
    },
    { columns: 80, rows: 50 }
  );
});

test('under the input box stands only the status row, with no strip of key hints', async () => {
  // Bug: a strip of key hints under the input named actions the owner could not place and took a row from the chat.
  // The owner's status row of 2026-11-08 stands under the input, so the box's border is the row above the last, and the
  // last row is blank while nothing is said.
  const { env } = chatEnv();
  await withChat(env, async (rig) => {
    // The frame's trailing blank row is not written, so the border is found by its row and the row under it is empty.
    const border = (): number => rig.screen().findIndex((line) => /^\s*╰─+╯\s*$/.test(line));
    await until(() => border() === rig.stdout.rows - 2);
    assert.equal(border(), rig.stdout.rows - 2);
    assert.equal((rig.screen()[rig.stdout.rows - 1] ?? '').trim(), '');
    assert.equal(/Ctrl\+|commands ·/.test(rig.screen().join('\n')), false);
  });
});
