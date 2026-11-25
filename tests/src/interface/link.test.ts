// Tests for the core side of the link (src/interface/link.ts), over the loopback of the wire, the real event
// door and the fake adapter served by serveAdapter. A few tests drive the interface end by hand where the
// serving side would never behave that way (an event before hello) and a few serve a gated adapter that answers
// only when the test says so, to hold actions pending.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { ackOf, envelope } from '../../../src/protocol/index.ts';
import { createLoopback } from '../../fixtures/loopback.ts';
import { serveAdapter } from '../../../src/protocol/serve.ts';
import type { Hello } from '../../../src/protocol/serve.ts';
import type { Capabilities, Delivery, MediaPickCapability } from '../../../src/protocol/adapter.ts';
import type { PortResult } from '../../../src/protocol/actions.ts';
import { createIfaceRouter, openAdapterLink, createLinkSwitch } from '../../../src/interface/link.ts';
import { createEventDoor } from '../../../src/interface/door.ts';
import { createFakeAdapter } from '../../../scripts/lib/fake.ts';
import type { Principal } from '../../../src/interface/principals.ts';
import type { Envelope, Transport } from '../../../src/protocol/wire.ts';
import type { EventHandlerContext, IngestRow } from '../../../src/interface/door.ts';
import { createCommandIntake } from '../../../src/interface/neptunia-cli.ts';
import { createAdmin } from '../../../src/admin.ts';
import { fakeStore, hotWith, personaGrants } from '../../fixtures/turn-harness.ts';
import { GUILD, START } from '../../fixtures/boundary.ts';
import { createTurnRunner as createRealTurnRunner } from '../../../src/behavior/turn.ts';
import { userText } from '../../../src/behavior/prompt.ts';
import { labels } from '../../fixtures/labels.ts';
import { freshWorld, useIface, world } from '../../fixtures/turn-world.ts';
import {
  NOW,
  fakeHot,
  fakeStore as capabilitiesFakeStore,
  fakeTurnChannel,
  identityCalibrator,
  normalizedTrigger,
  rawMessage,
} from '../../fixtures/turn-kit.ts';
import { chainsOf } from '../../fixtures/chains.ts';

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
  const attachment = stored.attachments[0];
  assert.equal(Buffer.compare(Buffer.from(attachment?.data ?? new Uint8Array(0)), Buffer.from(bytes)), 0);
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

// Forged principals through message fields and reconnect order. An interface client keeps to what its token stands for: it cannot post
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

test('forged principal: an interface event naming the command-line chat is refused', async () => {
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

test('forged principal: a second client of the same namespace does not take over the adapter', async () => {
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

test('forged principal: the same client reconnecting takes its own place back', async () => {
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

// No namespace `plugin` exists. A client that still says hello under it meets the link's
// ordinary refusal for a namespace its principal does not own (src/interface/link.ts), never a crash of the core.

const FAKE: Principal = { name: 'fake', kind: 'interface', iface: 'fake', permissions: [] };

test('a hello under the retired namespace plugin is refused with iface and the link closes', async () => {
  // Bug it catches: the core once routed a first `hello` under `plugin` to a plugin link. With that branch gone, a
  // leftover plugin unit must reach the adapter link's refusal, not an unhandled path that takes the core down.
  const warnings: Array<{ message: string; meta: unknown }> = [];
  const log = {
    info() {},
    warn: (message: string, meta?: unknown) => warnings.push({ message, meta }),
    error() {},
  };
  const door = createEventDoor({ handlers: {}, log });
  const { core, client } = createLoopback();
  const link = openAdapterLink({
    transport: core,
    door,
    principalOf: (token) => (token === 'fake-token' ? FAKE : null),
    log,
  });
  const closed: Array<string> = [];
  client.onClose((reason) => closed.push(reason));
  client.send(
    envelope(
      'hello',
      { iface: 'plugin', self: { id: 'echo', name: 'echo' }, root: null, token: 'fake-token' },
      { id: 'hello:plugin:echo' }
    )
  );
  await assert.rejects(link.hello, /link closed before hello: iface/);
  assert.deepEqual(warnings, [{ message: 'link: hello refused', meta: { reason: 'iface', principal: 'fake' } }]);
  assert.equal(link.isClosed(), true);
  assert.equal(closed.length, 1);
});

// Tests for the core's end of the link (src/interface/link.ts) once every client has its own token: `principalOf`
// turns the token of `hello` into a principal, and the principal, never what `hello` claims, decides what the
// connection may do. An interface principal sends events of its own `iface` only and never a command; only a `cli`
// principal reaches commands. The tests also cover what the link does with the `seq` an interface numbers its events
// with (one chat's events in order, a contiguous acknowledgement), the idempotency key a caller gives an
// effect, and an effect's cancellation. The interface end is driven by hand over the loopback where a well-behaved
// interface would never send what the test sends, and is the real serveAdapter over the fake adapter elsewhere.

type ClientLog = {
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
};

const clientQuiet: ClientLog = { info() {}, warn() {}, error() {} };
const CLIENT_CHAT = { iface: 'fake', chatId: 'c1' };
const CLIENT_CAPABILITIES: Capabilities = {
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
};
const CLIENT_SELF = { id: 'bot-1', name: 'Nova' };
const CLIENT_HELLO: Hello = {
  iface: 'fake',
  self: CLIENT_SELF,
  root: null,
  capabilities: CLIENT_CAPABILITIES,
  resume: null,
};

const CLIENT_FAKE: Principal = { name: 'fake', kind: 'interface', iface: 'fake', permissions: [] };
const OWNER: Principal = { name: 'owner', kind: 'cli', iface: 'cli', permissions: [] };
/** An interface principal whose `clients.json` entry still carries the permission `commands` that `/nep` needed. */
const UNIT: Principal = { name: 'unit', kind: 'interface', iface: 'fake', permissions: ['commands'] };
const TOKENS: Record<string, Principal> = {
  'fake-token': CLIENT_FAKE,
  'owner-token': OWNER,
  'unit-token': UNIT,
};
const clientPrincipalOf = (token: string): Principal | null => TOKENS[token] ?? null;

function clientReaction(id: string, chatId = 'c1', iface = 'fake'): Record<string, unknown> {
  return {
    kind: 'reaction.changed',
    iface,
    at: 1,
    id,
    chat: { id: chatId, kind: 'channel' },
    messageId: 'm1',
    emoji: { name: 'x' },
    accountId: 'u1',
    added: true,
  };
}

function command(id: string, iface: string): Record<string, unknown> {
  return {
    kind: 'command.requested',
    iface,
    at: 1,
    id,
    chat: { id: 'c1', kind: 'channel' },
    name: 'pause',
    args: {},
    replyRef: 'r1',
    requester: { id: 'owner-1', name: 'Owner', roles: [], owner: true },
  };
}

async function clientUntil(check: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** `promise`, or a rejection after two seconds: a link that never answers hello fails the test instead of hanging it. */
async function within<T>(promise: Promise<T>, ms = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('hello never answered')), ms);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** An event envelope numbered `seq`, as an interface with an outbox sends it. */
const numbered = (body: Record<string, unknown>, seq: number): Envelope =>
  Object.assign(envelope('event', body, { id: String(body.id) }), { seq });

const bodyOf = (value: Envelope): Record<string, unknown> => value.body as Record<string, unknown>;

/**
 * The core end with a door whose handlers record what started and, for the ids in `held`, wait until released. The
 * interface end is the loopback's client, driven by hand: `received` is every envelope the core sent it.
 */
function clientCore(
  held: ReadonlyArray<string> = [],
  options: {
    principalOf?: typeof clientPrincipalOf;
    intake?: boolean;
    lineLinks?: (message: Record<string, unknown>) => Promise<Record<string, unknown>>;
  } = {}
) {
  const started: Array<string> = [];
  const contexts: Array<EventHandlerContext> = [];
  const events: Array<object> = [];
  const committed: Array<IngestRow> = [];
  let commandChecks = 0;
  const gates = new Map<string, () => void>();
  const hold = (id: string): Promise<void> | undefined =>
    held.includes(id) ? new Promise<void>((resolve) => gates.set(id, resolve)) : undefined;
  const door = createEventDoor({
    handlers: {
      'reaction.changed': (event: { id: string }) => {
        started.push(event.id);
        return hold(event.id);
      },
      'command.requested': (event: { id: string }) => {
        started.push(event.id);
      },
      'message.received': (event: { id: string }, context: EventHandlerContext) => {
        contexts.push(context);
        events.push(event);
        started.push(event.id);
      },
    },
    log: clientQuiet,
    ingest: {
      seen: () => false,
      commit: (row) => {
        committed.push(row);
        return Promise.resolve();
      },
    },
  });
  const { core: coreEnd, client } = createLoopback();
  const intake = options.intake
    ? createCommandIntake({
        door,
        ready: () => Promise.resolve(),
        desk: () => {
          commandChecks += 1;
          return null;
        },
        ...(options.lineLinks === undefined ? {} : { lineLinks: options.lineLinks }),
        log: clientQuiet,
      })
    : null;
  const link: ReturnType<typeof openAdapterLink> = openAdapterLink({
    transport: coreEnd,
    door: intake?.doorOf(() => link) ?? door,
    principalOf: options.principalOf ?? clientPrincipalOf,
    log: clientQuiet,
  });
  const received: Array<Envelope> = [];
  const closed: Array<string> = [];
  client.onEnvelope((value) => received.push(value));
  client.onClose((reason) => closed.push(reason));
  return {
    link,
    client,
    started,
    contexts,
    events,
    committed,
    commandChecks: () => commandChecks,
    received,
    closed,
    release: (id: string): void => gates.get(id)?.(),
    hello(token: string, extra: Record<string, unknown> = {}, id = 'hello:1'): void {
      client.send(envelope('hello', { ...HELLO, token, ...extra }, { id }));
    },
    ackOf: (id: string): Record<string, unknown> | undefined => {
      const found = received.find((value) => value.type === 'ack' && value.replyTo === id);
      return found === undefined ? undefined : bodyOf(found);
    },
  };
}

async function answered(rig: ReturnType<typeof clientCore>, id: string): Promise<Record<string, unknown>> {
  await clientUntil(() => rig.ackOf(id) !== undefined);
  return rig.ackOf(id) ?? {};
}

test('an interface principal may not send an event of another iface: invalid, and the handler never runs', async () => {
  const rig = clientCore();
  rig.hello('fake-token');
  await within(rig.link.hello);
  rig.client.send(envelope('event', clientReaction('e1', 'c1', 'other'), { id: 'e1' }));
  assert.equal((await answered(rig, 'e1')).status, 'invalid');
  rig.client.send(envelope('event', clientReaction('e2'), { id: 'e2' }));
  assert.equal((await answered(rig, 'e2')).status, 'ok', 'its own iface passes on the same link');
  assert.deepEqual(rig.started, ['e2']);
  rig.link.close();
});

test('a hello of an interface principal that names an owner and the cli kind gains no command', async () => {
  const rig = clientCore();
  rig.hello('fake-token', { kind: 'cli', owner: true, ownerId: 'owner-1' });
  await within(rig.link.hello);
  rig.client.send(envelope('event', command('k1', 'fake'), { id: 'k1' }));
  assert.equal((await answered(rig, 'k1')).status, 'invalid');
  assert.deepEqual(rig.started, []);
  rig.link.close();
});

// No interface sends commands, whatever `clients.json` grants it.
test('an interface principal granted commands reaches no command: invalid, and the handler never runs', async () => {
  const rig = clientCore();
  rig.hello('unit-token');
  await within(rig.link.hello);
  rig.client.send(envelope('event', command('k1', 'fake'), { id: 'k1' }));
  assert.equal((await answered(rig, 'k1')).status, 'invalid');
  assert.deepEqual(rig.started, []);
  rig.link.close();
});

test('the cli principal reaches commands', async () => {
  const rig = clientCore();
  rig.hello('owner-token', { iface: 'cli' });
  await within(rig.link.hello);
  rig.client.send(envelope('event', command('k1', 'cli'), { id: 'k1' }));
  assert.equal((await answered(rig, 'k1')).status, 'ok');
  assert.deepEqual(rig.started, ['k1']);
  rig.link.close();
});

test('a second hello carrying the cli token is invalid and the link keeps its first principal', async () => {
  const rig = clientCore();
  rig.hello('fake-token');
  await within(rig.link.hello);
  rig.hello('owner-token', { iface: 'cli' }, 'hello:2');
  assert.equal((await answered(rig, 'hello:2')).status, 'invalid');
  rig.client.send(envelope('event', command('k1', 'cli'), { id: 'k1' }));
  assert.notEqual((await answered(rig, 'k1')).status, 'ok');
  assert.deepEqual(rig.started, []);
  rig.link.close();
});

test('an event envelope with a malformed body gets an invalid ack and the link stays open', async () => {
  const rig = clientCore();
  rig.hello('fake-token');
  await within(rig.link.hello);
  rig.client.send(envelope('event', { ...reaction('e1'), added: 'yes' }, { id: 'e1' }));
  assert.equal((await answered(rig, 'e1')).status, 'invalid');
  rig.client.send(envelope('event', clientReaction('e2'), { id: 'e2' }));
  assert.equal((await answered(rig, 'e2')).status, 'ok');
  assert.deepEqual(rig.closed, []);
  rig.link.close();
});

test('the ack of an event carries the contiguous watermark: a later event done first does not pass a held one', async () => {
  const rig = clientCore(['e2']);
  rig.hello('fake-token');
  await within(rig.link.hello);
  rig.client.send(numbered(clientReaction('e1', 'c1'), 1));
  rig.client.send(numbered(clientReaction('e2', 'c2'), 2));
  rig.client.send(numbered(clientReaction('e3', 'c3'), 3));
  assert.equal((await answered(rig, 'e3')).ackedSeq, 1, 'seq 2 is still being handled');
  rig.release('e2');
  assert.equal((await answered(rig, 'e2')).ackedSeq, 3);
  rig.link.close();
});

test("a chat's next event waits for the one before it, while another chat's event goes on", async () => {
  const rig = clientCore(['e1']);
  rig.hello('fake-token');
  await within(rig.link.hello);
  rig.client.send(numbered(clientReaction('e1', 'c1'), 1));
  rig.client.send(numbered(clientReaction('e2', 'c1'), 2));
  rig.client.send(numbered(clientReaction('e3', 'c2'), 3));
  await clientUntil(() => rig.started.includes('e3'));
  assert.deepEqual(rig.started, ['e1', 'e3'], 'e2 of c1 waits behind e1');
  rig.release('e1');
  await clientUntil(() => rig.started.includes('e2'));
  assert.deepEqual(rig.started, ['e1', 'e3', 'e2']);
  rig.link.close();
});

// The link and the fake adapter served over the loopback with the interface's token.
async function clientPair(adapter = createFakeAdapter()) {
  const { link, client } = clientCore();
  const served = serveAdapter({
    transport: client,
    hello: CLIENT_HELLO,
    token: 'fake-token',
    adapter,
    log: clientQuiet,
  });
  await within(link.hello);
  return { link, served, fake: adapter };
}

test('a send carries the idempotency key its caller gives, and a retry under the same key posts once', async () => {
  const { link, served, fake } = await clientPair();
  const key = 'turn-1:0:c1';
  const first = await link.adapter.send(CLIENT_CHAT, { text: 'once' }, { idempotencyKey: key });
  const retry = await link.adapter.send(CLIENT_CHAT, { text: 'once' }, { idempotencyKey: key });
  assert.equal(fake.messagesIn('c1').length, 1);
  assert.equal(retry.ref?.messageId, first.ref?.messageId);
  assert.equal(retry.idempotencyKey, key);
  served.close();
  link.close();
});

/** The core end over a hand-driven interface end that has said hello with the interface's token. */
async function handDriven(): Promise<{
  link: ReturnType<typeof openAdapterLink>;
  client: Transport;
  actions: Array<Envelope>;
  cancels: Array<Envelope>;
}> {
  const rig = clientCore();
  rig.hello('fake-token');
  await within(rig.link.hello);
  const actions: Array<Envelope> = [];
  const cancels: Array<Envelope> = [];
  rig.client.onEnvelope((value) => {
    if (value.type === 'action') actions.push(value);
    if (value.type === 'cancel') cancels.push(value);
  });
  return { link: rig.link, client: rig.client, actions, cancels };
}

test('a send whose signal is aborted before the call is cancelled and never sent to the interface', async () => {
  const { link, actions } = await handDriven();
  const controller = new AbortController();
  controller.abort();
  const delivery = await link.adapter.send(CLIENT_CHAT, { text: 'never' }, { signal: controller.signal });
  assert.equal(delivery.status, 'cancelled');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(actions, []);
  link.close();
});

test('an abort after the action went out sends a cancel naming it, and the result that arrives later stands', async () => {
  const { link, client, actions, cancels } = await handDriven();
  const controller = new AbortController();
  const pending = link.adapter.send(CLIENT_CHAT, { text: 'in flight' }, { signal: controller.signal });
  await clientUntil(() => actions.length === 1);
  const [action] = actions;
  if (action === undefined) throw new Error('no action');
  controller.abort();
  await clientUntil(() => cancels.length === 1);
  assert.equal(cancels[0]?.replyTo, action.id);
  const ref = { ...CHAT, messageId: 'p1' };
  const result = { status: 'ok', ref, parts: [ref], at: 5, idempotencyKey: 'k', error: null };
  client.send(envelope('action_result', result, { id: `result:${action.id}`, replyTo: action.id }));
  const delivery = await pending;
  assert.equal(delivery.status, 'ok');
  assert.equal(delivery.ref?.messageId, 'p1');
  link.close();
});

function ordinaryMessage(id: string, iface = 'cli'): Record<string, unknown> {
  return {
    kind: 'message.received',
    iface,
    at: 1,
    id,
    chat: { id: `${iface}:dm:owner`, kind: 'dm' },
    message: {
      id,
      author: { id: 'owner', name: 'Owner', self: false, bot: false },
      content: 'an ordinary message',
      at: 1,
      replyToId: null,
      replyPingAccountId: null,
      forwardedFrom: null,
      attachments: [],
      links: [],
      forwarded: [],
      stickers: [],
      emojis: [],
      reactions: [],
    },
    addressing: { mentioned: false, replyToSelf: false, mentionedAccountIds: [], mentionedChatIds: [] },
  };
}

test('an authenticated CLI message reaches the handler with verified sender, ingestion principal and sequence', async () => {
  // Catches sender provenance lost between token validation, envelope receipt and core-shaped handler dispatch.
  const rig = clientCore();
  try {
    rig.hello('owner-token', { iface: 'cli' });
    await within(rig.link.hello);
    rig.client.send(numbered(ordinaryMessage('cli-message'), 1));
    assert.deepEqual(await answered(rig, 'cli-message'), { status: 'ok', ackedSeq: 1 });
    const context = rig.contexts[0];
    assert.deepEqual(context?.authenticated, { name: OWNER.name, kind: 'cli' });
    assert.deepEqual(context?.ingest, {
      principal: OWNER.name,
      seq: 1,
      eventId: 'cli-message',
      kind: 'message.received',
      chat: 'cli:dm:owner',
    });
    assert.deepEqual(rig.committed, [context?.ingest]);
    assert.equal('authenticated' in (rig.events[0] ?? {}), false, 'trusted sender stays outside the wire event');
  } finally {
    rig.link.close();
  }
});

test('an interface named owner with command permission cannot claim CLI provenance in its event', async () => {
  // Catches privilege inferred from a name, command permission or untrusted event fields.
  const ownerNamedInterface: Principal = { ...FAKE, name: OWNER.name, permissions: ['commands'] };
  const rig = clientCore([], { principalOf: () => ownerNamedInterface });
  try {
    rig.hello('synthetic-interface-token');
    await within(rig.link.hello);
    const event = {
      ...ordinaryMessage('spoofed-message', 'fake'),
      internal: true,
      authenticated: { name: OWNER.name, kind: 'cli' },
      principal: OWNER.name,
    };
    rig.client.send(numbered(event, 1));
    const answer = await answered(rig, 'spoofed-message');
    const context = rig.contexts[0];
    if (answer.status === 'ok') assert.deepEqual(context?.authenticated, { name: OWNER.name, kind: 'interface' });
    else {
      assert.equal(answer.status, 'invalid');
      assert.deepEqual(rig.contexts, []);
    }
  } finally {
    rig.link.close();
  }
});

test('revoking a CLI token closes its link before another event can forward stale sender metadata', async () => {
  // Catches reusing the hello principal after per-envelope token validation has failed.
  let active = true;
  const rig = clientCore([], { principalOf: (token) => (active && token === 'owner-token' ? OWNER : null) });
  try {
    rig.hello('owner-token', { iface: 'cli' });
    await within(rig.link.hello);
    rig.client.send(numbered(ordinaryMessage('before-revocation'), 1));
    assert.equal((await answered(rig, 'before-revocation')).status, 'ok');
    const closed = new Promise<void>((resolve) => rig.client.onClose(() => resolve()));
    active = false;
    rig.client.send(numbered(ordinaryMessage('after-revocation'), 2));
    await within(closed);
    assert.deepEqual(rig.started, ['before-revocation']);
    assert.deepEqual(
      rig.contexts.map((context) => context.authenticated),
      [{ name: OWNER.name, kind: 'cli' }]
    );
    assert.deepEqual(
      rig.committed.map((row) => row.eventId),
      ['before-revocation']
    );
  } finally {
    rig.link.close();
  }
});

test('command intake preserves authenticated sender metadata for an ordinary CLI message', async () => {
  // Catches the intake wrapper dropping provenance or diverting ordinary messages into command handling.
  const rig = clientCore([], { intake: true });
  try {
    rig.hello('owner-token', { iface: 'cli' });
    await within(rig.link.hello);
    rig.client.send(numbered(ordinaryMessage('through-intake'), 1));
    assert.equal((await answered(rig, 'through-intake')).status, 'ok');
    assert.deepEqual(rig.started, ['through-intake']);
    const context = rig.contexts[0];
    assert.deepEqual(context?.authenticated, { name: OWNER.name, kind: 'cli' });
    assert.equal(rig.commandChecks(), 0);
  } finally {
    rig.link.close();
  }
});

test('command intake hands a CLI line to the door with the link items its lineLinks gave', async () => {
  // Catches the intake passing the owner's line on without its links, so a pasted URL reaches the persona as plain text.
  const item = { id: 'm#l0', kind: 'link', site: 'example.org', title: '', text: '', thumbnailUrl: null, url: 'u' };
  const rig = clientCore([], {
    intake: true,
    lineLinks: (message) => Promise.resolve({ ...message, links: [item] }),
  });
  try {
    rig.hello('owner-token', { iface: 'cli' });
    await within(rig.link.hello);
    rig.client.send(numbered(ordinaryMessage('with-link'), 1));
    assert.equal((await answered(rig, 'with-link')).status, 'ok');
    const message = (rig.events[0] as { message?: { links?: Array<object> } }).message;
    assert.deepEqual(message?.links, [item]);
  } finally {
    rig.link.close();
  }
});

test('command intake keeps the order of CLI lines when the links of the first take longer', async () => {
  // Catches a line without links overtaking an earlier line whose link read is still running.
  let release: () => void = () => {};
  const slow = new Promise<void>((resolve) => {
    release = resolve;
  });
  const rig = clientCore([], {
    intake: true,
    lineLinks: async (message) => {
      if (message.id === 'first') await slow;
      return message;
    },
  });
  try {
    rig.hello('owner-token', { iface: 'cli' });
    await within(rig.link.hello);
    // Un-numbered, as the command line sends its lines: the link runs such events concurrently.
    rig.client.send(envelope('event', ordinaryMessage('first'), { id: 'first' }));
    rig.client.send(envelope('event', ordinaryMessage('second'), { id: 'second' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await answered(rig, 'second');
    await answered(rig, 'first');
    assert.deepEqual(rig.started, ['first', 'second']);
  } finally {
    rig.link.close();
  }
});

test('the read goes over the link and comes back with the chat', async () => {
  const fake = createFakeAdapter({ iface: 'fake', selfId: 'self' });
  fake.seedDmChat('u1', 'dm-1');
  const door = createEventDoor({ handlers: {}, log: quiet });
  const { core, client } = createLoopback();
  const link = openAdapterLink({ transport: core, door, token: 'tok', log: quiet });
  const hello = {
    iface: 'fake',
    self: { id: 'self', name: 'Self' },
    root: { id: 'g1', name: 'Alpha' },
    capabilities: fake.capabilities(),
    resume: null,
  };
  serveAdapter({ transport: client, hello, token: 'tok', adapter: fake, log: quiet });
  await link.hello;
  assert.deepEqual(await link.adapter.dmChatOf({ iface: 'fake', accountId: 'u1' }), {
    status: 'ok',
    chatId: 'dm-1',
  });
  link.close();
});

test('the router sends the read to the interface the partner is on', async () => {
  const served = createFakeAdapter({ iface: 'discord', selfId: 'self' });
  const other = createFakeAdapter({ iface: 'other', selfId: 'self' });
  other.seedDmChat('u1', 'dm-other');
  const router = createIfaceRouter(
    served,
    (iface) => (iface === 'other' ? other : null),
    () => [other]
  );
  assert.deepEqual(await router.dmChatOf({ iface: 'other', accountId: 'u1' }), {
    status: 'ok',
    chatId: 'dm-other',
  });
});

const SILENT = { info() {}, warn() {}, error() {}, debug() {} };

/** The rigs and services a test opened; closed when the file is done. */
const OPEN: Array<{ close(): unknown }> = [];

describe('boundary', () => {
  after(async () => {
    for (const item of OPEN) await item.close();
  });

  describe('an adapter that claims the owner', () => {
    // The core authenticates each client by its token: the token stands for a principal, and only the `cli` principal
    // reaches commands. An interface that holds its own token and says in `hello` that it is the owner's cli, naming
    // the owner's id, gains nothing. The handler below believes the requester's id, so it would pause the persona if
    // the command reached it: the link must refuse the command before the door.
    test('a hello that names the owner gains no owner authority', async () => {
      const OWNER = 'owner-1';
      const store = Object.assign(fakeStore(), { flush: () => Promise.resolve() });
      const hot = hotWith({ config: { bot: { timezone: 'UTC', owners: [OWNER], access: {} } } });
      const client = { user: { id: 'self-id' }, channels: { cache: new Map() } };
      const admin = createAdmin({
        hot,
        store,
        client,
        isServedRoot: (id: unknown) => id === GUILD,
      });
      const ran: Array<string> = [];
      const door = createEventDoor({
        handlers: {
          'command.requested': (event) => {
            const { name, args, requester } = event as { name: string; args: object; requester: { id: string } };
            ran.push(name);
            // The door runs the operation by its name; the link refuses first.
            return admin.runSkillOp('bot.pause', args, { placeId: GUILD, accountId: requester.id });
          },
        },
        log: SILENT,
      });
      const HOSTILE = { name: 'hostile', kind: 'interface' as const, iface: 'hostile', permissions: [] };
      const ends = createLoopback();
      const link = openAdapterLink({
        transport: ends.core,
        door,
        principalOf: (token: string) => (token === 'hostile-token' ? HOSTILE : null),
        log: SILENT,
      });
      const acks: Array<{ replyTo: string | null; body: { status?: string } }> = [];
      ends.client.onEnvelope((value) => {
        if (value.type === 'ack') acks.push(value);
      });
      const connect = (iface: string, token: string) =>
        ends.client.send(
          envelope(
            'hello',
            {
              iface,
              self: { id: 'self-id', name: 'Nova' },
              root: null,
              kind: 'cli',
              owner: true,
              ownerId: OWNER,
              token,
            },
            { id: `hello:${iface}` }
          )
        );
      const pause = (iface: string) => ({
        kind: 'command.requested',
        iface,
        at: START,
        id: `command:${iface}`,
        chat: { id: 'c1', kind: 'channel' },
        name: 'pause',
        args: {},
        replyRef: 'r1',
        requester: { id: OWNER, name: 'Owner', roles: [], owner: true },
      });
      connect('hostile', 'hostile-token');
      // A link that never answers hello fails here rather than hanging the file.
      await Promise.race([
        link.hello,
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('hello never answered')), 2000)),
      ]);
      ends.client.send(envelope('event', pause('hostile'), { id: 'command:hostile' }));
      const deadline = Date.now() + 2000;
      while (!acks.some((ack) => ack.replyTo === 'command:hostile') && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 5));
      const ack = acks.find((item) => item.replyTo === 'command:hostile');
      assert.notEqual(ack?.body.status, 'ok', 'the owner-only operation was refused');
      assert.deepEqual(ran, [], 'the command never reached the door');
      assert.notEqual((store.state.data as { paused?: boolean }).paused, true, 'nothing was paused');
      link.close();
    });
  });
});

const LOOPBACK_SELF = { id: 'self-id', name: 'Νέπτυν' };
const GENERAL = { iface: 'fake', chatId: 'c1' };

async function rig(adapter: ReturnType<typeof createFakeAdapter> = createFakeAdapter()) {
  const door = createEventDoor({ handlers: {}, log: quiet });
  const { core, client } = createLoopback();
  const link = openAdapterLink({ transport: core, door, token: 'tok', log: quiet });
  const hello: Hello = {
    iface: 'fake',
    self: LOOPBACK_SELF,
    root: ROOT,
    capabilities: adapter.capabilities(),
    resume: null,
  };
  serveAdapter({ transport: client, hello, token: 'tok', adapter, log: quiet });
  await link.hello;
  return { link, fake: adapter, reads: link.adapter };
}

test('answers failed with link-closed for a read made after the link closed', async () => {
  const { link, reads } = await rig();
  link.close();
  const result = await reads.history(GENERAL, { limit: 1 });
  assert.equal(result.status, 'failed');
  assert.equal('error' in result ? result.error.code : null, 'link-closed');
});

const SERVED_TEXT = 'SERVED-EMOJI-TEXT';
const CLI_TEXT = 'CLI-EMOJI-TEXT';

/** The served interface's media pick: GIFs, custom emoji and its own line about them. */
const SERVED_PICK: MediaPickCapability = {
  gifForms: ['file', 'link'],
  emoji: { actions: ['append', 'replace'], render: { still: '<:{name}:{id}>' } },
  text: SERVED_TEXT,
};

/** What the command line declares in the scenes: it sends and types, and has no message address. */
const CLI_OPERATIONS: ReadonlyArray<string> = ['message.send', 'chat.typing'];

// An emoji and a sticker go by a stable name of the engine.
const WAVE = { id: '7', name: 'wave', platformName: 'wave', animated: false };

/** The tools the persona's grants would give on an interface that can do everything. */
const MESSAGE_TOOLS = ['message.edit', 'message.delete', 'message.react.add', 'message.react.remove'];

type Port = { capabilities: () => Capabilities };

/** Replaces what `port` declares with `change` of it. */
function declare(port: Port, change: (own: Capabilities) => Capabilities): void {
  const own = port.capabilities.bind(port);
  port.capabilities = () => change(own());
}

type Scene = {
  place: 'cli' | 'discord';
  cliPick?: MediaPickCapability | null;
  reply?: string;
};

type Seen = { request: string; tools: Array<string>; picks: number; sent: Array<unknown> };

/**
 * One reply turn in a place of `place`'s interface. The world's adapter is the place's; the other interface is a second
 * fake. The router serves the `discord` one and routes `cli`, as the core does.
 */
async function runScene({ place, cliPick = null, reply = '<msg>ναι, έλα</msg>' }: Scene): Promise<Seen> {
  useIface(place);
  freshWorld();
  const own = world().port;
  const other = createFakeAdapter({ iface: place === 'cli' ? 'discord' : 'cli', selfId: world().selfId });
  const served = place === 'discord' ? own : other;
  const cli = place === 'cli' ? own : other;
  declare(served, (caps) => ({ ...caps, mediaPick: SERVED_PICK }));
  declare(cli, (caps) => ({
    ...caps,
    operations: [...CLI_OPERATIONS],
    messageUrl: null,
    ...(cliPick ? { mediaPick: cliPick } : {}),
  }));
  const router = createIfaceRouter(
    served,
    (iface) => (iface === 'cli' ? cli : null),
    () => [cli]
  );
  const raws = [
    rawMessage({ id: 'm0', ts: NOW - 5000, content: 'καλημέρα' }),
    rawMessage({ id: 'm1', ts: NOW - 1000, content: 'θα έρθεις απόψε;' }),
  ];
  const channel = fakeTurnChannel(
    place === 'cli'
      ? { id: 'cli:dm:owner', dm: true, partnerId: 'u1', historyMessages: raws }
      : { historyMessages: raws }
  );
  const calls: Array<{ messages: Array<{ content: unknown }>; options: Record<string, unknown> }> = [];
  const hot = fakeHot(
    {},
    { access: personaGrants(MESSAGE_TOOLS) },
    {
      media: {
        maxPerTurn: 6,
        filePreviewChars: 500,
        pick: { maxOutputTokens: 17, candidates: 5, emojiCandidates: 5, emojiPerReplies: 0, emojiCooldownMinutes: 0 },
      },
      models: { routes: chainsOf({ analyzer: 'cheap/classifier' }) },
    }
  );
  Object.assign(hot.prompts, { 'classify/pick': 'Pick for {{name}}.', labels });
  const store = Object.assign(capabilitiesFakeStore(), {
    getGifs: () => null,
    getEmojiRails: () => null,
    setEmojiRails: () => {},
  });
  const emoji = {
    refresh: () => Promise.resolve(),
    byName: (name: string) => (name === WAVE.name ? WAVE : null),
    list: () => [WAVE],
    urlOf: () => null,
  };
  world().renormalize(hot.config);
  world().useClock(() => NOW);
  const options = {
    ...world().deps(),
    getSelfName: () => 'Bot',
    port: router,
    hot,
    store,
    emoji,
    llm: {
      complete: (messages: Array<{ content: unknown }>, given: Record<string, unknown>) => {
        calls.push({ messages, options: given });
        const text = given?.purpose === 'media-pick' ? '{"pick":"none","name":null}' : reply;
        return Promise.resolve({ text, usage: {}, estimated: 10 });
      },
    },
    calibrator: identityCalibrator(),
    now: () => NOW,
  };
  const turns = createRealTurnRunner(options);
  await turns.runTurn({
    chat: { iface: place, chatId: channel.id },
    mode: 'reply',
    trigger: normalizedTrigger(raws[1]),
    triggerKind: 'mention',
  } as unknown as Parameters<typeof turns.runTurn>[0]);
  const answered = calls.find((call) => call.options?.purpose !== 'media-pick');
  assert.ok(answered, 'the reply request was made');
  const tools = Array.isArray(answered.options.tools)
    ? (answered.options.tools as Array<{ function?: { name?: string } }>).map((tool) => tool.function?.name ?? '')
    : [];
  return {
    request: answered.messages.map((message) => userText(message.content) || String(message.content)).join('\n'),
    tools,
    picks: calls.filter((call) => call.options?.purpose === 'media-pick').length,
    sent: channel.sent.map((payload: { content: unknown }) => payload.content),
  };
}

test('a command line turn carries no emoji text of the served interface and runs no media pick', async () => {
  // Bug: the persona's request in the command line's chat told them about the server's custom emoji and stickers.
  const seen = await runScene({ place: 'cli' });
  assert.equal(seen.request.includes(SERVED_TEXT), false, seen.request);
  assert.equal(seen.picks, 0);
});

test("a command line turn carries the command line's own emoji text when it declares one", async () => {
  const cliPick: MediaPickCapability = {
    gifForms: [],
    emoji: { actions: ['append'], render: { still: ':{name}:' } },
    text: CLI_TEXT,
  };
  const seen = await runScene({ place: 'cli', cliPick });
  assert.ok(seen.request.includes(CLI_TEXT), seen.request);
  assert.equal(seen.request.includes(SERVED_TEXT), false);
});

test('a command line turn offers no reaction, edit or delete tool when the command line declares none', async () => {
  // Bug: the persona reacted and edited in the command line's chat, and the chat client refused every one.
  const seen = await runScene({ place: 'cli' });
  for (const name of ['message_edit', 'message_delete', 'message_react_add', 'message_react_remove'])
    assert.equal(seen.tools.includes(name), false, `${name} offered: ${seen.tools.join(', ')}`);
  assert.ok(seen.tools.includes('message_create'), 'sending stays offered');
});

test('a numbered line in a command line reply is not turned into a link of the served interface', async () => {
  // Bug: `#2` in the persona's reply became a discord.com jump link built on the command line's ids.
  const seen = await runScene({ place: 'cli', reply: '<msg>όπως είπες στο #2</msg>' });
  assert.equal(seen.sent.length, 1);
  assert.equal(String(seen.sent[0]).includes('https://'), false, String(seen.sent[0]));
});

test('a turn of the served interface keeps its emoji text, its media pick and every message tool', async () => {
  const seen = await runScene({ place: 'discord' });
  assert.ok(seen.request.includes(SERVED_TEXT), seen.request);
  assert.equal(seen.picks, 1);
  for (const name of ['message_edit', 'message_delete', 'message_react_add', 'message_react_remove'])
    assert.ok(seen.tools.includes(name), `${name} missing: ${seen.tools.join(', ')}`);
});
