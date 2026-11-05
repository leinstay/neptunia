// Tests for bin/secret-prompt.ts: the questions a command asks in the chat, through a fake terminal (a stream that says
// it is a TTY, read by a real readline interface). A secret answer is drawn as stars only, edited by backspace, aborted
// by Ctrl-C, and kept out of the interface's history; an ordinary answer is echoed like any typed line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import { createAnswers, mutableOutput } from '../bin/secret-prompt.ts';

/** A terminal: what the owner types goes into `stdin`, what is drawn comes out of `shown()`. */
function terminal() {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin });
  const stdout = new PassThrough();
  let drawn = '';
  stdout.on('data', (chunk: Buffer) => (drawn += chunk.toString()));
  const output = mutableOutput(stdout);
  const previousTerm = process.env.TERM;
  let rl: readline.Interface;
  try {
    // Readline chooses its backspace handler at construction from TERM, so the fake terminal supplies it.
    process.env.TERM = 'xterm-256color';
    rl = readline.createInterface({ input: stdin, output, terminal: true, history: ['/status'] });
  } finally {
    if (previousTerm === undefined) delete process.env.TERM;
    else process.env.TERM = previousTerm;
  }
  const answers = createAnswers({ rl, input: stdin, output, target: stdout });
  const commands: Array<string> = [];
  const historyWhileSecret: Array<boolean> = [];
  rl.on('history', () => historyWhileSecret.push(answers.secretWaiting()));
  rl.on('line', (line) => {
    if (!answers.take(line)) commands.push(line);
  });
  const type = async (text: string): Promise<void> => {
    stdin.write(text);
    await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    rl,
    answers,
    type,
    shown: () => drawn,
    commands,
    historyWhileSecret,
    historyOf: () => [...(rl as unknown as { history: Array<string> }).history],
  };
}

test('a secret answer is drawn as one star per character, backspace takes one away, and no typed character is shown', async () => {
  const term = terminal();
  const asked = term.answers.ask('Paste the key.', true);
  await term.type('78');
  await term.type('\x7f');
  await term.type('90');
  await term.type('\r');
  assert.equal(await asked, '790');
  // Bug caught: the terminal's own echo of the typed key, which a recording of the screen then keeps.
  assert.ok(!/[0-9]/.test(term.shown()), `nothing typed is shown: ${JSON.stringify(term.shown())}`);
  assert.equal((term.shown().match(/\*/g) ?? []).length, 4, 'two stars, one taken back, two more');
  assert.ok(term.shown().includes('\b \b'), 'backspace erases a star');
  term.rl.close();
});

test('a secret answer is not kept in the interface history, and the history event fires while the secret waits', async () => {
  const term = terminal();
  const asked = term.answers.ask('Paste the key.', true);
  await term.type('4242\r');
  await asked;
  // Bug caught: the key kept as the newest history line, written to the history file and recalled with the arrow key.
  assert.deepEqual(term.historyOf(), ['/status']);
  assert.deepEqual(term.historyWhileSecret, [true], 'the chat can see it must not write its history file');
  assert.deepEqual(term.commands, [], 'the answer was never a command');
  term.rl.close();
});

test('an ordinary answer is echoed, and the next line after the answers is a command again', async () => {
  const term = terminal();
  const asked = term.answers.ask('Model?', false);
  await term.type('abc\r');
  assert.equal(await asked, 'abc');
  assert.ok(term.shown().includes('abc'));
  await term.type('/status\r');
  assert.deepEqual(term.commands, ['/status']);
  assert.ok(term.shown().includes('/status'), 'the echo is back after a secret or an ordinary question');
  term.rl.close();
});

test('echo is back after a secret answer', async () => {
  const term = terminal();
  const asked = term.answers.ask('Paste the key.', true);
  await term.type('1\r');
  await asked;
  await term.type('/doctor\r');
  assert.ok(term.shown().includes('/doctor'));
  term.rl.close();
});

test('Ctrl-C ends a secret question with an empty answer', async () => {
  const term = terminal();
  const asked = term.answers.ask('Paste the key.', true);
  await term.type('12');
  await term.type('\x03');
  assert.equal(await asked, '');
  assert.equal(term.answers.secretWaiting(), false);
  term.rl.close();
});

test('the end of the input ends a waiting secret question with an empty answer', async () => {
  const term = terminal();
  const asked = term.answers.ask('Paste the key.', true);
  term.rl.close();
  assert.equal(await asked, '');
});
