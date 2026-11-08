// cli/app.ts drawn into a fake terminal: an offline visual fixture with no core and no provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable, Readable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { runInteractive } from '../cli/index.ts';
import type { ChatEnv, ChatEntry, Question } from '../cli/index.ts';
import { until } from './fixtures/chat-rig.ts';

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
    // The header of 2026-11-08 says `active` for a running core: the word of this assertion follows it.
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
    // The input row stood three rows from the bottom over a strip of key hints. The strip is gone (the chat follows
    // Claude Code, which has none), so the input row stood second from the bottom. The owner's status row of 2026-11-08
    // stands under the box's lower border, so the input row is the third from the bottom.
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
  // A row is matched by its text, not as the whole row: since the owner's word of 2026-11-08 the first row of a line
  // carries the lead `[time] [#N] ` and its later rows start in the column of its text.
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
  // A panel of lines alone is a command's text answer since the owner's word of 2026-11-08, kept in the command window's
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
  // Bug: `/clear` reaches the model, or wipes her memory.
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
  const { askQuestion } = await import('../cli/question.ts');
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
