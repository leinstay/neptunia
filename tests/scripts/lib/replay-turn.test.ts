// Tests for scripts/lib/replay-turn.ts `momentReads`: the chat reads of a replayed turn stop at its moment, a served
// chat answers from its lines as the platform pages them, and any other chat is asked for what came before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { momentReads, snowflakeAfter } from '../../../scripts/lib/replay-turn.ts';
import type { Reads } from '../../../src/interface/reads.ts';
import type { MessageEvent } from '../../../src/protocol/adapter.ts';

const AT = Date.UTC(2026, 2, 4, 10, 0, 0);
const CHAT = { iface: 'discord', chatId: '900000000000000002' };
const OTHER = { iface: 'discord', chatId: '900000000000000003' };

/** A line of the served chat at `minutes` from the moment, its id a snowflake of its time. */
const line = (minutes: number, text: string) => ({
  id: snowflakeAfter(AT + minutes * 60_000 - 1),
  placeId: CHAT.chatId,
  authorId: '1',
  authorName: 'Anna',
  content: text,
  ts: AT + minutes * 60_000,
});

/** Reads whose history answers `events` and keeps every query it got. */
function platform(events: Array<{ at: number; id: string }>) {
  const asked: Array<unknown> = [];
  const reads = {
    history: (ref: unknown, query: unknown) => {
      asked.push(query);
      return Promise.resolve({
        events: events.map((one) => ({ message: { id: one.id, at: one.at } }) as unknown as MessageEvent),
        complete: true,
      });
    },
  } as unknown as Reads;
  return { reads, asked };
}

test('a served chat answers its lines up to the moment, oldest first, the newest `limit` of them', async () => {
  const lines = [line(1, 'after'), line(-3, 'first'), line(-2, 'second'), line(0, 'now')];
  const reads = momentReads(platform([]).reads, { at: AT, served: new Map([[CHAT.chatId, lines]]) });
  const page = await reads.history(CHAT, { limit: 2 });
  assert.deepEqual(
    page?.events.map((event) => event.message.content),
    ['second', 'now']
  );
  assert.equal(page?.complete, false);
  const before = await reads.history(CHAT, { limit: 10, before: line(0, 'now').id });
  assert.deepEqual(
    before?.events.map((event) => event.message.content),
    ['first', 'second']
  );
});

test('any other chat is asked for the messages before the moment, and an event after it is kept out', async () => {
  const found = platform([
    { at: AT - 1000, id: '1' },
    { at: AT + 1000, id: '2' },
  ]);
  const reads = momentReads(found.reads, { at: AT, served: new Map() });
  const page = await reads.history(OTHER, { limit: 5 });
  assert.deepEqual(found.asked, [{ limit: 5, before: snowflakeAfter(AT) }]);
  assert.deepEqual(
    page?.events.map((event) => event.message.id),
    ['1']
  );
  // A read with a cursor of its own keeps it.
  await reads.history(OTHER, { limit: 5, before: '7' });
  assert.deepEqual(found.asked[1], { limit: 5, before: '7' });
});
