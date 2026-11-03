// Real observation writes retain the receipt of the accepted event across overlapping messages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEventDoor } from '../src/interface/door.ts';
import { createObserve } from '../src/pipeline/observe.ts';
import type { ObserveWhere } from '../src/pipeline/observe.ts';
import { createIngestRecord } from '../src/memory/db/ingest.ts';
import type { MessageEvent } from '../src/pipeline/edits.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';

const NOW = Date.parse('2026-10-24T12:00:00Z');
const quiet = { info() {}, warn() {} };
function message(id: string, room: string, content: string, edit = false): MessageEvent {
  return {
    kind: 'message.received',
    iface: 'synthetic',
    id,
    at: NOW,
    edit,
    addressing: { mentioned: false, replyToSelf: false, mentionedUserIds: [], mentionedConversationIds: [] },
    conversation: { id: room, kind: 'channel', chatType: 'channel', communityId: 'community' },
    message: {
      id: 'same-message',
      at: NOW - 60000,
      content,
      author: { id: 'member', name: 'Member', self: false, bot: false },
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
  };
}

for (const sameFamily of [false, true]) {
  test(`overlapping accepted ${sameFamily ? 'edits of one family' : 'messages in separate conversations'} keep their own receipts`, async () => {
    const memory = await openTestMemory({ now: () => NOW });
    try {
      const ingest = createIngestRecord({ memoryDb: memory.memoryDb, hot: memory.hot, now: () => NOW });
      const firstDone = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      let writes = 0;
      const observed = createObserve({
        hot: memory.hot,
        selfIdOf: () => 'self',
        timers: { set: () => null, clear() {} },
        memoryDb: {
          ...memory.memoryDb,
          observeMessage: async (envelope: object, where: ObserveWhere) => {
            const result = await memory.memoryDb.observeMessage(envelope, where);
            writes += 1;
            if (writes === 1) {
              entered.resolve();
              await firstDone.promise;
            }
            return result;
          },
        },
      });
      const door = createEventDoor({
        log: quiet,
        ingest,
        handlers: {
          'message.received': async (event: MessageEvent, context) => {
            await observed.observeLine(
              event,
              false,
              { guildId: 'community' },
              context.receipt
                ? {
                    eventId: context.receipt.eventId,
                    locator: { iface: event.iface, conversationId: event.conversation.id, messageId: event.message.id },
                    receipt: context.receipt,
                  }
                : undefined
            );
          },
        },
      });
      const a = door.submit(message('first-event', 'room-a', 'First body', sameFamily), {
        principal: 'adapter',
        seq: 1,
      });
      await Promise.race([entered.promise, a]);
      const b = await door.submit(
        message('second-event', sameFamily ? 'room-a' : 'room-b', 'Second body', sameFamily),
        { principal: 'adapter', seq: 2 }
      );
      firstDone.resolve();
      assert.equal((await a).status, 'ok');
      assert.equal(b.status, 'ok');
      const db = memory.memoryDb.database();
      if (!db) throw new Error('database unavailable');
      assert.deepEqual(
        db
          .prepare('SELECT i.event_id, s.text FROM ingest i JOIN sources s ON s.id = i.source_id ORDER BY i.seq')
          .all()
          .map((row) => [row.event_id, row.text]),
        [
          ['first-event', 'First body'],
          ['second-event', 'Second body'],
        ]
      );
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM message_families').get()?.n, sameFamily ? 1 : 2);
    } finally {
      await memory.close();
    }
  });
}

test('an observation timeout is unacknowledged until its late writer commit becomes durable', async () => {
  const memory = await openTestMemory({ now: () => NOW });
  const gate = Promise.withResolvers<void>();
  const timer = Promise.withResolvers<() => unknown>();
  const committed = Promise.withResolvers<void>();
  try {
    const ingest = createIngestRecord({ memoryDb: memory.memoryDb, hot: memory.hot, now: () => NOW });
    const observed = createObserve({
      hot: memory.hot,
      selfIdOf: () => 'self',
      timers: {
        set: (fn) => {
          timer.resolve(fn);
          return null;
        },
        clear() {},
      },
      memoryDb: {
        ...memory.memoryDb,
        observeMessage: async (envelope: object, where: ObserveWhere) => {
          await gate.promise;
          const result = await memory.memoryDb.observeMessage(envelope, where);
          committed.resolve();
          return result;
        },
      },
    });
    const door = createEventDoor({
      log: quiet,
      ingest,
      handlers: {
        'message.received': async (event: MessageEvent, context) => {
          await observed.observeLine(
            event,
            false,
            { guildId: 'community' },
            context.receipt
              ? {
                  eventId: context.receipt.eventId,
                  locator: { iface: event.iface, conversationId: event.conversation.id, messageId: event.message.id },
                  receipt: context.receipt,
                }
              : undefined
          );
        },
      },
    });
    const input = message('slow-event', 'room-a', 'Slow body');
    const result = door.submit(input, { principal: 'adapter', seq: 1 });
    (await timer.promise)();
    assert.equal((await result).status, 'failed');
    assert.equal(ingest.seen('adapter', 'slow-event'), false);
    gate.resolve();
    await committed.promise;
    assert.equal(ingest.seen('adapter', 'slow-event'), true);
    assert.equal((await door.submit(input, { principal: 'adapter', seq: 1 })).status, 'duplicate');
  } finally {
    gate.resolve();
    await memory.close();
  }
});
