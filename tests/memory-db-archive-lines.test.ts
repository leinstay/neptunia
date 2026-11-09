// The write kind `archive-lines` (src/memory/db/archive-lines.ts): the entries of the archive written as
// `claim_versions` rows of their place's month directly instead of through the archive mapper of a unit write. The
// first tests write the same entries through the unit write of each month and through the write kind, and compare
// every table column by column: the versions, the retired claims of items hot memory does not hold, their month's unit
// and the graph. Then the archive over a reopen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createArchive } from '../src/memory/archive.ts';
import { createAppendStore } from '../src/memory/append-store.ts';
import { placeOrPersona } from '../src/memory/db/storage-keys.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, Row } from '../src/memory/db/types.ts';
import { openTestMemory, tempDataDir } from './fixtures/memory-db/service.ts';

const NOW = Date.parse('2026-11-09T10:00:00.000Z');
const ROOT = 'synthetic:root:1';
const OCT = '2026-10-30T09:00:00.000Z';
const NOV = '2026-11-08T09:00:00.000Z';

type Memory = Awaited<ReturnType<typeof openTestMemory>>;
/** One write of a test: the place (null: the persona's), the month and its entries. */
type Write = { placeId: string | null; month: string; lines: Array<unknown> };

const entry = (id: string, itemId: string, recordedAt: string, extra: Row = {}): Row => ({
  id,
  itemId,
  itemKind: 'claim',
  revisionId: `rv-${id}`,
  event: 'expired',
  by: 'engine',
  origin: 'live',
  recordedAt,
  kind: 'fact',
  scope: { channel: 'room-a' },
  participants: ['member'],
  observedAt: { date: '2026-10-01' },
  text: { text: `the text of ${id}`, lang: 'en' },
  weight: 2,
  ...extra,
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

/** The unit write of one write: its place's month. */
const unitWrite = (write: Write): Row => ({
  op: 'lines',
  key: placeOrPersona('archive', write.placeId, { partition: write.month }),
  lines: write.lines,
});

async function fresh(): Promise<Memory> {
  return openTestMemory({ now: () => NOW, iface: () => 'synthetic' });
}

/** Runs the writes through both paths; returns every table of each and the answers of each write. */
async function writeBoth(
  writes: ReadonlyArray<Write>
): Promise<{ unit: [string, Array<unknown>]; direct: [string, Array<unknown>] }> {
  const viaUnit = await fresh();
  const direct = await fresh();
  try {
    const unitAnswers: Array<unknown> = [];
    for (const write of writes) unitAnswers.push(await viaUnit.memoryDb.writeUnit(unitWrite(write)));
    const directAnswers: Array<unknown> = [];
    for (const write of writes) directAnswers.push(await direct.memoryDb.writeArchiveLines(write));
    return {
      unit: [tablesOf(dbOf(viaUnit.memoryDb.readHandle()!)), unitAnswers],
      direct: [tablesOf(dbOf(direct.memoryDb.readHandle()!)), directAnswers],
    };
  } finally {
    await viaUnit.close();
    await direct.close();
  }
}

test('entries of two months, a repeated item, an entry with no id and a value that is no object store the same rows both ways', async () => {
  const noId = entry('x', 'item-3', NOV);
  delete noId.id;
  const { unit, direct } = await writeBoth([
    { placeId: ROOT, month: '2026-10', lines: [entry('a1', 'item-1', OCT)] },
    { placeId: ROOT, month: '2026-11', lines: [entry('a2', 'item-2', NOV, { scope: { user: 'member' } }), noId] },
    {
      placeId: ROOT,
      month: '2026-11',
      lines: [entry('a3', 'item-1', NOV, { event: 'replaced', text: { text: 'newer' } }), 'raw value'],
    },
  ]);
  assert.equal(direct[0], unit[0]);
  assert.deepEqual(direct[1], unit[1]);
});

test('entries of a direct chat and of the persona store the same rows both ways', async () => {
  const { unit, direct } = await writeBoth([
    {
      placeId: 'synthetic:dm:partner',
      month: '2026-11',
      lines: [entry('d1', 'item-4', NOV, { scope: { user: 'partner' } })],
    },
    { placeId: null, month: '2026-11', lines: [entry('p1', 'item-5', NOV, { scope: {} })] },
  ]);
  assert.equal(direct[0], unit[0]);
  assert.deepEqual(direct[1], unit[1]);
});

test('a write whose entries are not a list is refused with a code', async () => {
  const memory = await fresh();
  try {
    await assert.rejects(
      memory.memoryDb.writeArchiveLines({ placeId: ROOT, month: '2026-11', lines: 'none' as never }),
      {
        code: 'ARCHIVE_LINES_LINES',
      }
    );
  } finally {
    await memory.close();
  }
});

test('the archive reads back what it wrote after the database is closed and opened again', async () => {
  const dataDir = tempDataDir();
  // The pending queue's files: this test writes none.
  const appendStore = createAppendStore({ fsyncMs: 0 });
  const entries = [entry('r1', 'item-6', OCT), entry('r2', 'item-7', NOV)];
  const first = await openTestMemory({ dataDir, now: () => NOW, iface: () => 'synthetic' });
  const written: Array<object> = [];
  try {
    const archive = createArchive({ appendStore, dataDir, memoryDb: first.memoryDb, now: () => NOW });
    assert.deepEqual(await archive.append(ROOT, entries), { written: 2, duplicates: 0 });
    for await (const one of archive.iterate(ROOT)) written.push(one);
  } finally {
    await first.close();
  }
  const second = await openTestMemory({ dataDir, now: () => NOW, iface: () => 'synthetic' });
  try {
    const archive = createArchive({ appendStore, dataDir, memoryDb: second.memoryDb, now: () => NOW });
    const read: Array<object> = [];
    for await (const one of archive.iterate(ROOT)) read.push(one);
    assert.equal(read.length, 2);
    assert.deepEqual(read, written);
    assert.deepEqual(await archive.append(ROOT, entries), { written: 0, duplicates: 2 });
    assert.equal((await archive.find('item-7')).length, 1);
  } finally {
    await second.close();
  }
});
