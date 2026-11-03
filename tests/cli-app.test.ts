// cli/app.ts drawn into a fake terminal: an offline visual fixture with no core and no provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable, Readable } from 'node:stream';
import { runInteractive } from '../cli/index.ts';
import type { ChatEnv, ChatEntry, Question } from '../cli/index.ts';

function terminal(columns = 80) {
  let frames = '';
  const stdout = Object.assign(
    new Writable({
      write(chunk: Buffer | string, _encoding, done) {
        frames += String(chunk);
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
  return { stdout, stdin, type, frames: () => frames };
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
  await body(rig);
  rig.type('\u0003');
  await running;
}

test("the screen shows the galaxy, the status line, and a typed line reaches the core with the owner's history saved", async () => {
  // Bug: the chat draws nothing without a core's answer, or a line never reaches the link.
  const { env, sent, saved } = envOf();
  await withChat(env, async (rig) => {
    assert.match(rig.frames(), /neptunia/);
    assert.match(rig.frames(), /@/);
    await pause();
    assert.match(rig.frames(), /core: running/);
    rig.type('γεια');
    await pause();
    rig.type('\r');
    await pause();
  });
  assert.deepEqual(sent, ['γεια']);
  assert.deepEqual(saved.at(-1), ['γεια']);
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
