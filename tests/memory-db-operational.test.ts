// The operational write kind (src/memory/db/operational.ts): the engine's own state, usage, metrics, inner state, missed
// registries, recall traces and emoji rails, written by kind and subject instead of through a unit and its mapper. The
// first tests write one input through the unit write and through the operational write and compare the stored rows
// column by column. The ownership columns are the one difference the plan makes: the unit path spells `owner` from its
// unit id and fills `owner_key`, the operational write names the subject in `owner`. The last tests hold the schema step
// that moves the rows production holds to that owner, and the store's round trip over a reopen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createStore } from '../src/memory/store.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { operationalValue } from '../src/memory/db/operational.ts';
import { PERSONA_ID } from '../src/memory/db/ids.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, MemoryHandle, Row } from '../src/memory/db/types.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';
import { tempDir } from './fixtures/tmp.ts';

const NOW = Date.parse('2026-11-09T10:00:00.000Z');
const PLACE = 'discord:channel:100';

function fresh(name: string): { handle: MemoryHandle; db: Db; close: () => void } {
  const handle = openMemoryDb(path.join(tempDir(`operational-${name}`), 'memory.db'));
  return { handle, db: dbOf(handle), close: () => handle.close() };
}

/**
 * The operational rows of a database with the owner a unit spelled moved to its subject: a unit id, or a unit id with a
 * line position, becomes the subject the `storage_units` row names, with the same position. `owner_key` is left out.
 */
function rowsOf(db: Db): Array<Row> {
  return db
    .prepare('SELECT kind, owner, value, owner_file, retired_at, owner_key FROM operational ORDER BY kind, rowid')
    .all()
    .map((row) => {
      const unit = typeof row.owner_key === 'string' ? row.owner_key : null;
      const unitRow = unit ? db.prepare('SELECT subject_id FROM storage_units WHERE id = ?').get(unit) : undefined;
      const subject = unitRow?.subject_id;
      const owner = String(row.owner);
      const owned = unit !== null && (owner === unit || owner.startsWith(`${unit}#`));
      return {
        kind: row.kind,
        owner: owned ? `${String(subject)}${owner.slice(unit.length)}` : owner,
        value: row.value,
        owner_file: row.owner_file,
        retired_at: row.retired_at,
      };
    });
}

test('a second operational value replaces the first', () => {
  // Catches: a write that adds a row per value, or keeps the old value beside the new one.
  const direct = fresh('direct-twice');
  try {
    for (const value of [{ llmCount: 1 }, { llmCount: 2 }]) {
      applyMemoryWrite(direct.handle, {
        kind: 'operational',
        op: 'value',
        of: 'state',
        subject: PERSONA_ID,
        value,
        now: NOW,
      });
    }
    assert.equal(rowsOf(direct.db).length, 1);
    assert.deepEqual(operationalValue(direct.db, 'state', PERSONA_ID), { found: true, value: { llmCount: 2 } });
  } finally {
    direct.close();
  }
});

test('recall trace lines keep their positions and the newest lines under the cap', () => {
  // Catches: lines that lose their order, overwrite each other, or keep more than the cap.
  const direct = fresh('direct-trace');
  try {
    for (const run of [1, 2, 3]) {
      const lines = [{ record: { run }, maxLines: 2 }];
      applyMemoryWrite(direct.handle, {
        kind: 'operational',
        op: 'lines',
        of: 'recall_trace',
        subject: PLACE,
        lines,
        now: NOW,
      });
    }
    const stored = rowsOf(direct.db);
    assert.deepEqual(
      stored.map((row) => [row.owner, row.value]),
      [
        [`${PLACE}#1`, JSON.stringify({ run: 2 })],
        [`${PLACE}#2`, JSON.stringify({ run: 3 })],
      ]
    );
  } finally {
    direct.close();
  }
});

test('the operational reader finds nothing for a subject never written', () => {
  // Catches: a reader that answers another subject's row, or an empty value, for a subject with none.
  const direct = fresh('empty');
  try {
    applyMemoryWrite(direct.handle, {
      kind: 'operational',
      op: 'value',
      of: 'missed',
      subject: PLACE,
      value: {},
      now: NOW,
    });
    assert.deepEqual(operationalValue(direct.db, 'missed', 'discord:channel:200'), { found: false });
  } finally {
    direct.close();
  }
});

test('the operational write refuses a kind outside the operational kinds', () => {
  // Catches: a write of a memory kind such as `user` that lands as an operational row nobody reads.
  const direct = fresh('refuse');
  try {
    assert.throws(
      () =>
        applyMemoryWrite(direct.handle, {
          kind: 'operational',
          op: 'value',
          of: 'user',
          subject: PLACE,
          value: {},
          now: NOW,
        }),
      { code: 'OPERATIONAL_KIND' }
    );
  } finally {
    direct.close();
  }
});

/** A database holding two recall trace lines of a place under the owners this module reads. */
function seededTrace(): string {
  const file = path.join(tempDir('operational-trace'), 'memory.db');
  const handle = openMemoryDb(file);
  const insert = dbOf(handle).prepare("INSERT INTO operational (kind, owner, value) VALUES ('recall_trace', ?, ?)");
  insert.run(`${PLACE}#0`, '{"run":1}');
  insert.run(`${PLACE}#1`, '{"run":2}');
  handle.close();
  return file;
}

test('a new recall trace line takes the next position after the stored lines', () => {
  // Catches: a new line that overwrites the oldest stored line.
  const handle = openMemoryDb(seededTrace());
  try {
    const db = dbOf(handle);
    applyMemoryWrite(handle, {
      kind: 'operational',
      op: 'lines',
      of: 'recall_trace',
      subject: PLACE,
      lines: [{ record: { run: 3 }, maxLines: 500 }],
      now: NOW,
    });
    assert.deepEqual(
      db
        .prepare("SELECT owner, value FROM operational WHERE kind = 'recall_trace' ORDER BY rowid")
        .all()
        .map((row) => [row.owner, row.value]),
      [
        [`${PLACE}#0`, '{"run":1}'],
        [`${PLACE}#1`, '{"run":2}'],
        [`${PLACE}#2`, '{"run":3}'],
      ]
    );
  } finally {
    handle.close();
  }
});

test('the store keeps its state and emoji rails over a reopen of the database', async () => {
  // Catches: a store whose cache wrote a value no new store can read once the cache is gone.
  let mem = await openTestMemory();
  try {
    const first = createStore({ dataDir: mem.dataDir, memoryDb: mem.memoryDb });
    const { data } = first.state;
    data.llmCount = 7;
    first.state.markDirty();
    first.setEmojiRails(PLACE, { replies: 4 });
    first.flush();
    await first.flushSettled({});
    await mem.close();
    mem = await openTestMemory({ dataDir: mem.dataDir });
    const second = createStore({ dataDir: mem.dataDir, memoryDb: mem.memoryDb });
    const stored = second.state.data;
    assert.equal(stored.llmCount, 7);
    assert.deepEqual(second.getEmojiRails(PLACE), { replies: 4 });
    const { memoryDb } = mem;
    const db = memoryDb.readHandle()?.db as Db;
    assert.deepEqual(operationalValue(db, 'emoji_rails', PLACE), { found: true, value: { replies: 4 } });
  } finally {
    await mem.close();
    fs.rmSync(mem.dataDir, { recursive: true, force: true });
  }
});
