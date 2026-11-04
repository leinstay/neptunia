// cli/app.ts drawn into a fake terminal: an offline visual fixture with no core and no provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable, Readable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { runInteractive } from '../cli/index.ts';
import type { ChatEnv, ChatEntry, Question } from '../cli/index.ts';

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

const pause = (ms = 60): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
    send: (line) => sent.push(line),
    panelOf: (line) =>
      Promise.resolve(
        line === '/help' ? { title: 'Help', lines: ['status the summary', 'keys the model keys'] } : null
      ),
    subscribe: (given) => Object.assign(listeners, given),
    status: () =>
      Promise.resolve({
        core: { state: 'running', reason: null },
        memory: { path: 'direct', model: null, probe: 'ok', checkedAt: 1 },
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

test("the screen shows the galaxy, the status line, and a typed line reaches the core with the owner's history saved", async () => {
  // Bug: the chat draws nothing without a core's answer, or a line never reaches the link.
  const { env, sent, saved } = envOf();
  await withChat(env, async (rig) => {
    assert.match(rig.frames(), /neptunia/);
    assert.match(rig.frames(), /@/);
    await pause();
    // The header presents each status on its own readable line.
    assert.match(rig.frames(), /Core: running/);
    rig.type('γεια');
    await pause();
    rig.type('\r');
    await pause();
  });
  assert.deepEqual(sent, ['γεια']);
  assert.deepEqual(saved.at(-1), ['γεια']);
});

test('the input stays at the terminal bottom when the conversation is empty and the terminal grows', async () => {
  // Bug: an empty conversation leaves the input below the header instead of at the terminal bottom.
  const { env } = envOf();
  await withChat(env, async (rig) => {
    rig.type('bottom-input');
    await pause();
    assert.equal(
      rig.screen().findIndex((line) => line.includes('> bottom-input')),
      rig.stdout.rows - 3
    );
    rig.stdout.rows = 32;
    rig.stdout.emit('resize');
    await pause();
    assert.equal(
      rig.screen().findIndex((line) => line.includes('> bottom-input')),
      rig.stdout.rows - 3
    );
  });
});

test('a slash opens its menu with descriptions, and a panel opens with its search', async () => {
  // Bug: the slash menu lists commands that do not exist, or `/help` goes to the model as a chat line.
  const { env, sent } = envOf();
  await withChat(env, async (rig) => {
    rig.type('/');
    await pause();
    assert.match(rig.frames(), /\/status {2}the short summary/);
    rig.type('help');
    await pause();
    rig.type('\r');
    await pause(120);
    assert.match(rig.frames(), /search:/);
    rig.type('keys');
    await pause();
    assert.match(rig.frames(), /keys the model keys/);
    rig.type('\u001b');
    await pause(120);
  });
  assert.deepEqual(sent, []);
});

test('a secret question draws stars, its answer stays out of the history and off the screen', async () => {
  // Bug: a pasted key shows in the terminal or lands in the history file.
  const { env, saved, listeners } = envOf();
  let answer = '';
  await withChat(env, async (rig) => {
    listeners.question?.({ question: 'The key:', secret: true, answer: (text) => (answer = text) });
    await pause();
    rig.type('sk-secret');
    await pause();
    assert.match(rig.frames(), /\*{9}/);
    rig.type('\r');
    await pause();
    assert.equal(rig.frames().includes('sk-secret'), false);
  });
  assert.equal(answer, 'sk-secret');
  assert.deepEqual(saved, []);
});

test('clearing the display sends nothing to the core', async () => {
  // Bug: `/clear` reaches the model, or wipes her memory.
  const { env, sent, listeners } = envOf();
  await withChat(env, async (rig) => {
    listeners.entry?.({ who: 'her', text: 'μια απάντηση' });
    await pause();
    rig.type('/clear');
    await pause();
    rig.type('\r');
    await pause();
  });
  assert.deepEqual(sent, []);
});

test('panel navigation toggles a setting, edits another value and returns to chat without sending either to the model', async () => {
  // Bug: Enter only filters a text panel, or a settings edit is sent as conversation text.
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
    await pause();
    rig.type('\r');
    await pause(100);
    rig.type('\r');
    await pause(100);
    rig.type('\u001b[B');
    await pause();
    rig.type('\r');
    await pause();
    rig.type('new name');
    await pause();
    rig.type('\r');
    await pause(100);
    rig.type('\u001b');
    await pause();
  });
  assert.deepEqual(changed, ['true', 'new name']);
  assert.deepEqual(sent, []);
});

test('setup choices use arrows and Enter, while secret answers never appear in terminal output', async () => {
  // Bug: setup loses the selected option, or its independent secret dialog echoes a key.
  const { askQuestion } = await import('../cli/question.ts');
  const rig = terminal();
  const streams = { stdin: rig.stdin as never, stdout: rig.stdout as never };
  const choice = askQuestion('Enable heartbeat?', 'off', { choices: ['on', 'off'] }, streams);
  await pause();
  rig.type('\u001b[A');
  await pause();
  rig.type('\r');
  assert.equal(await choice, 'on');
  const secret = askQuestion('Service key', null, { secret: true }, streams);
  await pause();
  rig.type('private-value');
  await pause();
  rig.type('\r');
  assert.equal(await secret, 'private-value');
  assert.equal(rig.frames().includes('private-value'), false);
});
