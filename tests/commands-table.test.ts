// Tests for the chat's command table (src/interface/commands/table.ts): the commands of plan section 4.3 that PR 7a
// adds, and the lines the parse refuses. What each command answers is tested through `neptunia -p` in
// tests/neptunia-commands.test.ts; here only the table and the parse, with no core.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, parseCommandLine, operationOf } from '../src/interface/commands/table.ts';
import { createConsole } from '../src/interface/commands/console.ts';
import type { CommandArg } from '../src/interface/commands/table.ts';
import { tempDir } from './fixtures/tmp.ts';

/** The commands of the 4.3 table in PR 7a: `/mirror` and `/plugins` come later; `/skills` joined with PR 7e. */
const TABLE = [
  'status',
  'doctor',
  'logs',
  // Changed: `/report` is retired, the report reads as `/logs watcher`, so the one new command is `services`.
  'services',
  'usage',
  'errands',
  'intentions',
  'pause',
  // Stage Z: the engine proxy's commands.
  'proxy',
  'resume',
  'config',
  'model',
  'routes',
  'memory',
  'rules',
  'tools',
  'skills',
  'interfaces',
  'keys',
  'subharness',
  // Changed: `/agent` holds the execution mode that left `/subharness`.
  'agent',
  // Changed: `/search` holds quick search's targeted settings.
  'search',
  // Changed: `/mirror` is the owner's family over the diary's mirrors.
  'mirror',
  // The owner's `/mnemonic` shows and switches the language of the phrase-code word list.
  'mnemonic',
  'help',
  'clear',
];

test('every command of the table has a help line', () => {
  const missing = TABLE.filter((name) => (COMMANDS.find((command) => command.name === name)?.help.trim() ?? '') === '');
  assert.deepEqual(missing, []);
});

test('a line of a command the table does not hold is refused', () => {
  // Changed: the refused example was `/mirror list`, and `/mirror` is a table command.
  assert.equal(parseCommandLine('/nosuchcommand list').ok, false);
});

test('a subcommand the command does not have is refused', () => {
  assert.equal(parseCommandLine('/tools explode web.search').ok, false);
});

test('a command that needs a subcommand is refused without one', () => {
  assert.equal(parseCommandLine('/memory').ok, false);
});

test('a missing required argument is refused', () => {
  assert.equal(parseCommandLine('/tools grant').ok, false);
  assert.equal(parseCommandLine('/config set pace.settleMs').ok, false);
});

test('a /doctor part and a /usage window outside the table are refused', () => {
  assert.equal(parseCommandLine('/doctor disks').ok, false);
  assert.equal(parseCommandLine('/usage 90d').ok, false);
});

test('the last argument takes the rest of the line', () => {
  const parsed = parseCommandLine('/rules add never answer before noon');
  assert.ok(parsed.ok);
  assert.ok(
    Object.values(parsed.args).includes('never answer before noon'),
    'the rule text is one argument with its spaces'
  );
});

test('every listed part of /doctor and window of /usage parses', () => {
  for (const line of [
    '/doctor',
    '/doctor server',
    '/doctor core',
    '/doctor memory',
    '/usage',
    '/usage 7d',
    '/usage 30d',
  ])
    assert.equal(parseCommandLine(line).ok, true, line);
});

test('/skills with nothing after it lists, and list and pending take no argument', () => {
  const bare = parseCommandLine('/skills');
  assert.ok(bare.ok);
  assert.equal(bare.name, 'skills.list');
  assert.equal(parseCommandLine('/skills pending').ok, true);
  assert.equal(parseCommandLine('/skills list now').ok, false);
});

test('every /skills subcommand that works on one skill takes its name and is refused without it', () => {
  // Changed: `show` left, as `review` shows the active text with the candidates.
  for (const sub of ['enable', 'disable', 'review', 'activate', 'rollback', 'reject']) {
    const parsed = parseCommandLine(`/skills ${sub} look-it-up`);
    assert.ok(parsed.ok, sub);
    assert.equal(parsed.name, `skills.${sub}`);
    assert.ok(Object.values(parsed.args).includes('look-it-up'), sub);
    assert.equal(parseCommandLine(`/skills ${sub}`).ok, false, `${sub} needs a name`);
  }
});

// How a leaf of the owner's command table (src/interface/commands/table.ts) names the operation it runs, read through
// `operationOf`, and that the core's console (src/interface/commands/console.ts) answers every leaf of the table. The
// operations run against a fake that records them; no core, no model and no network.

/** The leaves the chat desk (src/interface/neptunia-cli.ts) answers before the console sees them. */
const DESK_LEAVES = new Set(['help', 'clear', 'interfaces.list', 'interfaces.enable', 'interfaces.disable']);

/** The leaves that read the machine and run no operation, left out as the console's own tests leave them out. */
const MACHINE_LEAVES = new Set(['doctor', 'doctor.server', 'doctor.core', 'doctor.memory', 'logs']);

/** Every leaf of the table as a line, each required argument filled with its first choice or `1`. */
function everyLine(): Array<string> {
  const filled = (args: ReadonlyArray<CommandArg>): Array<string> =>
    args
      .filter((one) => one.required)
      .flatMap((one) => (one.flag === undefined ? [one.choices?.[0] ?? '1'] : [one.flag, one.choices?.[0] ?? '1']));
  return COMMANDS.flatMap((command) => {
    const subs = command.subcommands;
    if (subs.length === 0) return [['/' + command.name, ...filled(command.args)].join(' ')];
    return subs.map((one) => ['/' + command.name, ...one.name.split('.'), ...filled(one.args)].join(' '));
  });
}

test('a bare command runs the operation it declares, with no arguments', () => {
  // Catches: the lookup reads subcommands only, so `/pause` and `/resume` lose their operation.
  assert.deepEqual(operationOf('pause', {}), { op: 'bot.pause', args: {} });
});

test('a leaf turns the parsed words into the arguments of its operation', () => {
  // Catches: a route of `any` reaches the operation as a role named `any`, or `fallbacks` stays the word `true`.
  const parsed = parseCommandLine('/routes set vendor/model alpha,beta any true');
  assert.ok(parsed.ok);
  const call = operationOf(parsed.name, parsed.args);
  assert.equal(call?.op, 'route.set');
  assert.equal(call?.args.role, undefined);
  assert.equal(call?.args.fallbacks, true);
  assert.equal(call?.args.providers, 'alpha,beta');
});

test('a leaf answered by a module of its own declares no operation', () => {
  // Catches: `/tools grant` runs a raw operation and skips the console's choice of her account as the target.
  assert.equal(operationOf('tools.grant', { tool: 'web.search' }), null);
});

test('/tools grants runs the whole grant table, access.list', () => {
  // Bug: the owner had no read of the grants members hold, only her own in `/tools list`.
  const parsed = parseCommandLine('/tools grants');
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.reason);
  assert.deepEqual(operationOf(parsed.name, parsed.args), { op: 'access.list', args: {} });
});

test('a name no leaf has declares no operation', () => {
  // Catches: a retired name or a stray client word finds an operation by a partial match.
  assert.equal(operationOf('wakes.stop', {}), null);
  assert.equal(operationOf('', {}), null);
});

test('the console answers every leaf of the table that reaches it', async () => {
  // Catches: a leaf added to the table with no way to run, which the owner learns of only as `no such command`.
  const dir = tempDir('nep-table-runs-');
  const desk = createConsole({
    runOp: () => Promise.resolve({ status: 'ok', code: '', summary: 'done', data: null }),
    ownerReads: { lessons: () => '' },
    places: () => ['g1'],
    selfId: () => 'self-1',
    hot: { config: { bot: { owners: [] } } },
    privateDir: dir,
    dataDir: dir,
    memoryDb: null,
    usage: null,
    metrics: null,
    chatLines: () => [],
    now: () => Date.parse('2026-11-08T12:00:00Z'),
    keys: { enabled: () => false, run: () => Promise.resolve({ text: 'keys', status: 'ok' }) },
    // `/services watcher enable` is a line of the table: without this it moves the server's real timer.
    serviceManager: () => Promise.resolve({ code: 0, stdout: '', stderr: '' }),
  });
  const unanswered: Array<string> = [];
  for (const line of everyLine()) {
    const parsed = parseCommandLine(line);
    assert.ok(parsed.ok, `${line}: ${parsed.ok ? '' : parsed.reason}`);
    if (DESK_LEAVES.has(parsed.name) || MACHINE_LEAVES.has(parsed.name)) continue;
    try {
      const answer = await desk.run(parsed.name, parsed.args, { id: 'owner-1' });
      if (answer.text.includes('no such command')) unanswered.push(parsed.name);
    } catch {
      // A family handler that needs the memory database throws over this fake; it was reached, which is the point.
    }
  }
  assert.deepEqual(unanswered, []);
});
