// The two boundaries of `neptunia` with no terminal: what the shell hands it in argv arrives at the handler byte for byte
// and never meets a shell, and a request that needs a person at a terminal ends at once with what to do instead. A
// panel-only request exits 2 with the explanation and the commands on stderr; a question nobody can answer exits 1 with
// the question on stderr. A secret comes only through `--secret-stdin` on a leaf that asks for one, or a masked prompt at
// a terminal, never as a word of argv. The families of values run in process through bin/neptunia-request.ts, and
// the matrix of the table's leaves parses into what each leaf's own arguments say. tests/bin/neptunia.test.ts holds
// what a real child proves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  COMMANDS_LINE,
  UnansweredQuestion,
  panelRefusal,
  parseLineRequest,
  parseRequest,
  secretFromStdin,
  unansweredText,
  COMMAND_NAMES,
} from '../../bin/neptunia-request.ts';
import { COMMANDS } from '../../src/interface/commands/table.ts';
import type { CommandArg, Parsed } from '../../src/interface/commands/table.ts';

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
    // The writes of lore are place-qualified.
    argv: ['memory', 'places', 'lore', 'add', 'g1', 'The Tower', 'tower, spire', NASTY],
    name: 'memory.places.lore.add',
    args: { place: 'g1', title: 'The Tower', keys: 'tower, spire', text: NASTY },
  },
  {
    what: 'two arguments each holding spaces',
    // The writes of names live under `/memory users names`.
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
  // `keys add` is the one leaf that adds a key.
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

/** Values the table's `check` of a leaf requires, for a leaf whose free sample it would refuse. */
const SAMPLES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  logs: { options: 'errors' },
  // A setup leaf takes one mode, so its sample names the flags it uses.
  'services.heartbeat.setup': { every: '6h', jitter: '30m' },
  'services.diary.setup': { every: '6h' },
  // The role of `/model sources` and `/model set` is checked against the roles and the agents on disk.
  'model.sources': { role: 'scout' },
  'model.set': { role: 'scout' },
  // `/tools grant` and `/tools revoke` take no target, so they need no sample.
};

/** One leaf: its dotted name, a representative argv and the arguments that argv must parse into. */
type Leaf = { name: string; argv: Array<string>; args: Record<string, string> };

function leafOf(name: string, every: ReadonlyArray<CommandArg>): Leaf {
  // A flag the leaf's sample leaves out is not typed: the modes of `services <name> setup` exclude each other.
  const named = SAMPLES[name];
  const args = every.filter((one) => one.flag === undefined || named === undefined || Object.hasOwn(named, one.name));
  const sample = (one: CommandArg): string => SAMPLES[name]?.[one.name] ?? one.choices?.[0] ?? `sample-${one.name}`;
  return {
    name,
    argv: [
      ...name.split('.'),
      ...args.filter((one) => one.flag === undefined).map(sample),
      ...args.flatMap((one) => (one.flag === undefined ? [] : [one.flag, sample(one)])),
    ],
    args: Object.fromEntries(args.map((one) => [one.name, sample(one)])),
  };
}

/**
 * Every leaf of the table but the `/interfaces` family, whose interface comes before its command: the subcommand's
 * words cannot spell it, so INTERFACE_FORMS below lists its forms.
 */
const LEAVES: ReadonlyArray<Leaf> = COMMANDS.filter((command) => command.name !== 'interfaces').flatMap((command) =>
  command.subcommands.length === 0
    ? [leafOf(command.name, command.args)]
    : command.subcommands.map((one) => leafOf(`${command.name}.${one.name}`, one.args))
);

/** The forms of the `/interfaces` family as argv, with the operation each parses into and the values it carries. */
const INTERFACE_FORMS: ReadonlyArray<{ argv: Array<string>; name: string; values: Array<string> }> = [
  { argv: ['interfaces', 'zeta71', 'setup'], name: 'interfaces.setup', values: [] },
  { argv: ['interfaces', 'zeta71', 'settings'], name: 'interfaces.settings', values: [] },
  { argv: ['interfaces', 'zeta71', 'set', 'token'], name: 'interfaces.set', values: ['token'] },
  { argv: ['interfaces', 'zeta71', 'clear', 'token'], name: 'interfaces.clear', values: ['token'] },
  { argv: ['interfaces', 'zeta71', 'add', 'servers', '111'], name: 'interfaces.add', values: ['servers', '111'] },
  { argv: ['interfaces', 'zeta71', 'remove', 'servers', '111'], name: 'interfaces.remove', values: ['servers', '111'] },
  { argv: ['interfaces', 'zeta71', 'enable'], name: 'interfaces.enable', values: [] },
  { argv: ['interfaces', 'zeta71', 'disable'], name: 'interfaces.disable', values: [] },
  { argv: ['interfaces', 'zeta71', 'invite'], name: 'interfaces.invite', values: [] },
  { argv: ['interfaces', 'zeta71', 'list'], name: 'interfaces.roots', values: [] },
];

for (const { argv, name, values } of INTERFACE_FORMS) {
  test(`${argv.join(' ')} parses into ${name} in the shell and in -p`, () => {
    // Catches: the shell form and the line of the chat reading the family in two orders, or a value lost on the way.
    for (const { parsed } of [parseRequest(argv), parseLineRequest(`/${argv.join(' ')}`)]) {
      assert.ok(parsed.ok, JSON.stringify(parsed));
      assert.equal(parsed.name, name);
      assert.equal(parsed.args.name, 'zeta71');
      for (const value of values) assert.ok(Object.values(parsed.args).includes(value), `${name} carries ${value}`);
    }
  });
}

for (const argv of [
  ['interfaces', 'zeta71', 'pair'],
  ['interfaces', 'zeta71', 'accept', 'g7'],
  ['interfaces', 'zeta71', 'remove', 'g7'],
]) {
  test(`${argv.join(' ')} is no command in the shell or in -p`, () => {
    // Pairing, accept and remove are no commands. Catches: a removed command still parsed.
    for (const { parsed } of [parseRequest(argv), parseLineRequest(`/${argv.join(' ')}`)])
      assert.equal(parsed.ok, false);
  });
}

test('interfaces set takes its secret from stdin with the interface first', () => {
  // Catches: `--secret-stdin` read as the value of the setting once the words move, so the key lands on the line.
  const { parsed, secretStdin } = parseRequest(['interfaces', 'zeta71', 'set', 'token', '--secret-stdin']);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  assert.equal(parsed.name, 'interfaces.set');
  assert.equal(secretStdin, true);
  assert.equal(Object.values(parsed.args).includes('--secret-stdin'), false);
});

for (const leaf of LEAVES) {
  test(`${leaf.argv.join(' ')} parses into ${leaf.name}`, () => {
    // Catches: a leaf the direct form cannot spell, or an argument that lands under another name.
    const { parsed } = parseRequest(leaf.argv);
    assert.deepEqual(parsed, { ok: true, name: leaf.name, args: leaf.args });
  });
}

for (const command of COMMANDS) {
  test(`${command.name} typed bare parses as the table says`, () => {
    // Catches: a bare `neptunia rules` or `neptunia interface` differs from the bare line of the chat.
    const { parsed } = parseRequest([command.name]);
    if (command.needsSubcommand === true) {
      assert.equal(parsed.ok, false);
      assert.ok(!parsed.ok && parsed.reason.includes(command.name), JSON.stringify(parsed));
      return;
    }
    const name =
      command.defaultSubcommand === undefined ? command.name : `${command.name}.${command.defaultSubcommand}`;
    assert.deepEqual(parsed, { ok: true, name, args: {} });
  });
}

test('an interfaces word the table does not name is refused with that word', () => {
  // No interface has commands of its own, so the parser refuses the word itself. Catches: a stray word parses and
  // reaches the core as a command. The first word after the family is the interface's name, so the reason may name
  // the command word that no interface has, or the name.
  const { parsed } = parseRequest(['interfaces', 'zeta71', 'sync', 'all', 'now']);
  assert.equal(parsed.ok, false);
  assert.ok(!parsed.ok && /sync|zeta71/.test(parsed.reason), JSON.stringify(parsed));
});

/** Each line the table refuses, with a word its reason must hold: the wrong word, or the argument that is missing. */
const BAD_SYNTAX: ReadonlyArray<{ argv: ReadonlyArray<string>; names: string }> = [
  { argv: ['rules', 'add'], names: 'text' },
  { argv: ['usage', '90d'], names: '90d' },
  { argv: ['doctor', 'disks'], names: 'disks' },
  { argv: ['memory', 'no-such-sub'], names: 'no-such-sub' },
  { argv: ['model', 'set', 'no-such-role'], names: 'no-such-role' },
  { argv: ['config', 'set', 'only.path'], names: 'value' },
  { argv: ['model', 'set', 'memory', 'some-model', '--no-such-flag', 'x'], names: '--no-such-flag' },
];

for (const { argv, names } of BAD_SYNTAX) {
  test(`${argv.join(' ')} is refused in both forms, its reason naming ${names}`, () => {
    // Catches: a refused line runs the handler, or a reason that does not say what is wrong with it.
    for (const { parsed } of [parseRequest(argv), parseLineRequest(`/${argv.join(' ')}`)]) {
      assert.equal(parsed.ok, false);
      assert.ok(!parsed.ok && parsed.reason.includes(names), JSON.stringify(parsed));
    }
  });
}

for (const argv of [['frobnicate'], ['hello', 'there'], ['rules add', 'x'], ['/rules', 'list']]) {
  test(`${JSON.stringify(argv[0])} is no word of the table`, () => {
    // Catches: the dispatcher's list of table words grows a word that is not a command, or strips a slash from argv.
    assert.equal(COMMAND_NAMES.includes(argv[0] ?? ''), false);
    assert.equal(parseRequest(argv).parsed.ok, false);
  });
}

test('the commands line of the usage names every command of the table', () => {
  // Catches: the usage hides commands, so a script that mistypes one learns nothing.
  for (const command of COMMANDS) assert.ok(COMMANDS_LINE.includes(command.name), command.name);
});

type Ok = Extract<Parsed, { ok: true }>;

/** The parse, which must have stood. */
function assertAccepted(parsed: Parsed): Ok {
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.reason);
  return parsed;
}

/** The reason of a refusal, which must have happened. */
function assertRefused(parsed: Parsed): string {
  assert.equal(parsed.ok, false, JSON.stringify(parsed));
  return parsed.ok ? '' : parsed.reason;
}

test('a key never goes on the command line of keys add, and stdin takes it', () => {
  // `keys add` stands for the leaf that only asks its secret.
  // Catches: the secret leaf loses its mark, so the value is parsed, echoed in a reason or kept in history.
  const reason = assertRefused(parseRequest(['keys', 'add', 'zeta71', 'sekret-71']).parsed);
  assert.equal(reason.includes('sekret-71'), false, reason);
  const stdin = parseRequest(['keys', 'add', 'zeta71', '--secret-stdin']);
  assert.equal(stdin.secretStdin, true);
  assert.equal(assertAccepted(stdin.parsed).args.name, 'zeta71');
  assert.equal(parseRequest(['keys', 'add', 'zeta71']).secretStdin, false);
});

test('--secret-stdin on a leaf that asks for no secret stays plain text', () => {
  // Catches: the new families take the flag as a switch where it is an ordinary word.
  // The plain leaf under test is `/memory recent`.
  const request = parseRequest(['memory', 'recent', '--secret-stdin']);
  assert.equal(request.secretStdin, false);
});
