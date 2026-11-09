// Tests for the core side of the link (src/interface/link.ts), over the loopback of the wire, the real event
// door and the fake adapter served by serveAdapter. A few tests drive the interface end by hand where the
// serving side would never behave that way (an event before hello) and a few serve a gated adapter that answers
// only when the test says so, to hold actions pending.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ackOf, createLoopback, envelope } from '../src/protocol/index.ts';
import { serveAdapter } from '../src/protocol/serve.ts';
import type { Hello } from '../src/protocol/serve.ts';
import type { Capabilities, Delivery } from '../src/protocol/adapter.ts';
import type { PortResult } from '../src/protocol/actions.ts';
import { createIfaceRouter, openAdapterLink, createLinkSwitch } from '../src/interface/link.ts';
import { createEventDoor } from '../src/interface/door.ts';
import { createFakeAdapter } from '../src/interface/fake.ts';
import type { Principal } from '../src/interface/principals.ts';
import type { Envelope } from '../src/protocol/wire.ts';

type Log = {
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
};
type FakeAdapter = ReturnType<typeof createFakeAdapter>;

const quiet: Log = { info() {}, warn() {}, error() {} };
const CHAT = { iface: 'fake', chatId: 'c1' };
const CAPABILITIES: Capabilities = {
  operations: ['message.send', 'message.edit', 'message.delete'],
  maxChars: 1234,
  maxFiles: 3,
  maxFileBytes: 4096,
  edit: { ownOnly: true, windowMs: null },
  history: true,
  threads: false,
  reactions: true,
  customEmoji: false,
  presence: false,
  voiceFormats: [],
  publish: [],
  search: false,
};
const SELF = { id: 'bot-1', name: 'Νέπτυν' };
const ROOT = { id: 'g1', name: 'Alpha' };
const HELLO: Hello = { iface: 'fake', self: SELF, root: ROOT, capabilities: CAPABILITIES, resume: 'r1' };

function reaction(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'reaction.changed',
    iface: 'fake',
    at: 1,
    id,
    chat: { id: 'c1', kind: 'channel' },
    messageId: 'm1',
    emoji: { name: 'x' },
    accountId: 'u1',
    added: true,
    ...extra,
  };
}

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// The core end: a door whose handler counts, and the link over the loopback.
function core(token = 'tok', handler: (event: object) => unknown = () => undefined) {
  const handled: Array<string> = [];
  const door = createEventDoor({
    handlers: {
      'reaction.changed': (event: { id: string }) => {
        handled.push(event.id);
        return handler(event);
      },
    },
    log: quiet,
  });
  const { core: coreEnd, client } = createLoopback();
  const link = openAdapterLink({ transport: coreEnd, door, token, log: quiet });
  return { link, client, handled };
}

// The whole thing: the link on one end and the fake adapter served on the other.
async function pair(adapter: FakeAdapter = createFakeAdapter()) {
  const { link, client, handled } = core();
  const served = serveAdapter({ transport: client, hello: HELLO, token: 'tok', adapter, log: quiet });
  await link.hello;
  return { link, served, client, handled, fake: adapter };
}

// An adapter whose send and fetch answer only when released; `arrived` counts the calls it got.
function gated() {
  const waiting: Array<() => void> = [];
  const state = { arrived: 0 };
  const fake = createFakeAdapter();
  const hold = (): Promise<void> => {
    state.arrived += 1;
    return new Promise<void>((resolve) => waiting.push(resolve));
  };
  const adapter: FakeAdapter = {
    ...fake,
    async send(chat, content) {
      await hold();
      return fake.send(chat, content);
    },
    async fetchMessages(chat, ids) {
      await hold();
      return fake.fetchMessages(chat, ids);
    },
  };
  return { adapter, state, release: (count = waiting.length) => waiting.splice(0, count).forEach((go) => go()) };
}

test('hello resolves with the iface, the persona, the root, the capabilities and resume of the interface', async () => {
  const { link, served } = await pair();
  assert.deepEqual(await link.hello, HELLO);
  served.close();
  link.close();
});

test('hello gives the persona id and name of the interface as the core keeps them for the link', async () => {
  const { link, served } = await pair();
  const hello = await link.hello;
  assert.deepEqual(hello.self, { id: 'bot-1', name: 'Νέπτυν' });
  assert.deepEqual(hello.root, { id: 'g1', name: 'Alpha' });
  served.close();
  link.close();
});

test('hello of an interface that serves no root resolves with root null', async () => {
  const { link, client } = core();
  const served = serveAdapter({
    transport: client,
    hello: { ...HELLO, root: null },
    token: 'tok',
    adapter: createFakeAdapter(),
    log: quiet,
  });
  assert.equal((await link.hello).root, null);
  served.close();
  link.close();
});

test('capabilities answers at once from the capabilities of hello, and the iface is the one of hello', async () => {
  const { link, served } = await pair();
  assert.equal(link.adapter.iface, 'fake');
  assert.deepEqual(link.adapter.capabilities(), CAPABILITIES);
  served.close();
  link.close();
});

test('runs the handler once and gives ok for a valid event, then duplicate for the same event again', async () => {
  const { link, served, handled } = await pair();
  const event = reaction('e1');
  assert.equal(await served.emit(event), 'ok');
  assert.equal(await served.emit(event), 'duplicate');
  assert.deepEqual(handled, ['e1']);
  served.close();
  link.close();
});

test('gives invalid for a malformed event and runs no handler', async () => {
  const { link, served, handled } = await pair();
  assert.equal(await served.emit(reaction('e1', { added: 'yes' })), 'invalid');
  assert.deepEqual(handled, []);
  served.close();
  link.close();
});

test('closes the link and runs no handler when an event comes before hello', async () => {
  const { link, client, handled } = core();
  const closed: Array<string> = [];
  client.onClose((reason) => closed.push(reason));
  client.send(envelope('event', reaction('e1'), { id: 'e1' }));
  await assert.rejects(link.hello);
  await until(() => closed.length === 1);
  assert.deepEqual(handled, []);
});

test('closes the link on a wrong token: hello rejects, nothing reaches the door and a waiting emit fails', async () => {
  const { link, client, handled } = core('right');
  const served = serveAdapter({
    transport: client,
    hello: HELLO,
    token: 'wrong',
    adapter: createFakeAdapter(),
    log: quiet,
  });
  const pending = served.emit(reaction('e1'));
  await assert.rejects(link.hello);
  assert.equal(await pending, 'failed');
  assert.deepEqual(handled, []);
});

test('closes the link when the first envelope is not hello', async () => {
  const { link, client } = core();
  const closed: Array<string> = [];
  client.onClose((reason) => closed.push(reason));
  client.send(envelope('ping', { at: 1 }, { id: 'p1' }));
  await assert.rejects(link.hello);
  await until(() => closed.length === 1);
});

test('handles two events at once: both handlers start before either ack comes back', async () => {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started: Array<string> = [];
  const { link, client } = (() => {
    const door = createEventDoor({
      handlers: {
        'reaction.changed': async (event: { id: string }) => {
          started.push(event.id);
          await gate;
        },
      },
      log: quiet,
    });
    const ends = createLoopback();
    return { link: openAdapterLink({ transport: ends.core, door, token: 'tok', log: quiet }), client: ends.client };
  })();
  const served = serveAdapter({
    transport: client,
    hello: HELLO,
    token: 'tok',
    adapter: createFakeAdapter(),
    log: quiet,
  });
  await link.hello;
  const first = served.emit(reaction('e1'));
  const second = served.emit(reaction('e2'));
  await until(() => started.length === 2);
  release();
  assert.deepEqual(await Promise.all([first, second]), ['ok', 'ok']);
  served.close();
  link.close();
});

test('a send returns the delivery of the fake with every part of a long text', async () => {
  const { link, served, fake } = await pair();
  const delivery = await link.adapter.send(CHAT, { text: 'a'.repeat(2500) });
  assert.equal(delivery.status, 'ok');
  assert.equal(delivery.parts.length, 2);
  assert.equal(delivery.ref?.messageId, fake.messagesIn('c1')[0]?.ref.messageId);
  served.close();
  link.close();
});

test('an attachment arrives at the fake with equal bytes', async () => {
  const { link, served, fake } = await pair();
  const bytes = new Uint8Array(3000);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 31) % 251;
  const delivery = await link.adapter.send(CHAT, { attachments: [{ name: 'f.bin', data: bytes }] });
  assert.equal(delivery.status, 'ok');
  const stored = fake.messagesIn('c1')[0] as { attachments: Array<{ data: Uint8Array }> };
  assert.equal(Buffer.compare(Buffer.from(stored.attachments[0]?.data ?? new Uint8Array(0)), Buffer.from(bytes)), 0);
  served.close();
  link.close();
});

test('edit, react, unreact, typing and delete reach the fake and return its ok', async () => {
  const { link, served, fake } = await pair();
  const delivery = await link.adapter.send(CHAT, { text: 'hi' });
  const ref = delivery.ref as NonNullable<Delivery['ref']>;
  const message = fake.messagesIn('c1')[0] as { text: string; reactions: Set<string> };

  assert.equal((await link.adapter.edit(ref, { text: 'changed' })).status, 'ok');
  assert.equal(message.text, 'changed');
  assert.equal((await link.adapter.react(ref, '👍')).status, 'ok');
  assert.deepEqual([...message.reactions], ['👍']);
  assert.equal((await link.adapter.unreact(ref, '👍')).status, 'ok');
  assert.deepEqual([...message.reactions], []);
  assert.equal((await link.adapter.typing(CHAT, { untilMs: 1 })).status, 'ok');
  assert.deepEqual(fake.typings, ['c1']);
  assert.equal((await link.adapter.delete(ref)).status, 'ok');
  assert.equal(fake.messagesIn('c1').length, 0);
  served.close();
  link.close();
});

test('a refusal of the fake comes back as its result: editing a message that is not there fails', async () => {
  const { link, served } = await pair();
  const result: PortResult = await link.adapter.edit({ ...CHAT, messageId: 'ghost' }, { text: 'x' });
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'unknown-message');
  served.close();
  link.close();
});

test('fetchMessages returns the messages the fake holds and marks the ones it does not', async () => {
  const { link, served, fake } = await pair();
  const delivery = await link.adapter.send(CHAT, { text: 'findable' });
  const messageId = delivery.ref?.messageId as string;
  const expected = await fake.fetchMessages(CHAT, [messageId, 'nope']);
  const got = await link.adapter.fetchMessages(CHAT, [messageId, 'nope']);
  assert.deepEqual(got, expected);
  assert.deepEqual((got as unknown as { messages: Array<unknown> }).messages[1], { messageId: 'nope', missing: true });
  served.close();
  link.close();
});

test('every send carries its own idempotency key', async () => {
  const { link, client } = core();
  const keys: Array<string> = [];
  client.onEnvelope((value) => {
    if (value.type === 'action') keys.push((value.body as { idempotencyKey?: string }).idempotencyKey ?? '');
  });
  client.send(
    envelope(
      'hello',
      { iface: 'fake', self: SELF, root: ROOT, capabilities: CAPABILITIES, resume: null, token: 'tok' },
      { id: 'h1' }
    )
  );
  await link.hello;
  void link.adapter.send(CHAT, { text: 'one' });
  void link.adapter.send(CHAT, { text: 'two' });
  await until(() => keys.length === 2);
  assert.match(keys[0] ?? '', /^.+$/);
  assert.notEqual(keys[0], keys[1]);
  link.close();
});

test('resolves the pending send as unknown with link-closed when the interface closes', async () => {
  const g = gated();
  const { link, served, client } = await pair(g.adapter);
  const pending = link.adapter.send(CHAT, { text: 'in flight' });
  await until(() => g.state.arrived === 1);
  client.close();
  const delivery = await pending;
  assert.equal(delivery.status, 'unknown');
  assert.equal(delivery.error?.code, 'link-closed');
  served.close();
});

test('resolves the pending send as unknown with link-closed when the core closes the link', async () => {
  const g = gated();
  const { link, served } = await pair(g.adapter);
  const pending = link.adapter.send(CHAT, { text: 'in flight' });
  await until(() => g.state.arrived === 1);
  link.close();
  const delivery = await pending;
  assert.equal(delivery.status, 'unknown');
  assert.equal(delivery.error?.code, 'link-closed');
  served.close();
});

test('resolves a pending fetchMessages as failed with link-closed, not unknown', async () => {
  const g = gated();
  const { link, served } = await pair(g.adapter);
  const pending = link.adapter.fetchMessages(CHAT, ['m1']);
  await until(() => g.state.arrived === 1);
  link.close();
  const result = (await pending) as unknown as PortResult;
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'link-closed');
  served.close();
});

test('calls after close answer at once: an effect is unknown, a read is failed, both link-closed', async () => {
  const { link, served } = await pair();
  link.close();
  const react = await link.adapter.react({ ...CHAT, messageId: 'm1' }, 'x');
  const send = await link.adapter.send(CHAT, { text: 'late' });
  const fetched = (await link.adapter.fetchMessages(CHAT, ['m1'])) as unknown as PortResult;
  assert.deepEqual([react.status, react.error?.code], ['unknown', 'link-closed']);
  assert.deepEqual([send.status, send.error?.code], ['unknown', 'link-closed']);
  assert.deepEqual([fetched.status, fetched.error?.code], ['failed', 'link-closed']);
  served.close();
});

test('refuses the 257th pending action with a retryable link-busy and keeps the first 256 waiting', async () => {
  const g = gated();
  const { link, served } = await pair(g.adapter);
  const pending: Array<Promise<Delivery>> = [];
  for (let index = 0; index < 256; index += 1) pending.push(link.adapter.send(CHAT, { text: `m${index}` }));
  const refused = await link.adapter.send(CHAT, { text: 'one too many' });
  assert.equal(refused.status, 'failed');
  assert.equal(refused.error?.code, 'link-busy');
  assert.equal(refused.error?.retryable, true);
  link.close();
  const closed = await Promise.all(pending);
  assert.equal(
    closed.every((delivery) => delivery.status === 'unknown'),
    true
  );
  served.close();
});

test('accepts a new action once an answer has freed a slot', async () => {
  const g = gated();
  const { link, served } = await pair(g.adapter);
  const pending: Array<Promise<Delivery>> = [];
  for (let index = 0; index < 256; index += 1) pending.push(link.adapter.send(CHAT, { text: `m${index}` }));
  await until(() => g.state.arrived >= 1);
  g.release(1);
  assert.equal((await pending[0])?.status, 'ok');
  const next = link.adapter.send(CHAT, { text: 'fits now' });
  link.close();
  assert.notEqual((await next).error?.code, 'link-busy');
  await Promise.all(pending);
  served.close();
});

test('an ack envelope the link never asked for does not disturb it', async () => {
  const { link, client, handled } = core();
  client.send(
    envelope(
      'hello',
      { iface: 'fake', self: SELF, root: ROOT, capabilities: CAPABILITIES, resume: null, token: 'tok' },
      { id: 'h1' }
    )
  );
  await link.hello;
  client.send(ackOf('nothing', 'ok'));
  client.send(envelope('event', reaction('e1'), { id: 'e1' }));
  await until(() => handled.length === 1);
  assert.deepEqual(handled, ['e1']);
  link.close();
});

test('the router answers what the interface of a reference declares, and nothing for one no adapter answers', () => {
  // Bug: a place of the command line, or of an interface not connected, was told the served interface could react.
  const served = createFakeAdapter({ iface: 'discord' });
  const cli = createFakeAdapter({ iface: 'cli', operations: ['message.send'] });
  const router = createIfaceRouter(
    served,
    (iface) => (iface === 'cli' ? cli : null),
    () => [cli]
  );
  assert.deepEqual(router.capabilitiesOf({ iface: 'cli' }).operations, ['message.send']);
  assert.ok(router.capabilitiesOf({ iface: 'discord' }).operations.includes('message.react.add'));
  assert.deepEqual(router.capabilitiesOf({ iface: 'elsewhere' }).operations, []);
});

// New reproductions, written from the risk the plan describes (forged principals through message fields and reconnect
// order); the original scenarios were not found. An interface client keeps to what its token stands for: it cannot post
// into the owner's command-line chat by naming it in an event, and connecting after another client of the same namespace
// does not take that client's place on the core's adapter. The links run over the loopback, the door over fake handlers.

const QUIET = { info() {}, warn() {}, error() {} };
const CAPABILITIES_RACES_PRINCIPALS: Capabilities = {
  operations: ['message.send'],
  maxChars: 2000,
  maxFiles: 10,
  maxFileBytes: 4096,
  edit: { ownOnly: true, windowMs: null },
  history: true,
  threads: false,
  reactions: true,
  customEmoji: false,
  presence: false,
  voiceFormats: [],
  publish: [],
  search: false,
};
const FIRST: Principal = { name: 'first', kind: 'interface', iface: 'fake', permissions: [] };
const SECOND: Principal = { name: 'second', kind: 'interface', iface: 'fake', permissions: [] };
const principalOf = (token: string): Principal | null =>
  token === 'first' ? FIRST : token === 'second' ? SECOND : null;

/** A link of the core with its client end; `started` holds the events that reached a handler. */
async function connected(token: string) {
  const started: Array<string> = [];
  const door = createEventDoor({
    handlers: {
      'reaction.changed': (event: { id: string }) => {
        started.push(event.id);
      },
    },
    log: QUIET,
  });
  const { core, client } = createLoopback();
  const link = openAdapterLink({ transport: core, door, principalOf, log: QUIET });
  const received: Array<Envelope> = [];
  const closed: Array<string> = [];
  client.onEnvelope((value) => received.push(value));
  client.onClose((reason) => closed.push(reason));
  client.send(
    envelope(
      'hello',
      {
        iface: 'fake',
        self: { id: 'bot-1', name: 'Nova' },
        root: null,
        capabilities: CAPABILITIES_RACES_PRINCIPALS,
        resume: null,
        token,
      },
      { id: `hello:${token}` }
    )
  );
  await link.hello;
  return { link, client, started, received, closed };
}

test('new reproduction: an interface event naming the command-line chat is refused', async () => {
  // Bug: the iface field is checked and the chat is not, so any interface client writes a line into
  // `cli:dm:owner`, the owner's private chat whose history and replies are the command line's.
  const { link, client, started, received } = await connected('first');
  try {
    client.send(
      envelope(
        'event',
        {
          kind: 'reaction.changed',
          iface: 'fake',
          at: 1,
          id: 'forged',
          chat: { id: 'cli:dm:owner', kind: 'dm' },
          messageId: 'm1',
          emoji: { name: 'x' },
          accountId: 'u1',
          added: true,
        },
        { id: 'forged' }
      )
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started, []);
    const answer = received.find((value) => value.type === 'ack' && value.replyTo === 'forged');
    assert.equal((answer?.body as { status?: unknown } | undefined)?.status, 'invalid');
  } finally {
    link.close();
  }
});

test('new reproduction: a second client of the same namespace does not take over the adapter', async () => {
  // Bug: `attach` compares nothing, so whichever client connects last receives every send meant for the first one.
  const first = await connected('first');
  const second = await connected('second');
  const routed = createLinkSwitch(first.link);
  try {
    routed.attach(second.link);
    assert.equal(routed.current().principal()?.name, 'first');
    assert.equal(first.link.isClosed(), false, 'the serving client stays connected');
    assert.equal(second.link.isClosed(), true, 'the newcomer is the one refused');
  } finally {
    first.link.close();
    second.link.close();
  }
});

test('new reproduction: the same client reconnecting takes its own place back', async () => {
  // Bug: a fix that refuses every second link leaves an interface that reconnects with no way back on the adapter.
  const first = await connected('first');
  const again = await connected('first');
  const routed = createLinkSwitch(first.link);
  try {
    routed.attach(again.link);
    assert.equal(routed.current(), again.link);
    assert.equal(first.link.isClosed(), true);
    // The reconnect above is today's behaviour; what is new is that it stays true beside the refusal.
    const stranger = await connected('second');
    routed.attach(stranger.link);
    assert.equal(routed.current(), again.link);
    stranger.link.close();
  } finally {
    again.link.close();
  }
});
