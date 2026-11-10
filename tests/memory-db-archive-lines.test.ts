// The write kind `archive-lines` (src/memory/db/archive-lines.ts): the entries of the archive written as
// `claim_versions` rows of their place's month directly instead of through the archive mapper of a unit write. The
// first tests write the same entries through the unit write of each month and through the write kind, and compare
// every table column by column: the versions, the retired claims of items hot memory does not hold, their month's unit
// and the graph. Then the archive over a reopen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createArchive } from '../src/memory/archive.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { createAppendStore } from '../src/memory/append-store.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Row } from '../src/memory/db/types.ts';
import { addChannelPlace } from './fixtures/memory-db/opaque-people.ts';
import { openTestMemory, tempDataDir } from './fixtures/memory-db/service.ts';

const NOW = Date.parse('2026-11-09T10:00:00.000Z');
const ROOT = 'synthetic:root:1';
const OCT = '2026-10-30T09:00:00.000Z';
const NOV = '2026-11-08T09:00:00.000Z';

type Memory = Awaited<ReturnType<typeof openTestMemory>>;

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

async function fresh(): Promise<Memory> {
  return openTestMemory({ now: () => NOW, iface: () => 'synthetic' });
}

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

test('an archived item of a chat whose place id spells nothing is a claim about the stored place', () => {
  const dir = tempDataDir();
  const handle = openMemoryDb(path.join(dir, 'memory.db'));
  try {
    const db = dbOf(handle);
    addChannelPlace(db, { id: 'place:9b22', iface: 'discord', authority: 'discord/global', native: 'room-n' });
    const line = entry('e1', 'claim:archived-1', NOV, { scope: { channel: 'room-n' }, participants: [] });
    applyMemoryWrite(handle, { kind: 'archive-lines', placeId: null, month: '2026-11', lines: [line], now: NOW });
    const claim = db.prepare('SELECT subject_kind, subject_id FROM claims WHERE id = ?').get('claim:archived-1');
    assert.deepEqual({ ...claim }, { subject_kind: 'place', subject_id: 'place:9b22' });
  } finally {
    handle.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
