// `neptunia <command> <args...>`: which handler a request reaches and how the process ends. The matrix of the table runs
// in process through the direct form's parser (bin/neptunia-request.ts), with what each leaf must parse into computed
// from the table's own arguments, so the parser is never its own oracle. A real child proves only what a child alone
// can: the dispatcher's first word, the exit code and the streams. Those share one recording core; the real core in the
// test process answers the two scenarios whose handler is the point. Exit codes: 0 success with the answer on stdout, 1
// an operational failure with the reason on stderr, 2 bad syntax with the reason on stderr.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMMANDS_LINE, COMMAND_NAMES, parseLineRequest, parseRequest } from '../bin/neptunia-request.ts';
import { COMMANDS } from '../src/interface/commands/table.ts';
import type { CommandArg } from '../src/interface/commands/table.ts';
import { ANSWER, query, runCli, startUnitsCore, withRig } from './fixtures/core-units.ts';
import type { Dirs } from './fixtures/core-units.ts';
import { cliFolders, handled, runChild, startRecordingCore } from './fixtures/recording-core.ts';
import type { RecordingCore, Reply } from './fixtures/recording-core.ts';

const T0 = Date.parse('2026-10-31T12:00:00Z');

const count = (text: string, part: string): number => text.split(part).length - 1;

/** Values the table's `check` of a leaf requires, for a leaf whose free sample it would refuse. */
const SAMPLES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  logs: { options: 'errors' },
  // Changed: `report` is retired. A setup leaf takes one mode, so its sample names the flags it uses.
  'services.heartbeat.setup': { every: '6h', jitter: '30m' },
  'services.selfreflection.setup': { every: '6h' },
  'services.selfimprovement.setup': { at: '03:00' },
  'doctor.watcher': { number: '3' },
  'tools.grant': { target: 'everyone' },
  'tools.revoke': { target: 'everyone' },
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

/** Every leaf of the table. */
const LEAVES: ReadonlyArray<Leaf> = COMMANDS.flatMap((command) =>
  command.subcommands.length === 0
    ? [leafOf(command.name, command.args)]
    : command.subcommands.map((one) => leafOf(`${command.name}.${one.name}`, one.args))
);

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
  // Changed: no interface has commands of its own, so the leaf that took any word and always refused it is gone and
  // the parser refuses the word itself. Catches: a stray word parses and reaches the core as a command.
  const { parsed } = parseRequest(['interfaces', 'zeta71', 'sync', 'all', 'now']);
  assert.equal(parsed.ok, false);
  assert.ok(!parsed.ok && parsed.reason.includes('zeta71'), JSON.stringify(parsed));
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

test('interface list reaches the management family: the answer alone on stdout, exit 0', async () => {
  // Catches: the first word `interface` stays the runner's, a result goes to stderr, or a log line joins what a script reads.
  fresh();
  const run = await runChild(dirs, ['interfaces', 'list']);
  assert.equal(run.code, 0, run.stderr.slice(0, 200));
  assert.equal(run.stdout, 'handled interfaces.list\n');
  assert.equal(run.stderr, '');
  assert.deepEqual(core.commands, [{ name: 'interfaces.list', args: {} }]);
  assert.deepEqual(core.lines, [], 'a management command is no line of the chat');
});

test('a command answered failed exits 1 with the reason on stderr and nothing on stdout', async () => {
  // Catches: a script reads a refusal on stdout as a result, or the handler's refusal is taken for bad syntax.
  fresh(() => ({ status: 'failed', text: 'zeta-refusal-reason' }));
  const run = await runChild(dirs, ['rules', 'remove', '9']);
  assert.equal(run.code, 1, run.stderr.slice(0, 200));
  assert.equal(run.stdout, '');
  assert.ok(run.stderr.includes('zeta-refusal-reason'), run.stderr.slice(0, 200));
});

test('a word the table does not know exits 2 with the usage and the table, and connects to no core', async () => {
  // Catches: an unknown word becomes a prompt to her, or spends a connection before it is refused.
  fresh();
  const connections = core.connections();
  const run = await runChild(dirs, ['hello', 'there', 'how', 'are', 'you']);
  assert.equal(run.code, 2, run.stderr.slice(0, 200));
  assert.equal(run.stdout, '');
  assert.ok(run.stderr.includes('usage:'), run.stderr.slice(0, 200));
  assert.ok(run.stderr.includes(COMMANDS_LINE), 'the usage names the table');
  assert.equal(core.connections(), connections);
});

test('a line the table refuses exits 2 with its reason on stderr and sends nothing', async () => {
  // Catches: a refusal exits 1 as if a command had failed, or goes on to the core.
  fresh();
  const run = await runChild(dirs, ['usage', '90d']);
  assert.equal(run.code, 2, run.stderr.slice(0, 200));
  assert.equal(run.stdout, '');
  assert.ok(run.stderr.includes('90d'), run.stderr.slice(0, 200));
  assert.deepEqual(core.commands, []);
});

test('-p with blank text is a usage error and no turn', async () => {
  // Catches: an empty prompt goes to the model.
  fresh();
  const run = await runChild(dirs, ['-p', '   ']);
  assert.equal(run.code, 2, run.stderr.slice(0, 200));
  assert.deepEqual(core.lines, []);
});

test('neptunia doctor live runs the doctor with the core asked for its probes', async () => {
  // Catches: the table's `/doctor live` has no direct spelling because the native doctor only reads --live.
  fresh();
  const run = await runChild(dirs, ['doctor', 'live']);
  assert.equal(run.stderr.startsWith('neptunia: usage:'), false, run.stderr.slice(0, 200));
  assert.deepEqual(core.commands, [{ name: 'doctor.live', args: {} }]);
});

test('neptunia services status <unit> keeps its form and runs systemctl with that unit', async () => {
  // Catches: the slice reroutes `service` before its own unified form exists, so the units cannot be read.
  fresh();
  const bin = join(dirs.root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'systemctl'), '#!/bin/sh\necho "zeta-systemctl $*"\nexit 3\n', { mode: 0o755 });
  const run = await runChild(dirs, ['services', 'status', 'zeta.service'], { env: { PATH: bin } });
  assert.ok(run.stdout.includes('zeta-systemctl status zeta.service'), run.stdout);
  assert.equal(run.code, 3, "systemctl's exit code is the command's");
  assert.deepEqual(core.commands, []);
});

test('-p with text is one turn with her, even when it opens with a table word: her reply on stdout, and it ends', async () => {
  // Catches: the slash is optional, so a sentence that opens with a table word runs that command, or the child waits on
  // an input nobody closes.
  const text = 'rules list say "hi" `now` $(echo zeta71)';
  await withRig({}, async ({ dirs: rig, llm, cores }) => {
    cores.push(await startUnitsCore(rig, llm, () => T0));
    const run = await runChild(rig, ['-p', text], { open: true });
    assert.equal(run.code, 0, run.stderr.slice(0, 200));
    assert.equal(count(run.stdout, ANSWER), 1, run.stdout);
    assert.equal(llm.requests.length, 1, 'one turn');
    assert.ok(
      JSON.stringify(llm.requests[0]).includes(JSON.stringify(text).slice(1, -1)),
      'the whole text reached her'
    );
    assert.deepEqual(
      query(
        rig,
        'SELECT s.kind, p.id AS place FROM sources s JOIN places p ON p.id = s.place_id WHERE s.text = ?',
        text
      ),
      [{ kind: 'seen', place: 'cli:dm:owner' }]
    );
  });
});

test('a rule added directly is stored whole and -p /rules list reads it, with no model and nothing in her memory', async () => {
  // Catches: the value is cut or re-quoted on its way into the rules, or a management command becomes a prompt.
  const rule = 'a "b" `c` $(d) zeta71';
  await withRig({}, async ({ dirs: rig, llm, cores }) => {
    cores.push(await startUnitsCore(rig, llm, () => T0));
    const added = await runCli(rig, ['rules', 'add', rule]);
    assert.equal(added.code, 0, added.stderr.slice(0, 200));
    const listed = await runCli(rig, ['-p', '/rules list']);
    assert.equal(listed.code, 0, listed.stderr.slice(0, 200));
    assert.ok(listed.stdout.includes(rule), listed.stdout);
    assert.equal(llm.requests.length, 0);
    assert.deepEqual(query(rig, "SELECT kind FROM sources WHERE text LIKE '%zeta71%'"), []);
  });
});
