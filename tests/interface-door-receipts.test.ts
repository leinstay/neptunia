// Accepted events own their observation and acknowledgement independently of message identity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEventDoor } from '../src/interface/door.ts';
import type { EventHandlerContext, IngestRow, ObservationCommit } from '../src/interface/door.ts';

const quiet = { info() {}, warn() {} };
const event = (id: string, room = 'room-a') => ({
  kind: 'reaction.changed',
  iface: 'synthetic',
  at: 1,
  id,
  conversation: { id: room, kind: 'channel' },
  messageId: 'same-message',
  emoji: { name: 'x' },
  accountId: 'member',
  added: true,
});

function fixture(handler: (context: EventHandlerContext) => unknown) {
  const standalone: Array<IngestRow> = [];
  const committed = new Set<string>();
  const door = createEventDoor({
    log: quiet,
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
    captured.map((row) => [row?.principal, row?.eventId, row?.conversation]),
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
      captured.push([row?.principal, row?.eventId, row?.seq, row?.conversation]);
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
