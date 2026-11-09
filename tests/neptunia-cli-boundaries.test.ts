// The two boundaries of `neptunia` with no terminal: what the shell hands it in argv arrives at the handler byte for byte
// and never meets a shell, and a request that needs a person at a terminal ends at once with what to do instead. A
// panel-only request exits 2 with the explanation and the commands on stderr; a question nobody can answer exits 1 with
// the question on stderr. A secret comes only through `--secret-stdin` on a leaf that asks for one, or a masked prompt at
// a terminal, never as a word of argv. The families of values run in process through bin/neptunia-request.ts; a real
// child proves the rest, with Ink watched through a resolve hook inside it.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  COMMANDS_LINE,
  UnansweredQuestion,
  panelRefusal,
  parseLineRequest,
  parseRequest,
  secretFromStdin,
  unansweredText,
} from '../bin/neptunia-request.ts';
import { startUnitsCore, withRig } from './fixtures/core-units.ts';
import type { Dirs } from './fixtures/core-units.ts';
import { cliFolders, handled, runChild, startRecordingCore } from './fixtures/recording-core.ts';
import type { RecordingCore, Reply } from './fixtures/recording-core.ts';

const T0 = Date.parse('2026-10-31T12:00:00Z');

/** How long a request with nobody to answer it may take (ms), a child's start included. */
const PROMPTLY = 8000;

/** A value that a shell, a line split or a re-quoting would change or run: `$(...)` would create `canary`. */
const nasty = (canary: string): string => `a "b" \`c\` $(touch ${canary}) $HOME 'd' \\e`;

/** What a line split or a trim would change: runs of spaces, a tab, a newline, both ends, and Greek. */
const SPACED = '  lead  double\ttab\nnewline κουνέλι trail ';

const NASTY = nasty('canary');

/** One argv and what must arrive at the handler. */
const BOUNDARIES: ReadonlyArray<{ what: string; argv: ReadonlyArray<string>; name: string; args: unknown }> = [
  {
    what: 'quotes, backticks and dollar syntax in the last argument',
    argv: ['rules', 'add', NASTY],
    name: 'rules.add',
    args: { text: NASTY },
  },
  {
    what: 'spaces, a tab, a newline and both ends of the last argument',
    argv: ['rules', 'add', SPACED],
    name: 'rules.add',
    args: { text: SPACED },
  },
  {
    what: 'spaces inside an argument before the last',
    // Plan 2026-11-04-cli-and-memory task 8 retires `/memory lore`: its writes are place-qualified.
    argv: ['memory', 'places', 'lore', 'add', 'g1', 'The Tower', 'tower, spire', NASTY],
    name: 'memory.places.lore.add',
    args: { place: 'g1', title: 'The Tower', keys: 'tower, spire', text: NASTY },
  },
  {
    what: 'two arguments each holding spaces',
    // Plan 2026-11-04-cli-and-memory task 8 retires `/memory aliases`: its writes live under `/memory users names`.
    argv: ['memory', 'users', 'names', 'add', 'Two Words', 'Νίκος "Νίκη" $(x)'],
    name: 'memory.users.names.add',
    args: { user: 'Two Words', name: 'Νίκος "Νίκη" $(x)' },
  },
  {
    what: 'a setting value with shell syntax',
    argv: ['config', 'set', 'pace.settleMs', NASTY],
    name: 'config.set',
    args: { path: 'pace.settleMs', value: NASTY },
  },
  {
    what: 'spaces in a positional argument and in flag values',
    argv: ['model', 'set', 'memory', 'vendor/model name', '--provider', 'p q', '--effort', 'e "f"'],
    name: 'model.set',
    args: { role: 'memory', model: 'vendor/model name', provider: 'p q', effort: 'e "f"' },
  },
  {
    what: 'a value that looks like a flag on a command without flags',
    argv: ['rules', 'add', '--looks-like-a-flag'],
    name: 'rules.add',
    args: { text: '--looks-like-a-flag' },
  },
  {
    what: 'a value that names a subcommand',
    argv: ['rules', 'add', 'list'],
    name: 'rules.add',
    args: { text: 'list' },
  },
  {
    what: 'loose words after the last argument, joined as the chat joins them',
    argv: ['rules', 'add', 'one', 'two', 'three'],
    name: 'rules.add',
    args: { text: 'one two three' },
  },
  {
    what: 'a value of logs with shell syntax',
    argv: ['logs', 'since', '$(touch canary)'],
    name: 'logs',
    args: { options: 'since $(touch canary)' },
  },
];

for (const { what, argv, name, args } of BOUNDARIES) {
  test(`${what} parse byte for byte`, () => {
    // Catches: argv is joined into a line and split again, which moves a word across arguments, squeezes spaces or trims.
    assert.deepEqual(parseRequest(argv).parsed, { ok: true, name, args });
  });
}

test('one argv word holding a space is no subcommand of two words', () => {
  // Catches: argv is joined before the parse, so the quoted word `lore add` reads as the subcommand `lore.add`.
  const { parsed } = parseRequest(['memory', 'lore add', 'title', 'keys', 'text']);
  assert.equal(parsed.ok, false);
  assert.ok(!parsed.ok && parsed.reason.includes('lore add'), JSON.stringify(parsed));
});

test('an empty last argument is missing and refused', () => {
  // Catches: an empty word from a script's unset variable stores an empty rule.
  const { parsed } = parseRequest(['rules', 'add', '']);
  assert.equal(parsed.ok, false);
  assert.ok(!parsed.ok && parsed.reason.includes('text'), JSON.stringify(parsed));
});

const SECRET = 'sk-or-v1-zeta-SECRETVALUE-0001';

/** The leaves that ask for a secret value, each with the words before the value. */
const SECRET_LEAVES: ReadonlyArray<{ name: string; words: ReadonlyArray<string>; args: unknown }> = [
  // Changed: `keys add` replaces `keys core add` and `keys extra add` (spec 2026-11-09-model-routes).
  { name: 'keys.add', words: ['keys', 'add', 'k1'], args: { name: 'k1' } },
  { name: 'keys.service.set', words: ['keys', 'service', 'set', 'youtube'], args: { name: 'youtube' } },
];

for (const { name, words, args } of SECRET_LEAVES) {
  test(`${name} takes its name and --secret-stdin, and refuses a secret as a word in both forms`, () => {
    // Catches: the last argument's rest rule folds the secret into the name, so it reaches the core, the logs and `ps`.
    assert.deepEqual(parseRequest(words), { parsed: { ok: true, name, args }, secretStdin: false });
    assert.deepEqual(parseRequest([...words, '--secret-stdin']), {
      parsed: { ok: true, name, args },
      secretStdin: true,
    });
    for (const { parsed } of [parseRequest([...words, SECRET]), parseLineRequest(`/${words.join(' ')} ${SECRET}`)]) {
      assert.equal(parsed.ok, false);
      assert.equal(JSON.stringify(parsed).includes(SECRET), false, 'the value is not echoed');
    }
  });
}

test('--secret-stdin on a leaf that asks no secret is a plain value', () => {
  // Catches: the flag is stripped from every command, so a rule that holds those words loses them.
  assert.deepEqual(parseRequest(['rules', 'add', '--secret-stdin']), {
    parsed: { ok: true, name: 'rules.add', args: { text: '--secret-stdin' } },
    secretStdin: false,
  });
});

const QUESTION = 'zeta-which-model?';
const SECRET_QUESTION = 'zeta-key-value:';

test('--secret-stdin answers a secret question with stdin less its one trailing newline', async () => {
  // Catches: the value keeps its newline and is stored broken, or more than one newline is taken off.
  assert.equal(await secretFromStdin(Readable.from([`${SECRET}\n`])).ask(SECRET_QUESTION, true), SECRET);
  assert.equal(await secretFromStdin(Readable.from(['a\n\n'])).ask(SECRET_QUESTION, true), 'a\n');
});

test('--secret-stdin with an empty stdin makes up no answer', async () => {
  // Catches: an unset variable in a script stores an empty key over a working one.
  await assert.rejects(secretFromStdin(Readable.from([])).ask(SECRET_QUESTION, true), UnansweredQuestion);
});

test('--secret-stdin answers no plain question and no second secret', async () => {
  // Catches: a later question is answered with the secret or an empty line, instead of naming what is missing.
  const answers = secretFromStdin(Readable.from([`${SECRET}\n`]));
  await assert.rejects(answers.ask(QUESTION, false), (err: Error) => err.message.includes(QUESTION));
  assert.equal(await answers.ask(SECRET_QUESTION, true), SECRET);
  await assert.rejects(answers.ask(SECRET_QUESTION, true), (err: Error) => !err.message.includes(SECRET));
});

test('an unanswered question names itself, and the channel only when it is secret', () => {
  // Catches: the reply leaves the caller with no way forward, or offers stdin for an answer it would refuse.
  assert.ok(unansweredText(QUESTION, false).includes(QUESTION));
  assert.equal(unansweredText(QUESTION, false).includes('--secret-stdin'), false);
  assert.ok(unansweredText(SECRET_QUESTION, true).includes('--secret-stdin'));
});

test('the explanation of a panel says how to run one command and names the table', () => {
  // Catches: a script is told it needs a terminal and nothing about what runs without one.
  const text = panelRefusal('zeta-panel');
  assert.ok(text.includes('zeta-panel'));
  assert.ok(text.includes('-p'));
  assert.ok(text.includes(COMMANDS_LINE));
});

// What a child alone can prove. One recording core serves them; each test sets what it answers.

let dirs: Dirs;
let core: RecordingCore;
let answer: () => Reply | null = () => null;

before(async () => {
  dirs = cliFolders();
  core = await startRecordingCore(dirs, (command) => answer() ?? handled(command));
});

after(async () => {
  await core.close();
  rmSync(dirs.root, { recursive: true, force: true });
});

/** The recording core emptied, answering with `reply` or with `handled <name>`. */
function fresh(reply: () => Reply | null = () => null): void {
  core.commands.length = 0;
  core.lines.length = 0;
  answer = reply;
}

test('a hostile value reaches the handler whole from a real argv, and no shell runs it', async () => {
  // Catches: the process re-quotes or joins its argv, or a shell sees the value on the way to the socket.
  fresh();
  const canary = join(dirs.root, 'canary');
  const text = `${nasty(canary)}${SPACED}`;
  // Plan 2026-11-04-cli-and-memory task 8 retires `/memory lore`: its writes are place-qualified.
  const run = await runChild(dirs, ['memory', 'places', 'lore', 'add', 'g1', 'The Tower', 'tower, spire', text]);
  assert.equal(run.code, 0, run.stderr.slice(0, 200));
  assert.deepEqual(core.commands, [
    { name: 'memory.places.lore.add', args: { place: 'g1', title: 'The Tower', keys: 'tower, spire', text } },
  ]);
  assert.equal(existsSync(canary), false, 'no shell ran the value');
});

/**
 * The environment that records every module the child resolves into `imports`. The list of a run is never empty, so
 * an empty list means the hook did not run and the assertion on Ink means nothing.
 */
function importProbe(): { env: NodeJS.ProcessEnv; imports(): Array<string> } {
  const log = join(dirs.root, 'imports');
  const probe = join(dirs.root, 'probe.mjs');
  rmSync(log, { force: true });
  writeFileSync(
    probe,
    `import { appendFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, next) {
    appendFileSync(${JSON.stringify(log)}, specifier + '\\n');
    return next(specifier, context);
  },
});
`
  );
  return {
    env: { NODE_OPTIONS: `--import=${probe}` },
    imports: () => readFileSync(log, 'utf8').split('\n').filter(Boolean),
  };
}

const PANELS: ReadonlyArray<{ what: string; argv: ReadonlyArray<string> }> = [
  { what: 'the chat with no arguments', argv: [] },
  { what: '-p /setup', argv: ['-p', '/setup'] },
  { what: 'neptunia clear', argv: ['clear'] },
];

for (const { what, argv } of PANELS) {
  test(`${what} with no terminal and an open input explains itself at once, with no Ink, line or command`, async () => {
    // Catches: the request waits on a pipe nobody writes to, tries Ink, or answers nothing at all.
    fresh();
    const probe = importProbe();
    // The plain chat over a pipe is asked for by name; a request that did not ask for it gets the explanation.
    const env = { ...probe.env, NEPTUNIA_PLAIN_CHAT: undefined };
    const run = await runChild(dirs, argv, { env, open: true, ms: PROMPTLY });
    assert.equal(run.code, 2, `${run.stderr.slice(0, 200)}${run.stdout.slice(0, 200)}`);
    assert.equal(run.stdout, '');
    assert.ok(run.stderr.includes(COMMANDS_LINE), 'the explanation names the table');
    assert.deepEqual(core.commands, []);
    assert.deepEqual(core.lines, [], 'no model turn');
    const imports = probe.imports();
    assert.ok(imports.length > 0, 'the import probe ran');
    assert.deepEqual(
      imports.filter((one) => one === 'ink' || one.endsWith('interfaces/cli/index.ts')),
      [],
      'Ink is not loaded'
    );
  });
}

test('a secret given as a word exits 2 from a real argv, reaches no core and is not echoed', async () => {
  // Catches: the process prints the refused argv back, or sends the command before it is refused.
  fresh();
  const run = await runChild(dirs, ['keys', 'add', 'k1', SECRET]);
  assert.equal(run.code, 2, run.stderr.slice(0, 200));
  assert.deepEqual(core.commands, []);
  assert.equal((run.stdout + run.stderr).includes(SECRET), false);
});

test('a secret question with no terminal exits 1 at once, names the channel and leaves stdin unread', async () => {
  // Catches: the question waits on a pipe that stays open, or whatever is on the pipe is sent as the key value.
  fresh(() => ({ status: 'ask', text: SECRET_QUESTION, dialogId: 'dialog-1', prompt: SECRET_QUESTION, secret: true }));
  const run = await runChild(dirs, ['keys', 'add', 'k1'], { input: `${SECRET}\n`, open: true, ms: PROMPTLY });
  assert.equal(run.code, 1, run.stderr.slice(0, 200));
  assert.equal(run.stdout, '');
  assert.ok(run.stderr.includes(SECRET_QUESTION), 'the missing input is named');
  assert.ok(run.stderr.includes('--secret-stdin'), run.stderr.slice(0, 200));
  assert.equal(core.commands.length, 1, 'stdin was not sent as the answer');
  assert.equal((run.stdout + run.stderr).includes(SECRET), false);
});

test('the real handler stores a token given through --secret-stdin, and prints none of it', async () => {
  // Catches: the channel parses but the real dialog broker never gets the answer, or the value is echoed.
  await withRig({}, async ({ dirs: rig, llm, cores }) => {
    cores.push(await startUnitsCore(rig, llm, () => T0));
    // Changed: `/interfaces token set` is gone, so a service key stands for the real handler behind the dialog.
    const run = await runChild(rig, ['keys', 'service', 'set', 'youtube', '--secret-stdin'], { input: `${SECRET}\n` });
    assert.equal(run.code, 0, run.stderr.slice(0, 200));
    const file = join(rig.privateDir, 'keys.json');
    assert.equal(
      (JSON.parse(readFileSync(file, 'utf8')) as { services?: { youtube?: string } }).services?.youtube,
      SECRET
    );
    assert.equal((run.stdout + run.stderr).includes(SECRET), false);
  });
});

test('interface run cli exits 2, says to run neptunia and connects to no core', async () => {
  // Catches: the unit runner starting the owner's terminal chat as a unit with no terminal, now that the package
  // exports start(host).
  fresh();
  const before = core.connections();
  const run = await runChild(dirs, ['interface', 'run', 'cli'], { ms: PROMPTLY });
  assert.equal(run.code, 2, run.stderr.slice(0, 200));
  assert.equal(run.stdout, '');
  assert.ok(run.stderr.includes('run neptunia'), run.stderr);
  assert.equal(core.connections(), before, 'no link was opened');
});
