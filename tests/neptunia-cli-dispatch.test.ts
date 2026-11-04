// `neptunia <command> <args...>` at the real argv boundary: each `neptunia` is a child process. The direct form uses the
// chat's parser and handlers, so the check of the table is generated from COMMANDS and `parseCommandLine` is its oracle.
// A generated leaf runs against the recording core, which runs no handler; the real core in the test process answers
// the few commands whose handler is the point. `-p` with a slash is a command, `-p` with text is one turn with her, and
// a word the table does not know is a usage error, never a prompt. Exit codes: 0 success with the answer on stdout, 1 an
// operational failure with the reason on stderr, 2 bad syntax with the reason on stderr.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMMANDS, parseCommandLine } from '../src/interface/commands/table.ts';
import type { CommandArg } from '../src/interface/commands/table.ts';
import { reportsDirOf, watcherDir } from '../src/watcher/read.ts';
import { ANSWER, query, runCli, spawnCli, startUnitsCore, startedUnit, until, withRig } from './fixtures/core-units.ts';
import { cliFolders, handled, runChild, withRecordingCore } from './fixtures/recording-core.ts';
import type { Reply } from './fixtures/recording-core.ts';

const T0 = Date.parse('2026-10-31T12:00:00Z');

/** An interface the local layer names, so `interface list` prints a name no label holds. */
const MARKED = { interfaces: { zeta71: { enabled: true } } };

const count = (text: string, part: string): number => text.split(part).length - 1;

/** The commands bin/neptunia.ts answers itself; each has a test of its own below, or in the boundaries file. */
const LOCAL = new Set(['doctor.live', 'logs', 'report', 'clear']);

/** Values the table's `check` of a leaf requires, for a leaf whose free sample it would refuse. */
const SAMPLES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'tools.grant': { target: 'everyone' },
  'tools.revoke': { target: 'everyone' },
};

/** A representative argv of one leaf: its words, then every positional argument, then every flag with its value. */
function leafArgv(name: string, args: ReadonlyArray<CommandArg>): Array<string> {
  const sample = (one: CommandArg): string => SAMPLES[name]?.[one.name] ?? one.choices?.[0] ?? `sample-${one.name}`;
  return [
    ...name.split('.'),
    ...args.filter((one) => one.flag === undefined).map(sample),
    ...args.flatMap((one) => (one.flag === undefined ? [] : [one.flag, sample(one)])),
  ];
}

/** Every leaf of the table with its dotted name and arguments, a command's `otherwise` form included. */
const LEAVES: ReadonlyArray<{ name: string; argv: Array<string> }> = COMMANDS.flatMap((command) => {
  const subs = command.subcommands.map((one) => ({ name: `${command.name}.${one.name}`, args: one.args }));
  const own = subs.length === 0 ? [{ name: command.name, args: command.args }] : subs;
  return own.map(({ name, args }) => ({ name, argv: leafArgv(name, args) }));
}).filter((leaf) => !LOCAL.has(leaf.name));

/** Whether `run` is the usage text alone: its first line starts `neptunia: usage:`. */
const isUsage = (stderr: string): boolean => stderr.startsWith('neptunia: usage:');

/** Asserts that `argv` reached the handler as the chat's parser reads the same words. */
async function assertReachesTheHandler(argv: ReadonlyArray<string>): Promise<void> {
  const parsed = parseCommandLine(`/${argv.join(' ')}`);
  assert.ok(parsed.ok, `the sample itself is refused by the table: ${parsed.ok ? '' : parsed.reason}`);
  await withRecordingCore(handled, async ({ dirs, core }) => {
    const run = await runChild(dirs, argv);
    assert.deepEqual(core.commands, [{ name: parsed.name, args: parsed.args }], run.stderr.slice(0, 200));
    assert.equal(run.code, 0, run.stderr.slice(0, 200));
    assert.equal(run.stdout, `handled ${parsed.name}\n`);
    assert.deepEqual(core.lines, [], 'a management command is no line of the chat');
  });
}

test('every leaf of the table dispatches directly to the handler the chat uses', { concurrency: 4 }, async (t) => {
  // Catches: a leaf the outer dispatcher misses answers usage or a prompt instead of running its command.
  await Promise.all(
    LEAVES.map((leaf) => t.test(`neptunia ${leaf.argv.join(' ')}`, () => assertReachesTheHandler(leaf.argv)))
  );
});

test('every command typed bare parses as in the chat', { concurrency: 4 }, async (t) => {
  // Catches: a bare `neptunia rules` or `neptunia interface` differs from `/rules` in the chat; `doctor`, `logs`,
  // `report` and `clear` run in the command line and have tests of their own.
  const bare = COMMANDS.filter((one) => !LOCAL.has(one.name) && one.name !== 'doctor');
  await Promise.all(
    bare.map((command) =>
      t.test(`neptunia ${command.name}`, async () => {
        const parsed = parseCommandLine(`/${command.name}`);
        if (parsed.ok) return assertReachesTheHandler([command.name]);
        await withRecordingCore(handled, async ({ dirs, core }) => {
          const run = await runChild(dirs, [command.name]);
          assert.equal(run.code, 2);
          assert.ok(run.stderr.includes(parsed.reason), run.stderr.slice(0, 200));
          assert.deepEqual(core.commands, []);
        });
      })
    )
  );
});

test('an interface subcommand the table does not name goes to the interface, as in the chat', async () => {
  // Catches: the `otherwise` branch of the parser is lost, so an interface's own subcommand answers usage.
  await assertReachesTheHandler(['interface', 'zeta71', 'sync', 'all', 'now']);
});

test('interface list and the other management forms reach the management family, not the runner', async () => {
  // Catches: the first word `interface` still belongs to the runner, which answers every management form with usage.
  await withRig({ config: MARKED }, async ({ dirs, llm, cores }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const run = await runCli(dirs, ['interface', 'list']);
    assert.equal(run.code, 0, run.stderr.slice(0, 200));
    assert.ok(run.stdout.includes('zeta71'), 'the answer names the interface of the local layer');
    assert.equal(llm.requests.length, 0, 'a command runs no turn');
  });
});

test('the direct form and -p give the same answer from the real handler', async () => {
  // Catches: the direct form has a parser or a handler of its own that drifts from the one the chat uses.
  await withRig({}, async ({ dirs, llm, cores }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const direct = await runCli(dirs, ['config', 'get', 'pace.settleMs']);
    const line = await runCli(dirs, ['-p', '/config get pace.settleMs']);
    assert.equal(direct.code, 0, direct.stderr.slice(0, 200));
    assert.equal(direct.stdout, line.stdout);
    assert.equal(llm.requests.length, 0);
  });
});

test('neptunia doctor live runs the doctor with the core asked for its probes', async () => {
  // Catches: the table's `/doctor live` has no direct spelling because the native doctor only reads --live.
  await withRecordingCore(handled, async ({ dirs, core }) => {
    const run = await runChild(dirs, ['doctor', 'live']);
    assert.equal(isUsage(run.stderr), false, run.stderr.slice(0, 200));
    assert.deepEqual(core.commands, [{ name: 'doctor.live', args: {} }]);
  });
});

test('neptunia logs reads the journal in the command line, with no core', async () => {
  // Catches: a local command is sent to the core, which has no `logs`, or never runs journalctl.
  const dirs = cliFolders();
  const bin = join(dirs.root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'journalctl'), '#!/bin/sh\necho "zeta-journal $*"\n', { mode: 0o755 });
  const run = await runChild(dirs, ['logs', 'errors'], { env: { PATH: bin } });
  assert.equal(run.code, 0, run.stderr.slice(0, 200));
  assert.ok(run.stdout.includes('zeta-journal'), run.stdout);
  assert.ok(run.stdout.includes('-p err'), run.stdout);
});

test('neptunia report prints the report of the day in the command line, with no core', async () => {
  // Catches: a local command is sent to the core, or its date argument is lost on the way to the reader.
  const dirs = cliFolders();
  const reports = reportsDirOf(dirs.privateDir, watcherDir({}));
  mkdirSync(reports, { recursive: true });
  writeFileSync(join(reports, '2026-11-03.md'), 'zeta-report-line\n');
  const run = await runChild(dirs, ['report', '2026-11-03']);
  assert.equal(run.code, 0, run.stderr.slice(0, 200));
  assert.ok(run.stdout.includes('zeta-report-line'), run.stdout);
});

// The native entries. These hold today and must keep holding once the table's words are dispatched: they cannot fail
// first, because the change they guard against is the one this slice makes.
const NATIVE_USAGE: ReadonlyArray<ReadonlyArray<string>> = [
  ['errand-runner'],
  ['interface', 'run'],
  ['service', 'bogus'],
  ['setup', '--no-such-flag'],
  ['watcher', 'bogus'],
  ['doctor', '--no-such-flag'],
];

for (const argv of NATIVE_USAGE) {
  test(`neptunia ${argv.join(' ')} stays a usage error of the native entry and asks no core`, async () => {
    // Catches: the table's dispatcher takes a native first word and the entry's own syntax stops being checked.
    await withRecordingCore(handled, async ({ dirs, core }) => {
      const run = await runChild(dirs, argv);
      assert.equal(run.code, 2, run.stderr.slice(0, 200));
      assert.deepEqual(core.commands, []);
    });
  });
}

test('neptunia task help stays the task board command line', async () => {
  // Catches: `task` falls to the table's unknown-word usage.
  await withRecordingCore(handled, async ({ dirs, core }) => {
    const run = await runChild(dirs, ['task', 'help']);
    assert.equal(run.code, 0, run.stderr.slice(0, 200));
    assert.notEqual(run.stdout + run.stderr, '');
    assert.deepEqual(core.commands, []);
  });
});

test('neptunia service status <unit> keeps its form and runs systemctl with that unit', async () => {
  // Catches: the slice reroutes `service` before its own unified form exists, so the units cannot be read.
  await withRecordingCore(handled, async ({ dirs, core }) => {
    const bin = join(dirs.root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'systemctl'), '#!/bin/sh\necho "zeta-systemctl $*"\nexit 3\n', { mode: 0o755 });
    const run = await runChild(dirs, ['service', 'status', 'zeta.service'], { env: { PATH: bin } });
    assert.ok(run.stdout.includes('zeta-systemctl status zeta.service'), run.stdout);
    assert.equal(run.code, 3, "systemctl's exit code is the command's");
    assert.deepEqual(core.commands, []);
  });
});

test('neptunia interface run <name> stays the runner of the interface', async () => {
  // Catches: `interface run` parses as the table's `otherwise` form (interface `run`, subcommand `fake`) and no unit starts.
  await withRig({}, async ({ dirs, llm, cores, units }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const unit = await startedUnit(dirs);
    units.push(unit);
    assert.equal(unit.child.exitCode, null, 'the runner keeps running');
  });
});

// -p: a slash is a command, anything else is one turn.

test('-p with text is one turn with her: her reply on stdout, the line in her memory, and the process ends', async () => {
  // Catches: the text parses as a command and is refused, or the child waits on an input nobody closes.
  const text = 'say "hi" `now` $(echo zeta71)';
  await withRig({}, async ({ dirs, llm, cores }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const run = await runChild(dirs, ['-p', text], { open: true });
    assert.equal(run.code, 0, run.stderr.slice(0, 200));
    assert.equal(count(run.stdout, ANSWER), 1, run.stdout);
    assert.equal(llm.requests.length, 1, 'one turn');
    assert.ok(
      JSON.stringify(llm.requests[0]).includes(JSON.stringify(text).slice(1, -1)),
      'the whole text reached her'
    );
    assert.deepEqual(
      query(
        dirs,
        'SELECT s.kind, p.id AS place FROM sources s JOIN places p ON p.id = s.place_id WHERE s.text = ?',
        text
      ),
      [{ kind: 'seen', place: 'cli:dm:owner' }]
    );
  });
});

test('-p with a management word and no slash is text for her, never a command', async () => {
  // Catches: the slash is optional, so a sentence that opens with a table word runs that command.
  await withRecordingCore(handled, async ({ dirs, core }) => {
    const spawned = spawnCli(dirs, ['-p', 'rules list']);
    try {
      await until(
        () => core.lines.length > 0 || core.commands.length > 0 || spawned.child.exitCode !== null,
        'the line or the command reaching the core'
      );
      assert.deepEqual(core.commands, []);
      assert.deepEqual(core.lines, ['rules list']);
    } finally {
      await spawned.kill();
    }
  });
});

test('-p with text and no core listening fails with 1 and reports the core, not a command', async () => {
  // Catches: with no core the text is refused as an unknown command, which sends a script looking in the wrong place.
  const run = await runChild(cliFolders(), ['-p', 'hello there']);
  assert.equal(run.code, 1, run.stderr.slice(0, 200));
  assert.equal(run.stdout, '');
  assert.equal(run.stderr.includes('/hello'), false, run.stderr.slice(0, 200));
});

for (const text of ['', '   ']) {
  test(`-p ${JSON.stringify(text)} is a usage error and no turn`, async () => {
    // Catches: an empty prompt goes to the model, or exits 1 as if a command had failed.
    await withRecordingCore(handled, async ({ dirs, core }) => {
      const run = await runChild(dirs, ['-p', text]);
      assert.equal(run.code, 2, run.stderr.slice(0, 200));
      assert.deepEqual(core.lines, []);
    });
  });
}

// Conflicts with `-p exits 1 for a command the core does not know` in tests/neptunia-cli.test.ts and two tests of
// tests/commands-console.test.ts, which predate the plan's return codes: a line the table refuses is bad syntax.
test('-p with a line the table refuses exits 2 and reaches no model', async () => {
  // Catches: a script cannot tell a mistyped command from a failed one, or the slash line falls through to a prompt.
  await withRecordingCore(handled, async ({ dirs, core }) => {
    for (const line of ['/no-such-command', '/memory', '/usage 90d', '/config set only.path']) {
      const parsed = parseCommandLine(line);
      assert.equal(parsed.ok, false);
      const run = await runChild(dirs, ['-p', line]);
      assert.equal(run.code, 2, line);
      assert.equal(run.stdout, '', line);
      assert.ok(run.stderr.includes(parsed.ok ? '' : parsed.reason), run.stderr.slice(0, 200));
    }
    assert.deepEqual(core.commands, []);
    assert.deepEqual(core.lines, []);
  });
});

test('a management command run directly writes nothing of itself into her memory and asks no model', async () => {
  // Catches: the direct form sends its words as a chat line, so a management command becomes a prompt.
  await withRig({}, async ({ dirs, llm, cores }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const run = await runCli(dirs, ['rules', 'add', 'zeta71 never before noon']);
    assert.equal(run.code, 0, run.stderr.slice(0, 200));
    assert.equal(llm.requests.length, 0);
    assert.deepEqual(query(dirs, "SELECT kind FROM sources WHERE text LIKE '%zeta71%'"), []);
  });
});

const UNKNOWN_WORDS: ReadonlyArray<ReadonlyArray<string>> = [
  ['frobnicate'],
  ['hello', 'there', 'how', 'are', 'you'],
  ['rules add', 'one word holding a space is no table word'],
  ['/rules', 'list'],
];

for (const argv of UNKNOWN_WORDS) {
  test(`neptunia ${JSON.stringify(argv[0])} exits 2 with a usage naming the table and sends nothing`, async () => {
    // Catches: an unknown word becomes a prompt to her, or the usage hides every command the table has.
    await withRecordingCore(handled, async ({ dirs, core }) => {
      const run = await runChild(dirs, argv);
      assert.equal(run.code, 2, run.stderr.slice(0, 200));
      assert.equal(run.stdout, '');
      assert.ok(run.stderr.includes('usage:'), run.stderr.slice(0, 200));
      for (const command of COMMANDS) assert.ok(run.stderr.includes(command.name), `the usage names ${command.name}`);
      assert.equal(core.connections(), 0, 'an unknown word connects to no core');
    });
  });
}

// Return codes and streams.

test('a command that succeeds prints its answer on stdout alone and exits 0', async () => {
  // Catches: a result goes to stderr, or a log line or a prompt is mixed into what a script reads.
  const reply = (): Reply => ({ status: 'ok', text: 'zeta-result-line' });
  await withRecordingCore(reply, async ({ dirs }) => {
    const run = await runChild(dirs, ['rules', 'list']);
    assert.equal(run.code, 0, run.stderr.slice(0, 200));
    assert.equal(run.stdout, 'zeta-result-line\n');
    assert.equal(run.stderr, '');
  });
});

for (const status of ['failed', 'denied', 'invalid']) {
  test(`a command answered ${status} exits 1 with the reason on stderr and nothing on stdout, run directly`, async () => {
    // Catches: a script reads a refusal on stdout as a result, or the handler's refusal is taken for bad syntax.
    const reply = (): Reply => ({ status, text: 'zeta-refusal-reason' });
    await withRecordingCore(reply, async ({ dirs }) => {
      const run = await runChild(dirs, ['rules', 'remove', '9']);
      assert.equal(run.code, 1, run.stderr.slice(0, 200));
      assert.equal(run.stdout, '');
      assert.ok(run.stderr.includes('zeta-refusal-reason'), run.stderr.slice(0, 200));
    });
  });
}

test('a command answered failed through -p puts the reason on stderr too', async () => {
  // Catches: the -p path keeps printing every answer on stdout whatever its status.
  const reply = (): Reply => ({ status: 'failed', text: 'zeta-refusal-reason' });
  await withRecordingCore(reply, async ({ dirs }) => {
    const run = await runChild(dirs, ['-p', '/rules remove 9']);
    assert.equal(run.code, 1);
    assert.equal(run.stdout, '');
    assert.ok(run.stderr.includes('zeta-refusal-reason'), run.stderr.slice(0, 200));
  });
});

test('a direct command with no core listening exits 1 without waiting', async () => {
  // Catches: the operational failure is reported as usage, or the child waits for a socket that never comes.
  const run = await runChild(cliFolders(), ['rules', 'list'], { open: true, ms: 10_000 });
  assert.equal(run.code, 1, run.stderr.slice(0, 200));
  assert.equal(run.stdout, '');
  assert.notEqual(run.stderr, '');
});

const BAD_SYNTAX: ReadonlyArray<ReadonlyArray<string>> = [
  ['rules', 'add'],
  ['usage', '90d'],
  ['health', 'disks'],
  ['memory', 'no-such-sub'],
  ['model', 'set', 'no-such-role'],
  ['simulation', 'enable'],
  ['config', 'set', 'only.path'],
  ['model', 'set', 'memory', 'some-model', '--no-such-flag', 'x'],
];

for (const argv of BAD_SYNTAX) {
  test(`neptunia ${argv.join(' ')} exits 2 with the table's reason and reaches no handler`, async () => {
    // Catches: a refused line runs the handler, or answers a generic usage that does not say what is wrong with it.
    const parsed = parseCommandLine(`/${argv.join(' ')}`);
    assert.equal(parsed.ok, false, 'the table refuses this line');
    await withRecordingCore(handled, async ({ dirs, core }) => {
      const run = await runChild(dirs, argv);
      assert.equal(run.code, 2, run.stderr.slice(0, 200));
      assert.equal(run.stdout, '');
      assert.ok(run.stderr.includes(parsed.ok ? '' : parsed.reason), run.stderr.slice(0, 200));
      assert.deepEqual(core.commands, []);
    });
  });
}
