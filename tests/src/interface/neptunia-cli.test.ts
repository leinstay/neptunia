// Where the core's command intake (src/interface/neptunia-cli.ts) sends the persona's posts in the owner's command line chat:
// to the client that sent the last line while it is connected, else to an open chat, a client that asked for the turn
// events with `turn.replay`. The clients are the real owner client (interfaces/cli/link.ts) over a loopback to the core's end
// of the link (src/interface/link.ts).
import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { openLinkOver } from '../../../interfaces/cli/link.ts';
import { createEventDoor } from '../../../src/interface/door.ts';
import { openAdapterLink } from '../../../src/interface/link.ts';
import type { AdapterLink } from '../../../src/interface/link.ts';
import {
  createCommandIntake,
  statusFactsOf,
  statusText,
  createCommandDesk,
} from '../../../src/interface/neptunia-cli.ts';
import type { Principal } from '../../../src/interface/principals.ts';
import { createLoopback } from '../../fixtures/loopback.ts';
import type { FactSources, StatusFacts, CommandDeps, CommandEvent } from '../../../src/interface/neptunia-cli.ts';
import { createRoleHealth } from '../../../src/llm/role-health.ts';
import { chainsOnDefaults } from '../../fixtures/chains.ts';
import { wrongly } from '../../fixtures/loose-types.ts';
import type { TestMemory } from '../../fixtures/memory-db/service.ts';

const quiet = { info() {}, warn() {}, error() {} };
const OWNER: Principal = { name: 'owner', kind: 'cli', iface: 'cli', permissions: [] };
const principalOf = (token: string): Principal | null => (token === 'owner-token' ? OWNER : null);
const CHAT = { iface: 'cli', chatId: 'cli:dm:owner' };

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(done(), 'the condition was reached');
}

/** The core's intake and a way to connect an owner client to it; `print` null is a client that takes no replies. */
function rig() {
  const door = createEventDoor({ handlers: { 'message.received': () => {} }, log: quiet });
  const intake = createCommandIntake({
    door,
    ready: () => Promise.resolve(),
    desk: () => ({ run: () => Promise.resolve({ text: '', status: 'ok' }) }),
    log: quiet,
  });
  async function connect(print: ((text: string) => void) | null) {
    const { core, client } = createLoopback();
    const link: AdapterLink = openAdapterLink({
      transport: core,
      door: intake.doorOf(() => link),
      principalOf,
      log: quiet,
    });
    const cli = openLinkOver(client, { token: 'owner-token', print });
    await link.hello;
    return { link, cli };
  }
  return { intake, connect };
}

test('a post reaches the open chat when the client that sent the last line is gone', async () => {
  // Bug: posts go only to the client that sent the last line, so after a `-p` run ends the open chat gets nothing.
  const { intake, connect } = rig();
  const shown: Array<string> = [];
  const chat = await connect((text) => shown.push(text));
  const replay = await chat.cli.ask({ name: 'turn.replay', args: { after: 0 } });
  assert.equal(replay.status, 'ok');
  const once = await connect(() => {});
  assert.equal(await once.cli.say('remind me at nine'), 'ok');
  once.cli.close();
  await until(() => once.link.isClosed());
  // A client that only runs commands is open too, and is no chat.
  await connect(null);
  const sent = await intake.chat()?.send(CHAT, { text: 'it is nine' });
  assert.equal(sent?.status, 'ok');
  assert.deepEqual(shown, ['it is nine']);
});

test('a chat that connects again after a lost link takes posts before the owner types', async () => {
  // Bug: after a reconnect the new link is not where posts go until the owner sends a line.
  const { intake, connect } = rig();
  const first = await connect(() => {});
  await first.cli.ask({ name: 'turn.replay', args: { after: 0 } });
  assert.equal(await first.cli.say('hello'), 'ok');
  first.cli.close();
  await until(() => first.link.isClosed());
  const shown: Array<string> = [];
  const again = await connect((text) => shown.push(text));
  await again.cli.ask({ name: 'turn.replay', args: { after: 0 } });
  const sent = await intake.chat()?.send(CHAT, { text: 'welcome back' });
  assert.equal(sent?.status, 'ok');
  assert.deepEqual(shown, ['welcome back']);
});

test("the owner's line reaches the door under the name of the owner's person", async () => {
  // Bug: the line the persona answered was written by `owner`, and memory kept `owner` as the owner's name.
  const names: Array<unknown> = [];
  const door = createEventDoor({
    handlers: {
      'message.received': (event: unknown) => {
        const { message, chat } = event as { message?: { author?: { name?: unknown } }; chat?: { name?: unknown } };
        names.push([message?.author?.name, chat?.name]);
      },
    },
    log: quiet,
  });
  const intake = createCommandIntake({
    door,
    ready: () => Promise.resolve(),
    desk: () => ({ run: () => Promise.resolve({ text: '', status: 'ok' }) }),
    ownerName: () => 'Robin',
    log: quiet,
  });
  const { core, client } = createLoopback();
  const link: AdapterLink = openAdapterLink({
    transport: core,
    door: intake.doorOf(() => link),
    principalOf,
    log: quiet,
  });
  const cli = openLinkOver(client, { token: 'owner-token', print: () => {} });
  await link.hello;
  assert.equal(await cli.say('hello there'), 'ok');
  await until(() => names.length > 0);
  assert.deepEqual(names, [['Robin', 'Robin']]);
});

// Tests for the failing model roles on `/status` (src/interface/neptunia-cli.ts#statusFactsOf and #statusText): the
// summary lists each globally failing role with its reason, as src/llm/role-health.ts reports it. No model call.

const NOW = Date.parse('2026-10-31T09:00:00Z');
const CONFIG = { models: { routes: chainsOnDefaults({ core: 'x/core', drawing: 'x/draw' }) } };

function sources(health: ReturnType<typeof createRoleHealth>): FactSources {
  return {
    version: '0.0.0',
    config: () => CONFIG,
    state: () => ({}),
    usageRows: () => [],
    interfaces: () => [],
    inner: () => null,
    errands: () => [],
    failingRoles: () => health.failing(CONFIG),
  };
}

test('/status names a globally failing role with its reason, and no role when none fails', () => {
  const health = createRoleHealth({ now: () => NOW, hasKey: () => true });
  const healthy = statusFactsOf(sources(health));
  assert.deepEqual(healthy.failingRoles, []);
  assert.ok(!statusText(healthy).includes('drawing'), 'no failing role, no line about it');

  health.failed('drawing', Object.assign(new Error('OpenRouter images HTTP 401'), { statusCode: 401, body: '' }));
  const facts = statusFactsOf(sources(health));
  assert.deepEqual(
    facts.failingRoles.map((row) => [row.role, row.reason]),
    [['drawing', 'unauthorized']]
  );
  const line = statusText(facts)
    .split('\n')
    .find((text) => text.includes('drawing'));
  assert.ok(line?.includes('unauthorized'), 'the role and its reason on one line');
});

test('the summary names the reason of a pause the core set itself', () => {
  const facts: StatusFacts = {
    version: '1',
    instance: 'x',
    coreModel: 'c',
    paused: { since: '2026-11-02T09:00:00.000Z', reason: 'no-core-route' },
    spend: { requests: 0, cost: 0, coreCost: 0 },
    interfaces: [],
    failingRoles: [],
    next: null,
    intentions: null,
    errands: { open: 0, latest: [] },
    slept: 0,
  };
  assert.ok(statusText(facts).includes('no-core-route'));
  assert.ok(!statusText({ ...facts, paused: { since: null } }).includes('no-core-route'));
});

const SECRET = 'sk-or-v1-SECRETVALUE-9999';

/** A desk whose console asks for a value and answers with the argument it was given and the length of the value. */
function desk(seen: { args: Array<Record<string, unknown>> }) {
  const deps = {
    console: {
      run: async (
        _name: string,
        args: Record<string, unknown>,
        _requester: { id: string },
        dialog?: { ask(question: string, options?: { secret?: boolean }): Promise<string> } | null
      ) => {
        seen.args.push(args);
        const value = (await dialog?.ask('value?', { secret: true })) ?? '';
        return { text: `${String(args.name)} has ${value.length} chars`, status: 'ok' };
      },
    },
    interfaces: { list: () => [], enable() {}, disable: () => Promise.resolve({ drained: 0, unknown: 0 }) },
    facts: () => {
      throw new Error('not used');
    },
    placeId: () => null,
    tasks: { command: () => Promise.reject(new Error('not used')) },
  } as unknown as CommandDeps;
  return createCommandDesk(deps);
}

const event = (extra: Partial<CommandEvent> = {}): CommandEvent => ({
  name: 'keys.add',
  args: { name: 'core-1' },
  chat: { id: 'cli:dm:owner' },
  requester: { id: 'owner', roles: [] },
  ...extra,
});

test('the desk refuses an answer to a closed question and tells the owner to run the command again', async () => {
  const commands = desk({ args: [] });
  const done = await commands.run(event({ dialogId: 'gone', answer: SECRET }), { kind: 'cli', name: 'cli' });
  assert.equal((done as { status: string }).status, 'invalid');
  assert.ok(!(done as { text: string }).text.includes('SECRETVALUE'));
});

function deskOver() {
  const consoleCalls: Array<string> = [];
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
  } as unknown as Parameters<typeof createCommandDesk>[0]);
  return { desk, consoleCalls };
}

const eventOf = (name: string, args: Record<string, unknown>): CommandEvent => ({
  name,
  args,
  chat: { id: 'c1' },
  requester: { id: 'someone', roles: [] },
});

test("an interface's command to change a mode never reaches the console", async () => {
  // Bug: a client other than the owner's chat asks for sudo and gets it, because its command is run as the owner's.
  // The interface is the client tried.
  const { desk, consoleCalls } = deskOver();
  for (const kind of ['interface'] as const) {
    const answer = await desk.run(eventOf('agent.mode', { unit: 'scout', mode: 'sudo' }), { kind, name: 'scout' });
    assert.notEqual(answer.status, 'ok', kind);
  }
  assert.deepEqual(consoleCalls, []);
});

test('the same command from the owner chat reaches the console', async () => {
  // Bug: the guard is so wide that the owner's own chat cannot change a mode either.
  const { desk, consoleCalls } = deskOver();
  await desk.run(eventOf('agent.mode', { unit: 'scout', mode: 'sudo' }), { kind: 'cli', name: 'cli' });
  assert.deepEqual(consoleCalls, ['agent.mode']);
});

const rigs: Array<TestMemory> = [];

const INSPECTIONS = [
  'memory.inspect.tables',
  'memory.inspect.rows',
  'memory.inspect.export',
  'memory.graph.nodes',
  'memory.users.list',
];

function inspectDesk(consoleCalls: Array<string>): ReturnType<typeof createCommandDesk> {
  const deps: CommandDeps = {
    console: {
      run: (name) => {
        consoleCalls.push(name);
        return Promise.resolve({ text: '{}', status: 'ok' });
      },
    },
    interfaces: { list: () => [], enable: () => {}, disable: () => Promise.resolve({ drained: 0, unknown: 0 }) },
    facts: () => wrongly({}),
  };
  return createCommandDesk(deps);
}

describe('commands memory inspect', () => {
  after(async () => {
    for (const memory of rigs) await memory.close();
  });

  for (const name of INSPECTIONS) {
    const event = { name, args: {}, chat: { id: 'cli:dm:owner' }, requester: { id: 'owner', roles: [] } };

    test(`${name} from the owner's chat reaches the console`, async () => {
      const consoleCalls: Array<string> = [];
      await inspectDesk(consoleCalls).run(event, { kind: 'cli', name: 'cli' });
      assert.deepEqual(consoleCalls, [name]);
    });

    // No agent principal exists to try; the interface case below covers every other caller.
    test(`${name} from an interface is denied`, async () => {
      const consoleCalls: Array<string> = [];
      const answer = await inspectDesk(consoleCalls).run(event, { kind: wrongly('interface'), name: 'discord' });
      assert.deepEqual(consoleCalls, []);
      assert.equal('status' in answer ? answer.status : '', 'denied');
    });
  }
});

describe('commands memory semantic', () => {
  after(async () => {
    for (const memory of rigs) await memory.close();
  });

  for (const name of [
    'memory.entities.list',
    'memory.entities.show',
    'memory.entities.names',
    'memory.entities.relations',
  ]) {
    const event = { name, args: {}, chat: { id: 'cli:dm:owner' }, requester: { id: 'owner', roles: [] } };
    test(`${name} reaches the console from the owner's chat and from no interface`, async () => {
      // Bug: a chat platform names the route and reads the DM's entities.
      // No agent principal exists to try.
      const calls: Array<string> = [];
      const deps: CommandDeps = {
        console: {
          run: (called) => {
            calls.push(called);
            return Promise.resolve({ text: '{}', status: 'ok' });
          },
        },
        interfaces: { list: () => [], enable: () => {}, disable: () => Promise.resolve({ drained: 0, unknown: 0 }) },
        facts: () => wrongly({}),
      };
      const desk = createCommandDesk(deps);
      const platform = await desk.run(event, { kind: wrongly('interface'), name: 'discord' });
      assert.deepEqual(calls, []);
      assert.equal('status' in platform ? platform.status : '', 'denied');
      await desk.run(event, { kind: 'cli', name: 'cli' });
      assert.deepEqual(calls, [name]);
    });
  }
});
