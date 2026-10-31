// Tests for the chat's command table (src/interface/commands/table.ts): the commands of plan section 4.3 that PR 7a
// adds, and the lines the parse refuses. What each command answers is tested through `neptunia -p` in
// tests/neptunia-commands.test.ts; here only the table and the parse, with no core.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, parseCommandLine } from '../src/interface/commands/table.ts';

/** The commands of the 4.3 table in PR 7a: `/mirror`, `/skills` and `/plugins` come later. */
const TABLE = [
  'status',
  'doctor',
  'health',
  'logs',
  'usage',
  'errands',
  'intentions',
  'wakes',
  'pause',
  'resume',
  'config',
  'model',
  'route',
  'memory',
  'rules',
  'tools',
  'interface',
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
  assert.equal(parseCommandLine('/mirror list').ok, false);
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

test('a /health part and a /usage window outside the table are refused', () => {
  assert.equal(parseCommandLine('/health disks').ok, false);
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

test('every listed part of /health and window of /usage parses', () => {
  for (const line of [
    '/health',
    '/health server',
    '/health core',
    '/health memory',
    '/usage',
    '/usage 7d',
    '/usage 30d',
  ])
    assert.equal(parseCommandLine(line).ok, true, line);
});
