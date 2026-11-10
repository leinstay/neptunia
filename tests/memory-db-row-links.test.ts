// The rows memory finds through stored columns instead of the text of their keys, on a database written before the
// columns existed (schema step 57, src/memory/db/schema.ts): a memory line's attitude rows by their decision, a split
// page's parts by the page of its runs, a lorebook entry's id from the claim's own fields and a GIF vector by its kind.
// Each test writes through the real writers, takes the database back to version 56 the way production holds it (the
// new columns dropped, the entry ids gone from the claims), opens it again and reads the same thing. Synthetic data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createJournal } from '../src/memory/journal.ts';
import { unitValue } from '../src/memory/db/readers/common.ts';
import { placeCollection } from '../src/memory/db/unit-keys.ts';
import { readGifVectors } from '../src/memory/db/gif-vectors.ts';
import { unitsOf } from '../src/memory/db/session-size.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { openTestMemory, tempDataDir } from './fixtures/memory-db/service.ts';

const NOW = Date.parse('2026-11-09T10:00:00.000Z');
const DAY = '2026-11-09T08:00:00.000Z';
const ROOT = 'synthetic:root:1';

/** The database file of `dataDir` taken back to version 56: the columns of step 57 dropped, the lore entry ids gone. */
function backTo56(dataDir: string, extra = ''): void {
  const db = new DatabaseSync(path.join(dataDir, 'memory.db'));
  try {
    db.exec(`DROP INDEX affinity_events_decision;
      ALTER TABLE affinity_events DROP COLUMN decision_id;
      DROP INDEX session_runs_page;
      ALTER TABLE session_runs DROP COLUMN page;
      ALTER TABLE session_runs DROP COLUMN parts;
      DROP INDEX vectors_kind;
      ALTER TABLE vectors DROP COLUMN kind;
      UPDATE claims SET extra = json_remove(extra, '$.id') WHERE kind = 'lore';
      DELETE FROM schema_version WHERE version > 56;
      ${extra}`);
  } finally {
    db.close();
  }
}

test("a database from before step 57 reads each memory line's own attitude after the step", async () => {
  // Bug: a step that leaves the old attitude rows without their decision loses every attitude of the journal, and a
  // reader that still matches the id prefix gives line `a` the attitude of line `a:2`.
  const dataDir = tempDataDir();
  const first = await openTestMemory({ dataDir, now: () => NOW, iface: () => 'synthetic' });
  try {
    const journal = createJournal({ dataDir, memoryDb: first.memoryDb, now: () => Date.parse(DAY) });
    await journal.memory(ROOT, { id: 'line-a', batchId: 'b-1', attitude: [{ accountId: 'member', delta: 1 }] });
    await journal.memory(ROOT, { id: 'line-a:2', batchId: 'b-2', attitude: [{ accountId: 'member', delta: 2 }] });
  } finally {
    await first.close();
  }
  backTo56(dataDir);
  const second = await openTestMemory({ dataDir, now: () => NOW, iface: () => 'synthetic' });
  try {
    const journal = createJournal({ dataDir, memoryDb: second.memoryDb, now: () => Date.parse(DAY) });
    const read = (await journal.read(ROOT, { day: DAY, n: 10 })) as Array<{
      id?: string;
      attitude?: Array<{ delta?: number }>;
    }>;
    assert.deepEqual(read.map((line) => [line.id, (line.attitude ?? []).map((move) => move.delta)]).sort(), [
      ['line-a', [1]],
      ['line-a:2', [2]],
    ]);
  } finally {
    await second.close();
  }
});

test('a database from before step 57 keeps its lorebook entry ids and its GIF vectors after the step', async () => {
  // Bug: entries that lose their id read back without one, and GIF vectors without a kind are no longer found.
  const dataDir = tempDataDir();
  const lore = [
    { id: 'k3x9', title: 'The pier', keys: ['pier'], text: 'Boats tie up at the north end.', always: false },
    { title: 'Tides', keys: ['tide'], text: 'Low water at dawn.', always: true },
  ];
  const first = await openTestMemory({ dataDir, now: () => NOW, iface: () => 'synthetic' });
  let written: unknown;
  try {
    await first.memoryDb.writePlaceLore({ placeId: ROOT, value: lore });
    await first.memoryDb.writeGifVector({ itemId: 'gif-wave', model: 'm-1', vector: [0.5, -0.25, 1] });
    written = unitValue(dbOf(first.memoryDb.readHandle()!), placeCollection('lore', ROOT));
  } finally {
    await first.close();
  }
  backTo56(dataDir);
  const second = await openTestMemory({ dataDir, now: () => NOW, iface: () => 'synthetic' });
  try {
    const db = dbOf(second.memoryDb.readHandle()!);
    assert.deepEqual(unitValue(db, placeCollection('lore', ROOT)), written);
    assert.deepEqual([...readGifVectors(db).keys()], ['gif-wave']);
  } finally {
    await second.close();
  }
});

test('a database from before step 57 keeps the split of a page whose part was applied', async () => {
  // Bug: a run stored before the step names its page and parts only in its batch key, so the next try sends the page
  // whole or split another way and writes the notes of the applied part a second time.
  const dataDir = tempDataDir();
  const first = await openTestMemory({ dataDir, now: () => NOW, iface: () => 'synthetic' });
  await first.close();
  backTo56(
    dataDir,
    `INSERT INTO session_runs (id, scope_key, mode, cursor_from, cursor_to, batch_key, applied, outcome)
       VALUES ('run:part', 'group:synthetic', 'apply', 40, 90, 'apply|group:synthetic|40|90|1|0/3', 1, 'ok');`
  );
  const second = await openTestMemory({ dataDir, now: () => NOW, iface: () => 'synthetic' });
  try {
    const db = dbOf(second.memoryDb.readHandle()!);
    const units = unitsOf(db, {
      mode: 'apply',
      scopeKey: 'group:synthetic',
      cursor: 40,
      cursorTo: 90,
      pages: 2,
      applied: (key) => key === 'apply|group:synthetic|40|90|1|0/3',
      partsOfPage: () => 1,
    });
    assert.deepEqual(
      units.map((unit) => [unit.page, unit.part, unit.parts, unit.applied]),
      [
        [0, 0, 1, false],
        [1, 0, 3, true],
        [1, 1, 3, false],
        [1, 2, 3, false],
      ]
    );
  } finally {
    await second.close();
  }
});
