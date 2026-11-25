// Tests for the serving side of the link (src/protocol/serve.ts): what an interface sends first, how it emits
// an event and reads its ack, and how it runs an action of the core on its adapter. The transport is a hand
// driven stand-in that writes every envelope through the wire codec, so a value that cannot be encoded fails
// here as it would on the socket, and that can deliver an envelope the codec would have refused.
//
// With an outbox (src/protocol/outbox.ts), every event an interface emits is numbered and kept until the core
// acknowledges it. The core answers `hello` with an `ack` whose `ackedSeq` is the principal's watermark, and the
// interface resends every event after it before any new one. A full outbox evicts nothing: the interface reports
// `outbox-full`, and the event it refused is counted and never read back from the platform. The serving side also
// refuses to start an action past its `deadlineAt`, by an injected clock. The core's end is driven by hand over
// the loopback, so the test decides what is acknowledged and when.
//
// The retry of a failed event runs end to end: the serving side over the loopback to the core's link
// (src/interface/link.ts) and its event door (src/interface/door.ts). The core answers `failed` while an event's
// observation is still being written past its deadline; its watermark stays below that event until the event is
// taken. The serving side sends a failed event again, marked `replayed`, after a delay on its injected timers, so the
// watermark moves on and the outbox drains without a reconnect.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ackOf, encodeEnvelope, envelope, portAction } from '../../../src/protocol/index.ts';
import { createLoopback } from '../../fixtures/loopback.ts';
import { serveAdapter } from '../../../src/protocol/serve.ts';
import type { Hello } from '../../../src/protocol/serve.ts';
import { createOutbox } from '../../../src/protocol/outbox.ts';
import type { Outbox } from '../../../src/protocol/outbox.ts';
import type { Capabilities, Adapter } from '../../../src/protocol/adapter.ts';
import type { Envelope, Transport } from '../../../src/protocol/wire.ts';
import { openAdapterLink } from '../../../src/interface/link.ts';
import { createEventDoor } from '../../../src/interface/door.ts';
import type { EventHandlerContext, ObservationCommit } from '../../../src/interface/door.ts';
import { createFakeAdapter } from '../../../scripts/lib/fake.ts';
import { channelInfo, lineEvent } from '../../fixtures/core-over-fake.ts';
import { tempDir } from '../../fixtures/tmp.ts';

type Log = {
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
};

type Sent = { id: string; type: string; replyTo: string | null; body: Record<string, unknown> };

const quiet: Log = { info() {}, warn() {}, error() {} };

const CHAT = { iface: 'fake', chatId: 'c1' };

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
};

const HELLO: Hello = {
  iface: 'fake',
  self: { id: 'bot-1', name: 'Νέπτυν' },
  root: { id: 'g1', name: 'Alpha' },
  capabilities: CAPABILITIES,
  resume: null,
};

function reaction(id: string): Record<string, unknown> {
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

test('sends hello first, with the iface, the persona, the root, the capabilities, resume and the token', () => {
  const r = rig();
  const [hello] = r.sent;
  assert.equal(hello?.type, 'hello');
  assert.deepEqual(hello?.body, {
    iface: 'fake',
    self: { id: 'bot-1', name: 'Νέπτυν' },
    root: { id: 'g1', name: 'Alpha' },
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
  const body = await r.run(portAction('send', [CHAT, { text: long }]), 'send-1');
  assert.equal(body.status, 'ok');
  assert.equal((body.parts as Array<unknown>).length, 2);
  assert.equal(r.adapter.messagesIn('c1').length, 2);
  r.served.close();
});

test('runs an edit, a delete, a react, an unreact and a typing on the adapter and returns its results', async () => {
  const r = rig();
  const sent = await r.run(portAction('send', [CHAT, { text: 'hi' }]), 'a-send');
  const ref = sent.ref as { iface: string; chatId: string; messageId: string };
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

  const typed = await r.run(portAction('typing', [CHAT]), 'a-typing');
  assert.equal(typed.status, 'ok');
  assert.deepEqual(r.adapter.typings, ['c1']);

  const deleted = await r.run(portAction('delete', [ref]), 'a-delete');
  assert.equal(deleted.status, 'ok');
  assert.equal(r.adapter.messagesIn('c1').length, 0);
  r.served.close();
});

test('runs messages.fetch on the adapter and answers the messages it found and the ids it did not', async () => {
  const r = rig();
  const sent = await r.run(portAction('send', [CHAT, { text: 'findable' }]), 'a-send');
  const messageId = (sent.ref as { messageId: string }).messageId;
  const body = await r.run({ action: 'messages.fetch', chat: CHAT, messageIds: [messageId, 'nope'] }, 'a-fetch');
  assert.equal(body.status, 'ok');
  // Each message found also carries its whole event (a read returns events), which the fake builds from what
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
  const ref = { ...CHAT, messageId: 'm1' };
  const body = await r.run(portAction('react', [ref, 'x']), 'a-react');
  assert.deepEqual(body, { status: 'failed', error: { code: 'http-500', retryable: true } });
  r.served.close();
});

test('answers an action without content as failed with invalid-action and runs nothing', async () => {
  const r = rig();
  const body = await r.run({ action: 'message.send', chat: CHAT }, 'a-bad');
  assert.deepEqual(body, { status: 'failed', error: { code: 'invalid-action', retryable: false } });
  assert.deepEqual(r.adapter.calls, []);
  r.served.close();
});

test('answers an action of an unknown name as failed with invalid-action', async () => {
  const r = rig();
  const body = await r.run({ action: 'message.explode', chat: CHAT }, 'a-unknown');
  assert.deepEqual(body, { status: 'failed', error: { code: 'invalid-action', retryable: false } });
  r.served.close();
});

test('posts once when the same idempotency key arrives twice and answers the second with the first result', async () => {
  const r = rig();
  const action = { ...portAction('send', [CHAT, { text: 'once' }]), idempotencyKey: 'k1' };
  const first = await r.run(action, 'a1');
  const second = await r.run(action, 'a2');
  assert.deepEqual(second, first);
  const { calls } = r.adapter;
  assert.equal(calls.filter((call) => call.op === 'send').length, 1);
  assert.equal(r.adapter.messagesIn('c1').length, 1);
  r.served.close();
});

async function sendKeys(r: ReturnType<typeof rig>, from: number, to: number): Promise<void> {
  for (let index = from; index < to; index += 1) {
    const action = { ...portAction('send', [CHAT, { text: `m${index}` }]), idempotencyKey: `k${index}` };
    await r.run(action, `a${index}`);
  }
}

const sends = (r: ReturnType<typeof rig>): number => {
  const { calls } = r.adapter;
  return calls.filter((call) => call.op === 'send').length;
};

test('still knows the first of 1000 idempotency keys: a repeat of it is not posted again', async () => {
  const r = rig();
  await sendKeys(r, 0, 1000);
  await r.run({ ...portAction('send', [CHAT, { text: 'again' }]), idempotencyKey: 'k0' }, 'repeat');
  assert.equal(sends(r), 1000);
  r.served.close();
});

test('forgets the oldest idempotency key after 1000 newer ones: a repeat of it is posted again', async () => {
  const r = rig();
  await sendKeys(r, 0, 1001);
  await r.run({ ...portAction('send', [CHAT, { text: 'again' }]), idempotencyKey: 'k0' }, 'repeat');
  assert.equal(sends(r), 1002);
  r.served.close();
});

// The serving side with an outbox, its core end driven by hand over the loopback.

const NOW = Date.parse('2026-10-27T12:00:00Z');

const OUTBOX_CAPABILITIES: Capabilities = {
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

const OUTBOX_HELLO: Hello = {
  iface: 'fake',
  self: { id: 'self-id', name: 'Nova' },
  root: { id: 'g1', name: 'Alpha' },
  capabilities: OUTBOX_CAPABILITIES,
  resume: null,
};

const seqOf = (value: Envelope): unknown => (value as Record<string, unknown>).seq;

/**
 * The core's end, by hand: it records every envelope the interface sends, and the test answers `hello` with a
 * watermark (`welcome`) and acknowledges events up to a `seq` (`ack`) when it chooses.
 */
function coreEnd(end: Transport) {
  const received: Array<Envelope> = [];
  end.onEnvelope((value) => received.push(value));
  const events = (): Array<Envelope> => received.filter((value) => value.type === 'event');
  return {
    received,
    events,
    /** The events received, as `seq:id`. */
    seen: (): Array<string> => events().map((value) => `${String(seqOf(value))}:${value.id}`),
    async welcome(ackedSeq: number): Promise<void> {
      await until(() => received.some((value) => value.type === 'hello'));
      const hello = received.find((value) => value.type === 'hello');
      end.send(envelope('ack', { status: 'ok', ackedSeq }, { id: 'ack:hello', replyTo: hello?.id ?? 'hello' }));
    },
    ack(id: string, ackedSeq: number): void {
      end.send(envelope('ack', { status: 'ok', ackedSeq }, { id: `ack:${id}`, replyTo: id }));
    },
    close: (): void => end.close(),
  };
}

function served(outbox: ReturnType<typeof createOutbox>, adapter = createFakeAdapter({ selfId: 'self-id' })) {
  const { core, client } = createLoopback();
  const serving = serveAdapter({ transport: client, hello: OUTBOX_HELLO, token: 'tok', adapter, log: quiet, outbox });
  return { serving, core: coreEnd(core), adapter };
}

test('after a dropped connection the interface resends, in order, only the events after the watermark of hello', async () => {
  const dir = tempDir('nep-serve-');
  const first = served(createOutbox({ dir, capacity: 10 }));
  await first.core.welcome(0);
  for (const id of ['e1', 'e2', 'e3']) void first.serving.emit(reaction(id));
  await until(() => first.core.events().length === 3);
  first.core.ack('e1', 1);
  await new Promise((resolve) => setImmediate(resolve));
  first.core.close();

  // The interface comes back with the outbox of its data folder; the core has e1 and says so in its answer to hello.
  const second = served(createOutbox({ dir, capacity: 10 }));
  await second.core.welcome(1);
  await until(() => second.core.events().length === 2);
  assert.deepEqual(second.core.seen(), ['2:e2', '3:e3']);
});

test('an event emitted before the answer to hello waits behind the replay of the outbox', async () => {
  const outbox = createOutbox({ dir: tempDir('nep-serve-'), capacity: 10 });
  outbox.push(reaction('e1'));
  outbox.push(reaction('e2'));
  const rig = served(outbox);
  void rig.serving.emit(reaction('e3'));
  await new Promise((resolve) => setImmediate(resolve));
  await rig.core.welcome(0);
  await until(() => rig.core.events().length === 3);
  assert.deepEqual(rig.core.seen(), ['1:e1', '2:e2', '3:e3']);
});

test('an emit resolves with the status of the ack of its own event', async () => {
  const rig = served(createOutbox({ dir: tempDir('nep-serve-'), capacity: 10 }));
  await rig.core.welcome(0);
  const status = rig.serving.emit(reaction('e1'));
  await until(() => rig.core.events().length === 1);
  rig.core.ack('e1', 1);
  assert.equal(await status, 'ok');
});

test('a full outbox refuses an event and reads nothing back from the platform once it drains', async () => {
  // Bug: a missed stretch is fetched and replayed on its own. The engine does no catch-up and recovers no gap from
  // history, so the refused event stays lost and is only counted.
  const adapter = createFakeAdapter({ selfId: 'self-id' });
  adapter.seedChat(channelInfo('c1'));
  const lines = [1000, 2000, 3000].map((at, index) =>
    lineEvent({ id: `m${index + 1}`, text: `line ${index + 1}`, at })
  );
  for (const line of lines) adapter.seedEvent(line);
  const rig = served(createOutbox({ dir: tempDir('nep-serve-'), capacity: 2 }), adapter);
  await rig.core.welcome(0);
  for (const line of lines) void rig.serving.emit(line);
  await until(() => rig.core.events().length === 2);
  assert.equal(rig.serving.status().outbox, 'outbox-full');

  rig.core.ack('fake:message:m2', 2);
  await until(() => rig.serving.status().outbox === 'ok');
  assert.equal(rig.core.events().length, 2);
  assert.equal(adapter.calls.filter((call) => call.op === 'history').length, 0);
});

// The serving end with an injected clock and a hand-driven core end that sends actions.
function clocked(adapter = createFakeAdapter({ selfId: 'self-id' })) {
  const clock = { now: NOW };
  const { core, client } = createLoopback();
  serveAdapter({ transport: client, hello: OUTBOX_HELLO, token: 'tok', adapter, log: quiet, now: () => clock.now });
  const results: Array<Envelope> = [];
  core.onEnvelope((value) => {
    if (value.type === 'action_result') results.push(value);
  });
  const send = (id: string, deadlineAt: number): void =>
    core.send(
      envelope(
        'action',
        {
          action: 'message.send',
          chat: { iface: 'fake', chatId: 'c1' },
          content: { text: 'hi' },
          idempotencyKey: `k-${id}`,
          deadlineAt,
        },
        { id }
      )
    );
  const resultOf = async (id: string): Promise<Record<string, unknown>> => {
    await until(() => results.some((value) => value.replyTo === id));
    return results.find((value) => value.replyTo === id)?.body as Record<string, unknown>;
  };
  return { clock, adapter, send, resultOf };
}

test('an action past its deadline is refused with deadline-passed and never reaches the adapter', async () => {
  const rig = clocked();
  rig.send('a1', NOW - 1);
  const result = await rig.resultOf('a1');
  assert.equal(result.status, 'failed');
  assert.equal((result.error as { code?: string } | undefined)?.code, 'deadline-passed');
  assert.deepEqual(rig.adapter.messagesIn('c1'), []);
});

test('an action that started before its deadline keeps its result when it ends after it', async () => {
  const fake = createFakeAdapter({ selfId: 'self-id' });
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const state = { arrived: false };
  const adapter: typeof fake = {
    ...fake,
    async send(chat, content) {
      state.arrived = true;
      await gate;
      return fake.send(chat, content);
    },
  };
  const rig = clocked(adapter);
  rig.send('a1', NOW + 100);
  await until(() => state.arrived);
  rig.clock.now = NOW + 500;
  release();
  assert.equal((await rig.resultOf('a1')).status, 'ok');
  assert.equal(fake.messagesIn('c1').length, 1);
});

// The retry of a failed event, end to end over the loopback to the core's link and its event door.

async function untilWithin(check: () => boolean, ms = 500): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return true;
}

const settle = (): Promise<boolean> => untilWithin(() => false, 30);

/** Timers the test fires by hand: `fire` runs every timer set and not cleared so far. */
function handTimers() {
  type Timer = { fn: () => void; cleared: boolean };
  const queued: Array<Timer> = [];
  return {
    set(fn: () => void): unknown {
      const timer: Timer = { fn, cleared: false };
      queued.push(timer);
      return timer;
    },
    clear(timer: unknown): void {
      const found = queued.find((one) => one === timer);
      if (found !== undefined) found.cleared = true;
    },
    waiting: (): number => queued.filter((one) => !one.cleared).length,
    fire(): void {
      for (const timer of queued.splice(0)) if (!timer.cleared) timer.fn();
    },
  };
}

/**
 * The observation write of one event: the first write of `slowId` waits for `release` and then lands or fails by
 * `lateOutcome`; every other write lands at once. `stored` lists what landed, `replayed` what came marked so.
 */
function retryRig(options: { capacity: number; lateOutcome?: 'lands' | 'fails'; handledKind?: string }) {
  const stored: Array<string> = [];
  const replayed: Array<string> = [];
  const state = { slowWrites: 0, slowArrivals: 0 };
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const write = async (id: string): Promise<ObservationCommit> => {
    if (id === 'slow' && state.slowWrites++ === 0) {
      await gate;
      if (options.lateOutcome === 'fails') return { ok: false, code: 'DB_BUSY' };
    }
    stored.push(id);
    return { ok: true, sourceId: `src-${id}` };
  };
  const door = createEventDoor({
    handlers: {
      // The observe path: the write is claimed and awaited up to its deadline, which the slow one misses.
      [options.handledKind ?? 'reaction.changed']: (
        event: { id: string; replayed?: boolean },
        context: EventHandlerContext
      ) => {
        if (event.replayed === true) replayed.push(event.id);
        const missesDeadline = event.id === 'slow' && state.slowArrivals++ === 0;
        const pending = context.receipt?.observe(() => write(event.id));
        return missesDeadline ? undefined : pending;
      },
    },
    log: quiet,
  });
  const { core, client } = createLoopback();
  openAdapterLink({ transport: core, door, token: 'tok', log: quiet });
  const timers = handTimers();
  const outbox: Outbox = createOutbox({ dir: tempDir('nep-serve-retry-'), capacity: options.capacity });
  const serving = serveAdapter({
    transport: client,
    hello: OUTBOX_HELLO,
    token: 'tok',
    adapter: createFakeAdapter({ selfId: 'self-id' }),
    log: quiet,
    outbox,
    timers,
  });
  const pendingIds = (): Array<unknown> => outbox.pending().map((entry) => entry.event.id);
  return { serving, outbox, timers, stored, replayed, release: () => release(), pendingIds };
}

test('a slow observation past its deadline does not hold the watermark back once its write lands', async () => {
  const run = retryRig({ capacity: 4 });
  assert.equal(await run.serving.emit(reaction('slow')), 'failed');
  run.release();
  for (const id of ['e2', 'e3']) assert.equal(await run.serving.emit(reaction(id)), 'ok');
  run.timers.fire();
  await untilWithin(() => run.outbox.pending().length === 0);
  assert.deepEqual(run.pendingIds(), []);
  // The outbox has room for every later event: none is lost to a full outbox.
  for (const id of ['e4', 'e5', 'e6', 'e7', 'e8']) assert.equal(await run.serving.emit(reaction(id)), 'ok');
  assert.equal(run.serving.status().outbox, 'ok');
  assert.deepEqual(run.stored, ['slow', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8']);
});

test('a late write that fails is run again from the outbox and stored, marked replayed', async () => {
  const run = retryRig({ capacity: 4, lateOutcome: 'fails' });
  assert.equal(await run.serving.emit(reaction('slow')), 'failed');
  run.release();
  assert.equal(await run.serving.emit(reaction('e2')), 'ok');
  await settle();
  run.timers.fire();
  await untilWithin(() => run.outbox.pending().length === 0);
  assert.deepEqual(run.pendingIds(), []);
  assert.deepEqual(run.stored, ['e2', 'slow']);
  assert.deepEqual(run.replayed, ['slow']);
});

test('an event still being written when its retry comes is tried again later', async () => {
  const run = retryRig({ capacity: 4 });
  assert.equal(await run.serving.emit(reaction('slow')), 'failed');
  run.timers.fire();
  await settle();
  assert.deepEqual(run.pendingIds(), ['slow']);
  assert.equal(run.timers.waiting(), 1);
  run.release();
  await settle();
  run.timers.fire();
  await untilWithin(() => run.outbox.pending().length === 0);
  assert.deepEqual(run.pendingIds(), []);
});

test('an event the core takes without a handler is never sent again', async () => {
  const run = retryRig({ capacity: 4, handledKind: 'presence.changed' });
  assert.equal(await run.serving.emit(reaction('e1')), 'unhandled');
  await settle();
  assert.equal(run.timers.waiting(), 0);
  assert.deepEqual(run.pendingIds(), []);
});

test('closing the link stops the retry of a failed event', async () => {
  const run = retryRig({ capacity: 4 });
  assert.equal(await run.serving.emit(reaction('slow')), 'failed');
  assert.equal(run.timers.waiting(), 1);
  run.serving.close();
  assert.equal(run.timers.waiting(), 0);
});

// The chat reads of the adapter contract (src/protocol/adapter.ts), each one round-tripped over the link: the
// fake adapter served by serveAdapter on one end of the loopback, the core's link (src/interface/link.ts) on the other.
// A read answers `{ status: 'ok', ...body }` or a status and an error, never a throw. The fake keeps what a test seeds
// (`seedChat`, `seedGroups`, `seedMember`, `seedEmoji`, `seedEvent`, `seedReactors`) and records each read in
// `calls` under its method name.

type ReadsLoopbackLog = {
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
};

const readsLoopbackQuiet: ReadsLoopbackLog = { info() {}, warn() {}, error() {} };
const SELF = { id: 'self-id', name: 'Νέπτυν' };
const ROOT = { id: 'g1', name: 'Alpha' };
const GENERAL = { iface: 'fake', chatId: 'c1' };

async function readsLoopbackRig(adapter: ReturnType<typeof createFakeAdapter> = createFakeAdapter()) {
  const door = createEventDoor({ handlers: {}, log: readsLoopbackQuiet });
  const { core, client } = createLoopback();
  const link = openAdapterLink({ transport: core, door, token: 'tok', log: readsLoopbackQuiet });
  const hello: Hello = {
    iface: 'fake',
    self: SELF,
    root: ROOT,
    capabilities: adapter.capabilities(),
    resume: null,
  };
  serveAdapter({ transport: client, hello, token: 'tok', adapter, log: readsLoopbackQuiet });
  await link.hello;
  return { link, fake: adapter, reads: link.adapter };
}

test('answers failed with adapter-threw when the adapter throws in a read', async () => {
  const base = createFakeAdapter();
  const throwing: Adapter = {
    ...base,
    history: (): Promise<never> => {
      throw new Error('boom');
    },
  };
  const { reads } = await readsLoopbackRig(throwing as ReturnType<typeof createFakeAdapter>);
  const result = await reads.history(GENERAL, { limit: 1 });
  assert.equal(result.status, 'failed');
  assert.equal('error' in result ? result.error.code : null, 'adapter-threw');
});
