// interfaces/cli/app.ts drawn into a fake terminal: an offline visual fixture with no core and no provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable, Readable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { runInteractive } from '../../../interfaces/cli/index.ts';
import type { ChatEnv, ChatEntry, Question, Panel } from '../../../interfaces/cli/index.ts';
import {
  until,
  KEY,
  bracketed,
  chatEnv,
  pause as cliPastePause,
  press,
  shows as cliPasteShows,
  withChat as cliPasteWithChat,
} from '../../fixtures/chat-rig.ts';

function terminal(columns = 80) {
  let frames = '';
  let screen = '';
  const stdout = Object.assign(
    new Writable({
      write(chunk: Buffer | string, _encoding, done) {
        frames += String(chunk);
        const visible = stripVTControlCharacters(String(chunk));
        if (visible.includes('\n')) screen = visible;
        done();
      },
    }),
    { columns, rows: 24, isTTY: true }
  );
  const stdin = Object.assign(new Readable({ read() {} }), {
    isTTY: true,
    setRawMode: () => stdin,
    ref: () => stdin,
    unref: () => stdin,
    setEncoding: () => stdin,
  });
  const type = (text: string): void => void stdin.push(text);
  return { stdout, stdin, type, frames: () => frames, screen: () => screen.replace(/\n$/, '').split('\n') };
}

const shows = (rig: ReturnType<typeof terminal>, needle: string) => (): boolean =>
  rig.screen().join('\n').includes(needle);

function envOf(over: Partial<ChatEnv> = {}) {
  const sent: Array<string> = [];
  const saved: Array<ReadonlyArray<string>> = [];
  const listeners: { entry?: (one: ChatEntry) => void; question?: (one: Question) => void } = {};
  const env: ChatEnv = {
    title: 'neptunia',
    commands: [
      { name: 'status', help: 'the short summary' },
      { name: 'help', help: 'this list' },
    ],
    history: [],
    still: true,
    send: (line) => void sent.push(line),
    panelOf: (line) =>
      Promise.resolve(
        line === '/help' ? { title: 'Help', lines: ['status the summary', 'keys the model keys'] } : null
      ),
    subscribe: (given) => Object.assign(listeners, given),
    status: () =>
      Promise.resolve({
        core: { state: 'running', reason: null, model: null, route: 'direct-api', bound: true },
        memory: { session: 'apply', model: null, route: 'direct-api', bound: true, probe: 'ok', checkedAt: 1 },
        analyzer: { model: null, route: 'direct-api', bound: true },
        interfaces: [],
      }),
    saveHistory: (lines) => saved.push(lines),
    now: () => 1000,
    ...over,
  };
  return { env, sent, saved, listeners };
}

async function withChat(env: ChatEnv, body: (rig: ReturnType<typeof terminal>) => Promise<void>): Promise<void> {
  const rig = terminal();
  let subscribed = false;
  const watched: ChatEnv = {
    ...env,
    subscribe: (given) => {
      subscribed = true;
      return env.subscribe(given);
    },
  };
  const running = runInteractive(watched, { stdin: rig.stdin as never, stdout: rig.stdout as never });
  // The first frame is drawn and the app listens for entries and questions: one sent earlier would be lost.
  await until(() => subscribed && rig.screen().join('').trim() !== '');
  // A failed assertion still closes the chat, so a red test reports instead of hanging the run.
  try {
    await body(rig);
  } finally {
    rig.type('\u0003');
    await running;
  }
}

test("the screen shows the galaxy, the status line, and a typed line reaches the core with the owner's history saved", async () => {
  // Bug: the chat draws nothing without a core's answer, or a line never reaches the link.
  const { env, sent, saved } = envOf();
  await withChat(env, async (rig) => {
    assert.match(rig.frames(), /neptunia/);
    assert.match(rig.frames(), /@/);
    // The header says `active` for a running core: the word of this assertion follows it.
    await until(() => /Core: active/.test(rig.frames()));
    // The header presents each status on its own readable line.
    assert.match(rig.frames(), /Core: active/);
    rig.type('γεια');
    await until(shows(rig, '> γεια'));
    rig.type('\r');
    await until(() => sent.length === 1 && saved.length > 0);
  });
  assert.deepEqual(sent, ['γεια']);
  assert.deepEqual(saved.at(-1), ['γεια']);
});

test('the input stays at the terminal bottom when the chat is empty and the terminal grows', async () => {
  // Bug: an empty chat leaves the input below the header instead of at the terminal bottom.
  const { env } = envOf();
  await withChat(env, async (rig) => {
    // The chat draws no strip of key hints, and the status row stands under the box's lower border, so the input row
    // is the third from the bottom.
    const inputRow = (): number => rig.screen().findIndex((line) => line.includes('> bottom-input'));
    rig.type('bottom-input');
    await until(() => inputRow() === rig.stdout.rows - 3);
    assert.equal(
      rig.screen().findIndex((line) => line.includes('> bottom-input')),
      rig.stdout.rows - 3
    );
    rig.stdout.rows = 32;
    rig.stdout.emit('resize');
    await until(() => inputRow() === rig.stdout.rows - 3);
    assert.equal(
      rig.screen().findIndex((line) => line.includes('> bottom-input')),
      rig.stdout.rows - 3
    );
  });
});

test('expanding a long answer shows its final line, and Page Up reaches its first', async () => {
  // Bug: clipping the chat to terminal height discards the beginning of an expanded answer.
  // The chat draws inline no more: on the alternate screen nothing scrolls into the terminal's history, so the first and
  // the final line of an answer taller than the window cannot share one screen. The start is reached with Page Up.
  // A row is matched by its text, not as the whole row: the first row of a line carries the lead `[time] [#N] ` and its later rows start in the column of its text.
  const { env, listeners } = envOf();
  const lines = Array.from({ length: 40 }, (_, index) => `answer-line-${index + 1}`);
  const onScreen = (rig: ReturnType<typeof terminal>, needle: string): boolean =>
    rig.screen().some((row) => row.trim() === needle || row.trimEnd().endsWith(`] ${needle}`));
  await withChat(env, async (rig) => {
    listeners.entry?.({ who: 'her', text: lines.join('\n') });
    await until(() => onScreen(rig, 'answer-line-1'));
    assert.ok(onScreen(rig, 'answer-line-1'));
    assert.equal(onScreen(rig, 'answer-line-40'), false);
    rig.type('\u000f');
    await until(() => onScreen(rig, 'answer-line-40'));
    assert.ok(onScreen(rig, 'answer-line-40'));
    for (let page = 0; page < 4 && !onScreen(rig, 'answer-line-1'); page += 1) {
      rig.type('\u001b[5~');
      await until(() => onScreen(rig, 'answer-line-1'), 500);
    }
    assert.ok(onScreen(rig, 'answer-line-1'));
  });
});

test('a slash opens its menu with descriptions, and a command shows its answer in the command window', async () => {
  // Bug: the slash menu lists commands that do not exist, or `/help` goes to the model as a chat line.
  // A panel of lines alone is a command's text answer, kept in the command window's
  // history, so it shows there as text and has no search of its own; the panels with rows keep theirs.
  const { env, sent } = envOf();
  await withChat(env, async (rig) => {
    rig.type('/');
    await until(() => /\/status {2}the short summary/.test(rig.frames()));
    assert.match(rig.frames(), /\/status {2}the short summary/);
    rig.type('help');
    await until(shows(rig, '> /help'));
    rig.type('\r');
    await until(shows(rig, 'keys the model keys'));
    assert.match(rig.screen().join('\n'), /status the summary/);
    rig.type('\u001b');
    await until(() => !rig.screen().join('\n').includes('keys the model keys'));
  });
  assert.deepEqual(sent, []);
});

test('a secret question draws stars, its answer stays out of the history and off the screen', async () => {
  // Bug: a pasted key shows in the terminal or lands in the history file.
  const { env, saved, listeners } = envOf();
  let answer = '';
  await withChat(env, async (rig) => {
    listeners.question?.({ question: 'The key:', secret: true, answer: (text) => (answer = text) });
    await until(shows(rig, 'The key:'));
    rig.type('sk-secret');
    await until(() => /\*{9}/.test(rig.frames()));
    assert.match(rig.frames(), /\*{9}/);
    rig.type('\r');
    await until(() => answer !== '');
    assert.equal(rig.frames().includes('sk-secret'), false);
  });
  assert.equal(answer, 'sk-secret');
  assert.deepEqual(saved, []);
});

test('clearing the display sends nothing to the core', async () => {
  // Bug: `/clear` reaches the model, or wipes the persona's memory.
  const { env, sent, listeners } = envOf();
  await withChat(env, async (rig) => {
    listeners.entry?.({ who: 'her', text: 'μια απάντηση' });
    await until(shows(rig, 'μια απάντηση'));
    rig.type('/clear');
    await until(shows(rig, '> /clear'));
    rig.type('\r');
    await until(() => !rig.screen().join('\n').includes('μια απάντηση'));
  });
  assert.deepEqual(sent, []);
});

test('panel navigation toggles a setting, edits another value and returns to chat without sending either to the model', async () => {
  // Bug: Enter only filters a text panel, or a settings edit is sent as chat text.
  const changed: Array<string> = [];
  const { env, sent } = envOf({
    panelOf: () =>
      Promise.resolve({
        title: 'Config',
        lines: [],
        rows: [
          {
            id: 'enabled',
            label: 'Enabled',
            detail: 'Run the feature',
            group: 'General',
            edit: { kind: 'boolean', value: 'false' },
            apply: (value: string) => {
              changed.push(value);
              return Promise.resolve({ status: 'ok', text: 'saved' });
            },
          },
          {
            id: 'name',
            label: 'Name',
            detail: 'A display name',
            group: 'General',
            edit: { kind: 'text', value: '' },
            apply: (value: string) => {
              changed.push(value);
              return Promise.resolve({ status: 'ok', text: 'saved' });
            },
          },
        ],
      }),
  });
  await withChat(env, async (rig) => {
    rig.type('/config');
    await until(shows(rig, '> /config'));
    rig.type('\r');
    await until(shows(rig, '1/2'));
    rig.type('\r');
    await until(shows(rig, 'Enabled  true'));
    rig.type('\u001b[B');
    await until(shows(rig, '2/2'));
    rig.type('\r');
    await until(shows(rig, 'Value:'));
    rig.type('new name');
    await until(shows(rig, 'Value: new name'));
    rig.type('\r');
    await until(shows(rig, 'Name  new name'));
    rig.type('\u001b');
    await until(() => !rig.screen().join('\n').includes('Enter open/toggle'));
  });
  assert.deepEqual(changed, ['true', 'new name']);
  assert.deepEqual(sent, []);
});

test('setup choices use arrows and Enter, while secret answers never appear in terminal output', async () => {
  // Bug: setup loses the selected option, or its independent secret dialog echoes a key.
  const { askQuestion } = await import('../../../interfaces/cli/question.ts');
  const rig = terminal();
  const streams = { stdin: rig.stdin as never, stdout: rig.stdout as never };
  const choice = askQuestion('Enable heartbeat?', 'off', { choices: ['on', 'off'] }, streams);
  await until(shows(rig, 'Enable heartbeat?'));
  rig.type('\u001b[A');
  await until(() => /› on/.test(rig.screen().join('\n')));
  rig.type('\r');
  assert.equal(await choice, 'on');
  const secret = askQuestion('Service key', null, { secret: true }, streams);
  await until(shows(rig, 'Service key'));
  rig.type('private-value');
  await until(() => rig.screen().join('\n').includes('*'.repeat('private-value'.length)));
  rig.type('\r');
  assert.equal(await secret, 'private-value');
  assert.equal(rig.frames().includes('private-value'), false);
});

// The chat's overlays through the real Ink screen (interfaces/cli/index.ts) in a fake terminal: one owner of the keys, a question's
// choices, an interrupted draft, and an overlay's late answer. No core and no provider.

function selectorTerminal() {
  let frames = '';
  let screen = '';
  const stdout = Object.assign(
    new Writable({
      write(chunk: Buffer | string, _encoding, done) {
        frames += String(chunk);
        const visible = stripVTControlCharacters(String(chunk));
        if (visible.includes('\n')) screen = visible;
        done();
      },
    }),
    { columns: 80, rows: 24, isTTY: true }
  );
  const stdin = Object.assign(new Readable({ read() {} }), {
    isTTY: true,
    setRawMode: () => stdin,
    ref: () => stdin,
    unref: () => stdin,
    setEncoding: () => stdin,
  });
  const type = (text: string): void => void stdin.push(text);
  return { stdout, stdin, type, frames: () => frames, screen: () => screen };
}

type Rig = ReturnType<typeof selectorTerminal>;

const pause = (ms = 60): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const selectorShows = (rig: Rig, text: string) => (): boolean => rig.screen().includes(text);
const ENTER = '\r';
const ESC = '\u001b';

function selectorEnvOf(over: Partial<ChatEnv> = {}) {
  const sent: Array<string> = [];
  const saved: Array<ReadonlyArray<string>> = [];
  const listeners: { entry?: (one: ChatEntry) => void; question?: (one: Question) => void } = {};
  const env: ChatEnv = {
    title: 'neptunia',
    commands: [
      { name: 'first', help: 'the first menu' },
      { name: 'second', help: 'the second menu' },
    ],
    history: [],
    still: true,
    send: (line) => void sent.push(line),
    panelOf: () => Promise.resolve(null),
    subscribe: (given) => Object.assign(listeners, given),
    status: () => Promise.resolve(null),
    saveHistory: (lines) => saved.push(lines),
    now: () => 1000,
    ...over,
  };
  return { env, sent, saved, listeners };
}

async function selectorWithChat(env: ChatEnv, body: (rig: Rig) => Promise<void>): Promise<void> {
  const rig = selectorTerminal();
  let subscribed = false;
  const watched: ChatEnv = {
    ...env,
    subscribe: (given) => {
      subscribed = true;
      return env.subscribe(given);
    },
  };
  const running = runInteractive(watched, { stdin: rig.stdin as never, stdout: rig.stdout as never });
  // The first frame is drawn and the app listens for questions: one sent earlier would be lost.
  await until(() => subscribed && rig.screen().trim() !== '');
  // A failed assertion still closes the chat, so a red test reports instead of hanging the run.
  try {
    await body(rig);
  } finally {
    rig.type('\u0003');
    await running;
  }
}

/**
 * Types a line and Enter as two keypresses, the way a person does. Each waits for its effect: the text on the screen,
 * then the sent line echoed into the transcript. A masked or answered line passes its own conditions.
 */
async function line(
  rig: Rig,
  text: string,
  typed: () => boolean = selectorShows(rig, text),
  sent: () => boolean = () => new RegExp(`^> ${text}\\s*$`, 'm').test(rig.screen())
): Promise<void> {
  rig.type(text);
  await until(typed);
  rig.type(ENTER);
  await until(sent);
}

test('a question with choices is filtered and answers the original value once, however often Enter comes', async () => {
  // Catches: choices dropped so the owner must retype a model name, or a second Enter sent on as a chat line.
  const { env, sent, listeners } = selectorEnvOf();
  const answers: Array<string> = [];
  await selectorWithChat(env, async (rig) => {
    listeners.question?.({
      question: 'Which model?',
      secret: false,
      choices: ['example-model-a', 'example-model-b'],
      answer: (text) => answers.push(text),
    });
    await until(selectorShows(rig, 'example-model-a'));
    assert.ok(rig.screen().includes('example-model-a'), rig.screen());
    rig.type('model-b');
    await until(() => rig.screen().includes('model-b') && !rig.screen().includes('example-model-a'));
    assert.equal(rig.screen().includes('example-model-a'), false, rig.screen());
    rig.type(ENTER);
    await until(() => answers.length === 1);
    rig.type(ENTER);
    // The second Enter changes nothing when the bug is absent, so only a fixed wait lets a stray answer or line show.
    await pause();
  });
  assert.deepEqual(answers, ['example-model-b']);
  assert.deepEqual(sent, []);
});

test('a filter that matches no choice does not answer the question', async () => {
  // Catches: the typed filter text going to the core as if it were one of the closed choices.
  const { env, listeners } = selectorEnvOf();
  const answers: Array<string> = [];
  await selectorWithChat(env, async (rig) => {
    listeners.question?.({
      question: 'Which model?',
      secret: false,
      choices: ['example-model-a'],
      answer: (text) => answers.push(text),
    });
    await until(selectorShows(rig, 'example-model-a'));
    rig.type('nothing like it');
    await until(selectorShows(rig, 'nothing like it'));
    rig.type(ENTER);
    // Nothing changes when the bug is absent, so a fixed wait is the only way to let a stray answer arrive.
    await pause();
    assert.deepEqual(answers, []);
  });
});

test('Escape on a question restores the draft it interrupted and sends nothing', async () => {
  // Catches: the half-written line wiped by a dialog that came from the core.
  const { env, sent, listeners } = selectorEnvOf();
  const answers: Array<string> = [];
  await selectorWithChat(env, async (rig) => {
    rig.type('an unfinished draft');
    await until(selectorShows(rig, 'an unfinished draft'));
    listeners.question?.({ question: 'Which?', secret: false, answer: (text) => answers.push(text) });
    await until(selectorShows(rig, 'Which?'));
    rig.type('half an answer');
    await until(selectorShows(rig, 'half an answer'));
    rig.type(ESC);
    await until(() => rig.screen().includes('an unfinished draft') && !rig.screen().includes('half an answer'));
    assert.ok(rig.screen().includes('an unfinished draft'), rig.screen());
    assert.equal(rig.screen().includes('half an answer'), false, rig.screen());
  });
  assert.deepEqual(answers, ['']);
  assert.deepEqual(sent, []);
});

test('a draft is not the answer to a question that interrupts it, and comes back after the answer', async () => {
  // Catches: Enter on the question sending the owner's unfinished chat line to the core as a key or a model name.
  const { env, sent, listeners } = selectorEnvOf();
  const answers: Array<string> = [];
  await selectorWithChat(env, async (rig) => {
    rig.type('an unfinished draft');
    await until(selectorShows(rig, 'an unfinished draft'));
    listeners.question?.({ question: 'Which?', secret: false, answer: (text) => answers.push(text) });
    await until(selectorShows(rig, 'Which?'));
    await line(rig, 'typed answer', undefined, () => rig.screen().includes('an unfinished draft'));
    assert.ok(rig.screen().includes('an unfinished draft'), rig.screen());
  });
  assert.deepEqual(answers, ['typed answer']);
  assert.deepEqual(sent, []);
});

test('a secret question over a draft stays masked and leaves no trace in the history', async () => {
  // Catches: restoring the input by keeping one buffer, which draws or saves the secret afterwards.
  const { env, saved, listeners } = selectorEnvOf();
  const answers: Array<string> = [];
  await selectorWithChat(env, async (rig) => {
    rig.type('draft');
    await until(selectorShows(rig, 'draft'));
    listeners.question?.({ question: 'The key:', secret: true, answer: (text) => answers.push(text) });
    await until(selectorShows(rig, 'The key:'));
    await line(
      rig,
      'sk-very-secret',
      selectorShows(rig, '*'.repeat('sk-very-secret'.length)),
      () => answers.length === 1
    );
    assert.ok(rig.screen().includes('draft'), rig.screen());
    assert.equal(rig.frames().includes('sk-very-secret'), false);
  });
  assert.deepEqual(answers, ['sk-very-secret']);
  assert.equal(saved.flat().includes('sk-very-secret'), false);
});

/** A chat whose `/first` panel answers when the test says so; `/second` answers at once. */
function lateFirst(answer: Panel | null) {
  let release: () => void = () => {};
  const held = new Promise<Panel | null>((resolve) => {
    release = () => resolve(answer);
  });
  const panelOf = (asked: string): Promise<Panel | null> =>
    asked === '/first' ? held : Promise.resolve({ title: 'Second', lines: ['the second menu body'] });
  return { panelOf, release: () => release() };
}

test('the panel of selector A arriving after B opened leaves B on the screen', async () => {
  // Catches: the slow answer replacing the overlay the owner is reading, its Enter then acting on the wrong rows.
  const { panelOf, release } = lateFirst({ title: 'First', lines: ['the first menu body'] });
  const { env } = selectorEnvOf({ panelOf });
  await selectorWithChat(env, async (rig) => {
    await line(rig, '/first');
    await line(rig, '/second', undefined, selectorShows(rig, 'the second menu body'));
    assert.ok(rig.screen().includes('the second menu body'), rig.screen());
    release();
    // The late answer must change nothing, so a fixed wait is the only way to let it show.
    await pause();
    assert.ok(rig.screen().includes('the second menu body'), rig.screen());
    assert.equal(rig.screen().includes('the first menu body'), false, rig.screen());
  });
});

test('a stale request that opens no panel is not sent on as a command', async () => {
  // Catches: `panelOf` answering null late, and the line A running as a command after B took over.
  const { panelOf, release } = lateFirst(null);
  const { env, sent } = selectorEnvOf({ panelOf });
  await selectorWithChat(env, async (rig) => {
    await line(rig, '/first');
    await line(rig, '/second', undefined, selectorShows(rig, 'the second menu body'));
    release();
    // The late answer must change nothing, so a fixed wait is the only way to let a stray command show.
    await pause();
  });
  assert.deepEqual(sent, []);
});

test('a panel closed with Escape does not come back when an older request answers', async () => {
  // Catches: the late answer reopening an overlay over a composer the owner has returned to.
  const { panelOf, release } = lateFirst({ title: 'First', lines: ['the first menu body'] });
  const { env } = selectorEnvOf({ panelOf });
  await selectorWithChat(env, async (rig) => {
    await line(rig, '/first');
    await line(rig, '/second', undefined, selectorShows(rig, 'the second menu body'));
    rig.type(ESC);
    await until(() => !rig.screen().includes('the second menu body'));
    assert.equal(rig.screen().includes('the second menu body'), false, rig.screen());
    release();
    // The late answer must change nothing, so a fixed wait is the only way to let it show.
    await pause();
    assert.equal(rig.screen().includes('the first menu body'), false, rig.screen());
  });
});

test('Escape while a panel is still loading cancels it, so the composer keeps the keys', async () => {
  // Catches: a panel popping up after the owner gave up on it and began typing, swallowing the next keys.
  const { panelOf, release } = lateFirst({ title: 'First', lines: ['the first menu body'] });
  const { env } = selectorEnvOf({ panelOf });
  await selectorWithChat(env, async (rig) => {
    await line(rig, '/first');
    rig.type(ESC);
    // The cancel changes nothing on the screen, so a fixed wait lets the keypress land before the late answer.
    await pause(120);
    release();
    // And the late answer must change nothing, so a fixed wait is the only way to let it show.
    await pause();
    assert.equal(rig.screen().includes('the first menu body'), false, rig.screen());
  });
});

test('a question over an open panel takes the paste and filters its choices, and the panel survives it', async () => {
  // Catches: a closed question typed as free text under a panel, or the answer closing the panel behind it.
  const { env, listeners } = selectorEnvOf({
    panelOf: () =>
      Promise.resolve({
        title: 'Rows',
        lines: [],
        rows: [{ id: 'one', label: 'A row', detail: 'its detail', group: 'All', prefill: '/one' }],
      }),
  });
  const answers: Array<string> = [];
  await selectorWithChat(env, async (rig) => {
    await line(rig, '/first', undefined, selectorShows(rig, 'A row'));
    listeners.question?.({
      question: 'Which?',
      secret: false,
      choices: ['pasted-choice', 'other'],
      answer: (text) => answers.push(text),
    });
    await until(selectorShows(rig, 'pasted-choice'));
    rig.type('pasted');
    await until(() => !rig.screen().includes('other'));
    assert.equal(rig.screen().includes('search: pasted'), false, rig.screen());
    assert.equal(rig.screen().includes('other'), false, rig.screen());
    rig.type(ENTER);
    await until(() => answers.length === 1 && rig.screen().includes('A row'));
    assert.deepEqual(answers, ['pasted-choice']);
    assert.ok(rig.screen().includes('A row'), rig.screen());
  });
});

const CHIP = /\[pasted \d+ lines\]/;

test('every single-byte split of a bracketed paste arrives as one paste with its UTF-8 whole', async () => {
  // Bug: a parallel stdin parser leaks the delimiters into the draft, or a split character becomes U+FFFD.
  const bytes = Buffer.from(bracketed('aé\nb'), 'utf8');
  for (let at = 1; at < bytes.length; at += 1) {
    const { env, sent } = chatEnv({ composer: { collapseLines: 1, collapseChars: 800 } });
    await cliPasteWithChat(env, async (rig) => {
      rig.type(bytes.subarray(0, at));
      await press(rig, bytes.subarray(at), cliPasteShows(rig, CHIP));
      assert.deepEqual(sent, [], `split at ${at}`);
      assert.equal(
        rig.screen().join('\n').includes('aé'),
        false,
        `a chip, so the paste channel took it; split at ${at}`
      );
      await press(rig, KEY.enter, () => sent.length === 1);
    });
    assert.deepEqual(sent, ['aé\nb'], `split at ${at}`);
  }
});

test('a paste whose escape prefix arrives a moment late is still one paste', async () => {
  // Bug: a delayed ESC reads as the Escape key, clears the draft and types the delimiter as text.
  const { env, sent } = chatEnv({ composer: { collapseLines: 1, collapseChars: 800 } });
  await cliPasteWithChat(env, async (rig) => {
    await press(rig, 'kept ', cliPasteShows(rig, '> kept'));
    rig.type('\u001b');
    // The gap is the scenario: the rest of the paste comes a moment after its escape prefix.
    await cliPastePause(5);
    await press(rig, '[200~one\ntwo\u001b[201~', cliPasteShows(rig, CHIP));
    assert.equal(rig.screen().join('\n').includes('one'), false, 'a chip, so the paste channel took it');
    await press(rig, KEY.enter, () => sent.length === 1);
  });
  assert.deepEqual(sent, ['kept one\ntwo']);
});
