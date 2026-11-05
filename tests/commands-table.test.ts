// Tests for the chat's command table (src/interface/commands/table.ts): the commands of plan section 4.3 that PR 7a
// adds, and the lines the parse refuses. What each command answers is tested through `neptunia -p` in
// tests/neptunia-commands.test.ts; here only the table and the parse, with no core.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, parseCommandLine } from '../src/interface/commands/table.ts';

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
  'simulation',
  // Changed: `/mirror` is the owner's family over the diary's mirrors.
  'mirror',
  'help',
  'clear',
];

test('the table holds exactly the commands of the 4.3 table that 7a builds, each once', () => {
  const names = COMMANDS.map((command) => command.name);
  assert.deepEqual([...names].sort(), [...TABLE].sort());
});

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
  for (const sub of ['show', 'enable', 'disable', 'review', 'activate', 'rollback', 'reject']) {
    const parsed = parseCommandLine(`/skills ${sub} look-it-up`);
    assert.ok(parsed.ok, sub);
    assert.equal(parsed.name, `skills.${sub}`);
    assert.ok(Object.values(parsed.args).includes('look-it-up'), sub);
    assert.equal(parseCommandLine(`/skills ${sub}`).ok, false, `${sub} needs a name`);
  }
});

test('/skills approve is no subcommand: an agent activates, nobody approves', () => {
  assert.equal(parseCommandLine('/skills approve look-it-up').ok, false);
});
