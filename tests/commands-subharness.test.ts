// `/subharness` and `/simulation` (src/interface/commands/table.ts, src/interface/commands/subharness.ts): the rows of
// the command table, the answers of the handlers over keys.json in a temp dir with a fake runner and fetch, the routing
// of the console, and the rule that only the owner's chat changes a mode. The tests assert on the data they put in (a
// key name, a mode, a file's content) and on statuses, not on the wording of an answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, parseCommandLine } from '../src/interface/commands/table.ts';
import { simulationCommand, subharnessCommand } from '../src/interface/commands/subharness.ts';
import { createConsole } from '../src/interface/commands/console.ts';
import type { ConsoleDeps } from '../src/interface/commands/console.ts';
import { createCommandDesk } from '../src/interface/neptunia-cli.ts';
import type { CommandEvent } from '../src/interface/neptunia-cli.ts';
import type { EnableDeps } from '../src/subharness/control.ts';
import { readKeysFile, writeKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';

const SECRET = 'sk-or-v1-oc-secret-0123456789';

test('the table parses /subharness: a bare line is the status, enable takes a backend and an optional --key', () => {
  // Bug: the --key flag is read as a positional word, so "opencode --key x" parses as backend "opencode --key x".
  assert.deepEqual(parseCommandLine('/subharness'), { ok: true, name: 'subharness.status', args: {} });
  assert.deepEqual(parseCommandLine('/subharness status'), { ok: true, name: 'subharness.status', args: {} });
  assert.deepEqual(parseCommandLine('/subharness enable codex'), {
    ok: true,
    name: 'subharness.enable',
    args: { backend: 'codex' },
  });
  assert.deepEqual(parseCommandLine('/subharness enable opencode --key oc-1'), {
    ok: true,
    name: 'subharness.enable',
    args: { backend: 'opencode', key: 'oc-1' },
  });
  assert.deepEqual(parseCommandLine('/subharness disable'), { ok: true, name: 'subharness.disable', args: {} });
});

test('the table refuses a backend that is none, a --key with no value, an unknown flag and a bare key word', () => {
  // Bug: "--key" with nothing after it enables opencode on the key named "--key"; a stray word becomes the key.
  for (const line of [
    '/subharness enable',
    '/subharness enable codx',
    '/subharness enable opencode --key',
    '/subharness enable opencode --force',
    '/subharness enable opencode oc-1',
    '/subharness enable opencode --key a b',
  ])
    assert.equal(parseCommandLine(line).ok, false, line);
});

test('the table parses /subharness mode with an agent, an optional mode, and refuses other words', () => {
  // Bug: a mode outside the four reaches the handler, or an agent outside the four is accepted.
  assert.deepEqual(parseCommandLine('/subharness mode dev sudo'), {
    ok: true,
    name: 'subharness.mode',
    args: { agent: 'dev', mode: 'sudo' },
  });
  assert.deepEqual(parseCommandLine('/subharness mode watcher'), {
    ok: true,
    name: 'subharness.mode',
    args: { agent: 'watcher' },
  });
  for (const line of ['/subharness mode', '/subharness mode dev root', '/subharness mode editor read'])
    assert.equal(parseCommandLine(line).ok, false, line);
});

test('the table parses /simulation: enable needs --key, disable and a bare line do not', () => {
  // Bug: "simulation enable" with no key switches the simulation on with nothing to spend.
  assert.deepEqual(parseCommandLine('/simulation'), { ok: true, name: 'simulation.status', args: {} });
  assert.deepEqual(parseCommandLine('/simulation enable --key sim'), {
    ok: true,
    name: 'simulation.enable',
    args: { key: 'sim' },
  });
  assert.deepEqual(parseCommandLine('/simulation disable'), { ok: true, name: 'simulation.disable', args: {} });
  assert.equal(parseCommandLine('/simulation enable').ok, false);
  assert.equal(parseCommandLine('/simulation enable sim').ok, false);
});

test('/help has a line for both commands, and every subcommand of both has a help line', () => {
  // Bug: a command is added to the handlers and not to the table, so /help never lists it.
  for (const name of ['subharness', 'simulation']) {
    const command = COMMANDS.find((one) => one.name === name);
    assert.ok(command, name);
    assert.notEqual(command.help.trim(), '');
    assert.deepEqual(
      command.subcommands.filter((sub) => sub.help.trim() === '').map((sub) => sub.name),
      []
    );
  }
});

function rig() {
  const dir = tempDir('nep-cmd-sub-');
  writeKeysFile(dir, { extra: { opencode: SECRET, sim: 'sk-or-v1-sim' } });
  const deps: EnableDeps = {
    privateDir: dir,
    runBackend: () => Promise.resolve({ ok: true, text: 'ok', exitCode: 0 }),
    fetch: () => Promise.resolve(new Response('{}', { status: 200 })),
  };
  return { dir, deps };
}

test('enable, status, mode and disable change keys.json and answer ok', async () => {
  // Bug: the handler answers ok without writing, or writes without answering what it did.
  const { dir, deps } = rig();
  assert.equal(
    (await subharnessCommand(deps, 'subharness.enable', { backend: 'opencode', key: 'opencode' })).status,
    'ok'
  );
  assert.equal(readKeysFile(dir).subharness.key, 'opencode');
  assert.equal((await subharnessCommand(deps, 'subharness.mode', { agent: 'dev', mode: 'sudo' })).status, 'ok');
  assert.equal(readKeysFile(dir).subharness.modes.dev, 'sudo');
  const status = await subharnessCommand(deps, 'subharness.status', {});
  assert.equal(status.status, 'ok');
  assert.ok(status.text.includes('opencode') && status.text.includes('sudo'));
  assert.equal(status.text.includes(SECRET), false);
  assert.equal((await subharnessCommand(deps, 'subharness.disable', {})).status, 'ok');
  assert.equal(readKeysFile(dir).subharness.backend, null);
});

test('a refused enable answers failed, starts with the command as typed, and writes nothing', async () => {
  // Bug: a failed check answers ok, so the owner thinks the subharness is on.
  const { dir, deps } = rig();
  const answer = await subharnessCommand(deps, 'subharness.enable', { backend: 'opencode', key: 'nope' });
  assert.equal(answer.status, 'failed');
  assert.ok(answer.text.startsWith('/subharness enable'));
  assert.equal(readKeysFile(dir).subharness.backend, null);
});

test('a mode line with no mode shows the current one and writes nothing', async () => {
  // Bug: the inspection form writes the default into keys.json.
  const { dir, deps } = rig();
  const answer = await subharnessCommand(deps, 'subharness.mode', { agent: 'scout' });
  assert.equal(answer.status, 'ok');
  assert.ok(answer.text.includes('write'));
  assert.deepEqual(readKeysFile(dir).subharness.modes, {});
});

test('simulation enable, status and disable go through the key store and answer ok', async () => {
  // Bug: the simulation commands are parsed and never reach the store.
  const { dir } = rig();
  assert.equal((await simulationCommand(dir, 'simulation.enable', { key: 'sim' })).status, 'ok');
  assert.equal(readKeysFile(dir).simulation.key, 'sim');
  assert.ok((await simulationCommand(dir, 'simulation.status', {})).text.includes('sim'));
  assert.equal((await simulationCommand(dir, 'simulation.enable', { key: 'nope' })).status, 'failed');
  assert.equal((await simulationCommand(dir, 'simulation.disable', {})).status, 'ok');
  assert.equal(readKeysFile(dir).simulation.key, null);
});

/** A console over fakes; `subharness` is the optional dep the commands need. */
function consoleOver(dir: string, subharness: ConsoleDeps['subharness']) {
  const deps: ConsoleDeps = {
    runOp: () => Promise.resolve({ status: 'ok', code: '', summary: '', data: null }),
    ownerReads: { lessons: () => '', aliases: () => '' },
    guildId: () => 'g1',
    selfId: () => 'self-1',
    hot: { config: { bot: { owners: [] } } },
    privateDir: dir,
    dataDir: dir,
    memoryDb: null,
    usage: null,
    metrics: null,
    conversationLines: () => [],
    now: () => 0,
    ...(subharness === undefined ? {} : { subharness }),
  };
  return createConsole(deps);
}

test('the console runs the subharness and simulation commands over its private dir', async () => {
  // Bug: the console falls through to "no such command" for the new names, so the chat cannot change a mode.
  const { dir, deps } = rig();
  const desk = consoleOver(dir, {
    runBackend: (name, brief) => deps.runBackend(name, brief),
    fetch: (url, init) => deps.fetch(url, init),
  });
  assert.equal((await desk.run('subharness.mode', { agent: 'dev', mode: 'full' }, { id: 'owner' })).status, 'ok');
  assert.equal(readKeysFile(dir).subharness.modes.dev, 'full');
  assert.equal((await desk.run('simulation.enable', { key: 'sim' }, { id: 'owner' })).status, 'ok');
});

test('without the runner and fetch the console refuses enable and runs no process', async () => {
  // Bug: a console built without the check dependencies falls back to the real codex or the real network.
  const { dir } = rig();
  const desk = consoleOver(dir, undefined);
  const answer = await desk.run('subharness.enable', { backend: 'codex' }, { id: 'owner' });
  assert.equal(answer.status, 'failed');
  assert.equal(readKeysFile(dir).subharness.backend, null);
});

function deskOver() {
  const consoleCalls: Array<string> = [];
  const taskCalls: Array<string> = [];
  const desk = createCommandDesk({
    console: {
      run: (name: string) => {
        consoleCalls.push(name);
        return Promise.resolve({ text: 'ran', status: 'ok' });
      },
    },
    interfaces: { list: () => [], enable: () => undefined, disable: () => Promise.resolve({ drained: 0, unknown: 0 }) },
    facts: () => {
      throw new Error('not used');
    },
    guildId: () => null,
    tasks: {
      command: (_principal: string, name: string) => {
        taskCalls.push(name);
        return Promise.resolve({ text: 'board', status: 'invalid' });
      },
    },
  } as unknown as Parameters<typeof createCommandDesk>[0]);
  return { desk, consoleCalls, taskCalls };
}

const eventOf = (name: string, args: Record<string, unknown>): CommandEvent => ({
  name,
  args,
  conversation: { id: 'c1' },
  requester: { id: 'someone', roles: [] },
});

test("an agent's command to change a mode never reaches the console", async () => {
  // Bug: a development agent whose report asks for sudo gets it, because its command is run as the owner's.
  const { desk, consoleCalls } = deskOver();
  for (const kind of ['agent', 'interface'] as const) {
    const answer = await desk.run(eventOf('subharness.mode', { agent: 'dev', mode: 'sudo' }), { kind, name: 'dev' });
    assert.notEqual(answer.status, 'ok', kind);
  }
  assert.deepEqual(consoleCalls, []);
});

test('the same command from the owner chat reaches the console', async () => {
  // Bug: the guard is so wide that the owner's own chat cannot change a mode either.
  const { desk, consoleCalls } = deskOver();
  await desk.run(eventOf('subharness.mode', { agent: 'dev', mode: 'sudo' }), { kind: 'cli', name: 'cli' });
  assert.deepEqual(consoleCalls, ['subharness.mode']);
});

test('/help from the owner chat lists /subharness and /simulation', async () => {
  // Bug: the commands exist in the table and the chat's help text does not show them.
  const { desk } = deskOver();
  const answer = await desk.run(eventOf('help', {}), { kind: 'cli', name: 'cli' });
  const lines = answer.text.split('\n');
  for (const name of ['subharness', 'simulation'])
    assert.ok(
      lines.some((line) => line.startsWith(`/${name} `)),
      name
    );
});
