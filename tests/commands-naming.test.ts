// The public names of the owner's commands after the naming policy (the command naming spec of 2026-11-04): `services`,
// `routes` and `interfaces` are plural collections, `/logs watcher` reads the watcher's reports, `/doctor` holds the
// checks `/health` had, and `/health`, `/report`, `/wakes` and the singular spellings are refused with the new spelling
// and run nothing. Only the table and its two parsers are used (src/interface/commands/table.ts, bin/neptunia-request.ts),
// with no core and no child process, so the chat's line and the shell's argv are compared word for word. Parsed names
// are asserted by their last words only: the internal `service.watcher.*` names may stay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatPanel } from '../bin/chat-panels.ts';
import { COMMAND_NAMES, parseLineRequest, parseRequest } from '../bin/neptunia-request.ts';
import { COMMANDS, parseCommandLine } from '../src/interface/commands/table.ts';
import type { Parsed } from '../src/interface/commands/table.ts';

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
      'clear',
      'config',
      'doctor',
      'errands',
      'help',
      'intentions',
      'interfaces',
      'keys',
      'logs',
      'memory',
      'mirror',
      'model',
      'pause',
      // Stage Z: the engine proxy's commands.
      'proxy',
      'resume',
      'routes',
      'rules',
      'search',
      'services',
      'simulation',
      'skills',
      'status',
      'subharness',
      'tools',
      'usage',
    ].sort()
  );
  assert.deepEqual([...COMMAND_NAMES].sort(), names, 'the shell and the chat list one table');
});

test('/model and /subharness keep their names', () => {
  // Catches: the rename sweeps the two entry points the owner asked to keep.
  for (const line of ['/model show', '/subharness status']) assertAccepted(parseCommandLine(line));
});

test('the help panel lists the plural collections and none of the retired commands', async () => {
  // Catches: the panel keeps a list of its own that drifts from the table.
  const panel = await chatPanel('/help', () => Promise.resolve({ status: 'ok', text: '' }));
  const labels = (panel?.rows ?? []).map((row) => row.label);
  for (const kept of ['/services', '/routes', '/interfaces', '/doctor', '/logs'])
    assert.ok(labels.includes(kept), kept);
  for (const gone of ['/service', '/health', '/wakes', '/report', '/route', '/interface'])
    assert.equal(labels.includes(gone), false, gone);
});

// ---- services --------------------------------------------------------------------------------------------------------

/** One command of the family, how its parsed name ends and the arguments it must carry. */
const SERVICE_LINES: ReadonlyArray<{ words: string; tail: string; args: Record<string, string> }> = [
  { words: 'watcher status', tail: 'watcher.status', args: {} },
  { words: 'heartbeat status', tail: 'heartbeat.status', args: {} },
  { words: 'selfreflection enable', tail: 'selfreflection.enable', args: {} },
  { words: 'selfimprovement disable', tail: 'selfimprovement.disable', args: {} },
  {
    words: 'heartbeat setup --every 3h --jitter 30m',
    tail: 'heartbeat.setup',
    args: { every: '3h', jitter: '30m' },
  },
  { words: 'watcher setup --at 00:00,12:00', tail: 'watcher.setup', args: { at: '00:00,12:00' } },
  { words: 'watcher trigger', tail: 'watcher.trigger', args: {} },
  { words: 'watcher cancel', tail: 'watcher.cancel', args: {} },
  {
    words: 'watcher evidence --from 2026-11-04T00:00:00Z --cursor c1',
    tail: 'watcher.evidence',
    args: { from: '2026-11-04T00:00:00Z', cursor: 'c1' },
  },
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

test('services takes the four mechanisms and the list, and no process unit as a mechanism', () => {
  // Catches: the system units (core, agent runners) slip into the scheduled mechanisms, or a fifth mechanism appears.
  const services = COMMANDS.find((command) => command.name === 'services');
  assert.ok(services);
  const first = new Set(services.subcommands.map((one) => one.name.split('.')[0]));
  assert.deepEqual([...first].sort(), ['heartbeat', 'list', 'selfimprovement', 'selfreflection', 'watcher']);
});

for (const words of [
  'start',
  'stop',
  'restart',
  'status',
  'restart neptunia-core.service',
  'watcher start',
  'bogus status',
  'list extra',
]) {
  test(`/services ${words} is refused: the unit verbs stay in the shell and are no mechanism`, () => {
    // Catches: the verbs of the system units become chat commands, or a bad word runs as if it were a mechanism.
    const reason = assertRefused(parseCommandLine(`/services ${words}`));
    assert.equal(reason.startsWith('unknown command'), false, 'the family itself is known');
  });
}

for (const line of [
  '/services heartbeat setup --every 0h',
  '/services watcher setup --at 25:00',
  '/services watcher setup --every 6h --jitter 5m',
  '/services watcher setup --at 00:00 --every 6h',
]) {
  test(`the parse still refuses "${line}"`, () => {
    // Catches: the rename drops the check on setup flags, so a bad schedule reaches the handler.
    assertRefused(parseCommandLine(line));
  });
}

test('/services watcher report is refused and names /logs watcher', () => {
  // Catches: the report stays readable under two commands, or the owner's old habit ends at a bare refusal.
  const reason = assertRefused(parseCommandLine('/services watcher report 2026-11-03'));
  assert.ok(reason.includes('logs watcher'), reason);
  assert.ok(assertRefused(parseRequest(['services', 'watcher', 'report']).parsed).includes('logs watcher'));
});

// ---- retired spellings -----------------------------------------------------------------------------------------------

/** A retired line, and the words of the command its refusal names instead. */
const RETIRED: ReadonlyArray<readonly [string, string]> = [
  ['/service watcher status', 'services watcher status'],
  ['/service heartbeat setup --every 3h', 'services'],
  ['/service watcher report 2026-11-03', 'logs watcher'],
  ['/health', 'doctor'],
  ['/health server', 'doctor server'],
  ['/health core', 'doctor core'],
  ['/health memory', 'doctor memory'],
  ['/wakes', 'services list'],
  ['/wakes list', 'services list'],
  ['/wakes stop', 'services'],
  ['/wakes start', 'services'],
  ['/report', 'logs watcher'],
  ['/report 2026-11-02', 'logs watcher'],
  ['/route list', 'routes'],
  ['/interface list', 'interfaces'],
];

for (const [line, names] of RETIRED) {
  test(`${line} is refused in both forms and names ${names}, running nothing`, () => {
    // Catches: a retired spelling still works behind the new one, or ends at "unknown command" with no way forward.
    const words = line.slice(1).split(' ');
    for (const parsed of [parseCommandLine(line), parseRequest(words).parsed, parseLineRequest(line).parsed]) {
      const reason = assertRefused(parsed);
      assert.ok(reason.includes(names), reason);
      assert.equal(reason.startsWith('unknown command'), false, reason);
    }
  });
}

test('every replacement a retired line names is a command that parses', () => {
  // Catches: a refusal points the owner at a spelling the table itself would refuse.
  for (const line of ['/services watcher status', '/services list', '/doctor', '/doctor server', '/doctor core']) {
    assertAccepted(parseCommandLine(line));
  }
  assertAccepted(parseCommandLine('/doctor memory'));
  assertAccepted(parseCommandLine('/logs watcher'));
  assertAccepted(parseCommandLine('/routes list'));
  assertAccepted(parseCommandLine('/interfaces list'));
});

// ---- /logs -----------------------------------------------------------------------------------------------------------

for (const [words, args] of [
  ['watcher', {}],
  ['watcher 2026-11-03', { target: '2026-11-03' }],
  ['watcher run-71', { target: 'run-71' }],
] as const) {
  test(`/logs ${words} reads the watcher's reports, in the chat's line and in argv`, () => {
    // Catches: the report reader has no home under /logs, or the date or run lands in the journal's options.
    const [chat, shell] = both(words, 'logs');
    assert.deepEqual(shell, chat);
    const parsed = assertAccepted(chat);
    assert.deepEqual(parsed.args, args);
  });
}

test('/logs watcher is another operation than the journal and shares nothing with its options', () => {
  // Catches: the watcher selector is read as journal words, so `/logs watcher` opens journalctl.
  const watcher = assertAccepted(parseCommandLine('/logs watcher 2026-11-03'));
  const journal = assertAccepted(parseCommandLine('/logs errors'));
  assert.notEqual(watcher.name, journal.name);
  assert.equal('options' in watcher.args, false);
});

for (const [line, options] of [
  ['/logs', undefined],
  ['/logs errors', 'errors'],
  ['/logs follow', 'follow'],
  ['/logs since 1 hour ago', 'since 1 hour ago'],
  ['/logs errors since 2 hours ago follow', 'errors since 2 hours ago follow'],
] as const) {
  test(`${line} keeps its journal filters`, () => {
    // Catches: the new watcher view swallows the journal's errors, follow or since.
    const parsed = assertAccepted(parseCommandLine(line));
    assert.equal(parsed.args.options, options);
    assert.equal(endsWith(parsed.name, 'watcher'), false);
  });
}

test('a since value written as one quoted argv word keeps its spaces', () => {
  // Catches: the shell's single word is split or dropped on its way into the journal filter.
  const parsed = assertAccepted(parseRequest(['logs', 'since', '1 hour ago']).parsed);
  assert.equal(parsed.args.options, 'since 1 hour ago');
});

for (const line of [
  '/logs watcher errors',
  '/logs watcher follow',
  '/logs watcher since 1 hour ago',
  '/logs errors watcher',
  '/logs since',
  '/logs frobnicate',
]) {
  test(`${line} is refused before any source is read`, () => {
    // Catches: a line that mixes the watcher's selector with the journal's words reads one of them and hides the other.
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

test('/interfaces keeps its leaves and the subcommand an interface brings itself', () => {
  // Catches: the rename drops the `otherwise` branch, so an interface's own subcommand is refused.
  assert.ok(endsWith(assertAccepted(parseCommandLine('/interfaces enable zeta71')).name, 'enable'));
  const own = assertAccepted(parseRequest(['interfaces', 'zeta71', 'sync', '$(echo zeta71)', 'now']).parsed);
  assert.ok(endsWith(own.name, 'command'));
  assert.deepEqual(own.args, { name: 'zeta71', sub: 'sync', rest: '$(echo zeta71) now' });
});

test('an interface token never goes on the command line of the renamed family, and stdin takes it', () => {
  // Catches: the secret leaf loses its mark in the rename, so the value is parsed, echoed in a reason or kept in history.
  const reason = assertRefused(parseRequest(['interfaces', 'token', 'set', 'zeta71', 'sekret-71']).parsed);
  assert.equal(reason.includes('sekret-71'), false, reason);
  const stdin = parseRequest(['interfaces', 'token', 'set', 'zeta71', '--secret-stdin']);
  assert.equal(stdin.secretStdin, true);
  assert.equal(assertAccepted(stdin.parsed).args.name, 'zeta71');
  assert.equal(parseRequest(['interfaces', 'token', 'set', 'zeta71']).secretStdin, false);
});

test('--secret-stdin on a leaf that asks for no secret stays plain text', () => {
  // Catches: the new families take the flag as a switch where it is an ordinary word.
  const request = parseRequest(['logs', 'watcher', '--secret-stdin']);
  assert.equal(request.secretStdin, false);
  if (request.parsed.ok) assert.equal(request.parsed.args.target, '--secret-stdin');
});

test('an unknown plural is no command and no prompt for her', () => {
  // Catches: a mistyped family parses as something, so a line meant for a command reaches a model.
  for (const line of ['/servicess list', '/route list', '/interfaces-list']) assertRefused(parseCommandLine(line));
});
