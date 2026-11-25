// Tests for src/interface/door.ts: the one event door -- validation at the boundary, idempotent
// ids (at-least-once delivery), failed handlers retried by redelivery, derived ids of the core's
// own events, the bounded memory of ids, and the envelope form answered by acks.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { createEventDoor, eventIdOf } from '../../../src/interface/door.ts';
import type { EventHandlerContext, From, IngestRow, ObservationCommit } from '../../../src/interface/door.ts';
import type { AuthenticatedSender } from '../../../src/interface/principals.ts';
import { envelope } from '../../../src/protocol/index.ts';
import type { ReactionChanged } from '../../../src/protocol/events.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { wrongly, present } from '../../fixtures/loose-types.ts';
import { createFakeAdapter } from '../../../scripts/lib/fake.ts';
import { heartbeatWake } from '../../../src/behavior/inner.ts';
import { skillRegistry } from '../../../src/tools/registry.ts';
import { createTurnRunner, fakeStore, hotWith, sequenceLlm } from '../../fixtures/turn-harness.ts';
import { GUILD, MINUTE, START, innerRig, newHistory, replyTo } from '../../fixtures/boundary.ts';
import type { createStore } from '../../../src/memory/store.ts';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKeyStore } from '../../../src/keys/store.ts';
import { startCore } from '../../../src/core.ts';
import { start } from '../../../scripts/lib/fake-interface.ts';
import { channelInfo, deliver } from '../../fixtures/core-over-fake.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { chainsOf } from '../../fixtures/chains.ts';

const quiet = () => {
  const lines: Array<Untyped> = [];
  return {
    lines,
    info: (...a: Array<Untyped>) => lines.push(['info', ...a]),
    warn: (...a: Array<Untyped>) => lines.push(['warn', ...a]),
  };
};

const reaction = (id = 'fake:reaction:1') => ({
  kind: 'reaction.changed',
  iface: 'fake',
  at: 1,
  id,
  chat: { id: 'c1', kind: 'channel' },
  messageId: 'm1',
  emoji: { name: '\u{1F389}' },
  accountId: 'u1',
  added: true,
});

test('door: an event reaches the handler of its kind once; the same id again is a duplicate', async () => {
  const got: Array<Untyped> = [];
  const door = createEventDoor({
    handlers: {
      'reaction.changed': (event: ReactionChanged) => {
        got.push(event.id);
        return 'done';
      },
    },
    log: quiet(),
  });
  assert.deepEqual(await door.submit(reaction()), { status: 'ok', id: 'fake:reaction:1', result: 'done' });
  assert.deepEqual(await door.submit(reaction()), { status: 'duplicate', id: 'fake:reaction:1' });
  assert.deepEqual(await door.submit(reaction('fake:reaction:2')), {
    status: 'ok',
    id: 'fake:reaction:2',
    result: 'done',
  });
  assert.deepEqual(got, ['fake:reaction:1', 'fake:reaction:2']);
});

test('door: a malformed event is invalid, logged by kind and reason only, and never handled', async () => {
  const log = quiet();
  let called = 0;
  const door = createEventDoor({
    handlers: {
      'reaction.changed': () => {
        called += 1;
      },
    },
    log,
  });
  const bad = { ...reaction(), accountId: 7, secret: 'private words' };
  assert.deepEqual(await door.submit(bad), { status: 'invalid', id: null, reason: 'accountId:type' });
  assert.deepEqual(await door.submit(wrongly(null)), { status: 'invalid', id: null, reason: 'event:type' });
  assert.equal(called, 0);
  assert.deepEqual(log.lines[0], [
    'warn',
    'interface: invalid event',
    { kind: 'reaction.changed', reason: 'accountId:type' },
  ]);
  assert.equal(JSON.stringify(log.lines).includes('private words'), false);
});

// A token whose id the message's emojis do not hold must not stop a read of history.
test('door: a message whose forwarded part holds a token its emojis do not list is invalid and never handled', async () => {
  let called = 0;
  const door = createEventDoor({
    handlers: {
      'message.received': () => {
        called += 1;
      },
    },
    log: quiet(),
  });
  const part = { content: 'look <emoji:888>', attachments: [], links: [], stickers: [], emojis: [] };
  const event = {
    kind: 'message.received',
    iface: 'fake',
    at: 1,
    id: 'fake:message:m1',
    chat: { id: 'c1', kind: 'channel' },
    message: {
      id: 'm1',
      author: { id: 'u1', name: 'Ann', self: false, bot: false },
      content: 'fwd',
      at: 1,
      replyToId: null,
      replyPingAccountId: null,
      forwardedFrom: null,
      attachments: [],
      links: [],
      forwarded: [part],
      stickers: [],
      emojis: [],
      reactions: [],
    },
    addressing: { mentioned: false, replyToSelf: false, mentionedAccountIds: [], mentionedChatIds: [] },
  };
  assert.deepEqual(await door.submit(event), { status: 'invalid', id: null, reason: 'message.content:emoji' });
  assert.equal(called, 0);
});

test('door: a kind without a handler is unhandled and not remembered', async () => {
  const door = createEventDoor({ handlers: {}, log: quiet() });
  assert.deepEqual(await door.submit(reaction()), { status: 'unhandled', id: 'fake:reaction:1' });
  assert.equal(door.seen('fake:reaction:1'), false);
});

test('door: a handler that throws is failed and not remembered, so a redelivery runs it again', async () => {
  let calls = 0;
  const door = createEventDoor({
    handlers: {
      'reaction.changed': () => {
        calls += 1;
        if (calls === 1) throw new Error('boom');
        return calls;
      },
    },
    log: quiet(),
  });
  assert.deepEqual(await door.submit(reaction()), { status: 'failed', id: 'fake:reaction:1', reason: 'handler-threw' });
  assert.deepEqual(await door.submit(reaction()), { status: 'ok', id: 'fake:reaction:1', result: 2 });
  assert.equal((await door.submit(reaction())).status, 'duplicate');
});

test('door: the same id while its handler still runs is a duplicate', async () => {
  let release: ((value?: unknown) => void) | undefined;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const door = createEventDoor({
    handlers: {
      'reaction.changed': async () => {
        calls += 1;
        await gate;
      },
    },
    log: quiet(),
  });
  const first = door.submit(reaction());
  assert.equal((await door.submit(reaction())).status, 'duplicate');
  present(release)();
  assert.equal((await first).status, 'ok');
  assert.equal(calls, 1);
});

test("door: the core's own events get derived ids: an errand end by task and status, a tick by time", async () => {
  const seen: Array<Untyped> = [];
  const door = createEventDoor({
    handlers: {
      'errand.done': (e: { errandId: string }) => seen.push(e.errandId),
      'scheduler.tick': () => seen.push('tick'),
    },
    log: quiet(),
  });
  const done = { kind: 'errand.done', at: 5, errandId: 't1', status: 'done', rootId: 'g1' };
  assert.equal(eventIdOf(done), 'errand.done:t1:done');
  assert.equal((await door.submit(done)).status, 'ok');
  assert.equal((await door.submit({ ...done, at: 9 })).status, 'duplicate', 'the same end delivered twice');
  assert.equal((await door.submit({ ...done, status: 'failed' })).status, 'ok', 'another end of the same task');
  assert.equal(eventIdOf({ kind: 'scheduler.tick', at: 7 }), 'scheduler.tick:7');
  assert.equal((await door.submit({ kind: 'scheduler.tick', at: 7 })).status, 'ok');
  assert.equal(eventIdOf({ kind: 'reaction.changed' }), null);
  assert.deepEqual(seen, ['t1', 't1', 'tick']);
});

test('door: only the newest `capacity` ids are remembered', async () => {
  const door = createEventDoor({ handlers: { 'reaction.changed': () => {} }, capacity: 2, log: quiet() });
  for (const id of ['a', 'b', 'c']) await door.submit(reaction(id));
  assert.equal(door.seen('a'), false);
  assert.equal(door.seen('b'), true);
  assert.equal(door.seen('c'), true);
  assert.equal((await door.submit(reaction('a'))).status, 'ok', 'an id past the memory is handled again');
});

test('door: envelopes -- hello and ping are acked, an event envelope is acked by its outcome, the rest is invalid', async () => {
  const door = createEventDoor({ handlers: { 'reaction.changed': () => {} }, log: quiet() });
  const ack = (replyTo: Untyped, status: Untyped, reason?: Untyped) => ({
    v: 1,
    id: `ack:${replyTo}`,
    type: 'ack',
    replyTo,
    body: reason ? { status, reason } : { status },
  });
  assert.deepEqual(
    await door.receive(
      envelope('hello', { iface: 'fake', self: { id: 'bot-1', name: 'Bot' }, root: null }, { id: 'h1' })
    ),
    ack('h1', 'ok')
  );
  assert.deepEqual(await door.receive(envelope('ping', {}, { id: 'p1' })), ack('p1', 'ok'));
  const event = reaction();
  assert.deepEqual(await door.receive(envelope('event', event, { id: event.id })), ack(event.id, 'ok'));
  assert.deepEqual(await door.receive(envelope('event', event, { id: event.id })), ack(event.id, 'duplicate'));
  assert.deepEqual(
    await door.receive(
      envelope('action', { action: 'chat.typing', chat: { iface: 'fake', chatId: 'c1' } }, { id: 'x1' })
    ),
    ack('x1', 'invalid', 'type:not-inbound')
  );
  assert.deepEqual(
    await door.receive(envelope('event', { ...event, accountId: '' }, { id: 'e2' })),
    ack('e2', 'invalid', 'body.accountId:type')
  );
  assert.deepEqual(await door.receive(wrongly({ id: 'z', type: 'nope' })), ack('z', 'invalid', 'v:unsupported'));
  assert.deepEqual(await door.receive(wrongly(null)), ack('unknown', 'invalid', 'envelope:type'));
});

test('door: two removals of the same emoji at different times both pass; the same instant is a duplicate', async () => {
  const { reactionEvent, reactionClearAllEvent, reactionClearEmojiEvent } =
    await import('../../../interfaces/discord/index.ts');
  const message = { id: 'm1', channelId: 'c1', guildId: 'g1', partial: false, author: { id: 'a1' } };
  const react = { message, emoji: { name: '\u{1F389}' } };
  const user = { id: 'u1' };
  const got: Array<Untyped> = [];
  const door = createEventDoor({
    handlers: {
      'reaction.changed': (event: ReactionChanged) => {
        got.push(event.cleared ?? (event.added ? 'add' : 'remove'));
      },
    },
    log: quiet(),
  });
  const builds = [
    (at: number) => reactionEvent(react, user, false, { now: () => at }),
    (at: number) => reactionClearAllEvent(message, { now: () => at }),
    (at: number) => reactionClearEmojiEvent(react, { now: () => at }),
  ];
  for (const build of builds) {
    assert.equal((await door.submit(build(1000))).status, 'ok');
    assert.equal((await door.submit(build(2000))).status, 'ok');
    assert.equal((await door.submit(build(2000))).status, 'duplicate');
  }
  assert.deepEqual(got, ['remove', 'remove', 'all', 'all', 'emoji', 'emoji']);
});

test('direct submissions without authenticated metadata remain ordinary even with an owner principal name', async () => {
  // Catches promoting an internal submission or an ingestion principal name into authenticated provenance.
  const contexts: Array<EventHandlerContext> = [];
  const committed: Array<IngestRow> = [];
  const door = createEventDoor({
    handlers: { 'reaction.changed': (_event: ReactionChanged, context: EventHandlerContext) => contexts.push(context) },
    ingest: {
      seen: () => false,
      commit: (row) => {
        committed.push(row);
        return Promise.resolve();
      },
    },
    log: quiet(),
  });
  assert.equal((await door.submit(reaction('direct'))).status, 'ok');
  assert.equal((await door.submit(reaction('named'), { principal: 'owner', seq: 4 })).status, 'ok');
  // The additive receipt carries observation state beside the unchanged provenance fields.
  assert.deepEqual(
    contexts.map(({ ingest, authenticated }) => ({ ingest, authenticated })),
    [
      { ingest: null, authenticated: null },
      {
        ingest: { principal: 'owner', seq: 4, eventId: 'named', kind: 'reaction.changed', chat: 'c1' },
        authenticated: null,
      },
    ]
  );
  assert.deepEqual(
    contexts.map(({ receipt }) => receipt?.eventId),
    ['direct', 'named']
  );
  assert.deepEqual(
    contexts.map(({ receipt }) => receipt?.row),
    contexts.map(({ ingest }) => ingest)
  );
  assert.deepEqual(committed, [{ principal: 'owner', seq: 4, eventId: 'named', kind: 'reaction.changed', chat: 'c1' }]);
});

for (const entry of ['receive', 'submit'] as const) {
  test(`${entry} preserves trusted sender metadata beside the original ingestion row`, async () => {
    // Catches sender metadata dropped by envelope reconstruction or handler dispatch.
    const contexts: Array<EventHandlerContext> = [];
    const committed: Array<IngestRow> = [];
    const authenticated: AuthenticatedSender = { name: 'verified-owner', kind: 'cli' };
    const from: From = { principal: authenticated.name, seq: 7, authenticated };
    const door = createEventDoor({
      handlers: {
        'reaction.changed': (_event: ReactionChanged, context: EventHandlerContext) => contexts.push(context),
      },
      ingest: {
        seen: () => false,
        commit: (row) => {
          committed.push(row);
          return Promise.resolve();
        },
      },
      log: quiet(),
    });
    const event = reaction(`trusted-${entry}`);
    if (entry === 'receive') {
      const input = Object.assign(envelope('event', event, { id: event.id }), { seq: 7 });
      assert.deepEqual(await door.receive(input, from), {
        v: 1,
        id: `ack:${event.id}`,
        type: 'ack',
        replyTo: event.id,
        body: { status: 'ok' },
      });
    } else assert.equal((await door.submit(event, from)).status, 'ok');
    const ingest = {
      principal: authenticated.name,
      seq: 7,
      eventId: event.id,
      kind: 'reaction.changed',
      chat: 'c1',
    };
    // The receipt is additive. Authentication and ingestion retain their exact prior values.
    assert.deepEqual(
      contexts.map(({ ingest, authenticated }) => ({ ingest, authenticated })),
      [{ ingest, authenticated }]
    );
    assert.deepEqual(
      contexts.map(({ receipt }) => [receipt?.eventId, receipt?.row]),
      [[event.id, ingest]]
    );
    assert.deepEqual(committed, [ingest]);
  });
}

test('a mismatched authenticated sender is invalid before handling or committing ingestion', async () => {
  // Catches an inconsistent trusted carrier entering the core under a different ingestion identity.
  let calls = 0;
  const committed: Array<IngestRow> = [];
  const door = createEventDoor({
    handlers: {
      'reaction.changed': () => {
        calls += 1;
      },
    },
    ingest: {
      seen: () => false,
      commit: (row) => {
        committed.push(row);
        return Promise.resolve();
      },
    },
    log: quiet(),
  });
  const from: From = { principal: 'ordinary', authenticated: { name: 'owner', kind: 'cli' } };
  const result = await door.submit(reaction('mismatched'), from);
  assert.equal(result.status, 'invalid');
  assert.equal(result.reason, 'sender:mismatch');
  assert.equal(calls, 0);
  assert.deepEqual(committed, []);
  assert.equal(door.seen('mismatched'), false);
});

// Accepted events own their observation and acknowledgement independently of message identity.

const receiptsQuiet = { info() {}, warn() {} };
const event = (id: string, room = 'room-a') => ({
  kind: 'reaction.changed',
  iface: 'synthetic',
  at: 1,
  id,
  chat: { id: room, kind: 'channel' },
  messageId: 'same-message',
  emoji: { name: 'x' },
  accountId: 'member',
  added: true,
});

function fixture(handler: (context: EventHandlerContext) => unknown) {
  const standalone: Array<IngestRow> = [];
  const committed = new Set<string>();
  const door = createEventDoor({
    log: receiptsQuiet,
    handlers: { 'reaction.changed': (_event, context) => handler(context) },
    ingest: {
      seen: (principal, id) => committed.has(`${principal}:${id}`),
      commit: (row) => {
        standalone.push(row);
        committed.add(`${row.principal}:${row.eventId}`);
        return Promise.resolve();
      },
    },
  });
  return { door, standalone, committed };
}

function deferred<T>() {
  return Promise.withResolvers<T>();
}
test('an unused receipt still commits an ignored event once', async () => {
  const env = fixture(() => undefined);
  assert.equal((await env.door.submit(event('ignored'), { principal: 'adapter', seq: 1 })).status, 'ok');
  assert.deepEqual(
    env.standalone.map((row) => [row.principal, row.eventId, row.seq]),
    [['adapter', 'ignored', 1]]
  );
});

test('a successful atomic observation is acknowledged without a standalone receipt write', async () => {
  const captured: Array<Readonly<IngestRow> | null> = [];
  const env = fixture(async ({ receipt }) => {
    await receipt?.observe((row) => {
      captured.push(row);
      return Promise.resolve({ ok: true, sourceId: 'source-a', revision: 1 });
    });
  });
  assert.equal((await env.door.submit(event('first'), { principal: 'adapter', seq: 1 })).status, 'ok');
  assert.deepEqual(env.standalone, []);
  assert.deepEqual(
    captured.map((row) => [row?.principal, row?.eventId, row?.chat]),
    [['adapter', 'first', 'room-a']]
  );
});

for (const failure of ['refused', 'threw'] as const) {
  test(`a ${failure} claimed observation leaves the event unacknowledged and retryable`, async () => {
    const env = fixture(async ({ receipt }) => {
      try {
        await receipt?.observe(() => {
          if (failure === 'threw') return Promise.reject(new Error('writer failed'));
          return Promise.resolve({ ok: false, code: 'BAD_PLACE' });
        });
      } catch {
        /* The pipeline may consume writer errors before returning. */
      }
    });
    assert.equal((await env.door.submit(event('retry'), { principal: 'adapter', seq: 1 })).status, 'failed');
    assert.deepEqual(env.standalone, []);
    assert.equal((await env.door.submit(event('retry'), { principal: 'adapter', seq: 1 })).status, 'failed');
  });
}

test('a claimed write still pending after handler timeout is not acknowledged by a standalone commit', async () => {
  const pending = deferred<ObservationCommit>();
  const env = fixture(({ receipt }) => {
    void receipt?.observe(() => pending.promise);
  });
  const result = await env.door.submit(event('slow'), { principal: 'adapter', seq: 1 });
  assert.equal(result.status, 'failed');
  assert.deepEqual(env.standalone, []);
  pending.resolve({ ok: true, sourceId: 'late-source', revision: 1 });
  await pending.promise;
});

test('one accepted event cannot replace its first observation with a second claim', async () => {
  let secondWrites = 0;
  let second: ObservationCommit | undefined;
  const env = fixture(async ({ receipt }) => {
    await receipt?.observe(() => Promise.resolve({ ok: true, sourceId: 'original-source', revision: 1 }));
    second = await receipt?.observe(() => {
      secondWrites += 1;
      return Promise.resolve({ ok: true, sourceId: 'replacement-source' });
    });
  });
  await env.door.submit(event('claim'), { principal: 'adapter', seq: 1 });
  assert.equal(second?.ok, false);
  assert.equal(secondWrites, 0);
  assert.deepEqual(env.standalone, []);
});

test('reversed completion of events sharing a message ID keeps each transport receipt', async () => {
  const first = deferred<void>();
  const entered = deferred<void>();
  const captured: Array<Array<unknown>> = [];
  const env = fixture(async ({ receipt }) => {
    await receipt?.observe(async (row) => {
      if (row?.eventId === 'first') {
        entered.resolve();
        await first.promise;
      }
      captured.push([row?.principal, row?.eventId, row?.seq, row?.chat]);
      return { ok: true, sourceId: `source-${row?.eventId}` };
    });
  });
  const a = env.door.submit(event('first', 'room-a'), { principal: 'adapter-a', seq: 1 });
  // Without a carrier the first handler returns immediately, which must still fail the result assertions.
  await Promise.race([entered.promise, a]);
  const b = await env.door.submit(event('second', 'room-b'), { principal: 'adapter-b', seq: 7 });
  first.resolve();
  assert.equal((await a).status, 'ok');
  assert.equal(b.status, 'ok');
  assert.deepEqual(captured, [
    ['adapter-b', 'second', 7, 'room-b'],
    ['adapter-a', 'first', 1, 'room-a'],
  ]);
  assert.deepEqual(env.standalone, []);
});

test('wire receipt fields cannot replace the accepted event identity', async () => {
  const captured: Array<Readonly<IngestRow> | null> = [];
  const env = fixture(async ({ receipt }) => {
    await receipt?.observe((row) => {
      captured.push(row);
      return Promise.resolve({ ok: true, sourceId: 'source-a' });
    });
  });
  await env.door.submit(
    { ...event('real'), receipt: { eventId: 'forged' }, ingest: { principal: 'cli', eventId: 'forged' } },
    { principal: 'adapter', seq: 4 }
  );
  assert.deepEqual(
    captured.map((row) => [row?.principal, row?.eventId, row?.seq]),
    [['adapter', 'real', 4]]
  );
  assert.deepEqual(env.standalone, []);
});

test('a committed observation remains durable when later handler work throws', async () => {
  const env = fixture(async ({ receipt }) => {
    await receipt?.observe((row) => {
      if (row) env.committed.add(`${row.principal}:${row.eventId}`);
      return Promise.resolve({ ok: true, sourceId: 'durable-source' });
    });
    throw new Error('later work failed');
  });
  assert.equal((await env.door.submit(event('durable'), { principal: 'adapter', seq: 1 })).status, 'failed');
  assert.equal((await env.door.submit(event('durable'), { principal: 'adapter', seq: 1 })).status, 'duplicate');
  assert.deepEqual(env.standalone, []);
});

test('redelivery cannot start another handler while a timed-out observation is still pending', async () => {
  const pending = deferred<ObservationCommit>();
  let calls = 0;
  let write: Promise<ObservationCommit> | undefined;
  const env = fixture(({ receipt }) => {
    calls += 1;
    write = receipt?.observe(() => pending.promise);
  });
  try {
    assert.equal((await env.door.submit(event('pending-retry'), { principal: 'adapter', seq: 1 })).status, 'failed');
    assert.equal((await env.door.submit(event('pending-retry'), { principal: 'adapter', seq: 1 })).status, 'failed');
    assert.equal(calls, 1);
    pending.resolve({ ok: true, sourceId: 'committed-late', revision: 1 });
    await write;
    assert.equal((await env.door.submit(event('pending-retry'), { principal: 'adapter', seq: 1 })).status, 'duplicate');
    assert.equal(calls, 1);
    assert.deepEqual(env.standalone, []);
  } finally {
    pending.resolve({ ok: true, sourceId: 'committed-late', revision: 1 });
    await write;
  }
});

test('a durable receipt deduplicates redelivery before the observation callback settles', async () => {
  const durable = deferred<void>();
  const response = deferred<void>();
  let calls = 0;
  const env = fixture(async ({ receipt }) => {
    calls += 1;
    await receipt?.observe(async (row) => {
      assert.ok(row);
      env.committed.add(`${row.principal}:${row.eventId}`);
      durable.resolve();
      await response.promise;
      return { ok: true, sourceId: 'durable-source', revision: 1 };
    });
  });
  const first = env.door.submit(event('durable-retry'), { principal: 'adapter', seq: 1 });
  try {
    await durable.promise;
    assert.equal((await env.door.submit(event('durable-retry'), { principal: 'adapter', seq: 1 })).status, 'duplicate');
    assert.equal(calls, 1);
    assert.deepEqual(env.standalone, []);
  } finally {
    response.resolve();
    await first;
  }
});

// The fakes hold only the part of the real object that the code under test reads, so each is cast once, here.
const fakeOf = <T>(value: object): T => value as T;

const SILENT = { info() {}, warn() {}, error() {}, debug() {} };

/** The rigs and services a test opened; closed when the file is done. */
const OPEN: Array<{ close(): unknown }> = [];

/**
 * The real turn runner over `port`, with a scripted `llm` and no Discord client.
 */
function runnerOver({
  port,
  hot,
  llm,
  store = fakeStore(),
}: {
  port: ReturnType<typeof createFakeAdapter>;
  hot: ReturnType<typeof hotWith>;
  llm: { complete: (messages: never, options: never) => Promise<unknown> };
  store?: ReturnType<typeof fakeStore> | ReturnType<typeof createStore>;
}) {
  const calibrator = { ratio: 1, apply: (value: number) => value, observe: () => {} };
  // The runner's declared parameters ask for more than a test passes (a describer, a fetch), and the fakes are narrower
  // than the real client and port, so the whole argument is cast.
  return createTurnRunner(
    fakeOf<Parameters<typeof createTurnRunner>[0]>({
      hot,
      store,
      llm,
      calibrator,
      now: () => START,
      port,
      skills: skillRegistry(),
      journal: null,
    })
  );
}

async function rig(options?: Parameters<typeof innerRig>[0]) {
  const opened = await innerRig(options);
  OPEN.push(opened.memory);
  return opened;
}

describe('boundary', () => {
  after(async () => {
    for (const item of OPEN) await item.close();
  });

  describe('a duplicate wake', () => {
    const WAKE_AT = START + 10 * MINUTE;
    const wakeEvent = () => ({
      kind: 'inner.wake',
      at: WAKE_AT,
      id: heartbeatWake(WAKE_AT).id,
      placeId: GUILD,
      wake: heartbeatWake(WAKE_AT),
    });

    test('delivered twice through the door it opens one inner turn', async () => {
      const core = await rig({ heartbeat: { enabled: false } });
      const answers = [await core.door.submit(wakeEvent()), await core.door.submit(wakeEvent())];
      await core.inner.tick();
      await core.inner.tick();
      await core.settle();
      assert.deepEqual(
        answers.map((answer) => answer.status),
        ['ok', 'duplicate']
      );
      const llmCalls = core.llm.calls;
      assert.equal(llmCalls.length, 1);
      assert.equal(core.wakeRuns().length, 1);
    });

    test('delivered again after a restart it opens no second inner turn', async () => {
      const core = await rig({ heartbeat: { enabled: false } });
      await core.door.submit(wakeEvent());
      await core.inner.tick();
      await core.settle();
      const restarted = await core.restart();
      const answer = await restarted.door.submit(wakeEvent());
      await restarted.inner.tick();
      await restarted.settle();
      assert.equal(
        (answer.result as { status: string }).status,
        'duplicate',
        'the door is new, the inner life remembers the wake'
      );
      const llmCalls = core.llm.calls;
      assert.equal(llmCalls.length, 1);
      assert.equal(core.wakeRuns().length, 1);
    });
  });

  describe('a replay after a reconnect', () => {
    const chat = { id: 'c1', kind: 'channel', placeId: 'g1', name: 'general', topic: null, category: null };
    const received = (id: string, text: string, redeliver: number) => ({
      kind: 'message.received',
      at: START,
      id: `fake:message:${id}`,
      chat,
      message: {
        id,
        author: { id: 'u1', name: 'Alice', self: false, bot: false },
        content: text,
        at: START,
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
      addressing: { mentioned: true, replyToSelf: false, mentionedAccountIds: ['self-id'], mentionedChatIds: [] },
      redeliver,
    });

    test('events delivered again make one turn each and the persona answers each only once', async () => {
      const port = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => START });
      // @ts-expect-error: hotWith has no `features` option, so the key is ignored
      const hot = hotWith({ features: { journal: false } });
      const llm = sequenceLlm(['<msg>γεια</msg>']);
      const turns = runnerOver({ port, hot, llm });
      const history = newHistory();
      const door = createEventDoor({
        handlers: {
          'message.received': (event) => {
            const { message, at } = event as { message: { id: string; content: string }; at: number };
            return replyTo(turns, history, { id: message.id, content: message.content, at });
          },
        },
        log: SILENT,
      });
      const fixture = { iface: 'fake', events: [received('m1', 'καλημέρα', 2), received('m2', 'τι κάνεις', 1)] };
      const answers: Array<{ id: string | null; status: string }> = [];
      for (const { redeliver, ...fields } of fixture.events) {
        const event = { iface: fixture.iface, ...fields };
        const { chat: where, message } = event;
        port.seed(where.id, { authorId: message.author.id, text: message.content, messageId: message.id });
        for (let delivery = 0; delivery <= redeliver; delivery += 1) {
          const { status, id } = await door.submit(structuredClone(event));
          answers.push({ id, status });
        }
      }
      assert.deepEqual(
        answers.map((answer) => `${answer.id}:${answer.status}`),
        [
          'fake:message:m1:ok',
          'fake:message:m1:duplicate',
          'fake:message:m1:duplicate',
          'fake:message:m2:ok',
          'fake:message:m2:duplicate',
        ]
      );
      assert.equal(llm.calls.length, 2, 'one turn for each message');
      assert.equal(port.calls.filter((call) => call.op === 'send').length, 2, 'one answer for each message');
    });
  });
});

type Running = Awaited<ReturnType<typeof start>>;
type MemberMessage = { id: string; content: string; at: number };

const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const SELF_ID = 'self-id';
const ANSWER = 'γεια σου, καλημέρα';
const PRIVATE_CONFIG = {
  bot: { timezone: 'UTC', owners: [], placeId: 'g1' },
  // No video role, so the start sends no canary probe to YouTube.
  models: { routes: chainsOf({ video: false }) },
  pace: { settleMs: 0, settleMaxMs: 0 },
  typing: { reactionDelayMs: [0, 0], betweenMessagesMs: [0, 0], minMs: 0, maxMs: 0 },
  features: {
    typingSimulation: false,
    spontaneous: false,
    eavesdrop: false,
    followUp: false,
    participation: false,
    customEmoji: false,
    gifs: false,
    offlineCatchUp: false,
    diary: false,
    mediaDescriptions: false,
    missedAnswers: false,
    channelRoute: false,
    recall: false,
    memoryPrefetch: false,
    channelPull: false,
    elsewhere: false,
    speech: false,
    pauseNotice: false,
  },
};

async function until(check: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// Short folders: a Unix socket path is limited to 108 bytes.
function folders() {
  const root = mkdtempSync(join(tmpdir(), 'cs-'));
  const dataDir = join(root, 'd');
  // The runtime private alias and all prepared persona files use the selected data root.
  const privateDir = dataDir;
  mkdirSync(join(dataDir, 'config'), { recursive: true });
  writeFileSync(join(dataDir, 'config', 'config.json'), JSON.stringify(PRIVATE_CONFIG));
  createKeyStore({ privateDir: dataDir }).add({ name: 'core-1', value: 'test-key' });
  return { root, dataDir, privateDir, paths: { rootDir: REPO, privateDir, dataDir } };
}

// The scripted model: it answers every request with `<msg>` + ANSWER and keeps the requests it got.
function scriptedLlm() {
  const requests: Array<unknown> = [];
  return {
    requests,
    // The door asks the address classifier first; it says yes and is not recorded.
    complete: (messages: unknown, given?: unknown): Promise<{ text: string; usage: object; estimated: number }> => {
      if ((given as { purpose?: unknown } | undefined)?.purpose === 'address')
        return Promise.resolve({ text: 'yes', usage: {}, estimated: 1 });
      requests.push(messages);
      return Promise.resolve({ text: `<msg>${ANSWER}</msg>`, usage: {}, estimated: 10 });
    },
  };
}

async function withCore(body: (core: Awaited<ReturnType<typeof startCore>>, ctx: Context) => Promise<void>) {
  const dirs = folders();
  const llm = scriptedLlm();
  let running: Running | null = null;
  const core = await startCore({
    paths: dirs.paths,
    env: {},
    interfaces: [
      {
        name: 'fake',
        start: async (host) => {
          running = await start(host, { selfId: SELF_ID });
          return running;
        },
      },
    ],
    llm,
    embedder: { embed: () => Promise.resolve([]) },
  });
  if (running === null) throw new Error('the core never started the fake interface');
  const live: Running = running;
  live.adapter.seedChat(channelInfo('c1'));
  const ctx: Context = {
    ...dirs,
    llm,
    mentionEvent: (message) =>
      deliver(live.adapter, { id: message.id, text: message.content, at: message.at, mention: true }),
    emit: (event) => live.emit(event),
    posted: () =>
      live.adapter
        .messagesIn('c1')
        .filter((message) => message.authorId === SELF_ID)
        .map((message) => message.text),
  };
  try {
    await body(core, ctx);
  } finally {
    await core.stop();
    rmSync(dirs.root, { recursive: true, force: true });
  }
}

type Context = ReturnType<typeof folders> & {
  llm: ReturnType<typeof scriptedLlm>;
  mentionEvent(message: MemberMessage): unknown;
  emit(event: unknown): Promise<string>;
  posted(): Array<string>;
};

test('the same event emitted again is a duplicate and the persona answers once', async () => {
  await withCapturedLogs(() =>
    withCore(async (_core, ctx) => {
      const event = ctx.mentionEvent({ id: 'm2', content: 'hello again', at: Date.now() });
      assert.equal(await ctx.emit(event), 'ok');
      await until(() => ctx.posted().length === 1);
      assert.equal(await ctx.emit(event), 'duplicate');
      await new Promise((resolve) => setTimeout(resolve, 300));
      const llmRequests = ctx.llm.requests;
      assert.equal(llmRequests.length, 1);
      assert.deepEqual(ctx.posted(), [ANSWER]);
    })
  );
});
