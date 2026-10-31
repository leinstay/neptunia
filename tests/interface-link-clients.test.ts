// Tests for the core's end of the link (src/interface/link.ts) once every client has its own token: `principalOf`
// turns the token of `hello` into a principal, and the principal, never what `hello` claims, decides what the
// connection may do. An interface principal sends events of its own `iface` only and never a command; only a `cli`
// principal reaches commands. The tests also cover what the link does with the `seq` an interface numbers its events
// with (one conversation's events in order, a contiguous acknowledgement), the idempotency key a caller gives an
// effect, and an effect's cancellation. The interface end is driven by hand over the loopback where a well-behaved
// interface would never send what the test sends, and is the real serveAdapter over the fake adapter elsewhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLoopback, envelope } from '../src/protocol/index.js';
import { serveAdapter } from '../src/protocol/serve.ts';
import type { Hello } from '../src/protocol/serve.ts';
import type { Capabilities } from '../src/protocol/adapter.ts';
import type { Envelope, Transport } from '../src/protocol/wire.ts';
import type { Principal } from '../src/interface/principals.ts';
import { openAdapterLink } from '../src/interface/link.ts';
import { createEventDoor } from '../src/interface/door.js';
import { createFakeAdapter } from '../src/interface/fake.js';

type Log = {
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
};

const quiet: Log = { info() {}, warn() {}, error() {} };
const CONVERSATION = { iface: 'fake', conversationId: 'c1' };
const CAPABILITIES: Capabilities = {
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
const SELF = { id: 'bot-1', name: 'Nova' };
const HELLO: Hello = { iface: 'fake', self: SELF, community: null, capabilities: CAPABILITIES, resume: null };

const FAKE: Principal = { name: 'fake', kind: 'interface', iface: 'fake', permissions: [] };
const OWNER: Principal = { name: 'owner', kind: 'cli', iface: 'cli', permissions: [] };
const AGENT: Principal = { name: 'hand', kind: 'agent', iface: null, permissions: [] };
/** An interface principal whose `clients.json` entry still carries the permission `commands` that `/nep` needed. */
const UNIT: Principal = { name: 'unit', kind: 'interface', iface: 'fake', permissions: ['commands'] };
const TOKENS: Record<string, Principal> = {
  'fake-token': FAKE,
  'owner-token': OWNER,
  'agent-token': AGENT,
  'unit-token': UNIT,
};
const principalOf = (token: string): Principal | null => TOKENS[token] ?? null;

function reaction(id: string, conversationId = 'c1', iface = 'fake'): Record<string, unknown> {
  return {
    kind: 'reaction.changed',
    iface,
    at: 1,
    id,
    conversation: { id: conversationId, kind: 'channel' },
    messageId: 'm1',
    emoji: { name: 'x' },
    userId: 'u1',
    added: true,
  };
}

function command(id: string, iface: string): Record<string, unknown> {
  return {
    kind: 'command.requested',
    iface,
    at: 1,
    id,
    conversation: { id: 'c1', kind: 'channel' },
    name: 'pause',
    args: {},
    replyRef: 'r1',
    requester: { id: 'owner-1', name: 'Owner', roles: [], owner: true },
  };
}

async function until(check: () => boolean, ms = 2000): Promise<void> {
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
function core(held: ReadonlyArray<string> = []) {
  const started: Array<string> = [];
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
      'message.received': (event: { id: string }) => {
        started.push(event.id);
      },
    },
    log: quiet,
  });
  const { core: coreEnd, client } = createLoopback();
  const link = openAdapterLink({ transport: coreEnd, door, principalOf, log: quiet });
  const received: Array<Envelope> = [];
  const closed: Array<string> = [];
  client.onEnvelope((value) => received.push(value));
  client.onClose((reason) => closed.push(reason));
  return {
    link,
    client,
    started,
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

async function answered(rig: ReturnType<typeof core>, id: string): Promise<Record<string, unknown>> {
  await until(() => rig.ackOf(id) !== undefined);
  return rig.ackOf(id) ?? {};
}

test('an interface principal may not send an event of another iface: invalid, and the handler never runs', async () => {
  const rig = core();
  rig.hello('fake-token');
  await within(rig.link.hello);
  rig.client.send(envelope('event', reaction('e1', 'c1', 'other'), { id: 'e1' }));
  assert.equal((await answered(rig, 'e1')).status, 'invalid');
  rig.client.send(envelope('event', reaction('e2'), { id: 'e2' }));
  assert.equal((await answered(rig, 'e2')).status, 'ok', 'its own iface passes on the same link');
  assert.deepEqual(rig.started, ['e2']);
  rig.link.close();
});

test('a hello of an interface principal that names an owner and the cli kind gains no command', async () => {
  const rig = core();
  rig.hello('fake-token', { kind: 'cli', owner: true, ownerId: 'owner-1' });
  await within(rig.link.hello);
  rig.client.send(envelope('event', command('k1', 'fake'), { id: 'k1' }));
  assert.equal((await answered(rig, 'k1')).status, 'invalid');
  assert.deepEqual(rig.started, []);
  rig.link.close();
});

// PR 7b: `/nep` is gone, so no interface sends commands, whatever `clients.json` still grants it.
test('an interface principal granted commands reaches no command: invalid, and the handler never runs', async () => {
  const rig = core();
  rig.hello('unit-token');
  await within(rig.link.hello);
  rig.client.send(envelope('event', command('k1', 'fake'), { id: 'k1' }));
  assert.equal((await answered(rig, 'k1')).status, 'invalid');
  assert.deepEqual(rig.started, []);
  rig.link.close();
});

test('the cli principal reaches commands', async () => {
  const rig = core();
  rig.hello('owner-token', { iface: 'cli' });
  await within(rig.link.hello);
  rig.client.send(envelope('event', command('k1', 'cli'), { id: 'k1' }));
  assert.equal((await answered(rig, 'k1')).status, 'ok');
  assert.deepEqual(rig.started, ['k1']);
  rig.link.close();
});

test('a second hello carrying the cli token is invalid and the link keeps its first principal', async () => {
  const rig = core();
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
  const rig = core();
  rig.hello('fake-token');
  await within(rig.link.hello);
  rig.client.send(envelope('event', { ...reaction('e1'), added: 'yes' }, { id: 'e1' }));
  assert.equal((await answered(rig, 'e1')).status, 'invalid');
  rig.client.send(envelope('event', reaction('e2'), { id: 'e2' }));
  assert.equal((await answered(rig, 'e2')).status, 'ok');
  assert.deepEqual(rig.closed, []);
  rig.link.close();
});

test('the ack of an event carries the contiguous watermark: a later event done first does not pass a held one', async () => {
  const rig = core(['e2']);
  rig.hello('fake-token');
  await within(rig.link.hello);
  rig.client.send(numbered(reaction('e1', 'c1'), 1));
  rig.client.send(numbered(reaction('e2', 'c2'), 2));
  rig.client.send(numbered(reaction('e3', 'c3'), 3));
  assert.equal((await answered(rig, 'e3')).ackedSeq, 1, 'seq 2 is still being handled');
  rig.release('e2');
  assert.equal((await answered(rig, 'e2')).ackedSeq, 3);
  rig.link.close();
});

test("a conversation's next event waits for the one before it, while another conversation's event goes on", async () => {
  const rig = core(['e1']);
  rig.hello('fake-token');
  await within(rig.link.hello);
  rig.client.send(numbered(reaction('e1', 'c1'), 1));
  rig.client.send(numbered(reaction('e2', 'c1'), 2));
  rig.client.send(numbered(reaction('e3', 'c2'), 3));
  await until(() => rig.started.includes('e3'));
  assert.deepEqual(rig.started, ['e1', 'e3'], 'e2 of c1 waits behind e1');
  rig.release('e1');
  await until(() => rig.started.includes('e2'));
  assert.deepEqual(rig.started, ['e1', 'e3', 'e2']);
  rig.link.close();
});

// The link and the fake adapter served over the loopback with the interface's token.
async function pair(adapter = createFakeAdapter()) {
  const { link, client } = core();
  const served = serveAdapter({ transport: client, hello: HELLO, token: 'fake-token', adapter, log: quiet });
  await within(link.hello);
  return { link, served, fake: adapter };
}

test('a send carries the idempotency key its caller gives, and a retry under the same key posts once', async () => {
  const { link, served, fake } = await pair();
  const key = 'turn-1:0:c1';
  const first = await link.adapter.send(CONVERSATION, { text: 'once' }, { idempotencyKey: key });
  const retry = await link.adapter.send(CONVERSATION, { text: 'once' }, { idempotencyKey: key });
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
  const rig = core();
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
  const delivery = await link.adapter.send(CONVERSATION, { text: 'never' }, { signal: controller.signal });
  assert.equal(delivery.status, 'cancelled');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(actions, []);
  link.close();
});

test('an abort after the action went out sends a cancel naming it, and the result that arrives later stands', async () => {
  const { link, client, actions, cancels } = await handDriven();
  const controller = new AbortController();
  const pending = link.adapter.send(CONVERSATION, { text: 'in flight' }, { signal: controller.signal });
  await until(() => actions.length === 1);
  const [action] = actions;
  if (action === undefined) throw new Error('no action');
  controller.abort();
  await until(() => cancels.length === 1);
  assert.equal(cancels[0]?.replyTo, action.id);
  const ref = { ...CONVERSATION, messageId: 'p1' };
  const result = { status: 'ok', ref, parts: [ref], at: 5, idempotencyKey: 'k', error: null };
  client.send(envelope('action_result', result, { id: `result:${action.id}`, replyTo: action.id }));
  const delivery = await pending;
  assert.equal(delivery.status, 'ok');
  assert.equal(delivery.ref?.messageId, 'p1');
  link.close();
});

// Stage 6c: an agent principal (a development agent of the board) says hello under `agent` and sends board
// commands only: a `command.requested` whose name starts with `task.`.

/** A command of the agent namespace named `name`. */
const agentCommand = (id: string, name: string): Record<string, unknown> => ({
  ...command(id, 'agent'),
  name,
  args: {},
});

test('an agent principal reaches a task command, and its status command is refused', async () => {
  const rig = core();
  rig.hello('agent-token', { iface: 'agent' });
  await within(rig.link.hello);
  rig.client.send(envelope('event', agentCommand('k1', 'task.list'), { id: 'k1' }));
  assert.equal((await answered(rig, 'k1')).status, 'ok');
  rig.client.send(envelope('event', agentCommand('k2', 'status'), { id: 'k2' }));
  assert.equal((await answered(rig, 'k2')).status, 'invalid');
  assert.deepEqual(rig.started, ['k1']);
  rig.link.close();
});

test("an agent principal's message event is refused and never reaches the door", async () => {
  const rig = core();
  rig.hello('agent-token', { iface: 'agent' });
  await within(rig.link.hello);
  const message = {
    kind: 'message.received',
    iface: 'agent',
    at: 1,
    id: 'm1',
    conversation: { id: 'agent:hand', kind: 'dm' },
    message: {
      id: 'm1',
      author: { id: 'hand', name: 'hand', self: false, bot: false },
      content: 'hello',
      sourceText: 'hello',
      system: false,
      at: 1,
      replyToId: null,
      replyPingUserId: null,
      forwardedFrom: null,
      attachments: [],
      links: [],
      forwarded: [],
      stickers: [],
      emojis: [],
      reactions: [],
    },
    addressing: { mentioned: false, replyToSelf: false, mentionedUserIds: [], mentionedConversationIds: [] },
  };
  rig.client.send(envelope('event', message, { id: 'm1' }));
  assert.equal((await answered(rig, 'm1')).status, 'invalid');
  assert.deepEqual(rig.started, []);
  rig.link.close();
});
