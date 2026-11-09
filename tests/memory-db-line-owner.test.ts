// The owner columns of the record, the journal and the archive (src/memory/db/line-owner.ts): every row they write
// names its writer, the place that holds it and its day or month, so its readers and positions need no unit. The first
// test writes the same lines once and compares, column by column, what the writers stamp with what version step 46
// derives from the units. Then the readers with the units' ownership taken away, and the positions of a day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownLineRows } from '../src/memory/db/line-owner.ts';
import { observationOf } from '../src/memory/db/observe-event.ts';
import { recordDays, recordHolders, recordLines, recordMonths, recordStats } from '../src/memory/db/record-lines.ts';
import { journalLines } from '../src/memory/db/journal-lines.ts';
import { archiveHolders, archiveLines, archiveMonths } from '../src/memory/db/archive-lines.ts';
import { placeOrPersona } from '../src/memory/db/storage-keys.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, Row } from '../src/memory/db/types.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';

const NOW = Date.parse('2026-11-09T10:00:00.000Z');
const ROOT = 'synthetic:root:1';
const DAY = '2026-11-09T08:00:00.000Z';
const LINE_TABLES = ['sources', 'day', 'decisions', 'affinity_events', 'claim_versions'];

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

/** Every table but the full-text indexes, each row as stored, in rowid order. */
function tablesOf(db: Db): string {
  const out: Record<string, Array<Row>> = {};
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL%' ORDER BY name")
    .all()
    .map((row) => String(row.name))
    .filter((name) => !/_(fts|tri)(_|$)/.test(name));
  for (const name of names) out[name] = db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
  return JSON.stringify(out, null, 1);
}

/** One of everything the three writers write: an observed message, record lines, journal lines, archive entries. */
async function writeAll(memory: Memory): Promise<Db> {
  const observed = observationOf({
    iface: 'synthetic',
    at: NOW,
    chat: { id: 'room-a', kind: 'channel', chatType: 'channel' },
    message: { id: 'm0', at: Date.parse(DAY), content: 'an observed line', author: { id: 'member' } },
  });
  if (!observed) throw new Error('synthetic message rejected');
  await memory.memoryDb.observeMessage(observed, { placeId: ROOT });
  await memory.memoryDb.writeRecordLines({ placeId: ROOT, lines: [seen('s1', 'm1'), seen('s2', 'm2')] });
  await memory.memoryDb.writeJournalLines({ placeId: ROOT, lines: [turn('t1'), memoryLine('d1')] });
  await memory.memoryDb.writeJournalLines({ placeId: null, lines: [turn('t2')] });
  await memory.memoryDb.writeArchiveLines({ placeId: ROOT, month: '2026-11', lines: [entry('a1', 'item-1')] });
  await memory.memoryDb.writeArchiveLines({ placeId: null, month: '2026-11', lines: [entry('a2', 'item-2')] });
  return dbOf(memory.memoryDb.readHandle()!);
}

/** Everything the readers of the three give for the root and the persona. */
function readAll(db: Db): unknown {
  const recordDay = placeOrPersona('record', ROOT, { partition: DAY.slice(0, 10) });
  return {
    record: recordLines(db, recordDay),
    days: recordDays(db, ROOT, '2026-11').map((day) => day.day),
    months: recordMonths(db, ROOT),
    stats: recordStats(db, ROOT),
    holders: recordHolders(db),
    journal: journalLines(db, placeOrPersona('journal', ROOT, { partition: DAY.slice(0, 10) })),
    personaJournal: journalLines(db, placeOrPersona('journal', null, { partition: DAY.slice(0, 10) })),
    archive: archiveLines(db, ROOT, '2026-11'),
    personaArchive: archiveLines(db, null, '2026-11'),
    archiveMonths: archiveMonths(db, ROOT),
    archiveHolders: archiveHolders(db),
  };
}

test('the writers stamp every line with the owner columns version step 46 derives from its unit', async () => {
  const memory = await openTestMemory({ now: () => NOW, iface: () => 'synthetic' });
  try {
    const db = await writeAll(memory);
    const stamped = tablesOf(db);
    const owned = db
      .prepare('SELECT writer, COUNT(*) AS n FROM sources WHERE writer IS NOT NULL GROUP BY writer')
      .all();
    assert.deepEqual(
      owned.map((row) => [row.writer, row.n]),
      [
        ['journal', 2],
        ['record', 3],
      ]
    );
    for (const table of LINE_TABLES) db.exec(`UPDATE "${table}" SET writer = NULL, holder_id = NULL, period = NULL`);
    db.exec('UPDATE claims SET writer = NULL');
    ownLineRows(db);
    assert.equal(tablesOf(db), stamped);
  } finally {
    await memory.close();
  }
});

test('the readers give the same lines, days, months and holders once no unit owns the rows', async () => {
  const memory = await openTestMemory({ now: () => NOW, iface: () => 'synthetic' });
  try {
    const db = await writeAll(memory);
    const before = readAll(db);
    assert.equal((before as { record: Array<string> }).record.length, 3);
    for (const table of [...LINE_TABLES, 'claims']) db.exec(`UPDATE "${table}" SET owner_key = NULL`);
    assert.deepEqual(readAll(db), before);
  } finally {
    await memory.close();
  }
});

test('a later write of a day continues after the highest position its rows hold in every table', async () => {
  const memory = await openTestMemory({ now: () => NOW, iface: () => 'synthetic' });
  try {
    const db = await writeAll(memory);
    for (const table of LINE_TABLES) db.exec(`UPDATE "${table}" SET owner_key = NULL`);
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
