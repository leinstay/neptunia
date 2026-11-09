// `/subharness` and `/agent mode` (src/interface/commands/table.ts, src/interface/commands/subharness.ts): the rows of
// the command table, the answers of the handlers over keys.json in a temp dir with a fake runner and fetch, the routing
// of the console, and the rule that only the owner's chat changes a mode. The tests assert on the data they put in (a
// key name, a mode, a file's content) and on statuses, not on the wording of an answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, parseCommandLine } from '../src/interface/commands/table.ts';
import { subharnessCommand } from '../src/interface/commands/subharness.ts';
import { createConsole } from '../src/interface/commands/console.ts';
import type { ConsoleDeps } from '../src/interface/commands/console.ts';
import { createCommandDesk } from '../src/interface/neptunia-cli.ts';
import type { CommandEvent } from '../src/interface/neptunia-cli.ts';
import type { EnableDeps } from '../src/subharness/control.ts';
import { deferModeToUnit } from '../src/setup/install.ts';
import { readKeysFile, writeKeysFile } from './fixtures/keys-file.ts';
import { fakeVendor } from './fixtures/fake-vendor.ts';
import { tempDir } from './fixtures/tmp.ts';

const SECRET = 'sk-or-v1-oc-secret-0123456789';

test('the table parses /subharness: a bare line is the status', () => {
  // Bug: the bare family word asks for a subcommand, so the owner cannot read what runs where.
  // Changed: the enable and disable forms left the family.
  assert.deepEqual(parseCommandLine('/subharness'), { ok: true, name: 'subharness.status', args: {} });
  assert.deepEqual(parseCommandLine('/subharness status'), { ok: true, name: 'subharness.status', args: {} });
});

test('the table parses /agent mode with an agent, an optional mode, and refuses other words', () => {
  // Bug: a mode outside the four reaches the handler, or an agent outside the four is accepted.
  // Changed: the execution mode moved from `/subharness mode` to `/agent mode`.
  assert.deepEqual(parseCommandLine('/agent mode dev sudo'), {
    ok: true,
    name: 'agent.mode',
    args: { agent: 'dev', mode: 'sudo' },
  });
  assert.deepEqual(parseCommandLine('/agent mode watcher'), {
    ok: true,
    name: 'agent.mode',
    args: { agent: 'watcher' },
  });
  for (const line of ['/agent mode', '/agent mode dev root', '/agent mode editor read'])
    assert.equal(parseCommandLine(line).ok, false, line);
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

function rig() {
  const dir = tempDir('nep-cmd-sub-');
  writeKeysFile(dir, { extra: { opencode: SECRET } });
  const deps: EnableDeps = {
    privateDir: dir,
    runBackend: () => Promise.resolve({ ok: true, text: 'ok', exitCode: 0 }),
    fetch: () => Promise.resolve(new Response('{}', { status: 200 })),
  };
  return { dir, deps };
}

test('a mode and the status change and read keys.json and answer ok', async () => {
  // Bug: the handler answers ok without writing, or writes without answering what it did.
  // Changed: enable and disable are gone; the status still names opencode's key and holds no key value.
  const { dir, deps } = rig();
  const stored = readKeysFile(dir);
  writeKeysFile(dir, { ...stored, subharness: { ...stored.subharness, key: 'opencode' } });
  assert.equal((await subharnessCommand(deps, 'agent.mode', { agent: 'dev', mode: 'sudo' })).status, 'ok');
  assert.equal(readKeysFile(dir).subharness.modes.dev, 'sudo');
  const status = await subharnessCommand(deps, 'subharness.status', {});
  assert.equal(status.status, 'ok');
  assert.ok(status.text.includes('opencode') && status.text.includes('sudo'));
  assert.equal(status.text.includes(SECRET), false);
});

test('a refused opencode login answers failed, names the key and writes nothing', async () => {
  // Bug: a failed check answers ok, so the owner thinks the source is on.
  // Changed: the login of opencode is what names its key, in place of enable.
  const { dir, deps } = rig();
  const answer = await subharnessCommand(deps, 'subharness.opencode.login', { key: 'nope' });
  assert.equal(answer.status, 'failed');
  assert.equal(readKeysFile(dir).subharness.key, null);
});

test('a mode line with no mode shows the current one and writes nothing', async () => {
  // Bug: the inspection form writes the default into keys.json.
  const { dir, deps } = rig();
  const answer = await subharnessCommand(deps, 'agent.mode', { agent: 'scout' });
  assert.equal(answer.status, 'ok');
  assert.ok(answer.text.includes('write'));
  assert.deepEqual(readKeysFile(dir).subharness.modes, {});
});

/** A console over fakes; `subharness` is the optional dep the commands need. */
function consoleOver(dir: string, subharness: ConsoleDeps['subharness']) {
  const deps: ConsoleDeps = {
    runOp: () => Promise.resolve({ status: 'ok', code: '', summary: '', data: null }),
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
    now: () => 0,
    ...(subharness === undefined ? {} : { subharness }),
  };
  return createConsole(deps);
}

test('the console runs the subharness commands over its private dir', async () => {
  // Bug: the console falls through to "no such command" for the new names, so the chat cannot change a mode.
  const { dir, deps } = rig();
  const desk = consoleOver(dir, {
    runBackend: (name, brief) => deps.runBackend(name, brief),
    fetch: (url, init) => deps.fetch(url, init),
  });
  assert.equal((await desk.run('agent.mode', { agent: 'dev', mode: 'full' }, { id: 'owner' })).status, 'ok');
  assert.equal(readKeysFile(dir).subharness.modes.dev, 'full');
});

test('without the runner and fetch the console refuses a model selection and runs no model', async () => {
  // The lead: routes are named direct-api, claude-harness, codex-harness and opencode-harness (owner, 2026-11-06).
  // Bug: a console built without the check dependencies falls back to the real codex or the real network.
  // Changed: the selection is where a check runs, now that enable is gone.
  const { dir } = rig();
  const vendor = fakeVendor(dir, 'codex', { loggedIn: true });
  const desk = consoleOver(dir, undefined);
  const answer = await desk.run(
    'model.set',
    { role: 'dev', model: 'gpt-6-sol', via: 'codex-harness' },
    { id: 'owner' }
  );
  assert.equal(answer.status, 'failed');
  assert.deepEqual(
    vendor.calls().filter((one) => one !== 'login status'),
    []
  );
  assert.equal(readKeysFile(dir).subharness.uses?.dev, undefined);
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
    placeId: () => null,
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
  chat: { id: 'c1' },
  requester: { id: 'someone', roles: [] },
});

test("an agent's command to change a mode never reaches the console", async () => {
  // Bug: a development agent whose report asks for sudo gets it, because its command is run as the owner's.
  const { desk, consoleCalls } = deskOver();
  for (const kind of ['agent', 'interface'] as const) {
    const answer = await desk.run(eventOf('agent.mode', { agent: 'dev', mode: 'sudo' }), { kind, name: 'dev' });
    assert.notEqual(answer.status, 'ok', kind);
  }
  assert.deepEqual(consoleCalls, []);
});

test('the same command from the owner chat reaches the console', async () => {
  // Bug: the guard is so wide that the owner's own chat cannot change a mode either.
  const { desk, consoleCalls } = deskOver();
  await desk.run(eventOf('agent.mode', { agent: 'dev', mode: 'sudo' }), { kind: 'cli', name: 'cli' });
  assert.deepEqual(consoleCalls, ['agent.mode']);
});

test('/help from the owner chat lists /subharness', async () => {
  // Bug: the commands exist in the table and the chat's help text does not show them.
  const { desk } = deskOver();
  const answer = await desk.run(eventOf('help', {}), { kind: 'cli', name: 'cli' });
  const lines = answer.text.split('\n');
  for (const name of ['subharness'])
    assert.ok(
      lines.some((line) => line.startsWith(`/${name} `)),
      name
    );
});

test('inside the core a mode change is stored and the answer names neptunia setup', async () => {
  // Catches: the core wires the mode to a sudo re-render that NoNewPrivileges refuses, and the owner reads a failure.
  // Changed: the step word left the public command, and the one flow re-renders the units.
  const { dir, deps } = rig();
  const inCore: EnableDeps = { ...deps, applyMode: (agent) => Promise.resolve(deferModeToUnit(agent)) };
  const answer = await subharnessCommand(inCore, 'agent.mode', { agent: 'server', mode: 'sudo' });
  assert.equal(answer.status, 'ok');
  assert.equal(readKeysFile(dir).subharness.modes.server, 'sudo');
  assert.ok(answer.text.includes('neptunia setup'));
});
