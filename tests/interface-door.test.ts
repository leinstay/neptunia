// Tests for src/interface/door.ts: the one event door -- validation at the boundary, idempotent
// ids (at-least-once delivery), failed handlers retried by redelivery, derived ids of the core's
// own events, the bounded memory of ids, and the envelope form answered by acks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEventDoor, eventIdOf } from '../src/interface/door.ts';
import type { EventHandlerContext, From, IngestRow } from '../src/interface/door.ts';
import type { AuthenticatedSender } from '../src/interface/principals.ts';
import { envelope } from '../src/protocol/index.ts';
import type { ErrandDone, ReactionChanged } from '../src/protocol/events.ts';
import type { Untyped } from '../src/tools/types.ts';
import { wrongly, present } from './fixtures/loose-types.ts';

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
  conversation: { id: 'c1', kind: 'channel' },
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
    handlers: { 'errand.done': (e: ErrandDone) => seen.push(e.errandId), 'scheduler.tick': () => seen.push('tick') },
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
      envelope('hello', { iface: 'fake', self: { id: 'bot-1', name: 'Bot' }, community: null }, { id: 'h1' })
    ),
    ack('h1', 'ok')
  );
  assert.deepEqual(await door.receive(envelope('ping', {}, { id: 'p1' })), ack('p1', 'ok'));
  const event = reaction();
  assert.deepEqual(await door.receive(envelope('event', event, { id: event.id })), ack(event.id, 'ok'));
  assert.deepEqual(await door.receive(envelope('event', event, { id: event.id })), ack(event.id, 'duplicate'));
  assert.deepEqual(
    await door.receive(
      envelope(
        'action',
        { action: 'conversation.typing', conversation: { iface: 'fake', conversationId: 'c1' } },
        { id: 'x1' }
      )
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
    await import('../interfaces/discord/index.ts');
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
        ingest: { principal: 'owner', seq: 4, eventId: 'named', kind: 'reaction.changed', conversation: 'c1' },
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
  assert.deepEqual(committed, [
    { principal: 'owner', seq: 4, eventId: 'named', kind: 'reaction.changed', conversation: 'c1' },
  ]);
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
      conversation: 'c1',
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
