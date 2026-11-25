// The mounted chat's fixed rows around the input: the status row under it that holds every short notice, the slash menu's
// rule and blank row above it, and the header's line of interfaces. Measured in the frame the chat wrote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEY, chatEnv, press, shows, until, withChat, pause, bracketed } from '../../fixtures/chat-rig.ts';
import type { Rig } from '../../fixtures/chat-rig.ts';
import type { ClientTurnEvent } from '../../../interfaces/cli/turn-state.ts';
import type { StatusBrief } from '../../../interfaces/cli/state.ts';

const AT = 1000;
const ROWS = 24;

/** The zero-based screen row of the input box's lower border. */
const lowerBorder = (rig: Rig): number => rig.screen().findLastIndex((line) => /^\s*╰─+╯\s*$/.test(line));
/** The zero-based screen row of the input box's upper border. */
const upperBorder = (rig: Rig): number => rig.screen().findLastIndex((line) => /^\s*╭─+╮\s*$/.test(line));
/** Everything drawn above the input box. */
const aboveInput = (rig: Rig): string => rig.screen().slice(0, upperBorder(rig)).join('\n');

test('the status row under the input is always there, blank when nothing is said, and the input never moves', async () => {
  // Bug: a notice or the persona's running turn takes a row above the input, so the input and the transcript jump by one row each
  // time a notice comes or goes.
  const chat = chatEnv();
  const event = (one: ClientTurnEvent): void => chat.listeners.turn?.(one);
  await withChat(chat.env, async (rig) => {
    await until(() => lowerBorder(rig) >= 0);
    assert.equal(lowerBorder(rig), ROWS - 2, 'one row stands under the input');
    assert.equal((rig.screen()[ROWS - 1] ?? '').trim(), '', 'the status row is blank with nothing to say');
    await press(rig, KEY.ctrlV, shows(rig, 'Images are not available'));
    assert.equal(lowerBorder(rig), ROWS - 2, 'a notice leaves the input where it was');
    assert.match(rig.screen()[ROWS - 1] ?? '', /Images are not available/);
    assert.ok(!aboveInput(rig).includes('Images are not available'), 'no notice above the input');
    await press(rig, 'x', () => !rig.screen().join('\n').includes('Images are not available'));
    event({ type: 'accepted', turnId: 't1', seq: 1, at: AT });
    event({ type: 'running', turnId: 't1', seq: 2, at: AT, streaming: false });
    await until(shows(rig, 'Thinking…'));
    assert.equal(lowerBorder(rig), ROWS - 2, 'the running turn leaves the input where it was');
    assert.match(rig.screen()[ROWS - 1] ?? '', /Thinking…/);
  });
});

test("the calls of the persona's running turn show on the status row and not above the input", async () => {
  // Bug: `using <tool>` takes a row between the transcript and the input and pushes the chat up while the persona works.
  const chat = chatEnv();
  const event = (one: ClientTurnEvent): void => chat.listeners.turn?.(one);
  await withChat(chat.env, async (rig) => {
    event({ type: 'accepted', turnId: 't1', seq: 1, at: AT });
    event({ type: 'running', turnId: 't1', seq: 2, at: AT, streaming: false });
    event({
      type: 'progress',
      turnId: 't1',
      seq: 3,
      at: AT,
      kind: 'tool',
      name: 'conversation.read',
      detail: 'started',
    });
    await until(shows(rig, 'Using conversation.read'));
    assert.match(rig.screen().at(-1) ?? '', /Using conversation\.read/);
    assert.ok(!aboveInput(rig).includes('using'), 'nothing of the turn above the input');
  });
});

const OSC52 = '\u001b]52;c;';

test('the copy notice of a mouse selection shows on the status row and not above the input', async () => {
  // Bug: `copied N chars to clipboard` takes a row above the input, so the selected rows jump as the copy lands.
  const { env, entry } = chatEnv({ mouse: true });
  await withChat(env, async (rig) => {
    entry({ who: 'her', text: 'alpha beta gamma' });
    await until(shows(rig, 'alpha beta gamma'));
    const screen = rig.screen();
    const row = screen.findIndex((line) => line.includes('alpha'));
    const column = (screen[row] ?? '').indexOf('alpha') + 1;
    rig.type(`\u001b[<0;${column};${row + 1}M`);
    rig.type(`\u001b[<32;${column + 9};${row + 1}M`);
    rig.type(`\u001b[<0;${column + 9};${row + 1}m`);
    await until(shows(rig, 'copied 10 chars to clipboard'));
    const copiedScreen = rig.screen();
    const above = aboveInput(rig);
    const border = lowerBorder(rig);
    // A key drops the selection first, so a failed assertion still lets Ctrl+C close the chat instead of copying again.
    await press(rig, KEY.escape, () => !rig.screen().join('\n').includes('copied'));
    assert.ok(rig.frames().includes(OSC52), 'the copy reached the terminal');
    assert.match(copiedScreen.at(-1) ?? '', /copied 10 chars to clipboard/);
    assert.ok(!above.includes('copied'), 'no notice above the input');
    assert.equal(border, ROWS - 2);
  });
});

test('the slash menu stands under a rule with a blank row between it and the last chat line', async () => {
  // Bug: the menu opens right under the newest message, so its first command reads as part of the persona's line.
  const { env, entry } = chatEnv();
  await withChat(env, async (rig) => {
    entry({ who: 'her', text: 'the newest line of hers' });
    await until(shows(rig, 'the newest line of hers'));
    await press(rig, '/', shows(rig, '/status'));
    const screen = rig.screen();
    const rule = screen.findIndex((line) => /^─{20,}$/.test(line.trim()));
    assert.ok(rule > 1, `a rule above the menu:\n${screen.join('\n')}`);
    assert.match(screen[rule + 1] ?? '', /\/status/, 'the menu starts under the rule');
    assert.equal((screen[rule - 1] ?? '').trim(), '', 'one blank row above the rule');
    assert.match(screen[rule - 2] ?? '', /the newest line of hers/, 'then the last chat line');
  });
});

const brief = (interfaces: StatusBrief['interfaces']): StatusBrief => ({
  core: { state: 'running', reason: null, model: 'a/model', route: 'direct-api', bound: true },
  memory: { session: 'apply', probe: 'ok', checkedAt: 1, model: 'a/model', route: 'direct-api', bound: true },
  analyzer: { model: 'a/model', route: 'direct-api', bound: true },
  interfaces,
});

const interfacesRow = (rig: Rig): string =>
  (rig.screen().find((line) => line.includes('Interfaces:')) ?? '').replace(/^.*Interfaces:/, 'Interfaces:').trim();

test('the header lists the command line and the interfaces that work, by name alone', async () => {
  // Bug: a disconnected or disabled interface shows with a state word, and the command line the owner types in is missing.
  const working = brief([
    { name: 'discord', enabled: true, connected: true },
    { name: 'telegram', enabled: true, connected: false },
    { name: 'slack', enabled: false, connected: false },
  ]);
  const { env } = chatEnv({ title: 'Project Neptunia', status: () => Promise.resolve(working) });
  await withChat(env, async (rig) => {
    await until(shows(rig, 'Interfaces: CLI'));
    assert.equal(interfacesRow(rig), 'Interfaces: CLI, Discord');
  });
});

test('the header of a fresh install lists the command line alone', async () => {
  // Bug: with no platform set up the line reads `disabled`, as if the chat the owner types in did not work.
  const { env } = chatEnv({ title: 'Project Neptunia', status: () => Promise.resolve(brief([])) });
  await withChat(env, async (rig) => {
    await until(shows(rig, 'Interfaces: CLI'));
    assert.equal(interfacesRow(rig), 'Interfaces: CLI');
  });
});

const text = (rig: Rig): string => rig.screen().join('\n');

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
  // Bug: Ctrl+C left the chat while the owner meant to copy the selection.
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
  // Bug: Ctrl+A does nothing in the input, so the owner cannot select the draft to retype it.
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

const SQUARE = { id: 'i1', name: 'square.png', contentType: 'image/png', reference: 'ref', alt: 'A grey square' };

const screenOf = (rig: Rig): string => rig.screen().join('\n');

/** A chat holding the owner's line #1 and the persona's lines #2 (a picture with it) and #3, the last two by message id. */
async function withLines(body: (rig: Rig, change: (change: object) => void) => Promise<void>): Promise<void> {
  const { env, listeners, entry } = chatEnv();
  await withChat(env, async (rig) => {
    entry({ who: 'owner', text: 'put the kettle on', number: 1 });
    entry({ who: 'her', text: 'the kettle is on 🙂', number: 2, messageId: 'm-2', attachments: [SQUARE] });
    entry({ who: 'her', text: 'tea is next', number: 3, messageId: 'm-3' });
    await until(() => screenOf(rig).includes('tea is next'));
    await body(rig, (change) => listeners.lineChange?.(change as never));
  });
}

test('an edit draws the new text of a line of the persona with the edited mark and moves nothing else', async () => {
  // Bug: the screen keeps the words the persona took out, or the edit reorders, renumbers or redraws the other lines.
  await withLines(async (rig, change) => {
    const before = screenOf(rig);
    const numbers = before.match(/#0*\d+/g);
    assert.equal(numbers?.length, 3, 'the three numbered lines are drawn');
    change({ id: 'm-2', text: 'the kettle is on' });
    await until(() => screenOf(rig).includes('the kettle is on (edited)'));
    const after = screenOf(rig);
    assert.equal(after.includes('🙂'), false, 'the old text is gone');
    assert.deepEqual(after.match(/#0*\d+/g), numbers, 'every line keeps its number');
    const at = ['put the kettle on', 'the kettle is on (edited)', 'tea is next'].map((text) => after.indexOf(text));
    assert.deepEqual(
      at,
      [...at].sort((one, two) => one - two),
      'the lines keep their order'
    );
    assert.equal(at.includes(-1), false, 'the other lines are still drawn');
  });
});

test('a deletion keeps the place and number of a line of the persona, reads it as a deleted message and drops its images', async () => {
  // Bug: the line vanishes and every later line shifts, or the words or the picture stay drawn after the persona took them back.
  await withLines(async (rig, change) => {
    assert.ok(screenOf(rig).includes('A grey square'), 'the picture was drawn');
    const numbers = screenOf(rig).match(/#0*\d+/g);
    change({ id: 'm-2', deleted: true });
    await until(() => screenOf(rig).includes('message deleted'));
    const after = screenOf(rig);
    assert.equal(after.includes('the kettle is on'), false, "the persona's words are gone");
    assert.equal(after.includes('A grey square'), false, 'its picture is gone');
    assert.deepEqual(after.match(/#0*\d+/g), numbers, 'every line keeps its number');
    assert.ok(after.indexOf('put the kettle on') < after.indexOf('message deleted'));
    assert.ok(after.indexOf('message deleted') < after.indexOf('tea is next'));
  });
});

test('a change for a message id the screen does not hold changes nothing', async () => {
  // Bug: a change names a line the screen never drew and it rewrites another line, or the owner's line of that id.
  await withLines(async (rig, change) => {
    const before = screenOf(rig);
    change({ id: 'no-such-line', text: 'changed' });
    change({ id: 'no-such-line', deleted: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(screenOf(rig), before);
  });
});

// A line of an earlier session is drawn from the stored history. A stored line of the persona carries its message id
// in `messageId` of the page `storedPage` returns, as `ChatEntry` names it, so a change for it finds the entry.
test('a line drawn from the stored history is redrawn by a change for its message id', async () => {
  // Bug: the owner's screen keeps the words the persona edited in a line from before the restart.
  const { env, listeners } = chatEnv({
    storedPage: () =>
      Promise.resolve([
        { id: 'src-1', who: 'owner' as const, text: 'put the kettle on', number: 140 },
        { id: 'src-2', who: 'her' as const, text: 'the kettle is on 🙂', number: 141, messageId: 'm-old' },
      ]),
  });
  await withChat(env, async (rig) => {
    await until(() => screenOf(rig).includes('the kettle is on 🙂'));
    listeners.lineChange?.({ id: 'm-old', text: 'the kettle is on' });
    await until(() => screenOf(rig).includes('the kettle is on (edited)'));
    const after = screenOf(rig);
    assert.equal(after.includes('🙂'), false);
    assert.ok(after.includes('put the kettle on'), 'the owner line stays');
  });
});

const LIMITS = { collapseLines: 3, collapseChars: 800 };

test('a paste into a secret question reaches only that question, and the interrupted draft comes back', async () => {
  // Bug: a pasted key lands in the chat draft, in the paste store or in the history file.
  const secret = 'synthetic-secret-for-test';
  let clock = 1000;
  const { env, sent, saved, question } = chatEnv({ composer: LIMITS, now: () => clock });
  let answered = '';
  await withChat(env, async (rig) => {
    await press(rig, 'Keep this draft.', shows(rig, '> Keep this draft.'));
    question({ question: 'The key:', secret: true, answer: (text) => (answered = text) });
    await until(shows(rig, 'The key:'));
    await press(rig, bracketed(secret), shows(rig, '*'.repeat(secret.length)));
    assert.equal(rig.frames().includes(secret), false);
    await press(rig, KEY.enter, () => answered !== '' && shows(rig, '> Keep this draft.')());
    assert.match(rig.screen().join('\n'), /Keep this draft\./);
    clock += 10_000;
    await press(rig, KEY.enter, () => sent.length === 1);
  });
  assert.equal(answered, secret);
  assert.deepEqual(sent, ['Keep this draft.']);
  assert.equal(JSON.stringify(saved).includes(secret), false);
});

/** A key-repeat interval of an ordinary keyboard, in ms. */
const REPEAT_MS = 30;

/** Long past any repeat: a person who saw the draft come back and pressed Enter on purpose. */
const DELIBERATE_MS = 10_000;

function chat(choices?: ReadonlyArray<string>) {
  let clock = 1000;
  const answers: Array<string> = [];
  const rig = chatEnv({ now: () => clock });
  return {
    ...rig,
    answers,
    advance: (ms: number) => (clock += ms),
    ask: () =>
      rig.question({
        question: 'Continue?',
        secret: false,
        ...(choices === undefined ? {} : { choices }),
        answer: (text) => void answers.push(text),
      }),
  };
}

test('a second Enter in the chunk of the answer leaves the restored draft in the composer', async () => {
  // Bug: the answer's chunk carries two returns, the second lands on the restored draft and sends it unseen.
  const { env, sent, answers, ask } = chat();
  await withChat(env, async (rig) => {
    await press(rig, 'kept draft', shows(rig, '> kept draft'));
    ask();
    await until(shows(rig, 'Continue?'));
    await press(rig, 'yes', shows(rig, '> yes'));
    await press(rig, `${KEY.enter}${KEY.enter}`, () => answers.length === 1 && shows(rig, '> kept draft')());
    // A swallowed Enter changes nothing on the screen, so only a fixed wait lets a stray send show.
    await pause();
    assert.deepEqual(answers, ['yes']);
    assert.deepEqual(sent, []);
    assert.match(rig.screen().join('\n'), /> kept draft/);
  });
});

test('a key-repeat burst after the answer sends nothing, and a deliberate Enter past its window sends the draft once', async () => {
  // Bug: a held Enter sends the draft, or the guard swallows every later Enter and the draft can never go out.
  const { env, sent, answers, ask, advance } = chat();
  await withChat(env, async (rig) => {
    await press(rig, 'kept draft', shows(rig, '> kept draft'));
    ask();
    await until(shows(rig, 'Continue?'));
    await press(rig, 'yes', shows(rig, '> yes'));
    await press(rig, KEY.enter, () => answers.length === 1 && shows(rig, '> kept draft')());
    for (let repeat = 0; repeat < 3; repeat += 1) {
      advance(REPEAT_MS);
      rig.type(KEY.enter);
      // A swallowed Enter changes nothing on the screen, so only a fixed wait lets a stray send show.
      await pause();
    }
    assert.deepEqual(answers, ['yes']);
    assert.deepEqual(sent, []);
    assert.match(rig.screen().join('\n'), /> kept draft/);
    advance(DELIBERATE_MS);
    await press(rig, KEY.enter, () => sent.length === 1);
    assert.deepEqual(sent, ['kept draft']);
  });
});

test('the same burst after choosing from a closed question leaves the draft too', async () => {
  // Bug: the selector takes its own Enter path, and only the typed answer got the guard.
  const { env, sent, answers, ask, advance } = chat(['on', 'off']);
  await withChat(env, async (rig) => {
    await press(rig, 'kept draft', shows(rig, '> kept draft'));
    ask();
    await until(shows(rig, 'Continue?'));
    await press(rig, KEY.enter, () => answers.length === 1 && shows(rig, '> kept draft')());
    advance(REPEAT_MS);
    rig.type(KEY.enter);
    // A swallowed Enter changes nothing on the screen, so only a fixed wait lets a stray send show.
    await pause();
    assert.deepEqual(answers, ['on']);
    assert.deepEqual(sent, []);
    assert.match(rig.screen().join('\n'), /> kept draft/);
  });
});

test('other keys during the window edit the restored draft as usual', async () => {
  // Bug: the guard drops typed text as well as Enter, and the owner's next word is lost.
  const { env, sent, answers, ask, advance } = chat();
  await withChat(env, async (rig) => {
    await press(rig, 'kept', shows(rig, '> kept'));
    ask();
    await until(shows(rig, 'Continue?'));
    await press(rig, 'yes', shows(rig, '> yes'));
    await press(rig, KEY.enter, () => answers.length === 1 && shows(rig, '> kept')());
    await press(rig, ' more', shows(rig, '> kept more'));
    advance(DELIBERATE_MS);
    await press(rig, KEY.enter, () => sent.length === 1);
  });
  assert.deepEqual(sent, ['kept more']);
});

test('the window does not hold an ordinary send with no question before it', async () => {
  // Bug: the guard runs from the last Enter of any kind, and two quick messages lose the second.
  const { env, sent } = chat();
  await withChat(env, async (rig) => {
    await press(rig, 'one', shows(rig, '> one'));
    await press(rig, KEY.enter, () => sent.length === 1);
    await press(rig, 'two', shows(rig, '> two'));
    await press(rig, KEY.enter, () => sent.length === 2);
  });
  assert.deepEqual(sent, ['one', 'two']);
});
