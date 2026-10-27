// Tests for the serving side of the link (src/protocol/serve.ts) with an outbox (src/protocol/outbox.ts): every event
// an interface emits is numbered and kept until the core acknowledges it. The core answers `hello` with an `ack` whose
// `ackedSeq` is the principal's watermark, and the interface resends every event after it before any new one. A full
// outbox evicts nothing: the interface reports `outbox-full` and recovers the gap from the platform's history, under
// the ids live ingestion gives. The serving side also refuses to start an action past its `deadlineAt`, by an injected
// clock. The core's end is driven by hand over the loopback, so the test decides what is acknowledged and when.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLoopback, envelope } from '../src/protocol/index.js';
import { serveAdapter } from '../src/protocol/serve.ts';
import type { Hello } from '../src/protocol/serve.ts';
import { createOutbox } from '../src/protocol/outbox.ts';
import type { Capabilities } from '../src/protocol/adapter.ts';
import type { Envelope, Transport } from '../src/protocol/wire.ts';
import { createFakeAdapter } from '../src/interface/fake.js';
import { channelInfo, lineEvent } from './fixtures/core-over-fake.ts';
import { tempDir } from './fixtures/tmp.js';

type Log = {
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
};

const quiet: Log = { info() {}, warn() {}, error() {} };
const NOW = Date.parse('2026-10-27T12:00:00Z');
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
const HELLO: Hello = {
  iface: 'fake',
  self: { id: 'self-id', name: 'Nova' },
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
  const serving = serveAdapter({ transport: client, hello: HELLO, token: 'tok', adapter, log: quiet, outbox });
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

test('a full outbox reports outbox-full, and once drained recovers the gap from history under the live id', async () => {
  const adapter = createFakeAdapter({ selfId: 'self-id' });
  adapter.seedConversation(channelInfo('c1'));
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
  await until(() => rig.core.events().length === 3);
  const recovered = rig.core.events()[2];
  assert.equal(recovered?.id, lines[2]?.id, 'the recovered event has the id live ingestion gave m3');
  assert.equal(seqOf(recovered ?? envelope('event', {}, { id: 'none' })), 3);
  assert.equal(rig.serving.status().outbox, 'ok');
});

// The serving end with an injected clock and a hand-driven core end that sends actions.
function clocked(adapter = createFakeAdapter({ selfId: 'self-id' })) {
  const clock = { now: NOW };
  const { core, client } = createLoopback();
  serveAdapter({ transport: client, hello: HELLO, token: 'tok', adapter, log: quiet, now: () => clock.now });
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
          conversation: { iface: 'fake', conversationId: 'c1' },
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
    async send(conversation, content) {
      state.arrived = true;
      await gate;
      return fake.send(conversation, content);
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
