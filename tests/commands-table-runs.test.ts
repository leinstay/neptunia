// How a leaf of the owner's command table (src/interface/commands/table.ts) names the operation it runs, read through
// `operationOf`, and that the core's console (src/interface/commands/console.ts) answers every leaf of the table. The
// operations run against a fake that records them; no core, no model and no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConsole } from '../src/interface/commands/console.ts';
import { COMMANDS, operationOf, parseCommandLine } from '../src/interface/commands/table.ts';
import type { CommandArg } from '../src/interface/commands/table.ts';
import { tempDir } from './fixtures/tmp.ts';

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
