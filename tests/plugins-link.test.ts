// The core's end of one plugin's connection (src/plugins/link.ts), driven by hand over the loopback: the hello and the
// principal, the events a plugin may not send (spec test 6), the registration, and the deadline of a call with the
// late answer dropped (spec test 4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLoopback, envelope } from '../src/protocol/index.ts';
import type { RegisterOutcome } from '../src/protocol/plugin.ts';
import { openPluginLink, routeConnection } from '../src/plugins/link.ts';
import type { PluginLink } from '../src/plugins/link.ts';
import type { Envelope, Transport } from '../src/protocol/wire.ts';
import type { Principal } from '../src/interface/principals.ts';
import { lineEvent } from './fixtures/core-over-fake.ts';
import { echoTool, pluginHello, quiet, rawClient, statusOf } from './fixtures/plugin-rig.ts';
import type { Raw } from './fixtures/plugin-rig.ts';

const NOW = Date.parse('2026-11-01T09:00:00Z');
const PLUGIN: Principal = { name: 'echo', kind: 'plugin', iface: null, permissions: [] };
const INTERFACE: Principal = { name: 'fake', kind: 'interface', iface: 'fake', permissions: [] };
const REQUEST = { tool: 'echo.say', args: { text: 'hi' }, requester: null, conversationId: null, idempotencyKey: 'k1' };

type Rig = {
  link: PluginLink;
  raw: Raw;
  registered: Array<[string, ReadonlyArray<unknown>]>;
  closed: Array<string>;
  tokens: Map<string, Principal>;
};

function rig(
  options: { deadlineMs?: number; admit?: (principal: Principal) => string | null; outcome?: RegisterOutcome } = {}
): Rig {
  const { core, client } = createLoopback();
  const tokens = new Map<string, Principal>([
    ['plugin-token', PLUGIN],
    ['interface-token', INTERFACE],
  ]);
  const registered: Array<[string, ReadonlyArray<unknown>]> = [];
  const closed: Array<string> = [];
  const link = openPluginLink({
    transport: core,
    principalOf: (token) => tokens.get(token) ?? null,
    ...(options.admit === undefined ? {} : { admit: options.admit }),
    register: (plugin, tools) => {
      registered.push([plugin, tools]);
      return options.outcome ?? { accepted: ['echo.say'], refused: [] };
    },
    onClosed: (plugin) => closed.push(plugin),
    deadlineMs: () => options.deadlineMs ?? 5000,
    now: () => NOW,
    log: quiet,
  });
  link.hello.catch(() => {});
  return { link, raw: rawClient(client), registered, closed, tokens };
}

async function greeted(options: Parameters<typeof rig>[0] = {}): Promise<Rig> {
  const made = rig(options);
  made.raw.transport.send(pluginHello('echo', 'plugin-token'));
  await made.link.hello;
  return made;
}

const until = async (check: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

test('accepts the hello of a plugin principal and acks it ok', async () => {
  const { link, raw } = rig();
  raw.transport.send(pluginHello('echo', 'plugin-token'));
  assert.deepEqual(await link.hello, { plugin: 'echo' });
  assert.equal(statusOf(await raw.ack('h1')), 'ok');
  assert.equal(link.principal()?.kind, 'plugin');
});

test('closes the link on a token nobody holds, and on a token of an interface principal', async () => {
  const unknown = rig();
  unknown.raw.transport.send(pluginHello('echo', 'nope'));
  await assert.rejects(unknown.link.hello);
  assert.equal(unknown.link.isClosed(), true);
  const wrongKind = rig();
  wrongKind.raw.transport.send(pluginHello('fake', 'interface-token'));
  await assert.rejects(wrongKind.link.hello);
  assert.equal(wrongKind.link.isClosed(), true);
});

test('closes the link when the hello names another namespace than plugin', async () => {
  const { link, raw } = rig();
  raw.send(
    'hello',
    { iface: 'agent', self: { id: 'echo', name: 'echo' }, community: null, token: 'plugin-token' },
    'h1'
  );
  await assert.rejects(link.hello);
  assert.equal(link.isClosed(), true);
});

test('closes the link when the first envelope is not a hello', async () => {
  const { link, raw } = rig();
  raw.send('tool.register', { tools: [] }, 'r1');
  await assert.rejects(link.hello);
  assert.equal(link.isClosed(), true);
});

test('refuses the hello of a plugin the core does not admit, with the reason it gives', async () => {
  const { link, raw } = rig({ admit: () => 'plugin-disabled' });
  raw.transport.send(pluginHello('echo', 'plugin-token'));
  await assert.rejects(link.hello, /plugin-disabled/);
  assert.equal(link.isClosed(), true);
});

test('answers a message.received event of a plugin principal invalid and passes it to no one', async () => {
  const { raw } = await greeted();
  const event = { ...lineEvent({ id: 'm1', text: 'hello', at: NOW }), iface: 'plugin' };
  raw.send('event', event, event.id);
  const answer = await raw.ack(event.id);
  assert.equal(statusOf(answer), 'invalid');
  assert.equal((answer.body as Record<string, unknown>).reason, 'body.kind:not-allowed');
});

test('answers a second hello invalid and keeps the link open', async () => {
  const { link, raw } = await greeted();
  raw.transport.send(pluginHello('echo', 'plugin-token', 'h2'));
  const answer = await raw.ack('h2');
  assert.equal(statusOf(answer), 'invalid');
  assert.equal(link.isClosed(), false);
});

test('hands the tools of a tool.register to the registry and answers with what it accepted and refused', async () => {
  const outcome = { accepted: ['echo.say'], refused: [{ name: 'other.say', reason: 'wrong-prefix' }] };
  const { raw, registered } = await greeted({ outcome });
  raw.send('tool.register', { tools: [echoTool()] }, 'r1');
  const answer = await raw.ack('r1');
  assert.equal(statusOf(answer), 'ok');
  assert.deepEqual((answer.body as Record<string, unknown>).accepted, ['echo.say']);
  assert.deepEqual((answer.body as Record<string, unknown>).refused, outcome.refused);
  assert.equal(registered[0]?.[0], 'echo');
  assert.equal(registered[0]?.[1].length, 1);
});

test('answers a tool.register with a malformed body invalid and registers nothing', async () => {
  const { raw, registered } = await greeted();
  raw.send('tool.register', { tools: 'echo.say' }, 'r1');
  assert.equal(statusOf(await raw.ack('r1')), 'invalid');
  assert.equal(registered.length, 0);
});

test('closes the link when the token stops standing for the plugin', async () => {
  const { link, raw, tokens } = await greeted();
  tokens.delete('plugin-token');
  raw.send('tool.register', { tools: [] }, 'r1');
  await until(() => link.isClosed());
  assert.equal(link.isClosed(), true);
});

test('sends a tool.call with the deadline from now and resolves with the plugin answer', async () => {
  const { link, raw } = await greeted({ deadlineMs: 5000 });
  const pending = link.callTool(REQUEST);
  const sent = await raw.next((value) => value.type === 'tool.call', 'the tool.call');
  assert.equal((sent.body as Record<string, unknown>).deadlineAt, NOW + 5000);
  assert.equal((sent.body as Record<string, unknown>).idempotencyKey, 'k1');
  raw.send('action_result', { status: 'ok', data: { text: 'echo: hi' } }, 'r-1', sent.id);
  assert.deepEqual(await pending, { status: 'ok', data: { text: 'echo: hi' } });
});

test('a call past its deadline answers that the plugin did not answer, and the late answer is dropped', async () => {
  const { link, raw } = await greeted({ deadlineMs: 40 });
  const first = link.callTool(REQUEST);
  const late = await raw.next((value) => value.type === 'tool.call', 'the first tool.call');
  assert.deepEqual(await first, { status: 'unknown', code: 'plugin-no-answer' });
  // The plugin answers after the deadline: nothing resolves, and the link stays open.
  raw.send('action_result', { status: 'ok', data: { text: 'too late' } }, 'late-1', late.id);
  const second = link.callTool({ ...REQUEST, idempotencyKey: 'k2' });
  const sent = await raw.next((value) => value.type === 'tool.call' && value.id !== late.id, 'the second tool.call');
  raw.send('action_result', { status: 'ok', data: { text: 'on time' } }, 'r-2', sent.id);
  assert.deepEqual(await second, { status: 'ok', data: { text: 'on time' } });
  assert.equal(link.isClosed(), false);
});

test('a link that closes with a call waiting resolves it as not connected, and a later call fails at once', async () => {
  const { link, raw } = await greeted();
  const pending = link.callTool(REQUEST);
  await raw.next((value) => value.type === 'tool.call', 'the tool.call');
  link.close();
  assert.deepEqual(await pending, { status: 'unknown', code: 'plugin-not-connected' });
  assert.deepEqual(await link.callTool(REQUEST), { status: 'failed', code: 'plugin-not-connected' });
});

test('tells its owner once that a plugin that said hello is gone, and nothing for one that never did', async () => {
  const hello = await greeted();
  hello.link.close();
  hello.link.close();
  assert.deepEqual(hello.closed, ['echo']);
  const never = rig();
  never.raw.transport.send(pluginHello('echo', 'nope'));
  await assert.rejects(never.link.hello);
  assert.deepEqual(never.closed, []);
});

// routeConnection: the first envelope picks the link, and that envelope still reaches it.
function routed(first: Envelope): { picked: Array<string>; got: Array<Envelope>; later: Array<Envelope> } {
  const { core, client } = createLoopback();
  const picked: Array<string> = [];
  const got: Array<Envelope> = [];
  const later: Array<Envelope> = [];
  const take = (name: string) => (view: Transport) => {
    picked.push(name);
    view.onEnvelope((value) => (got.length === 0 ? got : later).push(value));
  };
  routeConnection(core, { adapter: take('adapter'), plugin: take('plugin') });
  client.send(first);
  client.send(envelope('event', { kind: 'message.received' }, { id: 'second' }));
  return { picked, got, later };
}

const settleLoopback = () => new Promise((resolve) => setImmediate(resolve));

test('routes a hello under plugin to the plugin link and hands it that hello and what follows', async () => {
  const first = pluginHello('echo', 'plugin-token');
  const run = routed(first);
  await settleLoopback();
  assert.deepEqual(run.picked, ['plugin']);
  assert.equal(run.got[0]?.id, first.id);
  assert.equal(run.later.length, 1);
});

test('routes a hello under any other namespace to the adapter link', async () => {
  const run = routed(
    envelope('hello', { iface: 'fake', self: { id: 'x', name: 'x' }, community: null, token: 't' }, { id: 'h2' })
  );
  await settleLoopback();
  assert.deepEqual(run.picked, ['adapter']);
  assert.equal(run.got[0]?.id, 'h2');
});

test('routes a first envelope that is not a hello to the adapter link, so the adapter can refuse it', async () => {
  const run = routed(envelope('event', { kind: 'message.received' }, { id: 'first' }));
  await settleLoopback();
  assert.deepEqual(run.picked, ['adapter']);
});

test('decides once: a plugin hello after an adapter hello does not open a second link', async () => {
  const { core, client } = createLoopback();
  const picked: Array<string> = [];
  routeConnection(core, { adapter: () => picked.push('adapter'), plugin: () => picked.push('plugin') });
  client.send(
    envelope('hello', { iface: 'fake', self: { id: 'x', name: 'x' }, community: null, token: 't' }, { id: 'a' })
  );
  client.send(pluginHello('echo', 'plugin-token', 'b'));
  await settleLoopback();
  assert.deepEqual(picked, ['adapter']);
});
