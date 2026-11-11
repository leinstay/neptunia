// Tests for the chat's command table (src/interface/commands/table.ts): the commands of plan section 4.3 that PR 7a
// adds, and the lines the parse refuses. What each command answers is tested through `neptunia -p` in
// tests/neptunia-commands.test.ts; here only the table and the parse, with no core.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, parseCommandLine, operationOf } from '../src/interface/commands/table.ts';
import { createConsole } from '../src/interface/commands/console.ts';
import { menuCommandsOf } from '../src/interface/commands/table.ts';
import type { Command, CommandArg } from '../src/interface/commands/table.ts';
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

/**
 * The family as the owner set it on 2026-11-11, after his cut: the interface first, then its command. Each line with the
 * operation it parses into, the interface it names and the other values it carries.
 */
const INTERFACE_FORMS: ReadonlyArray<{ line: string; name: string; values: ReadonlyArray<string> }> = [
  { line: '/interfaces zeta71 setup', name: 'interfaces.setup', values: [] },
  { line: '/interfaces zeta71 settings', name: 'interfaces.settings', values: [] },
  { line: '/interfaces zeta71 set token', name: 'interfaces.set', values: ['token'] },
  { line: '/interfaces zeta71 set prefix ok', name: 'interfaces.set', values: ['prefix', 'ok'] },
  { line: '/interfaces zeta71 clear token', name: 'interfaces.clear', values: ['token'] },
  { line: '/interfaces zeta71 add servers 111', name: 'interfaces.add', values: ['servers', '111'] },
  { line: '/interfaces zeta71 remove servers 111', name: 'interfaces.remove', values: ['servers', '111'] },
  { line: '/interfaces zeta71 enable', name: 'interfaces.enable', values: [] },
  { line: '/interfaces zeta71 disable', name: 'interfaces.disable', values: [] },
  { line: '/interfaces zeta71 invite', name: 'interfaces.invite', values: [] },
  { line: '/interfaces zeta71 list', name: 'interfaces.roots', values: [] },
];

for (const { line, name, values } of INTERFACE_FORMS) {
  test(`${line} parses into ${name} on the interface it names`, () => {
    // Catches: the name taken for a command word, a value landing under the interface's name, or a command of one
    // interface run on another.
    const parsed = parseCommandLine(line);
    assert.ok(parsed.ok, `${line}: ${parsed.ok ? '' : parsed.reason}`);
    assert.equal(parsed.name, name);
    assert.equal(parsed.args.name, 'zeta71');
    for (const value of values) assert.ok(Object.values(parsed.args).includes(value), `${line} carries ${value}`);
  });
}

test('/interfaces and /interfaces list list every interface', () => {
  // Catches: `list` read as the name of an interface, so the owner's overview becomes a command on nothing.
  for (const line of ['/interfaces', '/interfaces list']) {
    const parsed = parseCommandLine(line);
    assert.ok(parsed.ok, line);
    assert.equal(parsed.name, 'interfaces.list');
    assert.equal(parsed.args.name, undefined, line);
  }
});

test('an interface command without its value is refused', () => {
  // Catches: `set` with no key writing the interface's name as a key, or `remove` with one word taken for something to
  // remove.
  for (const line of ['/interfaces zeta71 set', '/interfaces zeta71 add servers', '/interfaces zeta71 remove servers'])
    assert.equal(parseCommandLine(line).ok, false, line);
});

test('the forms with the command before the interface are no command', () => {
  // The owner's decision of 2026-11-11 removed them with no alias. Catches: an old line still running, here or with
  // its words reread, so a script written for the old order changes the wrong thing.
  for (const line of [
    '/interfaces invite zeta71',
    '/interfaces roots zeta71',
    '/interfaces setup zeta71',
    '/interfaces enable zeta71',
    '/interfaces disable zeta71',
    '/interfaces pair open zeta71',
    '/interfaces set zeta71 token',
  ])
    assert.equal(parseCommandLine(line).ok, false, line);
});

test('pairing, accept and remove of a root are no commands of an interface', () => {
  // The owner removed them on 2026-11-11: a root she is added to is served at once, and his accounts are bound with
  // `/memory bind`. Catches: a removed command still parsed and run under its old name.
  for (const line of [
    '/interfaces zeta71 pair',
    '/interfaces zeta71 pair πέτρα δέντρο νερό',
    '/interfaces zeta71 accept g7',
    '/interfaces zeta71 remove g7',
    '/interfaces pair πέτρα δέντρο νερό',
  ])
    assert.equal(parseCommandLine(line).ok, false, line);
});

test('/skills keeps the command before the skill', () => {
  // Catches: the interfaces grammar spread to the other family built on the same module commands.
  const parsed = parseCommandLine('/skills setup gifs');
  assert.ok(parsed.ok);
  assert.equal(parsed.name, 'skills.setup');
  assert.equal(parsed.args.name, 'gifs');
  assert.equal(parseCommandLine('/skills gifs setup').ok, false);
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
  // The `/interfaces` family puts the interface before its command (owner's decision of 2026-11-11), which a line built
  // from the table's subcommand words cannot spell, so its lines are the spec's forms.
  return COMMANDS.flatMap((command) => {
    if (command.name === 'interfaces') return ['/interfaces', ...INTERFACE_FORMS.map((form) => form.line)];
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

// The rows of the owner's slash menu, built from the table by `menuCommandsOf`.
const NAME_ARG: CommandArg = { name: 'name', required: true };
const MENU_FIXTURE: ReadonlyArray<Command> = [
  {
    name: 'plain',
    help: 'An ordinary command',
    args: [],
    subcommands: [
      { name: 'list', help: 'List them', args: [] },
      { name: 'service.set', help: 'Set one service', args: [{ name: 'key', required: true }] },
    ],
  },
  {
    name: 'named',
    help: 'A command that reads the name first',
    args: [],
    nameFirst: true,
    subcommands: [
      { name: 'list', help: 'Every one', args: [] },
      { name: 'enable', help: 'Enable one', args: [NAME_ARG] },
      { name: 'roots', help: 'Its roots', args: [NAME_ARG], word: 'list' },
    ],
  },
];

test('the menu of an ordinary command has its own row, then a row per leaf with the dot as a space', () => {
  // Catches: a leaf row dropped, a dotted leaf name left with its dot, or the command's own row missing or moved.
  const rows = menuCommandsOf([MENU_FIXTURE[0]], ['alpha']);
  assert.deepEqual(rows, [
    { name: 'plain', help: 'An ordinary command' },
    { name: 'plain list', help: 'List them' },
    { name: 'plain service set', help: 'Set one service' },
  ]);
});

test('the menu of a nameFirst command puts each interface name before the leaf word', () => {
  // Catches: the bug itself, a row `named enable` that is no command, and a leaf row for one name only.
  const rows = menuCommandsOf([MENU_FIXTURE[1]], ['alpha', 'beta']).map((row) => row.name);
  assert.deepEqual(rows, [
    'named',
    'named list',
    'named alpha enable',
    'named beta enable',
    'named alpha list',
    'named beta list',
  ]);
});

test('a leaf of a nameFirst command that has a word shows the word and keeps its own help', () => {
  // Catches: the leaf's name (`roots`) typed after the name instead of its word, or its help replaced.
  const rows = menuCommandsOf([MENU_FIXTURE[1]], ['alpha']);
  assert.equal(rows.find((row) => row.name === 'named alpha list')?.help, 'Its roots');
  assert.equal(
    rows.some((row) => row.name.includes('roots')),
    false
  );
});

test('no row of a nameFirst command puts a leaf word before the name', () => {
  // Catches: the old row order (`named enable alpha`, `named enable`) coming back beside the right one.
  const names = menuCommandsOf([MENU_FIXTURE[1]], ['alpha', 'beta']).map((row) => row.name);
  for (const word of ['enable', 'list'])
    for (const interfaceName of ['alpha', 'beta'])
      assert.equal(names.includes(`named ${word} ${interfaceName}`), false, `named ${word} ${interfaceName}`);
  assert.equal(names.includes('named enable'), false);
});

test('a nameFirst command with no interface names keeps its own row and the leaves without a name', () => {
  // Catches: a leaf row with a missing name (`named  enable`, `named <name> enable`) when no interface exists.
  const rows = menuCommandsOf([MENU_FIXTURE[1]], []);
  assert.deepEqual(
    rows.map((row) => row.name),
    ['named', 'named list']
  );
});

test('the rows of the real table hold no name twice, the roots leaf and the bare list included', () => {
  // Catches: `interfaces list` (every interface) and `interfaces alpha list` (its roots) collapsed into one name.
  const names = menuCommandsOf(COMMANDS, ['alpha', 'beta']).map((row) => row.name);
  assert.deepEqual(names, [...new Set(names)]);
  assert.ok(names.includes('interfaces list'));
  assert.ok(names.includes('interfaces alpha list'));
});

test('every interfaces row of the real table but the command itself is a line the parser knows', () => {
  // The parse takes any name, so a made-up one stands in. A row that asks for a value (`set`) fails on its usage, which
  // is fine here. Catches: a row whose words are no leaf, the failure the old `interfaces disable` row gave.
  const rows = menuCommandsOf(COMMANDS, ['alpha']).filter(
    (row) => row.name.startsWith('interfaces ') && row.name !== 'interfaces'
  );
  assert.ok(rows.length > 2);
  for (const row of rows) {
    const parsed = parseCommandLine('/' + row.name);
    if (parsed.ok) continue;
    assert.doesNotMatch(parsed.reason, /has no command|needs a command|unknown command|has no subcommand/, row.name);
  }
  assert.ok(parseCommandLine('/interfaces alpha disable').ok);
  assert.equal(
    rows.some((row) => row.name === 'interfaces disable'),
    false
  );
});
