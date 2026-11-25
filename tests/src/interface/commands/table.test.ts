// Tests for the chat's command table (src/interface/commands/table.ts): its commands and the lines the parse refuses.
// What each command answers is tested through `neptunia -p` in tests/src/interface/commands/console.test.ts; here only
// the table and the parse, with no core.
import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMANDS,
  parseCommandLine,
  operationOf,
  menuCommandsOf,
  takesSecretStdin,
  commandLineWords,
  parseCommandWords,
} from '../../../../src/interface/commands/table.ts';
import { createConsole } from '../../../../src/interface/commands/console.ts';
import type { Command, CommandArg, Parsed } from '../../../../src/interface/commands/table.ts';
import { tempDir } from '../../../fixtures/tmp.ts';
import { ROUTE_ROLES } from '../../../../src/llm/route-text.ts';
import { COMMAND_NAMES, parseLineRequest, parseRequest } from '../../../../bin/neptunia-request.ts';
import type { TestMemory } from '../../../fixtures/memory-db/service.ts';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Answer } from '../../../../src/interface/commands/console.ts';
import { graphNodeId } from '../../../../src/memory/db/graph.ts';
import type { Db } from '../../../../src/memory/db/types.ts';
import { openTestMemory } from '../../../fixtures/memory-db/service.ts';
import {
  ALEX,
  KAI,
  MIRA,
  ROOM,
  addEntity,
  addSource,
  candidate,
  commit,
  sameAs,
  semanticWorld,
  successor,
  worksOn,
} from '../../../fixtures/memory-db/semantic-world.ts';
import type { World } from '../../../fixtures/memory-db/semantic-world.ts';
import { MODULE_ACTIONS } from '../../../../src/interface/commands/module-setup.ts';
import { ANNA, BORIS } from '../../../fixtures/memory-db/opaque-people.ts';

/** The commands of the table that `/help` lists. */
const TABLE = [
  'status',
  'doctor',
  'logs',
  // `services` holds the scheduled mechanisms.
  'services',
  'usage',
  'errands',
  'intentions',
  'pause',
  // The engine proxy's commands.
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
  // `/agent` holds the execution mode.
  'agent',
  // `/search` holds quick search's targeted settings.
  'search',
  // `/humanizer` switches the humanizer and shows its two roles.
  'humanizer',
  // `/mirror` is the owner's family over the diary's mirrors.
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
  // `/mirror` is a table command, so a word no command has stands for the refused line.
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
  // `review` shows the active text with the candidates.
  for (const sub of ['enable', 'disable', 'review', 'activate', 'rollback', 'reject']) {
    const parsed = parseCommandLine(`/skills ${sub} look-it-up`);
    assert.ok(parsed.ok, sub);
    assert.equal(parsed.name, `skills.${sub}`);
    assert.ok(Object.values(parsed.args).includes('look-it-up'), sub);
    assert.equal(parseCommandLine(`/skills ${sub}`).ok, false, `${sub} needs a name`);
  }
});

/**
 * The family: the interface first, then its command. Each line with the
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
  // They are no commands and have no alias. Catches: a line of the other order still running, here or with its words
  // reread, so a script written for that order changes the wrong thing.
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
  // They are no commands: a root the persona is added to is served at once, and the owner's accounts are bound with
  // `/memory bind`. Catches: a removed command still parsed and run under its name.
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
  // The role of `/model set` and `/model sources` has no choice list, since the agents on disk are roles too, so
  // its word is the first model role.
  const word = (one: CommandArg): string => one.choices?.[0] ?? (one.name === 'role' ? 'core' : '1');
  const filled = (args: ReadonlyArray<CommandArg>): Array<string> =>
    args.filter((one) => one.required).flatMap((one) => (one.flag === undefined ? [word(one)] : [one.flag, word(one)]));
  // The `/interfaces` family puts the interface before its command, which a line built from the table's subcommand
  // words cannot spell, so its lines are written out.
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

test('/errands add hands the named agent the rest of the line as its goal', () => {
  // Catches: the owner's command loses the agent, so a server errand goes to the scout, or the goal is cut at a space.
  const parsed = parseCommandLine('/errands add server list the failed units');
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.reason);
  // Each agent has a tool of its own, so the agent picks the operation and the goal is its one argument.
  assert.deepEqual(operationOf(parsed.name, parsed.args), {
    op: 'errand.server',
    args: { goal: 'list the failed units' },
  });
});

test('a leaf answered by a module of its own declares no operation', () => {
  // Catches: `/tools grant` runs a raw operation and skips the console's choice of the persona's account as the target.
  assert.equal(operationOf('tools.grant', { tool: 'web.search' }), null);
});

test('/tools grants runs the whole grant table, access.list', () => {
  // Bug: the owner has no read of the grants members hold, only the persona's own in `/tools list`.
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
    // `/services heartbeat enable` is a line of the table: without this it moves the server's real timer.
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

test('/routes set and /routes remove offer any and every role the routing knows', () => {
  // Catches: the command keeps a list of its own, so `/routes set <model> <providers> search` is refused.
  const routes = COMMANDS.find((command) => command.name === 'routes');
  for (const name of ['set', 'remove']) {
    const role = routes?.subcommands.find((one) => one.name === name)?.args.find((one) => one.name === 'role');
    assert.deepEqual(role?.choices, ['any', ...ROUTE_ROLES], name);
  }
});

// The public names of the owner's commands: `services`,
// `routes` and `interfaces` are plural collections, `/doctor` holds the checks `/health` had, and `/health`, `/report`,
// `/wakes` and the singular spellings are refused with the new spelling and run nothing. Only the table and its two
// parsers are used (src/interface/commands/table.ts, bin/neptunia-request.ts), with no core and no child process, so
// the chat's line and the shell's argv are compared word for word. Parsed names are asserted by their last words only.

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

/** Whether the dotted `name` ends with the dotted `tail`. */
const endsWith = (name: string, tail: string): boolean => {
  const words = name.split('.');
  const last = tail.split('.');
  return words.slice(words.length - last.length).join('.') === tail;
};

/** The two spellings of one command: the chat's line and the shell's words. */
const both = (words: string, command: string): [Parsed, Parsed] => [
  parseCommandLine(`/${command} ${words}`),
  parseRequest([command, ...words.split(' ')]).parsed,
];

// ---- one table -------------------------------------------------------------------------------------------------------

test('the table holds the plural collections and none of the retired singular or merged commands', () => {
  // Catches: a retired command stays in the table, so help, completion and the usage still offer it.
  const names = COMMANDS.map((command) => command.name).sort();
  assert.deepEqual(
    names,
    [
      // `/agent mode` came from main after this list was written (b6a91eac), and the naming policy leaves it alone.
      'agent',
      // `/agents` lists the agents on disk; the plural names the whole collection, as the policy asks.
      'agents',
      'clear',
      'config',
      'doctor',
      'errands',
      'help',
      // `/humanizer` switches the humanizer and shows its two roles.
      'humanizer',
      'intentions',
      'interfaces',
      'keys',
      'logs',
      'memory',
      'mirror',
      // The owner's `/mnemonic` shows and switches the language of the phrase codes.
      'mnemonic',
      'model',
      'pause',
      // The engine proxy's commands.
      'proxy',
      'resume',
      'routes',
      'rules',
      'search',
      'services',
      'skills',
      'status',
      'subharness',
      'tools',
      'usage',
    ].sort()
  );
  assert.deepEqual([...COMMAND_NAMES].sort(), names, 'the shell and the chat list one table');
});

// ---- services --------------------------------------------------------------------------------------------------------

/** One command of the family, how its parsed name ends and the arguments it must carry. */
const SERVICE_LINES: ReadonlyArray<{ words: string; tail: string; args: Record<string, string> }> = [
  { words: 'heartbeat status', tail: 'heartbeat.status', args: {} },
  { words: 'diary enable', tail: 'diary.enable', args: {} },
  {
    words: 'heartbeat setup --every 3h --jitter 30m',
    tail: 'heartbeat.setup',
    args: { every: '3h', jitter: '30m' },
  },
  { words: 'heartbeat setup --at 00:00,12:00', tail: 'heartbeat.setup', args: { at: '00:00,12:00' } },
  { words: 'list', tail: 'list', args: {} },
];

for (const { words, tail, args } of SERVICE_LINES) {
  test(`/services ${words} and the argv of neptunia services ${words} give one operation with the same arguments`, () => {
    // Catches: the slash line and the shell's words reach different handlers, or an argument lands under another name.
    const [chat, shell] = both(words, 'services');
    const line = assertAccepted(parseLineRequest(`/services ${words}`).parsed);
    assert.deepEqual(shell, chat);
    assert.deepEqual(line, assertAccepted(chat));
    assert.ok(endsWith(line.name, tail), line.name);
    assert.deepEqual(line.args, args);
  });
}

test('services takes the two mechanisms and the list, and no process unit', () => {
  // Catches: the system units (core, agent runners) slip into the scheduled mechanisms, or a fifth mechanism appears.
  const services = COMMANDS.find((command) => command.name === 'services');
  assert.ok(services);
  const first = new Set(services.subcommands.map((one) => one.name.split('.')[0]));
  assert.deepEqual([...first].sort(), ['diary', 'heartbeat', 'list']);
});

for (const words of [
  'start',
  'stop',
  'restart',
  'status',
  'restart neptunia-core.service',
  // `bogus status` stands for a word that names no mechanism.
  'bogus status',
  'list extra',
]) {
  test(`/services ${words} is refused: the unit verbs stay in the shell and are no mechanism`, () => {
    // Catches: the verbs of the system units become chat commands, or a bad word runs as if it were a mechanism.
    const reason = assertRefused(parseCommandLine(`/services ${words}`));
    assert.equal(reason.startsWith('unknown command'), false, 'the family itself is known');
  });
}

for (const [line, options] of [
  ['/logs', undefined],
  ['/logs errors', 'errors'],
  ['/logs follow', 'follow'],
  ['/logs since 1 hour ago', 'since 1 hour ago'],
  ['/logs errors since 2 hours ago follow', 'errors since 2 hours ago follow'],
] as const) {
  test(`${line} keeps its journal filters`, () => {
    // Catches: the journal's errors, follow or since lost on the way to journalctl.
    const parsed = assertAccepted(parseCommandLine(line));
    assert.equal(parsed.args.options, options);
  });
}

test('a since value written as one quoted argv word keeps its spaces', () => {
  // Catches: the shell's single word is split or dropped on its way into the journal filter.
  const parsed = assertAccepted(parseRequest(['logs', 'since', '1 hour ago']).parsed);
  assert.equal(parsed.args.options, 'since 1 hour ago');
});

// A word `/logs` does not take is `frobnicate`.
for (const line of ['/logs since', '/logs frobnicate']) {
  test(`${line} is refused before any source is read`, () => {
    // Catches: a line with a word the journal does not take reads the journal anyway.
    assertRefused(parseCommandLine(line));
  });
}

// ---- /doctor ---------------------------------------------------------------------------------------------------------

test('/doctor, its three scopes and live are five different operations without arguments', () => {
  // Catches: the merged health scopes answer as the aggregate, or as the model probe.
  const names = ['', ' server', ' core', ' memory', ' live'].map((scope) => {
    const chat = parseCommandLine(`/doctor${scope}`);
    const shell = parseRequest(['doctor', ...scope.split(' ').filter((word) => word !== '')]).parsed;
    assert.deepEqual(shell, chat);
    const parsed = assertAccepted(chat);
    assert.deepEqual(parsed.args, {});
    return parsed.name;
  });
  assert.equal(new Set(names).size, 5, names.join(' '));
  assert.ok(endsWith(names[4] ?? '', 'live'));
});

for (const line of ['/doctor disks', '/doctor server core', '/doctor live server']) {
  test(`${line} is refused`, () => {
    // Catches: a scope the table does not have runs as the aggregate.
    assertRefused(parseCommandLine(line));
  });
}

// ---- other families --------------------------------------------------------------------------------------------------

test('/routes takes the arguments /route took, and a model with a space stays one word', () => {
  // Catches: the plural family renames its leaves or reads the shell's words differently from the chat's.
  assert.deepEqual(assertAccepted(parseCommandLine('/routes set vendor/model prov1,prov2 any true false')).args, {
    model: 'vendor/model',
    providers: 'prov1,prov2',
    role: 'any',
    fallbacks: 'true',
    byok: 'false',
  });
  assert.deepEqual(assertAccepted(parseCommandLine('/routes remove vendor/model any')).args, {
    model: 'vendor/model',
    role: 'any',
  });
  assert.equal(
    assertAccepted(parseRequest(['routes', 'set', 'vendor/model x', 'p1']).parsed).args.model,
    'vendor/model x'
  );
  assert.ok(endsWith(assertAccepted(parseCommandLine('/routes')).name, 'list'));
});

test('/interfaces keeps its leaves', () => {
  // No interface brings subcommands of its own, and tests/bin/neptunia-request.test.ts checks that such a word is
  // refused. Catches: the rename drops a leaf.
  // The interface comes before its command.
  assert.ok(endsWith(assertAccepted(parseCommandLine('/interfaces zeta71 enable')).name, 'enable'));
});

test('the table parses /subharness: a bare line is the status', () => {
  // Bug: the bare family word asks for a subcommand, so the owner cannot read what runs where.
  // The family has no enable and disable forms.
  assert.deepEqual(parseCommandLine('/subharness'), { ok: true, name: 'subharness.status', args: {} });
  assert.deepEqual(parseCommandLine('/subharness status'), { ok: true, name: 'subharness.status', args: {} });
});

test('the table parses /agent mode with a unit, an optional mode, and refuses other words', () => {
  // Bug: a mode outside the four reaches the handler, or a unit outside the two is accepted.
  // A mode belongs to a unit, which carries the name of its one agent; `web` is no unit.
  assert.deepEqual(parseCommandLine('/agent mode scout sudo'), {
    ok: true,
    name: 'agent.mode',
    args: { unit: 'scout', mode: 'sudo' },
  });
  assert.deepEqual(parseCommandLine('/agent mode server'), {
    ok: true,
    name: 'agent.mode',
    args: { unit: 'server' },
  });
  for (const line of ['/agent mode', '/agent mode scout root', '/agent mode web read'])
    assert.equal(parseCommandLine(line).ok, false, line);
});

test('the table parses /agents and /agent enable and disable into their operations', () => {
  // Bug: the owner has no command to list the agents or switch one on, so a local agent stays off.
  assert.deepEqual(parseCommandLine('/agents'), { ok: true, name: 'agents', args: {} });
  assert.deepEqual(parseCommandLine('/agent enable code'), {
    ok: true,
    name: 'agent.enable',
    args: { name: 'code' },
  });
  assert.deepEqual(parseCommandLine('/agent disable code'), {
    ok: true,
    name: 'agent.disable',
    args: { name: 'code' },
  });
});

test('/help has a line for /subharness, and every subcommand of it has a help line', () => {
  // Bug: a command is added to the handlers and not to the table, so /help never lists it.
  for (const name of ['subharness']) {
    const command = COMMANDS.find((one) => one.name === name);
    assert.ok(command, name);
    assert.notEqual(command.help.trim(), '');
    assert.deepEqual(
      command.subcommands.filter((sub) => sub.help.trim() === '').map((sub) => sub.name),
      []
    );
  }
});

test('the chat parses the search commands and the binding target', () => {
  // Bug: the table lacks a command the setup promises.
  for (const line of [
    '/search',
    '/search enable',
    '/search disable',
    '/search engine brave',
    // Quick search runs on the analyzer, so its routes are checked as the analyzer's.
    '/keys check analyzer',
  ]) {
    assert.match(JSON.stringify(parseCommandLine(line)), /"name":"(search|keys)\.[a-z]+"/, line);
  }
  // Quick search has no chain of its own, so no command puts a model on it.
  assert.doesNotMatch(JSON.stringify(parseCommandLine('/search model a/b')), /"name":"search\.model"/);
});

const AGENT = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';

test('the chat parses every proxy command, and only set takes its value as a secret', () => {
  // Catches: the group is missing from the shared table, so `/nep proxy` and the CLI disagree, or the URL goes on a command line.
  for (const line of [
    '/proxy set',
    '/proxy on',
    '/proxy off',
    '/proxy status',
    '/proxy test',
    `/proxy useragent ${AGENT}`,
  ]) {
    const parsed = parseCommandLine(line);
    assert.equal(parsed.ok, true, line);
    if (parsed.ok) assert.match(parsed.name, /^proxy\./, line);
  }
  const ua = parseCommandLine(`/proxy useragent ${AGENT}`);
  assert.equal(ua.ok && ua.args.value, AGENT);
  assert.equal(takesSecretStdin('proxy.set'), true);
  assert.equal(takesSecretStdin('proxy.on'), false);
});

test('the table parses model set for an agent with an effort', () => {
  // Catches: the table refuses an agent as no model role, or drops --effort, so the dialog never sees it.
  // The agent named is the server.
  const parsed = parseCommandLine('/model set server gpt-6-astra --effort medium');
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.deepEqual(parsed.args, { role: 'server', model: 'gpt-6-astra', effort: 'medium' });
});

const LINES = [
  ['/memory graph kinds', 'memory.graph.kinds'],
  ['/memory graph nodes --kinds claim,person --limit 5 --cursor c1', 'memory.graph.nodes'],
  [
    '/memory graph edges --predicates quotes --mode historical --valid-at 2026-01-01T00:00:00.000Z --recorded-before 2026-02-01T00:00:00.000Z --limit 5 --cursor c1',
    'memory.graph.edges',
  ],
  ['/memory graph node claim:a', 'memory.graph.node'],
  [
    '/memory graph neighbors claim:a --direction both --predicates quotes --mode active --limit 5 --cursor c1',
    'memory.graph.neighbors',
  ],
  [
    '/memory graph walk claim:a --direction in --predicates quotes --mode historical --depth 3 --nodes 9 --cursor c1',
    'memory.graph.walk',
  ],
  ['/memory graph path claim:a claim:b --direction both --mode active --depth 4', 'memory.graph.path'],
] as const;

for (const [line, name] of LINES) {
  test(`${line} parses to ${name}, the same from the chat and from argv`, () => {
    const fromChat = parseCommandLine(line);
    assert.ok(fromChat.ok, fromChat.ok ? '' : fromChat.reason);
    assert.equal(fromChat.name, name);
    assert.deepEqual(parseRequest(commandLineWords(line)).parsed, fromChat);
  });
}

const rigs: Array<TestMemory> = [];

// ---------- the table ----------

const LOCATOR = '{"kind":"rowid","alias":"rowid","value":"1"}';
const INSPECT_LINES: ReadonlyArray<readonly [Array<string>, string]> = [
  [['memory', 'inspect', 'tables'], 'memory.inspect.tables'],
  [['memory', 'inspect', 'tables', '--snapshot', 's1'], 'memory.inspect.tables'],
  [['memory', 'inspect', 'schema', 'claims', '--snapshot', 's1'], 'memory.inspect.schema'],
  [
    ['memory', 'inspect', 'rows', 'claims', '--snapshot', 's1', '--limit', '5', '--cursor', 'c1', '--filters', '[]'],
    'memory.inspect.rows',
  ],
  [['memory', 'inspect', 'row', 'claims', LOCATOR, '--snapshot', 's1'], 'memory.inspect.row'],
  [
    ['memory', 'inspect', 'value', 'claims', LOCATOR, 'text', '--snapshot', 's1', '--offset', '10'],
    'memory.inspect.value',
  ],
  [['memory', 'inspect', 'export', '/tmp/x.jsonl'], 'memory.inspect.export'],
  [['memory', 'inspect', 'close', 's1'], 'memory.inspect.close'],
  [['memory', 'sources', 'show', 'source:1'], 'memory.sources.show'],
  [['memory', 'sources', 'list', '--limit', '5', '--cursor', 'c1'], 'memory.sources.list'],
  [['memory', 'claims', 'show', 'claim:1'], 'memory.claims.show'],
  [['memory', 'claims', 'versions', 'claim:1'], 'memory.claims.versions'],
  [['memory', 'descriptions', 'show', 'desc:1'], 'memory.descriptions.show'],
  [['memory', 'episodes', 'show', 'episode:1'], 'memory.episodes.show'],
  [['memory', 'diary', 'show', 'diary:1'], 'memory.diary.show'],
  [['memory', 'media', 'show', 'media:1'], 'memory.media.show'],
  [['memory', 'publications', 'show', 'publication:1'], 'memory.publications.show'],
  [['memory', 'sessions', 'show', 'session:1'], 'memory.sessions.show'],
  [['memory', 'requests', 'show', 'request:1'], 'memory.requests.show'],
  [['memory', 'turns', 'show', 'turn:1'], 'memory.turns.show'],
];

describe('commands memory inspect', () => {
  after(async () => {
    for (const memory of rigs) await memory.close();
  });

  for (const [words, name] of INSPECT_LINES) {
    test(`${words.join(' ')} parses to ${name} from argv and as a whole line`, () => {
      const fromArgv = parseCommandWords(words);
      assert.ok(fromArgv.ok, fromArgv.ok ? '' : fromArgv.reason);
      assert.equal(fromArgv.name, name);
      assert.deepEqual(parseRequest(words).parsed, fromArgv);
      if (!words.includes(LOCATOR))
        assert.deepEqual(parseRequest(commandLineWords(`/${words.join(' ')}`)).parsed, fromArgv);
    });
  }
});

const BOUNDS = { pageRows: 25, snapshotIdleSeconds: 60, snapshotMaxSeconds: 300, maxSnapshots: 8 };

type Version = { claimId: string; versionId: string };
const written = (result: object): Version => result as Version;

/** What the seed wrote, by name, and the contexts the core would issue for the group and the two DMs. */
type Seeded = {
  open: string;
  secret: string;
  edited: string;
  lumen: string;
  orbis: string;
  hidden: string;
  lumenName: Version;
  hiddenName: Version;
  moth: Version;
  works1: Version;
  works2: Version;
  kai: Version;
  mira: Version;
  event: Version;
  dmMeeting: Version;
  hiddenWork: Version;
  kite: string;
  kyte: string;
  contexts: World['contexts'];
};

type Rig = {
  memory: TestMemory;
  db: Db;
  ops: Array<string>;
  dir: string;
  seeded: Seeded;
  /** One command as argv words, as `neptunia memory ...` hands them over. */
  say(...words: Array<string>): Promise<Answer>;
  /** One command as the chat's line. */
  line(text: string): Promise<Answer>;
  run(command: { name: string; args: Record<string, unknown> }): Promise<Answer>;
};

const label = (entityId: string, role: 'alias', text: string, sources: Array<string>) =>
  candidate(
    'entity.label',
    'label',
    [
      { role: 'entity', position: 0, ref: { kind: 'entity', id: entityId } },
      { role, position: 0, literal: text },
      { role: 'language', position: 0, literal: 'en' },
    ],
    sources
  );

/**
 * A public project, a public event and a project only Alex's DM knows; a DM alias; a relation changed from positive to
 * negative; a public and a private inference resting on its first version; an event with four roles held in the room; a
 * DM meeting in the room; two public concepts declared the same; and an edited revision of the public line the facts cite.
 */
function seed(world: World): Seeded {
  const open = addSource(world, 'public', 'Alex works on Lumen; Orbis met in the room with Mira speaking');
  const secret = addSource(world, 'alex', 'Mira helps on Lumen; Hidden is mine');
  const lumen = addEntity(world, 'project', 'Lumen', [open]);
  const orbis = addEntity(world, 'event', 'Orbis', [open]);
  const hidden = addEntity(world, 'project', 'Hidden', [secret], world.contexts.alex);
  const moth = written(commit(world, label(lumen.entityId, 'alias', 'Moth', [secret]), world.contexts.alex));
  const works1 = written(commit(world, worksOn(ALEX, lumen.entityId, [open])));
  const inferred = { how: 'inferred', dependencies: [{ versionId: works1.versionId, role: 'supports' as const }] };
  const kai = written(commit(world, worksOn(KAI, lumen.entityId, [open], inferred)));
  const mira = written(commit(world, worksOn(MIRA, lumen.entityId, [secret], inferred), world.contexts.alex));
  const event = written(
    commit(
      world,
      candidate(
        'event.occurrence',
        'nary',
        [
          { role: 'event', position: 0, ref: { kind: 'entity', id: orbis.entityId } },
          { role: 'organizer', position: 0, ref: { kind: 'person', id: ALEX } },
          { role: 'speaker', position: 0, ref: { kind: 'person', id: MIRA } },
          { role: 'project', position: 0, ref: { kind: 'entity', id: lumen.entityId } },
          { role: 'location', position: 0, ref: { kind: 'place', id: ROOM } },
        ],
        [open]
      )
    )
  );
  const dmMeeting = written(
    commit(
      world,
      candidate(
        'event.occurrence',
        'nary',
        [
          { role: 'event', position: 0, ref: { kind: 'entity', id: hidden.entityId } },
          { role: 'attendee', position: 0, ref: { kind: 'person', id: ALEX } },
          { role: 'location', position: 0, ref: { kind: 'place', id: ROOM } },
        ],
        [secret]
      ),
      world.contexts.alex
    )
  );
  const hiddenWork = written(commit(world, worksOn(ALEX, hidden.entityId, [secret]), world.contexts.alex));
  const works2 = written(
    commit(world, worksOn(ALEX, lumen.entityId, [open], successor(works1, { polarity: 'negative' })))
  );
  const kite = addEntity(world, 'concept', 'Kite', [open]).entityId;
  const kyte = addEntity(world, 'concept', 'Kyte', [open]).entityId;
  commit(world, sameAs(kyte, kite, [open]));
  const edited = 'src:edited';
  world.db
    .prepare(
      `INSERT INTO sources (id, kind, iface, native_id, revision, place_id, author_account, author_kind, occurred_at,
         recorded_at, text, scope_kind, scope_iface, scope_dm, audience_id)
       SELECT ?, kind, iface, native_id, 2, place_id, author_account, author_kind, occurred_at, recorded_at, 'edited later',
         scope_kind, scope_iface, scope_dm, audience_id FROM sources WHERE id = ?`
    )
    .run(edited, open);
  return {
    open,
    secret,
    edited,
    lumen: lumen.entityId,
    orbis: orbis.entityId,
    hidden: hidden.entityId,
    lumenName: lumen,
    hiddenName: hidden,
    moth,
    works1,
    works2,
    kai,
    mira,
    event,
    dmMeeting,
    hiddenWork,
    kite,
    kyte,
    contexts: world.contexts,
  };
}

/** The seed through the writer on a file, then the real service over that file with the console on it. */
async function rig(): Promise<Rig> {
  const world = semanticWorld();
  const seeded = seed(world);
  world.handle.close();
  const dir = dirname(world.file);
  mkdirSync(join(dir, 'config'), { recursive: true });
  const memory = await openTestMemory({ dataDir: dir, config: { memoryDb: { inspection: BOUNDS } } });
  rigs.push(memory);
  const db = memory.memoryDb.database();
  assert.ok(db);
  const ops: Array<string> = [];
  const desk = createConsole({
    runOp: (op) => {
      ops.push(op);
      return Promise.resolve({ status: 'failed', code: 'NOT_FOR_A_BROWSER_READ', summary: '', data: null });
    },
    ownerReads: { lessons: () => '' },
    places: () => [],
    selfId: () => null,
    hot: memory.hot,
    privateDir: dir,
    dataDir: memory.dataDir,
    memoryDb: memory.memoryDb,
    usage: null,
    metrics: { samples: () => [] },
    chatLines: () => [],
    now: () => Date.UTC(2026, 10, 5, 12),
  });
  const run = async (command: { name: string; args: Record<string, unknown> }): Promise<Answer> => {
    const real = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(new Error('a memory read reached the network'));
    try {
      return await desk.run(command.name, command.args, { id: 'owner' });
    } finally {
      globalThis.fetch = real;
    }
  };
  return {
    memory,
    db,
    ops,
    dir,
    seeded,
    run,
    say: (...words) => {
      const parsed = parseRequest(words).parsed;
      assert.ok(parsed.ok, parsed.ok ? '' : `${words.join(' ')}: ${parsed.reason}`);
      return run(parsed);
    },
    line: (text) => {
      const parsed = parseCommandLine(text);
      assert.ok(parsed.ok, parsed.ok ? '' : `${text}: ${parsed.reason}`);
      return run(parsed);
    },
  };
}
const entityNode = (id: string): string => graphNodeId('semantic_entity', id);

// ---- the command table -----------------------------------------------------------------------------------------------

const AT = '2026-11-05T10:00:30.000Z';
const SEMANTIC_LINES: ReadonlyArray<readonly [Array<string>, string, Record<string, string>]> = [
  [['memory', 'entities', 'list'], 'memory.entities.list', {}],
  [
    [
      'memory',
      'entities',
      'list',
      '--kind',
      'project',
      '--name',
      'Lumen',
      '--recorded-before',
      AT,
      '--limit',
      '5',
      '--cursor',
      'c1',
    ],
    'memory.entities.list',
    { kind: 'project', name: 'Lumen', 'recorded-before': AT, limit: '5', cursor: 'c1' },
  ],
  [['memory', 'entities', 'show', 'ent:1', '--recorded-before', AT], 'memory.entities.show', { entity: 'ent:1' }],
  [['memory', 'entities', 'names', 'ent:1'], 'memory.entities.names', { entity: 'ent:1' }],
  [
    [
      'memory',
      'entities',
      'relations',
      'ent:1',
      '--predicates',
      'project.works_on',
      '--mode',
      'historical',
      '--recorded-before',
      AT,
      '--limit',
      '5',
      '--cursor',
      'c1',
    ],
    'memory.entities.relations',
    { entity: 'ent:1', predicates: 'project.works_on', mode: 'historical', 'recorded-before': AT },
  ],
];

describe('commands memory semantic', () => {
  after(async () => {
    for (const memory of rigs) await memory.close();
  });

  for (const [words, name, args] of SEMANTIC_LINES) {
    test(`${words.join(' ')} parses to ${name}, the same from argv and from the chat`, () => {
      const fromArgv = parseCommandWords(words);
      assert.ok(fromArgv.ok, fromArgv.ok ? '' : fromArgv.reason);
      assert.equal(fromArgv.name, name);
      for (const [key, value] of Object.entries(args)) assert.equal(fromArgv.args[key], value, key);
      assert.deepEqual(parseRequest(words).parsed, fromArgv);
      assert.deepEqual(parseCommandLine(`/${words.join(' ')}`), fromArgv);
    });
  }

  test('a semantic graph id reads the same from a chat line and from argv', async () => {
    const one = await rig();
    const node = entityNode(one.seeded.lumen);
    const words = ['memory', 'graph', 'neighbors', node, '--direction', 'in', '--predicates', 'asserts'];
    const fromShell = await one.say(...words);
    const fromChat = await one.line(`/${words.join(' ')}`);
    assert.equal(fromShell.status, 'ok');
    assert.equal(fromChat.text, fromShell.text);
  });
});

// ---------- the table ----------

const MEMORY_LINES = [
  ['/memory users list', 'memory.users.list'],
  [
    '/memory users list --name Ελένη --interface discord --authority discord/global --limit 5 --cursor c1',
    'memory.users.list',
  ],
  ['/memory users show person:x', 'memory.users.show'],
  ['/memory users accounts person:x', 'memory.users.accounts'],
  ['/memory users names person:x', 'memory.users.names'],
  ['/memory users relationship person:x', 'memory.users.relationship'],
  ['/memory users private person:x', 'memory.users.private'],
  ['/memory places list --interface zeta --authority zeta/one --roots --limit 5 --cursor c1', 'memory.places.list'],
  ['/memory places tree place:x --limit 5', 'memory.places.tree'],
  ['/memory places show place:x --include-children', 'memory.places.show'],
  // Bare `/memory places lore <place>` is no command: `places show` lists the claim rows, and `places lore list` the
  // entries.
] as const;

for (const [line, name] of MEMORY_LINES) {
  test(`${line} parses to ${name}, the same from the chat and from argv`, () => {
    // Bug: a leaf added to one path, so a script and the chat disagree on the operation or its typed arguments.
    const fromChat = parseCommandLine(line);
    assert.ok(fromChat.ok, fromChat.ok ? '' : fromChat.reason);
    assert.equal(fromChat.name, name);
    assert.deepEqual(parseRequest(commandLineWords(line)).parsed, fromChat);
  });
}

// The family

for (const backend of ['codex', 'claude', 'opencode']) {
  for (const action of ['login', 'status', 'logout']) {
    test(`/subharness ${backend} ${action} parses as its own leaf, in the chat and on argv`, () => {
      // Catches: the backend word falling through to a usage error, or the two spellings differing.
      const expected = { ok: true, name: `subharness.${backend}.${action}`, args: {} };
      assert.deepEqual(parseCommandLine(`/subharness ${backend} ${action}`), expected);
      assert.deepEqual(parseCommandWords(['subharness', backend, action]), expected);
    });
  }
}

test('opencode login takes the extra key by name', () => {
  // Catches: opencode with no way to say which key it runs on, since it has no vendor login of its own here.
  assert.deepEqual(parseCommandLine('/subharness opencode login --key oc-1'), {
    ok: true,
    name: 'subharness.opencode.login',
    args: { key: 'oc-1' },
  });
});

test('every action of the contract has its command, and the chat parses the targeted commands of both module kinds', () => {
  // Bug: the table lacks a command the setup promises, so nobody can change one value without the whole walk.
  // The interface comes before its command.
  for (const [line, name] of [
    ['/interfaces discord setup', 'interfaces.setup'],
    ['/interfaces discord settings', 'interfaces.settings'],
    ['/interfaces discord set token', 'interfaces.set'],
    ['/interfaces discord clear token', 'interfaces.clear'],
    ['/interfaces discord add servers 111', 'interfaces.add'],
    ['/interfaces discord remove servers 111', 'interfaces.remove'],
    ['/skills setup gifs', 'skills.setup'],
    ['/skills settings gifs', 'skills.settings'],
    ['/skills set gifs key', 'skills.set'],
    ['/skills clear gifs key', 'skills.clear'],
  ]) {
    const parsed = parseCommandLine(line);
    assert.equal(typeof parsed === 'object' && parsed !== null && 'name' in parsed ? parsed.name : parsed, name, line);
  }
});

test('the actions the console routes are the ones the table offers', () => {
  // Bug: an action of the contract has no row, so `moduleCommand` can never reach it from the chat.
  for (const action of MODULE_ACTIONS) {
    const words = action === 'setup' || action === 'settings' ? 'gifs' : 'gifs key value';
    assert.match(JSON.stringify(parseCommandLine(`/skills ${action} ${words}`)), new RegExp(`skills\\.${action}`));
  }
});

const NAMES = ['heartbeat', 'diary'] as const;
const ACTIONS = ['setup', 'enable', 'disable', 'status'] as const;

for (const name of NAMES) {
  for (const action of ACTIONS) {
    test(`/services ${name} ${action} parses as service.${name}.${action}`, () => {
      // Catches: a name or an action of the family is missing from the table, so the chat answers "unknown command".
      assert.deepEqual(parseCommandLine(`/services ${name} ${action}`), {
        ok: true,
        name: `services.${name}.${action}`,
        args: {},
      });
    });
  }
}

test('setup takes --at and --every as flags', () => {
  // Catches: the value is read as a positional word, or the flag name differs from the one the docs and setup offer.
  assert.deepEqual(parseCommandLine('/services heartbeat setup --at 00:00,12:00'), {
    ok: true,
    name: 'services.heartbeat.setup',
    args: { at: '00:00,12:00' },
  });
  assert.deepEqual(parseCommandLine('/services diary setup --every 90m'), {
    ok: true,
    name: 'services.diary.setup',
    args: { every: '90m' },
  });
});

test('heartbeat setup takes --jitter beside an interval, and alone', () => {
  // Catches: the jitter of the heartbeat has no way to be set once `/config` stops being the only door to it.
  assert.deepEqual(parseCommandLine('/services heartbeat setup --every 3h --jitter 30m'), {
    ok: true,
    name: 'services.heartbeat.setup',
    args: { every: '3h', jitter: '30m' },
  });
  assert.deepEqual(parseCommandLine('/services heartbeat setup --jitter 0m'), {
    ok: true,
    name: 'services.heartbeat.setup',
    args: { jitter: '0m' },
  });
});

for (const line of [
  // The modes exclude each other.
  '/services heartbeat setup --at 00:00 --every 6h',
  // Malformed and duplicate slots.
  '/services heartbeat setup --at 25:00',
  '/services heartbeat setup --at 7:00',
  '/services heartbeat setup --at 00:60',
  '/services heartbeat setup --at noon',
  '/services heartbeat setup --at 00:00,00:00',
  '/services heartbeat setup --at 00:00,',
  '/services heartbeat setup --at ,00:00',
  // Zero, negative and malformed intervals.
  '/services heartbeat setup --every 0h',
  '/services heartbeat setup --every 0m',
  '/services heartbeat setup --every -1h',
  '/services heartbeat setup --every 6',
  '/services heartbeat setup --every 1.5h',
  '/services heartbeat setup --every 1h30m',
  '/services heartbeat setup --every 6d',
  // Only the heartbeat has a jitter, only on an interval, and it is a duration of zero or more.

  '/services diary setup --every 6h --jitter 5m',
  '/services heartbeat setup --at 06:00 --jitter 5m',
  '/services heartbeat setup --every 3h --jitter -5m',
  '/services heartbeat setup --every 3h --jitter soon',
  // Only setup takes a schedule.
  '/services heartbeat enable --every 3h',
  '/services heartbeat status --at 00:00',
  // No mechanic has the operations of one run.
  '/services heartbeat trigger',
  '/services diary cancel',
  // A name or an action outside the family, and the verbs of the system units, which belong to the shell.
  '/services bogus status',
  '/services status',
  '/services restart',
  '/services',
]) {
  test(`the parse refuses "${line}"`, () => {
    // Catches: a line the handler would have to reject reaches it, so the chat and the shell can disagree on it.
    const parsed = parseCommandLine(line);
    assert.equal(parsed.ok, false);
    assert.equal(!parsed.ok && parsed.reason.startsWith('unknown command'), false, 'the family itself is known');
  });
}

test('/config check is a command of the table', () => {
  assert.deepEqual(parseCommandLine('/config check'), { ok: true, name: 'config.check', args: {} });
});

test('the table parses the keys commands to the names and arguments the commands answer to', () => {
  const parsed = (line: string) => {
    const result = parseCommandLine(line);
    return result.ok ? { name: result.name, args: result.args } : result.reason;
  };
  const refused = (line: string): boolean => !parseCommandLine(line).ok;
  // The key commands take a key's name, and `check` takes a role or a key.
  assert.deepEqual(parsed('/keys add core-1'), { name: 'keys.add', args: { name: 'core-1' } });
  assert.deepEqual(parsed('/keys remove core-1'), { name: 'keys.remove', args: { name: 'core-1' } });
  assert.deepEqual(parsed('/keys list'), { name: 'keys.list', args: {} });
  assert.deepEqual(parsed('/keys check vision'), { name: 'keys.check', args: { target: 'vision' } });
  assert.deepEqual(parsed('/model set vision x/y'), { name: 'model.set', args: { role: 'vision', model: 'x/y' } });
  for (const line of ['/keys', '/keys bind drawing art', '/keys check', '/keys add'])
    assert.equal(refused(line), true, `${line} is refused with a reason`);
});

// the table

test('the table parses model set with a provider and an effort', () => {
  // Catches: the flags refused as unknown, so neither setting can be given from the chat.
  const parsed = parseCommandLine('/model set analyzer openai/gpt-6.1-sol --provider openai --effort high');
  assert.equal(parsed.ok, true);
  if (parsed.ok)
    assert.deepEqual(parsed.args, {
      role: 'analyzer',
      model: 'openai/gpt-6.1-sol',
      provider: 'openai',
      effort: 'high',
    });
});

test('the table parses model set for the memory role', () => {
  // Catches: "memory" refused as no model role, so the memory writer's model and key path cannot be set.
  const parsed = parseCommandLine('/model set memory anthropic/claude-opus-4.6');
  assert.equal(parsed.ok, true);
});

test('the chat parses the service commands', () => {
  // Bug: the table lacks the command the setup step names.
  for (const line of ['/keys service list', '/keys service set youtube', '/keys service clear youtube']) {
    const parsed = parseCommandLine(line);
    assert.match(JSON.stringify(parsed), /keys\.service\./, line);
  }
});

// ---------- the owner's command ----------

test('/memory users merge parses the same from the chat and from argv', () => {
  const line = `/memory users merge ${BORIS} ${ANNA} --reason same`;
  const fromChat = parseCommandLine(line);
  assert.ok(fromChat.ok, fromChat.ok ? '' : fromChat.reason);
  assert.equal(fromChat.name, 'memory.users.merge');
  assert.deepEqual(parseRequest(commandLineWords(line)).parsed, fromChat);
});
