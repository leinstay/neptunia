// Tests for the serving side of the link (src/protocol/serve.ts): what an interface sends first, how it emits
// an event and reads its ack, and how it runs an action of the core on its adapter. The transport is a hand
// driven stand-in that writes every envelope through the wire codec, so a value that cannot be encoded fails
// here as it would on the socket, and that can deliver an envelope the codec would have refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ackOf, encodeEnvelope, portAction } from '../src/protocol/index.js';
import { serveAdapter } from '../src/protocol/serve.ts';
import type { Hello } from '../src/protocol/serve.ts';
import type { Capabilities } from '../src/protocol/adapter.ts';
import type { Envelope, Transport } from '../src/protocol/wire.ts';
import { createFakeAdapter } from '../src/interface/fake.js';

type Log = {
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
};
type Sent = { id: string; type: string; replyTo: string | null; body: Record<string, unknown> };

const quiet: Log = { info() {}, warn() {}, error() {} };
const CONVERSATION = { iface: 'fake', conversationId: 'c1' };
const CAPABILITIES: Capabilities = {
  operations: ['message.send', 'message.edit'],
  maxChars: 2000,
  maxFiles: 10,
  maxFileBytes: 8 * 1024 * 1024,
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
const HELLO: Hello = {
  iface: 'fake',
  self: { id: 'bot-1', name: 'Νέπτυν' },
  community: { id: 'g1', name: 'Alpha' },
  capabilities: CAPABILITIES,
  resume: null,
};

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

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// The serving end alone: `sent` is what it wrote (as the receiver would read it), `deliver` hands it an
// envelope as if the core had sent it.
function rig(adapter = createFakeAdapter()) {
  const sent: Array<Sent> = [];
  const envelopeHandlers = new Set<(envelope: Envelope) => void>();
  const closeHandlers = new Set<(reason: string) => void>();
  const state = { closed: false };
  const finish = (reason: string): void => {
    if (state.closed) return;
    state.closed = true;
    for (const handler of [...closeHandlers]) handler(reason);
  };
  const transport: Transport = {
    send(value) {
      if (state.closed) return;
      sent.push(JSON.parse(encodeEnvelope(value)) as Sent);
    },
    onEnvelope(handler) {
      envelopeHandlers.add(handler);
      return () => envelopeHandlers.delete(handler);
    },
    onClose(handler) {
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
    close() {
      finish('closed');
    },
  };
  const served = serveAdapter({ transport, hello: HELLO, token: 'tok', adapter, log: quiet });
  return {
    adapter,
    served,
    sent,
    state,
    deliver(value: unknown): void {
      for (const handler of [...envelopeHandlers]) handler(value as Envelope);
    },
    peerCloses(): void {
      finish('peer-closed');
    },
    // Runs one action and returns the body of its result.
    async run(body: unknown, id = 'a1'): Promise<Record<string, unknown>> {
      const before = sent.length;
      this.deliver({ v: 1, id, type: 'action', replyTo: null, body });
      await until(() => sent.slice(before).some((item) => item.type === 'action_result' && item.replyTo === id));
      const result = sent.slice(before).find((item) => item.type === 'action_result' && item.replyTo === id);
      return (result as Sent).body;
    },
  };
}

test('sends hello first, with the iface, the persona, the community, the capabilities, resume and the token', () => {
  const r = rig();
  assert.equal(r.sent[0]?.type, 'hello');
  assert.deepEqual(r.sent[0]?.body, {
    iface: 'fake',
    self: { id: 'bot-1', name: 'Νέπτυν' },
    community: { id: 'g1', name: 'Alpha' },
    capabilities: CAPABILITIES,
    resume: null,
    token: 'tok',
  });
  r.served.close();
});

test('emits an event as an envelope with the event id and resolves with the status of its ack', async () => {
  for (const status of ['ok', 'duplicate', 'invalid', 'unhandled', 'failed'] as const) {
    const r = rig();
    const event = reaction(`e-${status}`);
    const pending = r.served.emit(event);
    await until(() => r.sent.some((item) => item.type === 'event'));
    const sent = r.sent.find((item) => item.type === 'event') as Sent;
    assert.equal(sent.id, `e-${status}`);
    assert.deepEqual(sent.body, event);
    r.deliver(ackOf(`e-${status}`, status));
    assert.equal(await pending, status);
    r.served.close();
  }
});

test('drops raw and rawPrevious before the event is encoded', async () => {
  const r = rig();
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const pending = r.served.emit({ ...reaction('e1'), raw: cycle, rawPrevious: cycle });
  await until(() => r.sent.some((item) => item.type === 'event'));
  const body = (r.sent.find((item) => item.type === 'event') as Sent).body;
  assert.equal('raw' in body, false);
  assert.equal('rawPrevious' in body, false);
  assert.equal(body.kind, 'reaction.changed');
  r.deliver(ackOf('e1', 'ok'));
  await pending;
  r.served.close();
});

test('sends a second event before the ack of the first and resolves each by its own ack', async () => {
  const r = rig();
  const first = r.served.emit(reaction('e1'));
  const second = r.served.emit(reaction('e2'));
  await until(() => r.sent.filter((item) => item.type === 'event').length === 2);
  const resolved: Array<string> = [];
  void first.then((status) => resolved.push(`first:${status}`));
  void second.then((status) => resolved.push(`second:${status}`));
  r.deliver(ackOf('e2', 'duplicate'));
  await until(() => resolved.length === 1);
  assert.deepEqual(resolved, ['second:duplicate']);
  r.deliver(ackOf('e1', 'ok'));
  await until(() => resolved.length === 2);
  assert.deepEqual(resolved, ['second:duplicate', 'first:ok']);
  r.served.close();
});

test('resolves a pending emit as failed when the other side closes', async () => {
  const r = rig();
  const pending = r.served.emit(reaction('e1'));
  await until(() => r.sent.some((item) => item.type === 'event'));
  r.peerCloses();
  assert.equal(await pending, 'failed');
});

test('resolves an emit on a closed transport as failed without sending the event', async () => {
  const r = rig();
  r.peerCloses();
  assert.equal(await r.served.emit(reaction('e1')), 'failed');
  assert.equal(
    r.sent.some((item) => item.type === 'event'),
    false
  );
});

test('close closes the transport and fails the events still waiting for an ack', async () => {
  const r = rig();
  const pending = r.served.emit(reaction('e1'));
  await until(() => r.sent.some((item) => item.type === 'event'));
  r.served.close();
  assert.equal(await pending, 'failed');
  assert.equal(r.state.closed, true);
});

test('runs a send on the adapter and answers with the delivery and its parts, replyTo the action id', async () => {
  const r = rig();
  const long = 'a'.repeat(2500);
  const body = await r.run(portAction('send', [CONVERSATION, { text: long }]), 'send-1');
  assert.equal(body.status, 'ok');
  assert.equal((body.parts as Array<unknown>).length, 2);
  assert.equal(r.adapter.messagesIn('c1').length, 2);
  r.served.close();
});

test('runs an edit, a delete, a react, an unreact and a typing on the adapter and returns its results', async () => {
  const r = rig();
  const sent = await r.run(portAction('send', [CONVERSATION, { text: 'hi' }]), 'a-send');
  const ref = sent.ref as { iface: string; conversationId: string; messageId: string };
  const message = r.adapter.messagesIn('c1')[0] as { text: string; reactions: Set<string> };

  const edited = await r.run(portAction('edit', [ref, { text: 'changed' }]), 'a-edit');
  assert.equal(edited.status, 'ok');
  assert.equal(message.text, 'changed');

  const reacted = await r.run(portAction('react', [ref, '👍']), 'a-react');
  assert.equal(reacted.status, 'ok');
  assert.deepEqual([...message.reactions], ['👍']);

  const unreacted = await r.run(portAction('unreact', [ref, '👍']), 'a-unreact');
  assert.equal(unreacted.status, 'ok');
  assert.deepEqual([...message.reactions], []);

  const typed = await r.run(portAction('typing', [CONVERSATION]), 'a-typing');
  assert.equal(typed.status, 'ok');
  assert.deepEqual(r.adapter.typings, ['c1']);

  const deleted = await r.run(portAction('delete', [ref]), 'a-delete');
  assert.equal(deleted.status, 'ok');
  assert.equal(r.adapter.messagesIn('c1').length, 0);
  r.served.close();
});

test('runs messages.fetch on the adapter and answers the messages it found and the ids it did not', async () => {
  const r = rig();
  const sent = await r.run(portAction('send', [CONVERSATION, { text: 'findable' }]), 'a-send');
  const messageId = (sent.ref as { messageId: string }).messageId;
  const body = await r.run(
    { action: 'messages.fetch', conversation: CONVERSATION, messageIds: [messageId, 'nope'] },
    'a-fetch'
  );
  assert.equal(body.status, 'ok');
  // Each message found also carries its whole event (stage 3: a read returns events), which the fake builds from what
  // it stores; the expectation names the fields this test is about and checks the event is there.
  const items = body.messages as Array<Record<string, unknown>>;
  assert.deepEqual(
    items.map(({ event, ...rest }) => (event === undefined ? rest : { ...rest, event: 'present' })),
    [
      { messageId, text: 'findable', attachments: [], event: 'present' },
      { messageId: 'nope', missing: true },
    ]
  );
  r.served.close();
});

test('keeps the platform error out of the result so a cause that cannot be encoded never reaches the wire', async () => {
  const r = rig();
  const cause: Record<string, unknown> = {};
  cause.self = cause;
  r.adapter.failNext('react', { status: 'failed', error: { code: 'http-500', retryable: true, cause } });
  const ref = { ...CONVERSATION, messageId: 'm1' };
  const body = await r.run(portAction('react', [ref, 'x']), 'a-react');
  assert.deepEqual(body, { status: 'failed', error: { code: 'http-500', retryable: true } });
  r.served.close();
});

test('answers an action without content as failed with invalid-action and runs nothing', async () => {
  const r = rig();
  const body = await r.run({ action: 'message.send', conversation: CONVERSATION }, 'a-bad');
  assert.deepEqual(body, { status: 'failed', error: { code: 'invalid-action', retryable: false } });
  assert.deepEqual(r.adapter.calls, []);
  r.served.close();
});

test('answers an action of an unknown name as failed with invalid-action', async () => {
  const r = rig();
  const body = await r.run({ action: 'message.explode', conversation: CONVERSATION }, 'a-unknown');
  assert.deepEqual(body, { status: 'failed', error: { code: 'invalid-action', retryable: false } });
  r.served.close();
});

test('posts once when the same idempotency key arrives twice and answers the second with the first result', async () => {
  const r = rig();
  const action = { ...portAction('send', [CONVERSATION, { text: 'once' }]), idempotencyKey: 'k1' };
  const first = await r.run(action, 'a1');
  const second = await r.run(action, 'a2');
  assert.deepEqual(second, first);
  assert.equal(r.adapter.calls.filter((call) => call.op === 'send').length, 1);
  assert.equal(r.adapter.messagesIn('c1').length, 1);
  r.served.close();
});

async function sendKeys(r: ReturnType<typeof rig>, from: number, to: number): Promise<void> {
  for (let index = from; index < to; index += 1) {
    const action = { ...portAction('send', [CONVERSATION, { text: `m${index}` }]), idempotencyKey: `k${index}` };
    await r.run(action, `a${index}`);
  }
}

const sends = (r: ReturnType<typeof rig>): number => r.adapter.calls.filter((call) => call.op === 'send').length;

test('still knows the first of 1000 idempotency keys: a repeat of it is not posted again', async () => {
  const r = rig();
  await sendKeys(r, 0, 1000);
  await r.run({ ...portAction('send', [CONVERSATION, { text: 'again' }]), idempotencyKey: 'k0' }, 'repeat');
  assert.equal(sends(r), 1000);
  r.served.close();
});

test('forgets the oldest idempotency key after 1000 newer ones: a repeat of it is posted again', async () => {
  const r = rig();
  await sendKeys(r, 0, 1001);
  await r.run({ ...portAction('send', [CONVERSATION, { text: 'again' }]), idempotencyKey: 'k0' }, 'repeat');
  assert.equal(sends(r), 1002);
  r.served.close();
});
