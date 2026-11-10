// The owner columns of the record, the journal and the archive (src/memory/db/line-owner.ts): every row they write
// names its writer, the place that holds it and its day or month, so its readers and positions need no unit. The tests
// read with the units' ownership taken away, continue the positions of a day, and check that the writers register no
// unit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observationOf } from '../src/memory/db/observe-event.ts';
import { recordDays, recordHolders, recordLines, recordMonths, recordStats } from '../src/memory/db/record-lines.ts';
import { journalLines } from '../src/memory/db/journal-lines.ts';
import { archiveHolders, archiveLines, archiveMonths } from '../src/memory/db/archive-lines.ts';
import { placeOrPersona } from '../src/memory/db/unit-keys.ts';
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

/** Everything the readers of the three give for the root and the persona. */
function readAll(db: Db): unknown {
  const recordDay = placeOrPersona('record', ROOT, { partition: DAY.slice(0, 10) });
  return {
    record: recordLines(db, recordDay),
    days: recordDays(db, ROOT, '2026-11').map((entry) => entry.day),
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

/** The storage units and the rows naming a unit or a file the writes left: none once the rows own themselves. */
function legacyOwners(db: Db): Array<string> {
  const found: Array<string> = [];
  if (Number(db.prepare('SELECT COUNT(*) AS n FROM storage_units').get()?.n) > 0) found.push('storage_units');
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
    if (name === 'graph_edges') continue; // its owner_key is the graph's own key, not a unit
    const columns = db
      .prepare(`PRAGMA table_info("${String(name)}")`)
      .all()
      .map((column) => String(column.name));
    for (const column of ['owner_key', 'owner_file', 'origin_file'].filter((col) => columns.includes(col)))
      if (db.prepare(`SELECT 1 FROM "${String(name)}" WHERE "${column}" IS NOT NULL LIMIT 1`).get())
        found.push(`${String(name)}.${column}`);
  }
  return found;
}

test('the record, the journal, the archive and an observed message register no storage unit and name no unit in a row', async () => {
  const memory = await openTestMemory({ now: () => NOW, iface: () => 'synthetic' });
  try {
    assert.deepEqual(legacyOwners(await writeAll(memory)), []);
  } finally {
    await memory.close();
  }
});
