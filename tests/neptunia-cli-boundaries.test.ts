// The two boundaries of `neptunia` run as a child with no terminal: what the shell hands it in argv arrives at the
// handler byte for byte and never meets a shell, and a request that needs a person at a terminal ends at once with what
// to do instead. A panel-only request exits 2 with the explanation and the commands on stderr; a question nobody can
// answer exits 1 with the question on stderr. A secret comes only through `--secret-stdin` on a leaf that asks for one,
// or a masked prompt at a terminal, never as a word of argv. Ink is watched through a resolve hook in the child.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMMANDS, parseCommandLine } from '../src/interface/commands/table.ts';
import { runCli, startUnitsCore, withRig } from './fixtures/core-units.ts';
import type { Dirs } from './fixtures/core-units.ts';
import { cliFolders, handled, runChild, withRecordingCore } from './fixtures/recording-core.ts';
import type { Received, Reply } from './fixtures/recording-core.ts';

const T0 = Date.parse('2026-10-31T12:00:00Z');

/** How long a request with nobody to answer it may take (ms), a child's start included. */
const PROMPTLY = 8000;

/** A value that a shell, a line split or a re-quoting would change or run: `$(...)` would create `canary`. */
const nasty = (canary: string): string => `a "b" \`c\` $(touch ${canary}) $HOME 'd' \\e`;

/** What a line split or a trim would change: runs of spaces, a tab, a newline, both ends, and Greek. */
const SPACED = '  lead  double\ttab\nnewline κουνέλι trail ';

/** One argv and what must arrive at the handler. */
type Boundary = { what: string; argv(canary: string): Array<string>; name: string; args(canary: string): unknown };

const BOUNDARIES: ReadonlyArray<Boundary> = [
  {
    what: 'quotes, backticks and dollar syntax in the last argument',
    argv: (canary) => ['rules', 'add', nasty(canary)],
    name: 'rules.add',
    args: (canary) => ({ text: nasty(canary) }),
  },
  {
    what: 'spaces, a tab, a newline and both ends of the last argument',
    argv: () => ['rules', 'add', SPACED],
    name: 'rules.add',
    args: () => ({ text: SPACED }),
  },
  {
    what: 'spaces inside an argument before the last',
    argv: (canary) => ['memory', 'lore', 'add', 'The Tower', 'tower, spire', nasty(canary)],
    name: 'memory.lore.add',
    args: (canary) => ({ title: 'The Tower', keys: 'tower, spire', text: nasty(canary) }),
  },
  {
    what: 'two arguments each holding spaces',
    argv: () => ['memory', 'aliases', 'add', 'Two Words', 'Νίκος "Νίκη" $(x)'],
    name: 'memory.aliases.add',
    args: () => ({ user: 'Two Words', name: 'Νίκος "Νίκη" $(x)' }),
  },
  {
    what: 'a setting value with shell syntax',
    argv: (canary) => ['config', 'set', 'pace.settleMs', nasty(canary)],
    name: 'config.set',
    args: (canary) => ({ path: 'pace.settleMs', value: nasty(canary) }),
  },
  {
    what: 'spaces in a positional argument and in flag values',
    argv: () => ['model', 'set', 'memory', 'vendor/model name', '--provider', 'p q', '--effort', 'e "f"'],
    name: 'model.set',
    args: () => ({ role: 'memory', model: 'vendor/model name', provider: 'p q', effort: 'e "f"' }),
  },
  {
    what: 'a value that looks like a flag on a command without flags',
    argv: () => ['rules', 'add', '--looks-like-a-flag'],
    name: 'rules.add',
    args: () => ({ text: '--looks-like-a-flag' }),
  },
  {
    what: 'a value that names a subcommand',
    argv: () => ['rules', 'add', 'list'],
    name: 'rules.add',
    args: () => ({ text: 'list' }),
  },
  {
    what: 'loose words after the last argument, joined as the chat joins them',
    argv: () => ['rules', 'add', 'one', 'two', 'three'],
    name: 'rules.add',
    args: () => ({ text: 'one two three' }),
  },
];

for (const boundary of BOUNDARIES) {
  test(`${boundary.what} arrive byte for byte and run no shell`, async () => {
    // Catches: argv is joined into a line and split again, which moves a word across arguments, squeezes spaces or trims
    // a value, or a shell sees the value and runs it.
    await withRecordingCore(handled, async ({ dirs, core }) => {
      const canary = join(dirs.root, 'canary');
      const run = await runChild(dirs, boundary.argv(canary));
      assert.equal(run.code, 0, run.stderr.slice(0, 200));
      assert.deepEqual(core.commands, [{ name: boundary.name, args: boundary.args(canary) }]);
      assert.equal(existsSync(canary), false, 'no shell ran the value');
    });
  });
}

test('one argv word holding a space is no subcommand of two words', async () => {
  // Catches: argv is joined before the parse, so the quoted word `lore add` reads as the subcommand `lore.add`.
  await withRecordingCore(handled, async ({ dirs, core }) => {
    const run = await runChild(dirs, ['memory', 'lore add', 'title', 'keys', 'text']);
    assert.equal(run.code, 2, run.stderr.slice(0, 200));
    assert.ok(run.stderr.includes('lore add'), 'the refusal names the word as it came');
    assert.deepEqual(core.commands, []);
  });
});

test('an empty last argument is missing, as the table says, and reaches no handler', async () => {
  // Catches: an empty word from a script's unset variable stores an empty rule.
  const refused = parseCommandLine('/rules add');
  assert.equal(refused.ok, false);
  await withRecordingCore(handled, async ({ dirs, core }) => {
    const run = await runChild(dirs, ['rules', 'add', '']);
    assert.equal(run.code, 2, run.stderr.slice(0, 200));
    assert.ok(run.stderr.includes(refused.ok ? '' : refused.reason), run.stderr.slice(0, 200));
    assert.deepEqual(core.commands, []);
  });
});

test('the rule of the plan is stored whole by the real handler', async () => {
  // Catches: the value survives the parser and is cut or re-quoted on its way into the rules.
  const rule = 'a "b" `c` $(d)';
  await withRig({}, async ({ dirs, llm, cores }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const added = await runCli(dirs, ['rules', 'add', rule]);
    assert.equal(added.code, 0, added.stderr.slice(0, 200));
    const listed = await runCli(dirs, ['rules', 'list']);
    assert.ok(listed.stdout.includes(rule), listed.stdout);
    assert.equal(llm.requests.length, 0);
  });
});

test('a value of neptunia logs reaches journalctl as words, with no shell between', async () => {
  // Catches: the local command builds a shell line, so a value given to `since` runs.
  const dirs = cliFolders();
  const canary = join(dirs.root, 'canary');
  const args = join(dirs.root, 'args');
  writeFileSync(join(dirs.root, 'journalctl'), `#!/bin/sh\nfor a in "$@"; do echo "$a"; done > ${args}\n`, {
    mode: 0o755,
  });
  const value = `$(touch ${canary})`;
  const run = await runChild(dirs, ['logs', 'since', value], { env: { PATH: dirs.root } });
  assert.equal(run.code, 0, run.stderr.slice(0, 200));
  assert.ok(readFileSync(args, 'utf8').split('\n').includes(value), 'the value is one word of journalctl');
  assert.equal(existsSync(canary), false);
});

/**
 * The environment that records every module the child resolves into `imports`. The list of a run is never empty, so
 * an empty list means the hook did not run and the assertion on Ink means nothing.
 */
function importProbe(dirs: Dirs): { env: NodeJS.ProcessEnv; imports(): Array<string> } {
  const log = join(dirs.root, 'imports');
  const probe = join(dirs.root, 'probe.mjs');
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

/** Asserts the answer to a panel-only request: exit 2, the commands on stderr, no Ink, no line, no command. */
async function assertExplainsThePanel(argv: ReadonlyArray<string>, open: boolean): Promise<void> {
  await withRecordingCore(handled, async ({ dirs, core }) => {
    const probe = importProbe(dirs);
    // The plain chat over a pipe is asked for by name; a request that did not ask for it gets the explanation.
    const env = { ...probe.env, NEPTUNIA_PLAIN_CHAT: undefined };
    const run = await runChild(dirs, argv, { env, open, ms: PROMPTLY });
    assert.equal(run.code, 2, `${run.stderr.slice(0, 200)}${run.stdout.slice(0, 200)}`);
    assert.equal(run.stdout, '');
    assert.ok(run.stderr.includes('-p'), 'the explanation says how to run one command');
    for (const command of COMMANDS) assert.ok(run.stderr.includes(command.name), `it names ${command.name}`);
    assert.deepEqual(core.commands, []);
    assert.deepEqual(core.lines, [], 'no model turn');
    const imports = probe.imports();
    assert.ok(imports.length > 0, 'the import probe ran');
    assert.deepEqual(
      imports.filter((one) => one === 'ink' || one.endsWith('cli/index.ts')),
      [],
      'Ink is not loaded'
    );
  });
}

const PANELS: ReadonlyArray<{ what: string; argv: ReadonlyArray<string> }> = [
  { what: 'the chat with no arguments', argv: [] },
  { what: '-p /setup', argv: ['-p', '/setup'] },
  { what: '-p /clear', argv: ['-p', '/clear'] },
  { what: 'neptunia clear', argv: ['clear'] },
];

for (const { what, argv } of PANELS) {
  test(`${what} with no terminal and an open input explains itself at once`, () =>
    // Catches: the request waits on a pipe nobody writes to, tries Ink, or answers nothing at all.
    assertExplainsThePanel(argv, true));
}

test('the chat with no arguments and an input already at its end explains itself at once', () =>
  // Catches: an empty input reads as a chat that ended well, exit 0 with nothing said.
  assertExplainsThePanel([], false));

test('the chat with no terminal explains itself the same with no core listening', async () => {
  // Catches: the explanation depends on the core, so a script with the core down hears only that no core listens.
  const run = await runChild(cliFolders(), [], { env: { NEPTUNIA_PLAIN_CHAT: undefined }, open: true, ms: PROMPTLY });
  assert.equal(run.code, 2, run.stderr.slice(0, 200));
  for (const command of COMMANDS) assert.ok(run.stderr.includes(command.name), `it names ${command.name}`);
});

/** A core that asks `prompts` in order, each secret or not by its entry, then answers ok. */
function asking(questions: ReadonlyArray<{ prompt: string; secret: boolean }>): (command: Received) => Reply {
  let asked = 0;
  return () => {
    const question = questions[asked];
    asked += 1;
    if (question === undefined) return { status: 'ok', text: 'zeta-done' };
    return { status: 'ask', text: question.prompt, dialogId: `dialog-${asked}`, ...question };
  };
}

const QUESTION = { prompt: 'zeta-which-model?', secret: false };
const SECRET_QUESTION = { prompt: 'zeta-key-value:', secret: true };
const SECRET = 'sk-or-v1-zeta-SECRETVALUE-0001';

for (const argv of [
  ['skills', 'setup', 'zeta'],
  ['-p', '/skills setup zeta'],
]) {
  test(`${argv.join(' ')} with a question and no terminal exits 1 with the question on stderr, never hangs`, async () => {
    // Catches: the question waits on a pipe nobody writes to, or the reply says nothing of what the command needed.
    await withRecordingCore(asking([QUESTION]), async ({ dirs, core }) => {
      const run = await runChild(dirs, argv, { open: true, ms: PROMPTLY });
      assert.equal(run.code, 1, run.stderr.slice(0, 200));
      assert.equal(run.stdout, '');
      assert.ok(run.stderr.includes(QUESTION.prompt), 'the missing input is named');
      assert.equal(core.commands.length, 1, 'no answer was made up');
    });
  });
}

test('a secret question with no terminal names the channel and never reads stdin uninvited', async () => {
  // Catches: whatever is on the pipe is sent as the key value, or the reply leaves the caller with no way forward.
  await withRecordingCore(asking([SECRET_QUESTION]), async ({ dirs, core }) => {
    const run = await runChild(dirs, ['keys', 'core', 'add', 'k1'], { input: `${SECRET}\n`, ms: PROMPTLY });
    assert.equal(run.code, 1, run.stderr.slice(0, 200));
    assert.ok(run.stderr.includes('--secret-stdin'), run.stderr.slice(0, 200));
    assert.equal(core.commands.length, 1, 'stdin was not sent as the answer');
    assert.equal((run.stdout + run.stderr).includes(SECRET), false);
  });
});

test('--secret-stdin answers the secret question from stdin, its one trailing newline dropped', async () => {
  // Catches: the value travels as an argument and lands in `ps`, or keeps its newline and is stored broken.
  await withRecordingCore(asking([SECRET_QUESTION]), async ({ dirs, core }) => {
    const run = await runChild(dirs, ['keys', 'core', 'add', 'k1', '--secret-stdin'], { input: `${SECRET}\n` });
    assert.equal(run.code, 0, run.stderr.slice(0, 200));
    assert.equal(run.stdout, 'zeta-done\n');
    assert.deepEqual(core.commands, [
      { name: 'keys.core.add', args: { name: 'k1' } },
      { name: 'keys.core.add', args: { name: 'k1' }, dialogId: 'dialog-1', answer: SECRET },
    ]);
    assert.equal((run.stdout + run.stderr).includes(SECRET), false);
  });
});

test('--secret-stdin with an empty stdin exits 1 and sends no answer', async () => {
  // Catches: an unset variable in a script stores an empty key over a working one.
  await withRecordingCore(asking([SECRET_QUESTION]), async ({ dirs, core }) => {
    const run = await runChild(dirs, ['keys', 'core', 'add', 'k1', '--secret-stdin'], { input: '', ms: PROMPTLY });
    assert.equal(run.code, 1, run.stderr.slice(0, 200));
    assert.notEqual(run.stderr, '');
    assert.equal(core.commands.length, 1);
  });
});

test('--secret-stdin answers no plain question that follows the secret', async () => {
  // Catches: a second question is answered with the secret or an empty line, instead of naming what is missing.
  await withRecordingCore(asking([SECRET_QUESTION, QUESTION]), async ({ dirs, core }) => {
    const run = await runChild(dirs, ['keys', 'core', 'add', 'k1', '--secret-stdin'], {
      input: `${SECRET}\n`,
      ms: PROMPTLY,
    });
    assert.equal(run.code, 1, run.stderr.slice(0, 200));
    assert.ok(run.stderr.includes(QUESTION.prompt), run.stderr.slice(0, 200));
    assert.equal(core.commands.length, 2, 'the first answer and no other');
  });
});

test('--secret-stdin on a leaf that asks no secret is a plain value', async () => {
  // Catches: the flag is stripped from every command, so a rule that holds those words loses them.
  await withRecordingCore(handled, async ({ dirs, core }) => {
    const run = await runChild(dirs, ['rules', 'add', '--secret-stdin']);
    assert.equal(run.code, 0, run.stderr.slice(0, 200));
    assert.deepEqual(core.commands, [{ name: 'rules.add', args: { text: '--secret-stdin' } }]);
  });
});

/** The leaves that ask for a secret value, each with the words before the value. */
const SECRET_LEAVES: ReadonlyArray<{ name: string; words: ReadonlyArray<string>; args: unknown }> = [
  { name: 'keys.core.add', words: ['keys', 'core', 'add', 'k1'], args: { name: 'k1' } },
  { name: 'keys.extra.add', words: ['keys', 'extra', 'add', 'k1'], args: { name: 'k1' } },
  { name: 'keys.service.set', words: ['keys', 'service', 'set', 'youtube'], args: { name: 'youtube' } },
  { name: 'interface.token.set', words: ['interface', 'token', 'set', 'zeta'], args: { name: 'zeta' } },
];

for (const { name, words, args } of SECRET_LEAVES) {
  test(`${name} takes its name directly and refuses a secret as a word of argv`, async () => {
    // Catches: the last argument's rest rule folds the secret into the name, so it reaches the core, the logs and `ps`.
    await withRecordingCore(handled, async ({ dirs, core }) => {
      const plain = await runChild(dirs, words);
      assert.equal(plain.code, 0, plain.stderr.slice(0, 200));
      assert.deepEqual(core.commands, [{ name, args }]);
      core.commands.length = 0;

      const run = await runChild(dirs, [...words, SECRET]);
      assert.equal(run.code, 2, run.stderr.slice(0, 200));
      assert.deepEqual(core.commands, [], 'nothing of it reaches the core');
      assert.equal((run.stdout + run.stderr).includes(SECRET), false, 'the value is not echoed');
    });
  });

  test(`${name} refuses a secret as a word of a -p line`, async () => {
    // Catches: the check guards the direct form and the same value still goes through -p.
    await withRecordingCore(handled, async ({ dirs, core }) => {
      const run = await runChild(dirs, ['-p', `/${words.join(' ')} ${SECRET}`]);
      assert.equal(run.code, 2, run.stderr.slice(0, 200));
      assert.deepEqual(core.commands, []);
      assert.equal((run.stdout + run.stderr).includes(SECRET), false, 'the value is not echoed');
    });
  });
}

test('the real handler stores a token given through --secret-stdin', async () => {
  // Catches: the channel works against the stand-in but the real dialog broker never gets the answer.
  await withRig({}, async ({ dirs, llm, cores }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const run = await runChild(dirs, ['interface', 'token', 'set', 'zeta', '--secret-stdin'], {
      input: `${SECRET}\n`,
    });
    assert.equal(run.code, 0, run.stderr.slice(0, 200));
    const file = join(dirs.privateDir, 'interfaces', 'zeta', 'credentials.json');
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { token: SECRET });
    assert.equal((run.stdout + run.stderr).includes(SECRET), false);
  });
});

test('the real handler asking with no terminal exits 1 and writes nothing, the input left open', async () => {
  // Catches: the real dialog waits its five minutes for an answer nobody can send.
  await withRig({}, async ({ dirs, llm, cores }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const run = await runChild(dirs, ['interface', 'token', 'set', 'zeta'], { open: true, ms: PROMPTLY });
    assert.equal(run.code, 1, run.stderr.slice(0, 200));
    assert.notEqual(run.stderr, '');
    assert.equal(existsSync(join(dirs.privateDir, 'interfaces', 'zeta', 'credentials.json')), false);
  });
});
