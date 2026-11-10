// The editor actions on the mounted chat: nothing is sent or stored by a search, and an unfinished draft always comes back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEY, chatEnv, pause, press, shows, until, withChat } from './fixtures/chat-rig.ts';
import type { Rig } from './fixtures/chat-rig.ts';

const text = (rig: Rig): string => rig.screen().join('\n');

test('reverse search, cancelled, restores the exact draft and sends nothing', async () => {
  // Bug: Escape from the search clears what the owner was typing, or the query goes to the core.
  const { env, sent, saved } = chatEnv({ history: ['needle in the history', 'other'] });
  await withChat(env, async (rig) => {
    await press(rig, 'unfinished  draft', shows(rig, '> unfinished  draft'));
    await press(rig, KEY.ctrlR, shows(rig, 'history search:'));
    await press(rig, 'needle', shows(rig, 'needle in the history'));
    assert.match(rig.screen().join('\n'), /needle in the history/);
    await press(
      rig,
      KEY.escape,
      () => /> unfinished {2}draft/.test(text(rig)) && !text(rig).includes('history search')
    );
    assert.match(rig.screen().join('\n'), /> unfinished {2}draft/);
    assert.equal(rig.screen().join('\n').includes('needle in the history'), false);
  });
  assert.deepEqual(sent, []);
  assert.deepEqual(saved, []);
});

test('reverse search, accepted, loads the match into the draft and leaves sending to the next Enter', async () => {
  // Bug: Enter on a match runs an old command straight away.
  const { env, sent } = chatEnv({ history: ['needle in the history', 'other'] });
  await withChat(env, async (rig) => {
    await press(rig, KEY.ctrlR, shows(rig, 'history search:'));
    await press(rig, 'needle', shows(rig, 'needle in the history'));
    await press(
      rig,
      KEY.enter,
      () => /> needle in the history/.test(text(rig)) && !text(rig).includes('history search')
    );
    assert.deepEqual(sent, []);
    assert.match(rig.screen().join('\n'), /> needle in the history/);
    await press(rig, KEY.enter, () => sent.length === 1);
  });
  assert.deepEqual(sent, ['needle in the history']);
});

test('undo and redo step through typed edits of the input', async () => {
  // Bug: Ctrl+Z is ignored, or inserts a control character into the draft.
  const { env, sent } = chatEnv();
  await withChat(env, async (rig) => {
    await press(rig, 'first', shows(rig, '> first'));
    await press(rig, ' second', shows(rig, 'first second'));
    await press(rig, KEY.ctrlZ, () => !text(rig).includes('second'));
    assert.equal(rig.screen().join('\n').includes('second'), false);
    await press(rig, KEY.ctrlY, shows(rig, 'first second'));
    assert.match(rig.screen().join('\n'), /first second/);
    await press(rig, KEY.enter, () => sent.length === 1);
  });
  assert.deepEqual(sent, ['first second']);
});

test('a stashed draft leaves the input and comes back on the second stash key on an empty input', async () => {
  // Bug: the stash loses the draft, or stashing an empty input overwrites the one held.
  const { env, sent } = chatEnv();
  await withChat(env, async (rig) => {
    await press(rig, 'held draft', shows(rig, '> held draft'));
    await press(rig, KEY.ctrlS, () => !text(rig).includes('held draft'));
    assert.equal(rig.screen().join('\n').includes('held draft'), false);
    await press(rig, 'quick', shows(rig, '> quick'));
    await press(rig, KEY.enter, () => sent.length === 1);
    await press(rig, KEY.ctrlS, shows(rig, '> held draft'));
    assert.match(rig.screen().join('\n'), /> held draft/);
    await press(rig, KEY.enter, () => sent.length === 2);
  });
  assert.deepEqual(sent, ['quick', 'held draft']);
});

test('the external editor returns its text into the draft, and a failure leaves the draft', async () => {
  // Bug: the chat sends the edited text at once, or a failing editor costs the draft.
  let outcome: 'edit' | 'fail' = 'edit';
  const asked: Array<string> = [];
  const { env, sent } = chatEnv({
    editDraft: (text) => {
      asked.push(text);
      return Promise.resolve(
        outcome === 'edit' ? { status: 'edited', text: 'from γ editor' } : { status: 'failed', text }
      );
    },
  });
  await withChat(env, async (rig) => {
    await press(rig, 'original', shows(rig, '> original'));
    await press(rig, KEY.ctrlG, shows(rig, '> from γ editor'));
    assert.deepEqual(asked, ['original']);
    assert.deepEqual(sent, []);
    assert.match(rig.screen().join('\n'), /> from γ editor/);
    outcome = 'fail';
    await press(rig, KEY.ctrlG, () => asked.length === 2);
    // A failing editor leaves the screen as it was, so only a fixed wait lets a lost draft show.
    await pause();
    assert.match(rig.screen().join('\n'), /> from γ editor/);
  });
});

test('Ctrl+Z, the stash and the editor do nothing inside a secret question', async () => {
  // Bug: a typed key is copied into the undo stack, the stash or a temporary draft file.
  const asked: Array<string> = [];
  const { env, question } = chatEnv({
    editDraft: (text) => {
      asked.push(text);
      return Promise.resolve({ status: 'edited', text });
    },
  });
  let answered = '';
  await withChat(env, async (rig) => {
    question({ question: 'The key:', secret: true, answer: (given) => (answered = given) });
    await until(shows(rig, 'The key:'));
    await press(rig, 'sk-one', shows(rig, '*'.repeat(6)));
    for (const ignored of [KEY.ctrlZ, KEY.ctrlS, KEY.ctrlG]) {
      rig.type(ignored);
      // An ignored key changes nothing on the screen, so only a fixed wait lets a misplaced edit or stash show.
      await pause();
    }
    await press(rig, '-two', shows(rig, '*'.repeat(10)));
    await press(rig, KEY.enter, () => answered !== '');
  });
  assert.equal(answered, 'sk-one-two');
  assert.deepEqual(asked, []);
});

test('Enter in an open slash menu completes the row, and the composer behind it sends nothing', async () => {
  // Bug: a rebuilt key handler gives one Enter to the menu and to the composer.
  const { env, sent } = chatEnv();
  await withChat(env, async (rig) => {
    await press(rig, '/st', shows(rig, '/status'));
    await press(rig, KEY.enter, shows(rig, /> \/status/));
    assert.deepEqual(sent, []);
    assert.match(rig.screen().join('\n'), /> \/status/);
  });
});

test('a keymap conflict from the settings shows when the chat opens', async () => {
  // Bug: a broken binding silently does nothing.
  const { env } = chatEnv({ bindings: [{ context: 'composer', key: 'enter', action: 'history.search' }] });
  const { env: clean } = chatEnv();
  let plain = '';
  await withChat(clean, (rig) => {
    plain = rig.screen().join('\n');
    return Promise.resolve();
  });
  await withChat(env, async (rig) => {
    await until(shows(rig, /enter/i));
    assert.notEqual(rig.screen().join('\n'), plain);
    assert.match(rig.screen().join('\n'), /enter/i);
  });
});

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

const OSC52 = '\u001b]52;c;';
/** The texts the chat put on the terminal's clipboard, in order. */
const copied = (rig: Rig): Array<string> =>
  rig
    .frames()
    .split(OSC52)
    .slice(1)
    .map((rest) => Buffer.from(rest.slice(0, rest.indexOf('\u0007')), 'base64').toString('utf8'));
/** The one-based cell where `needle` starts on the screen, as a mouse report counts. */
const cellOf = (rig: Rig, needle: string): { row: number; column: number } => {
  const screen = rig.screen();
  const row = screen.findIndex((line) => line.includes(needle));
  assert.ok(row >= 0, `"${needle}" is not on the screen`);
  return { row: row + 1, column: (screen[row] ?? '').indexOf(needle) + 1 };
};
const drag = (rig: Rig, from: { row: number; column: number }, to: { row: number; column: number }): void => {
  rig.type(`\u001b[<0;${from.column};${from.row}M`);
  rig.type(`\u001b[<32;${to.column};${to.row}M`);
  rig.type(`\u001b[<0;${to.column};${to.row}m`);
};

test('dragging over a reply copies the selected text to the clipboard and says how much', async () => {
  // Bug: with mouse tracking on, the terminal's own selection is gone and nothing in the chat could be copied.
  const { env, entry } = chatEnv({ mouse: true });
  await withChat(env, async (rig) => {
    entry({ who: 'her', text: 'alpha beta gamma' });
    await until(shows(rig, 'alpha beta gamma'));
    const start = cellOf(rig, 'alpha');
    drag(rig, start, { row: start.row, column: start.column + 9 });
    await until(shows(rig, 'copied 10 chars to clipboard'));
    assert.deepEqual(copied(rig), ['alpha beta']);
    assert.match(text(rig), /copied 10 chars to clipboard/);
    // A key drops the selection, so the Ctrl+C that closes the chat leaves instead of copying again.
    await press(rig, KEY.escape, () => !text(rig).includes('copied'));
  });
});

test('a selection over two rows copies both, joined by a newline', async () => {
  // Bug: a selection across rows kept only its first or its last row.
  const { env, entry } = chatEnv({ mouse: true });
  await withChat(env, async (rig) => {
    entry({ who: 'her', text: 'upper-row\nlower-row' });
    await until(shows(rig, 'lower-row'));
    const start = cellOf(rig, 'upper-row');
    const end = cellOf(rig, 'lower-row');
    drag(rig, start, { row: end.row, column: end.column + 'lower-row'.length - 1 });
    await until(() => copied(rig).length === 1);
    assert.deepEqual(copied(rig), ['upper-row\nlower-row']);
    await press(rig, KEY.escape, () => !text(rig).includes('copied'));
  });
});

test('a click without a drag copies nothing', async () => {
  // Bug: every click put one character on the clipboard and replaced what the owner had copied elsewhere.
  const { env, entry } = chatEnv({ mouse: true });
  await withChat(env, async (rig) => {
    entry({ who: 'her', text: 'alpha beta gamma' });
    await until(shows(rig, 'alpha beta gamma'));
    const at = cellOf(rig, 'beta');
    rig.type(`\u001b[<0;${at.column};${at.row}M`);
    rig.type(`\u001b[<0;${at.column};${at.row}m`);
    await pause();
    assert.deepEqual(copied(rig), []);
  });
});

test('Ctrl+C with a selection copies it again and keeps the chat open', async () => {
  // Bug: Ctrl+C left the chat while the owner meant to copy what he had selected.
  const { env, entry, sent } = chatEnv({ mouse: true });
  await withChat(env, async (rig) => {
    entry({ who: 'her', text: 'alpha beta gamma' });
    await until(shows(rig, 'alpha beta gamma'));
    const start = cellOf(rig, 'gamma');
    drag(rig, start, { row: start.row, column: start.column + 4 });
    await until(() => copied(rig).length === 1);
    await press(rig, KEY.ctrlC, () => copied(rig).length === 2);
    assert.deepEqual(copied(rig), ['gamma', 'gamma']);
    await press(rig, 'still here', shows(rig, '> still here'));
    await press(rig, KEY.enter, () => sent.length === 1);
  });
  assert.deepEqual(sent, ['still here']);
});

const CTRL_A = '\u0001';

test('Ctrl+A then typing replaces the whole draft', async () => {
  // Bug: Ctrl+A does nothing in the input, so the owner cannot select his draft to retype it.
  const { env, sent } = chatEnv({ mouse: true });
  await withChat(env, async (rig) => {
    await press(rig, 'old draft', shows(rig, '> old draft'));
    // A selection is only a style, and this screen has no colour: a fixed wait lets the key land.
    rig.type(CTRL_A);
    await pause();
    await press(rig, 'new', () => text(rig).includes('> new') && !text(rig).includes('old'));
    await press(rig, KEY.enter, () => sent.length === 1);
  });
  assert.deepEqual(sent, ['new']);
});

test('Ctrl+A then Ctrl+C copies the whole draft and leaves the transcript alone', async () => {
  // Bug: Ctrl+A selects the transcript, or Ctrl+C with the draft selected leaves the chat.
  const { env, entry, sent } = chatEnv({ mouse: true });
  await withChat(env, async (rig) => {
    entry({ who: 'her', text: 'alpha beta gamma' });
    await press(rig, 'my draft', () => text(rig).includes('> my draft') && text(rig).includes('alpha beta gamma'));
    // A selection is only a style, and this screen has no colour: a fixed wait lets the key land.
    rig.type(CTRL_A);
    await pause();
    await press(rig, KEY.ctrlC, () => copied(rig).length === 1);
    assert.deepEqual(copied(rig), ['my draft']);
    await until(shows(rig, 'copied 8 chars to clipboard'));
    assert.match(text(rig), /copied 8 chars to clipboard/);
    await press(rig, KEY.right, () => !text(rig).includes('copied'));
    await press(rig, '!', shows(rig, '> my draft!'));
    await press(rig, KEY.enter, () => sent.length === 1);
  });
  assert.deepEqual(sent, ['my draft!']);
});

test('a drag over the draft selects the characters it covers, and Backspace removes them', async () => {
  // Bug: a drag inside the input only moves the caret, so a part of the draft cannot be selected or removed at once.
  const { env, sent } = chatEnv({ mouse: true });
  await withChat(env, async (rig) => {
    await press(rig, 'alpha beta gamma', shows(rig, '> alpha beta gamma'));
    const start = cellOf(rig, 'beta');
    drag(rig, start, { row: start.row, column: start.column + 3 });
    await pause();
    await press(rig, KEY.backspace, shows(rig, '> alpha  gamma'));
    await press(rig, KEY.enter, () => sent.length === 1);
  });
  assert.deepEqual(sent, ['alpha  gamma']);
});

test('Ctrl+C with a draft selection copies the selected characters and keeps the chat open', async () => {
  // Bug: Ctrl+C over a selection in the input leaves the chat instead of copying.
  const { env, sent } = chatEnv({ mouse: true });
  await withChat(env, async (rig) => {
    await press(rig, 'alpha beta gamma', shows(rig, '> alpha beta gamma'));
    const start = cellOf(rig, 'gamma');
    drag(rig, start, { row: start.row, column: start.column + 4 });
    await pause();
    assert.deepEqual(copied(rig), []);
    await press(rig, KEY.ctrlC, () => copied(rig).length === 1);
    assert.deepEqual(copied(rig), ['gamma']);
    await until(shows(rig, 'copied 5 chars to clipboard'));
    await press(rig, 'X', shows(rig, '> alpha beta X'));
    await press(rig, KEY.enter, () => sent.length === 1);
  });
  assert.deepEqual(sent, ['alpha beta X']);
});

test('a drag that starts in the transcript and ends in the input copies transcript text and leaves the draft whole', async () => {
  // Bug: the input's own selection takes over a drag that began in the transcript and copies the draft instead.
  const { env, entry, sent } = chatEnv({ mouse: true });
  await withChat(env, async (rig) => {
    entry({ who: 'her', text: 'alpha beta gamma' });
    await press(rig, 'draft', () => text(rig).includes('> draft') && text(rig).includes('alpha beta gamma'));
    const start = cellOf(rig, '[#1] alpha');
    // To the last column of the input's row: the selection keeps to the transcript's rows and takes the whole line.
    drag(rig, start, { row: cellOf(rig, '> draft').row, column: 79 });
    await until(() => copied(rig).length === 1);
    assert.deepEqual(copied(rig), ['[#1] alpha beta gamma']);
    // An arrow key drops the selection and leaves the draft, so the Ctrl+C that closes the chat leaves.
    await press(rig, KEY.left, () => !text(rig).includes('copied'));
    await press(rig, KEY.enter, () => sent.length === 1);
  });
  assert.deepEqual(sent, ['draft']);
});
