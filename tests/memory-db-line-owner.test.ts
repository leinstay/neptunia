// The owner columns of the record, the journal and the archive (src/memory/db/line-owner.ts): every row they write
// names its writer, the place that holds it and its day or month, so its readers and positions need no unit. The test
// continues the positions of a day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observationOf } from '../src/memory/db/observe-event.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, Row } from '../src/memory/db/types.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';

const NOW = Date.parse('2026-11-09T10:00:00.000Z');
const ROOT = 'synthetic:root:1';
const DAY = '2026-11-09T08:00:00.000Z';

type Memory = Awaited<ReturnType<typeof openTestMemory>>;

const seen = (id: string, messageId: string): Row => ({
  v: 1,
  id,
  kind: 'seen',
  messageId,
  revision: 1,
  occurredAt: DAY,
  recordedAt: DAY,
  scope: { channel: 'room-a' },
  by: 'member',
  replyTo: null,
  text: `text of ${id}`,
  media: [],
  mentions: [],
  direct: false,
  participants: ['member'],
  sourceMessageIds: [messageId],
  origin: 'live',
});

const envelope = (kind: string, id: string, extra: Row = {}): Row => ({
  v: 1,
  id,
  kind,
  occurredAt: DAY,
  recordedAt: DAY,
  scope: { channel: 'room-a' },
  participants: ['member'],
  sourceMessageIds: ['m1'],
  origin: 'live',
  ...extra,
});

const turn = (id: string): Row =>
  envelope('turn', id, {
    turnId: `turn-${id}`,
    attemptId: 1,
    mode: 'reply',
    outcome: 'spoke',
    reason: null,
    posted: [{ messageId: 'm9', replyTo: 'm1', opId: 'op-1' }],
    think: 'a synthetic thought',
  });

const memoryLine = (id: string): Row =>
  envelope('memory', id, {
    batchId: 'b-1',
    stage: 'applied',
    note: 'a batch',
    attitude: [{ accountId: 'member', delta: 3, applied: 2, reason: 'was kind' }],
  });

const entry = (id: string, itemId: string): Row => ({
  id,
  itemId,
  itemKind: 'claim',
  revisionId: `rv-${id}`,
  event: 'expired',
  by: 'engine',
  origin: 'live',
  recordedAt: DAY,
  scope: { channel: 'room-a' },
  text: { text: `the text of ${id}` },
});

/** One of everything the three writers write: an observed message, record lines, journal lines, archive entries. */
async function writeAll(memory: Memory): Promise<Db> {
  const observed = observationOf({
    iface: 'synthetic',
    at: NOW,
    chat: { id: 'room-a', kind: 'channel', chatType: 'channel' },
    message: { id: 'm0', at: Date.parse(DAY), content: 'an observed line', author: { id: 'member' } },
  });
  if (!observed) throw new Error('synthetic message rejected');
  const service = memory.memoryDb;
  await service.observeMessage(observed, { placeId: ROOT });
  await service.writeRecordLines({ placeId: ROOT, lines: [seen('s1', 'm1'), seen('s2', 'm2')] });
  await service.writeJournalLines({ placeId: ROOT, lines: [turn('t1'), memoryLine('d1')] });
  await service.writeJournalLines({ placeId: null, lines: [turn('t2')] });
  await service.writeArchiveLines({ placeId: ROOT, month: '2026-11', lines: [entry('a1', 'item-1')] });
  await service.writeArchiveLines({ placeId: null, month: '2026-11', lines: [entry('a2', 'item-2')] });
  return dbOf(service.readHandle()!);
}

test('a later write of a day continues after the highest position its rows hold in every table', async () => {
  const memory = await openTestMemory({ now: () => NOW, iface: () => 'synthetic' });
  try {
    const db = await writeAll(memory);
    await memory.memoryDb.writeJournalLines({ placeId: ROOT, lines: [turn('t3')] });
    const positions = ['day', 'decisions']
      .flatMap((table) =>
        db
          .prepare(`SELECT position FROM "${table}" WHERE writer = 'journal' AND holder_id = ? AND period = ?`)
          .all(ROOT, DAY.slice(0, 10))
          .map((row) => Number(row.position))
      )
      .sort((a, b) => a - b);
    assert.deepEqual(positions, [0, 1, 2]);
  } finally {
    await memory.close();
  }
});
