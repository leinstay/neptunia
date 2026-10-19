// Tests for src/behavior/deleted-lines.js: the deletions of a window read from the record.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deletedLinesMax, deletedLinesOf, withDeletedLines } from '../src/behavior/deleted-lines.js';

const T0 = Date.UTC(2026, 9, 19, 10, 0, 0);
const iso = (ts) => new Date(ts).toISOString();
const live = (id, ts, over = {}) => ({ id, ts, authorId: 'u1', authorName: 'Alice', content: 'hi', channelId: 'c1', ...over });
const seen = (messageId, ts, by = 'u2') => ({ kind: 'seen', messageId, occurredAt: iso(ts), by, scope: { channel: 'c1' } });
const deleted = (messageId, ts, by = 'u2') => ({ kind: 'deleted', messageId, occurredAt: iso(ts), participants: [by], scope: { channel: 'c1' } });

/** A record whose iterate keeps the query it was asked and yields `lines`. */
function fakeRecord(lines) {
  const record = {
    queries: [],
    async *iterate(guildId, query) {
      record.queries.push({ guildId, ...query });
      for (const line of lines) yield line;
    },
  };
  return record;
}

test('deletedLinesOf: a deleted message the history lacks becomes a placeholder at its own time, named by the history, the read bounded to the window and one channel', async () => {
  const history = [live('m1', T0), live('m3', T0 + 3000, { authorId: 'u2', authorName: 'Zoë' })];
  const record = fakeRecord([seen('m2', T0 + 1000), deleted('m2', T0 + 9000), deleted('m1', T0 + 9500), { kind: 'said', messageId: 'x', occurredAt: iso(T0) }]);
  const found = await deletedLinesOf({ record, guildId: 'g1', channelId: 'c1', history });
  assert.deepEqual(record.queries, [{ guildId: 'g1', from: iso(T0), channelIds: ['c1'] }]);
  assert.deepEqual(found.placeholders.map((p) => [p.id, p.ts, p.authorName, p.deleted, p.content]), [['m2', T0 + 1000, 'Zoë', true, '']], 'the time of the seen line, not the deletion; a message still in the history is no placeholder');
  assert.deepEqual([...found.deletedIds], ['m2']);
  assert.equal(typeof found.ms, 'number');
  // Without a seen line the deletion time is used; the persona's own deleted line reads as hers.
  const own = await deletedLinesOf({ record: fakeRecord([deleted('m9', T0 + 2000, 'self')]), guildId: 'g1', channelId: 'c1', history, selfId: 'self', selfName: 'Nept' });
  assert.deepEqual(own.placeholders.map((p) => [p.ts, p.self, p.authorName]), [[T0 + 2000, true, 'Nept']]);
});

test('deletedLinesOf: only the newest context.deletedLinesMax placeholders stay, every id is still known; a failed read gives none', async () => {
  const history = [live('m1', T0)];
  const lines = [1, 2, 3, 4].flatMap((n) => [seen(`d${n}`, T0 + n * 1000), deleted(`d${n}`, T0 + 60_000)]);
  const found = await deletedLinesOf({ record: fakeRecord(lines), guildId: 'g1', channelId: 'c1', history, max: 2 });
  assert.deepEqual(found.placeholders.map((p) => p.id), ['d3', 'd4']);
  assert.equal(found.deletedIds.size, 4);
  const broken = { async *iterate() { throw new Error('disk'); } };
  const failed = await deletedLinesOf({ record: broken, guildId: 'g1', channelId: 'c1', history });
  assert.deepEqual([failed.placeholders, failed.deletedIds.size, failed.failed], [[], 0, true]);
  assert.deepEqual([deletedLinesMax({}), deletedLinesMax({ deletedLinesMax: 3 }), deletedLinesMax({ deletedLinesMax: -1 })], [10, 3, 10]);
});

test('withDeletedLines: each placeholder sits before the first later line, after the reply parents; none changes nothing', () => {
  const parent = live('p', T0 - 5000, { replyParent: true });
  const history = [parent, live('m1', T0), live('m3', T0 + 3000)];
  const gone = (id, ts) => ({ id, ts, deleted: true });
  assert.deepEqual(withDeletedLines(history, [gone('d1', T0 - 9000), gone('d2', T0 + 1000), gone('d3', T0 + 9000)]).map((m) => m.id), ['p', 'd1', 'm1', 'd2', 'm3', 'd3']);
  assert.equal(withDeletedLines(history, []), history);
});
