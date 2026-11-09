// The command window of the mounted chat: a slash command's answer, its line and its time go to a window of their own
// between the chat and the input, which takes half the rows the header and the input leave, scrolls on its own and closes
// on Esc. Her lines and the owner's lines to her stay in the chat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEY, chatEnv, press, shows, until, withChat } from './fixtures/chat-rig.ts';
import type { Rig } from './fixtures/chat-rig.ts';
import type { ChatEnv, Panel } from '../cli/app.ts';

const text = (rig: Rig): string => rig.screen().join('\n');
/** The window's top rule: the one row that starts with a run of box-drawing lines at the left edge. */
const ruleRow = (rig: Rig): number => rig.screen().findIndex((line) => /^─{3}/.test(line));
/** The input box's upper border. */
const inputTop = (rig: Rig): number => rig.screen().findIndex((line) => line.startsWith('╭'));
const rowOf = (rig: Rig, needle: string): number => rig.screen().findIndex((line) => line.includes(needle));

/** An env whose slash commands answer with `answers[line]` through `send`, as the core's command path does. */
function commandEnv(answers: Record<string, string>, over: Partial<ChatEnv> = {}) {
  const lines: Array<string> = [];
  const made = chatEnv({
    mouse: true,
    timeZone: 'UTC',
    send: (line: string): Promise<string> | undefined => {
      lines.push(line);
      return line.startsWith('/') ? Promise.resolve(answers[line] ?? 'no answer') : undefined;
    },
    ...over,
  });
  return { ...made, lines };
}

test("a slash command's answer shows in the command window under the chat and never in the chat", async () => {
  // Bug: the answer of `/status` lands in the transcript among her lines, or the command line goes there as the owner's.
  const { env, entry, lines } = commandEnv({ '/status': 'core-answer-text' });
  await withChat(env, async (rig) => {
    entry({ who: 'her', text: 'her-line' });
    await until(shows(rig, 'her-line'));
    await press(rig, '/status', shows(rig, '> /status'));
    await press(rig, KEY.enter, shows(rig, 'core-answer-text'));
    const rule = ruleRow(rig);
    assert.ok(rule > rowOf(rig, 'her-line'), 'the window stands below the chat');
    assert.ok(rowOf(rig, 'core-answer-text') > rule && rowOf(rig, 'core-answer-text') < inputTop(rig));
    assert.ok(rowOf(rig, '] /status') > rule, 'the command line heads its answer in the window');
    assert.equal(rig.screen().slice(0, rule).join('\n').includes('/status'), false);
    // Closed, the window takes its rows with it: the answer was never a line of the chat.
    await press(rig, KEY.escape, () => !text(rig).includes('core-answer-text'));
    assert.ok(text(rig).includes('her-line'));
    assert.equal(text(rig).includes('/status'), false);
  });
  assert.deepEqual(lines, ['/status']);
});

test('the window opens at half the free rows, the chat keeps the other half, and Esc gives the chat its rows back', async () => {
  // Bug: the window covers the chat, takes a fixed size, or leaves the chat short after it closed.
  const { env, entry } = commandEnv({ '/status': 'answer' });
  const long = Array.from({ length: 30 }, (_none, index) => `line-${index + 1}`).join('\n');
  const chatRows = (rig: Rig): number => rig.screen().filter((line) => /(^|\s)line-\d+$/.test(line.trim())).length;
  await withChat(env, async (rig) => {
    entry({ who: 'her', text: long });
    await until(shows(rig, 'line-14'));
    // 80 by 24: a header of 6 rows, an input of 3 and the status row of 2026-11-08 under it leave 14, all of them the
    // chat's, its fold row included. The status row took one row from the chat, so each count is one less than before.
    assert.equal(chatRows(rig), 13);
    await press(rig, '/status', shows(rig, '> /status'));
    await press(rig, KEY.enter, () => ruleRow(rig) >= 0 && text(rig).includes('answer'));
    assert.equal(ruleRow(rig), 6 + 7, 'the chat keeps 7 rows under the header');
    assert.equal(inputTop(rig) - ruleRow(rig), 7, 'the window takes the other 7');
    assert.equal(chatRows(rig), 6);
    await press(rig, KEY.escape, () => ruleRow(rig) === -1);
    assert.equal(chatRows(rig), 13);
  });
});

test('Esc closes the window first and keeps the draft, and the next Esc clears the input as before', async () => {
  // Bug: Esc with the window open throws the unfinished draft away, or a closed window changes what Esc does to the input.
  const { env, lines } = commandEnv({ '/status': 'answer-here' });
  await withChat(env, async (rig) => {
    await press(rig, '/status', shows(rig, '> /status'));
    await press(rig, KEY.enter, shows(rig, 'answer-here'));
    await press(rig, 'half typed', shows(rig, '> half typed'));
    await press(rig, KEY.escape, () => ruleRow(rig) === -1);
    assert.match(text(rig), /> half typed/);
    await press(rig, KEY.escape, () => !text(rig).includes('half typed'));
    assert.equal(ruleRow(rig), -1);
  });
  assert.deepEqual(lines, ['/status']);
});

test('the next command reopens the window with the earlier results above, each under its line and its time', async () => {
  // Bug: reopening shows only the newest answer, or an answer loses the command and the time that produced it.
  const { env } = commandEnv({ '/status': 'first-answer', '/help': 'second-answer' });
  await withChat(
    env,
    async (rig) => {
      await press(rig, '/status', shows(rig, '> /status'));
      await press(rig, KEY.enter, shows(rig, 'first-answer'));
      await press(rig, KEY.escape, () => ruleRow(rig) === -1);
      await press(rig, '/help', shows(rig, '> /help'));
      await press(rig, KEY.enter, shows(rig, 'second-answer'));
      const order = ['] /status', 'first-answer', '] /help', 'second-answer'].map((needle) => rowOf(rig, needle));
      assert.ok(order.every((row) => row > ruleRow(rig)));
      assert.deepEqual(
        order,
        order.toSorted((a, b) => a - b)
      );
      // `now` is 1000 ms past the epoch, drawn in UTC: each command line opens with its time and its number.
      assert.match(rig.screen()[order[0]] ?? '', /^\[1970-01-01 00:00\] \[#1\] \/status$/);
      assert.match(rig.screen()[order[2]] ?? '', /^\[1970-01-01 00:00\] \[#2\] \/help$/);
      assert.equal(
        rig
          .screen()
          .slice(ruleRow(rig))
          .some((line) => line.trimStart().startsWith('>')),
        false,
        'no row of the window carries a `>` mark'
      );
    },
    { rows: 30 }
  );
  // Changed: each finished command takes one more row for its finish time (owner, 2026-11-09), so both results fit in
  // the window of a taller terminal; at 24 rows the first command line scrolls out of the window's seven rows.
});

test("the window pads its commands' numbers to the widest one, so each command line keeps one column", async () => {
  // Bug: the tenth command's `[#10]` is a cell wider than `[#9]`, and the command lines stop lining up.
  const { env } = commandEnv({ '/status': 'answer' });
  await withChat(
    env,
    async (rig) => {
      for (let count = 1; count <= 10; count += 1) {
        const pattern = new RegExp(`\\[#0?${count}\\] /status$`);
        await press(rig, '/status', shows(rig, '> /status'));
        await press(rig, KEY.enter, () => rig.screen().some((line) => pattern.test(line)));
        await press(rig, KEY.escape, () => ruleRow(rig) === -1);
      }
      await press(rig, '/status', shows(rig, '> /status'));
      await press(rig, KEY.enter, shows(rig, '[#11] /status'));
      const lines = rig.screen().filter((line) => line.endsWith('] /status'));
      assert.ok(lines.includes('[1970-01-01 00:00] [#01] /status'), lines.join('\n'));
      assert.ok(lines.includes('[1970-01-01 00:00] [#11] /status'), lines.join('\n'));
      assert.deepEqual(new Set(lines.map((line) => line.length)), new Set([32]));
    },
    { rows: 120 }
  );
});

/** The rows that hold `prefix` followed by a number, as numbers. */
const numbered = (rig: Rig, prefix: string): Array<number> =>
  rig.screen().flatMap((line) => {
    const found = new RegExp(`(?:^|\\] )${prefix}(\\d+)$`).exec(line.trim());
    return found === null ? [] : [Number(found[1])];
  });

test('the wheel scrolls the window under the pointer and leaves the other where it was', async () => {
  // Bug: the wheel over the command window scrolls the chat, or the wheel over the chat scrolls the window too.
  const answer = Array.from({ length: 40 }, (_none, index) => `ans-${index}`).join('\n');
  const { env, entry } = commandEnv({ '/status': answer });
  await withChat(env, async (rig) => {
    for (let index = 0; index < 40; index += 1) entry({ who: 'her', text: `chat-${index}` });
    await until(shows(rig, 'chat-39'));
    await press(rig, '/status', shows(rig, '> /status'));
    await press(rig, KEY.enter, shows(rig, 'ans-39'));
    const chatBefore = numbered(rig, 'chat-');
    const windowRow = ruleRow(rig) + 3;
    for (let tick = 0; tick < 4; tick += 1) rig.type(`\u001b[<64;2;${windowRow}M`);
    await until(() => !text(rig).includes('ans-39'));
    assert.equal(text(rig).includes('ans-39'), false);
    assert.deepEqual(numbered(rig, 'chat-'), chatBefore);
    const windowBefore = numbered(rig, 'ans-');
    const chatRow = ruleRow(rig) - 2;
    for (let tick = 0; tick < 4; tick += 1) rig.type(`\u001b[<64;2;${chatRow}M`);
    await until(() => !text(rig).includes('chat-39'));
    assert.equal(text(rig).includes('chat-39'), false);
    assert.deepEqual(numbered(rig, 'ans-'), windowBefore);
  });
});

test('a drag over the window copies its text', async () => {
  // Bug: the selection measures against the chat's rows only, so a drag in the window copies a chat row or nothing.
  const { env, entry } = commandEnv({ '/status': 'window alpha beta' });
  await withChat(env, async (rig) => {
    entry({ who: 'her', text: 'chat gamma delta' });
    await press(rig, '/status', shows(rig, '> /status'));
    await press(rig, KEY.enter, shows(rig, 'window alpha beta'));
    const row = rowOf(rig, 'window alpha beta') + 1;
    const column = (rig.screen()[row - 1] ?? '').indexOf('alpha') + 1;
    rig.type(`\u001b[<0;${column};${row}M`);
    rig.type(`\u001b[<32;${column + 9};${row}M`);
    rig.type(`\u001b[<0;${column + 9};${row}m`);
    await until(shows(rig, 'copied 10 chars'));
    const copied = rig.frames().split('\u001b]52;c;').slice(1);
    const last = copied.at(-1) ?? '';
    assert.equal(Buffer.from(last.slice(0, last.indexOf('\u0007')), 'base64').toString('utf8'), 'alpha beta');
    // A key drops the selection, so the Ctrl+C that closes the chat leaves instead of copying again.
    await press(rig, KEY.escape, () => !text(rig).includes('copied'));
  });
});

test('an interactive panel draws inside the window, under the chat and the header, and Esc closes both', async () => {
  // Bug: `/config` draws over the chat and hides the header, or Esc leaves an empty window behind.
  const panel: Panel = {
    title: 'Settings',
    lines: [],
    rows: [{ id: 'a', label: 'first-setting-row', detail: 'a setting', group: 'General', value: 'on' }],
  };
  const { env, entry, lines } = commandEnv(
    {},
    { panelOf: (line: string) => Promise.resolve(line === '/config' ? panel : null) }
  );
  await withChat(env, async (rig) => {
    entry({ who: 'her', text: 'her-line' });
    await until(shows(rig, 'her-line'));
    await press(rig, '/config', shows(rig, '> /config'));
    await press(rig, KEY.enter, shows(rig, 'first-setting-row'));
    const rule = ruleRow(rig);
    assert.ok(rule > rowOf(rig, 'her-line'));
    assert.ok(rowOf(rig, 'first-setting-row') > rule && rowOf(rig, 'first-setting-row') < rig.stdout.rows);
    assert.ok(text(rig).includes('neptunia'), 'the header stays');
    await press(rig, KEY.escape, () => ruleRow(rig) === -1);
    assert.equal(text(rig).includes('first-setting-row'), false);
    assert.ok(text(rig).includes('her-line'));
  });
  assert.deepEqual(lines, []);
});

test('a chat line that reads like a command word goes to her and opens no window', async () => {
  // Bug: the chat asked `panelOf` for every line, so a plain `status` to her opened the status panel and was never sent.
  const status: Panel = { title: 'Status', lines: ['the status panel body'] };
  const { env, lines } = commandEnv({}, { panelOf: () => Promise.resolve(status) });
  await withChat(env, async (rig) => {
    await press(rig, 'status', shows(rig, '> status'));
    await press(rig, KEY.enter, () => lines.length === 1);
    assert.equal(ruleRow(rig), -1);
    assert.equal(text(rig).includes('the status panel body'), false);
  });
  assert.deepEqual(lines, ['status']);
});

// ---- start and finish, and a result that comes while the window is closed (owner, 2026-11-09) ----------------------

/** A command answer the test releases when it wants, with the clock it moves meanwhile. */
function lateAnswer() {
  const clock = { t: 1000 };
  let release: (text: string) => void = () => undefined;
  const answer = new Promise<string>((resolve) => {
    release = resolve;
  });
  const { env, lines } = commandEnv(
    {},
    {
      now: () => clock.t,
      send: (line: string) => {
        lines.push(line);
        return line.startsWith('/') ? answer : undefined;
      },
    }
  );
  return { env, clock, release: (text: string) => release(text) };
}

test('a finished command shows the minute it finished under its answer, and a running one shows none', async () => {
  // Bug: a command that took an hour reads like one that answered at once, since only its start is drawn.
  const { env, clock, release } = lateAnswer();
  await withChat(env, async (rig) => {
    await press(rig, '/status', shows(rig, '> /status'));
    await press(rig, KEY.enter, shows(rig, '] /status'));
    assert.equal(text(rig).includes('finished'), false, 'nothing finished yet');
    clock.t = 1000 + 90_000;
    release('late-answer');
    await until(shows(rig, 'late-answer'));
    await until(shows(rig, 'finished 1970-01-01 00:01'));
    assert.ok(rowOf(rig, 'finished 1970-01-01 00:01') > rowOf(rig, 'late-answer'), 'under the answer');
    assert.match(rig.screen()[rowOf(rig, '] /status')] ?? '', /^\[1970-01-01 00:00\] \[#1\] \/status$/);
  });
});

test('an answer that arrives while the window is closed reopens the window with it', async () => {
  // Bug: a long command's answer lands in a closed window, and the owner never learns that it finished.
  const { env, release } = lateAnswer();
  await withChat(env, async (rig) => {
    await press(rig, '/status', shows(rig, '> /status'));
    await press(rig, KEY.enter, shows(rig, '] /status'));
    await press(rig, KEY.escape, () => ruleRow(rig) === -1);
    release('background-answer');
    await until(() => ruleRow(rig) >= 0 && text(rig).includes('background-answer'));
    assert.ok(rowOf(rig, 'background-answer') > ruleRow(rig));
  });
});

test('closing the window on a panel still loading does not reopen it with the cancel', async () => {
  // Bug: the Cancelled. that closing writes into the loading result counts as a finished command and reopens the window
  // the owner just closed.
  const { env } = commandEnv({}, { panelOf: () => new Promise(() => undefined) });
  await withChat(env, async (rig) => {
    await press(rig, '/status', shows(rig, '> /status'));
    await press(rig, KEY.enter, shows(rig, '] /status'));
    await press(rig, KEY.escape, () => ruleRow(rig) === -1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(ruleRow(rig), -1);
  });
});
