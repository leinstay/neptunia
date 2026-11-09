// The chat's overlays through the real Ink screen (interfaces/cli/index.ts) in a fake terminal: one owner of the keys, a question's
// choices, an interrupted draft, and an overlay's late answer. No core and no provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { runInteractive } from '../interfaces/cli/index.ts';
import type { ChatEnv, ChatEntry, Panel, Question } from '../interfaces/cli/index.ts';
import { until } from './fixtures/chat-rig.ts';

function terminal() {
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

type Rig = ReturnType<typeof terminal>;

const pause = (ms = 60): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const shows = (rig: Rig, text: string) => (): boolean => rig.screen().includes(text);
const ENTER = '\r';
const ESC = '\u001b';

function envOf(over: Partial<ChatEnv> = {}) {
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

async function withChat(env: ChatEnv, body: (rig: Rig) => Promise<void>): Promise<void> {
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
  typed: () => boolean = shows(rig, text),
  sent: () => boolean = () => new RegExp(`^> ${text}\\s*$`, 'm').test(rig.screen())
): Promise<void> {
  rig.type(text);
  await until(typed);
  rig.type(ENTER);
  await until(sent);
}

test('a question with choices is filtered and answers the original value once, however often Enter comes', async () => {
  // Catches: choices dropped so the owner must retype a model name, or a second Enter sent on as a chat line.
  const { env, sent, listeners } = envOf();
  const answers: Array<string> = [];
  await withChat(env, async (rig) => {
    listeners.question?.({
      question: 'Which model?',
      secret: false,
      choices: ['example-model-a', 'example-model-b'],
      answer: (text) => answers.push(text),
    });
    await until(shows(rig, 'example-model-a'));
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
  const { env, listeners } = envOf();
  const answers: Array<string> = [];
  await withChat(env, async (rig) => {
    listeners.question?.({
      question: 'Which model?',
      secret: false,
      choices: ['example-model-a'],
      answer: (text) => answers.push(text),
    });
    await until(shows(rig, 'example-model-a'));
    rig.type('nothing like it');
    await until(shows(rig, 'nothing like it'));
    rig.type(ENTER);
    // Nothing changes when the bug is absent, so a fixed wait is the only way to let a stray answer arrive.
    await pause();
    assert.deepEqual(answers, []);
  });
});

test('Escape on a question restores the draft it interrupted and sends nothing', async () => {
  // Catches: the half-written line wiped by a dialog that came from the core.
  const { env, sent, listeners } = envOf();
  const answers: Array<string> = [];
  await withChat(env, async (rig) => {
    rig.type('an unfinished draft');
    await until(shows(rig, 'an unfinished draft'));
    listeners.question?.({ question: 'Which?', secret: false, answer: (text) => answers.push(text) });
    await until(shows(rig, 'Which?'));
    rig.type('half an answer');
    await until(shows(rig, 'half an answer'));
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
  const { env, sent, listeners } = envOf();
  const answers: Array<string> = [];
  await withChat(env, async (rig) => {
    rig.type('an unfinished draft');
    await until(shows(rig, 'an unfinished draft'));
    listeners.question?.({ question: 'Which?', secret: false, answer: (text) => answers.push(text) });
    await until(shows(rig, 'Which?'));
    await line(rig, 'typed answer', undefined, () => rig.screen().includes('an unfinished draft'));
    assert.ok(rig.screen().includes('an unfinished draft'), rig.screen());
  });
  assert.deepEqual(answers, ['typed answer']);
  assert.deepEqual(sent, []);
});

test('a secret question over a draft stays masked and leaves no trace in the history', async () => {
  // Catches: restoring the input by keeping one buffer, which draws or saves the secret afterwards.
  const { env, saved, listeners } = envOf();
  const answers: Array<string> = [];
  await withChat(env, async (rig) => {
    rig.type('draft');
    await until(shows(rig, 'draft'));
    listeners.question?.({ question: 'The key:', secret: true, answer: (text) => answers.push(text) });
    await until(shows(rig, 'The key:'));
    await line(rig, 'sk-very-secret', shows(rig, '*'.repeat('sk-very-secret'.length)), () => answers.length === 1);
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
  const { env } = envOf({ panelOf });
  await withChat(env, async (rig) => {
    await line(rig, '/first');
    await line(rig, '/second', undefined, shows(rig, 'the second menu body'));
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
  const { env, sent } = envOf({ panelOf });
  await withChat(env, async (rig) => {
    await line(rig, '/first');
    await line(rig, '/second', undefined, shows(rig, 'the second menu body'));
    release();
    // The late answer must change nothing, so a fixed wait is the only way to let a stray command show.
    await pause();
  });
  assert.deepEqual(sent, []);
});

test('a panel closed with Escape does not come back when an older request answers', async () => {
  // Catches: the late answer reopening an overlay over a composer the owner has returned to.
  const { panelOf, release } = lateFirst({ title: 'First', lines: ['the first menu body'] });
  const { env } = envOf({ panelOf });
  await withChat(env, async (rig) => {
    await line(rig, '/first');
    await line(rig, '/second', undefined, shows(rig, 'the second menu body'));
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
  const { env } = envOf({ panelOf });
  await withChat(env, async (rig) => {
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
  const { env, listeners } = envOf({
    panelOf: () =>
      Promise.resolve({
        title: 'Rows',
        lines: [],
        rows: [{ id: 'one', label: 'A row', detail: 'its detail', group: 'All', prefill: '/one' }],
      }),
  });
  const answers: Array<string> = [];
  await withChat(env, async (rig) => {
    await line(rig, '/first', undefined, shows(rig, 'A row'));
    listeners.question?.({
      question: 'Which?',
      secret: false,
      choices: ['pasted-choice', 'other'],
      answer: (text) => answers.push(text),
    });
    await until(shows(rig, 'pasted-choice'));
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
