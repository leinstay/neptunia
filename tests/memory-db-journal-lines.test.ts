// The write kind `journal-lines` (src/memory/db/journal-lines.ts): the lines of the journal written as rows of their
// place's day directly instead of through the journal mapper of a unit write. The first tests write the same lines
// through the unit write of each day and through the write kind, and compare every table column by column: the `day`,
// `decisions`, `sources` and `affinity_events` rows, their day's unit and the graph. Then the journal over a reopen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJournal } from '../src/memory/journal.ts';
import { openTestMemory, tempDataDir } from './fixtures/memory-db/service.ts';

const NOW = Date.parse('2026-11-09T10:00:00.000Z');
const ROOT = 'synthetic:root:1';
const DAY2 = '2026-11-09T08:00:00.000Z';

type Memory = Awaited<ReturnType<typeof openTestMemory>>;

async function fresh(): Promise<Memory> {
  return openTestMemory({ now: () => NOW, iface: () => 'synthetic' });
}

test('a write whose lines are not a list is refused with a code', async () => {
  const memoryDb = (await fresh()).memoryDb;
  try {
    await assert.rejects(memoryDb.writeJournalLines({ placeId: ROOT, lines: 'none' as never }), {
      code: 'JOURNAL_LINES_LINES',
    });
  } finally {
    await memoryDb.close();
  }
});

test('the journal reads back what it wrote after the database is closed and opened again', async () => {
  const dataDir = tempDataDir();
  let clock = Date.parse(DAY2);
  const now = () => clock;
  const first = await openTestMemory({ dataDir, now: () => NOW, iface: () => 'synthetic' });
  const written: Array<object> = [];
  try {
    const journal = createJournal({ dataDir, memoryDb: first.memoryDb, now });
    const { turnId } = journal.start(ROOT, { placeId: 'room-a', mode: 'reply' });
    clock += 1000;
    await journal.turn(ROOT, { placeId: 'room-a', turnId, think: 'a synthetic thought', outcome: 'spoke' });
    await journal.memory(ROOT, { batchId: 'b-1', attitude: [{ accountId: 'member', delta: 1 }] });
    written.push(...(await journal.read(ROOT, { day: DAY2, n: 10 })));
  } finally {
    await first.close();
  }
  const second = await openTestMemory({ dataDir, now: () => NOW, iface: () => 'synthetic' });
  try {
    const journal = createJournal({ dataDir, memoryDb: second.memoryDb, now });
    const read = await journal.read(ROOT, { day: DAY2, n: 10 });
    assert.equal(read.length, 3);
    assert.deepEqual(read, written);
    assert.deepEqual(
      read.map((line) => (line as { kind?: unknown }).kind),
      ['turn.start', 'turn', 'memory']
    );
    assert.equal((await journal.stats(ROOT)).lastWriteMs, clock);
  } finally {
    await second.close();
  }
});
