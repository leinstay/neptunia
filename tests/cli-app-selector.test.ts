// The chat's overlays through the real Ink screen (cli/index.ts) in a fake terminal: one owner of the keys, a question's
// choices, an interrupted draft, and an overlay's late answer. No core and no provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { runInteractive } from '../cli/index.ts';
import type { ChatEnv, ChatEntry, Panel, Question } from '../cli/index.ts';

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
    send: (line) => sent.push(line),
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
  const running = runInteractive(env, { stdin: rig.stdin as never, stdout: rig.stdout as never });
  await pause();
  // A failed assertion still closes the chat, so a red test reports instead of hanging the run.
  try {
    await body(rig);
  } finally {
    rig.type('\u0003');
    await running;
  }
}

/** Types a line and Enter as two keypresses, the way a person does. */
async function line(rig: Rig, text: string): Promise<void> {
  rig.type(text);
  await pause();
  rig.type(ENTER);
  await pause();
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
    await pause();
    assert.ok(rig.screen().includes('example-model-a'), rig.screen());
    rig.type('model-b');
    await pause();
    assert.equal(rig.screen().includes('example-model-a'), false, rig.screen());
    rig.type(ENTER);
    await pause();
    rig.type(ENTER);
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
    await pause();
    await line(rig, 'nothing like it');
    assert.deepEqual(answers, []);
  });
});

test('Escape on a question restores the draft it interrupted and sends nothing', async () => {
  // Catches: the half-written line wiped by a dialog that came from the core.
  const { env, sent, listeners } = envOf();
  const answers: Array<string> = [];
  await withChat(env, async (rig) => {
    rig.type('an unfinished draft');
    await pause();
    listeners.question?.({ question: 'Which?', secret: false, answer: (text) => answers.push(text) });
    await pause();
    rig.type('half an answer');
    await pause();
    rig.type(ESC);
    await pause(120);
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
    await pause();
    listeners.question?.({ question: 'Which?', secret: false, answer: (text) => answers.push(text) });
    await pause();
    await line(rig, 'typed answer');
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
    await pause();
    listeners.question?.({ question: 'The key:', secret: true, answer: (text) => answers.push(text) });
    await pause();
    await line(rig, 'sk-very-secret');
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
    await line(rig, '/second');
    assert.ok(rig.screen().includes('the second menu body'), rig.screen());
    release();
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
    await line(rig, '/second');
    release();
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
    await line(rig, '/second');
    rig.type(ESC);
    await pause(120);
    assert.equal(rig.screen().includes('the second menu body'), false, rig.screen());
    release();
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
    await pause(120);
    release();
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
    await line(rig, '/first');
    listeners.question?.({
      question: 'Which?',
      secret: false,
      choices: ['pasted-choice', 'other'],
      answer: (text) => answers.push(text),
    });
    await pause();
    rig.type('pasted');
    await pause();
    assert.equal(rig.screen().includes('search: pasted'), false, rig.screen());
    assert.equal(rig.screen().includes('other'), false, rig.screen());
    rig.type(ENTER);
    await pause();
    assert.deepEqual(answers, ['pasted-choice']);
    assert.ok(rig.screen().includes('A row'), rig.screen());
  });
});
