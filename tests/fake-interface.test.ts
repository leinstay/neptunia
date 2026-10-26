// Tests for the fake interface (src/interface/fake-interface.ts): `start(host)` serves the in-memory adapter over the
// link, like the Discord session does for Discord. The link runs over the loopback into a real event door, so each
// assertion reads what the core's end sees. `start(host, options)` takes the persona's id and the `legacy` object
// the core reads (a test passes none here), `emit(event)` is the interface injecting an inbound event and resolves
// with the ack status, and `adapter` is the fake adapter whose stored messages are what the persona posted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLoopback } from '../src/protocol/wire.ts';
import { openAdapterLink } from '../src/interface/link.ts';
import { createEventDoor } from '../src/interface/door.js';
import { createFakeAdapter } from '../src/interface/fake.js';
import { start } from '../src/interface/fake-interface.ts';
import type { InterfaceHost } from '../src/protocol/host.ts';

const TOKEN = 'link-token';
const SELF_ID = 'self-id';
const CONVERSATION = { iface: 'fake', conversationId: 'c1' };
const quiet = { info(): void {}, warn(): void {}, error(): void {} };

function reaction(id: string): Record<string, unknown> {
  return {
    kind: 'reaction.changed',
    iface: 'fake',
    at: 1,
    id,
    conversation: { id: 'c1', kind: 'channel' },
    messageId: 'm1',
    emoji: { name: 'x' },
    userId: 'u1',
    added: true,
  };
}

// The core end (a door that records the ids it handled, the link) and the host that hands the interface the other end.
function rig() {
  const handled: Array<string> = [];
  const door = createEventDoor({
    handlers: { 'reaction.changed': (event: { id: string }) => void handled.push(event.id) },
    log: quiet,
  });
  const loop = createLoopback();
  const link = openAdapterLink({ transport: loop.core, door, token: TOKEN, log: quiet });
  const host: InterfaceHost = {
    connect: () => Promise.resolve(loop.client),
    token: TOKEN,
    env: {},
    config: () => ({}),
    onConfigChange: () => () => {},
    log: quiet,
  };
  return { host, link, loop, handled };
}

test('says hello as the fake interface with the capabilities of the fake adapter', async () => {
  const { host, link } = rig();
  const running = await start(host, { selfId: SELF_ID });
  const hello = await link.hello;
  const expected = createFakeAdapter().capabilities();
  assert.equal(running.iface, 'fake');
  assert.equal(hello.iface, 'fake');
  assert.deepEqual(hello.capabilities.operations, expected.operations);
  assert.equal(hello.capabilities.maxChars, expected.maxChars);
  await running.stop();
});

test('says hello with the persona and the community it was given', async () => {
  const { host, link } = rig();
  const running = await start(host, {
    self: { id: 'bot-7', name: 'Νόβα' },
    community: { id: 'g9', name: 'Beta' },
  });
  const hello = await link.hello;
  assert.deepEqual(hello.self, { id: 'bot-7', name: 'Νόβα' });
  assert.deepEqual(hello.community, { id: 'g9', name: 'Beta' });
  await running.stop();
});

test('says hello with the selfId option as the persona id when no self is given', async () => {
  const { host, link } = rig();
  const running = await start(host, { selfId: SELF_ID });
  const hello = await link.hello;
  assert.equal(hello.self.id, SELF_ID);
  assert.equal(typeof hello.self.name, 'string');
  await running.stop();
});

test('an emitted event reaches the door of the core and is acknowledged ok', async () => {
  const { host, link, handled } = rig();
  const running = await start(host, { selfId: SELF_ID });
  await link.hello;
  running.open();
  assert.equal(await running.emit(reaction('fake:reaction:1')), 'ok');
  assert.deepEqual(handled, ['fake:reaction:1']);
  await running.stop();
});

test('an event emitted twice is handled once and the second ack says duplicate', async () => {
  const { host, link, handled } = rig();
  const running = await start(host, { selfId: SELF_ID });
  await link.hello;
  running.open();
  const first = await running.emit(reaction('fake:reaction:2'));
  const second = await running.emit(reaction('fake:reaction:2'));
  assert.deepEqual([first, second], ['ok', 'duplicate']);
  assert.deepEqual(handled, ['fake:reaction:2']);
  await running.stop();
});

test('a send from the core lands in the stored messages of the fake as a message of the persona', async () => {
  const { host, link } = rig();
  const running = await start(host, { selfId: SELF_ID });
  await link.hello;
  running.open();
  const delivery = await link.adapter.send(CONVERSATION, { text: 'καλημέρα' });
  assert.equal(delivery.status, 'ok');
  const stored = running.adapter.messagesIn('c1').map((message) => [message.authorId, message.text]);
  assert.deepEqual(stored, [[SELF_ID, 'καλημέρα']]);
  await running.stop();
});

test('stop closes the link, so the core sees its peer gone and a later send fails', async () => {
  const { host, link, loop } = rig();
  const running = await start(host, { selfId: SELF_ID });
  await link.hello;
  let closedWith: string | null = null;
  loop.core.onClose((reason) => {
    closedWith = reason;
  });
  await running.stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closedWith, 'peer-closed');
  const delivery = await link.adapter.send(CONVERSATION, { text: 'late' });
  assert.notEqual(delivery.status, 'ok');
  assert.equal(running.adapter.messagesIn('c1').length, 0);
});
