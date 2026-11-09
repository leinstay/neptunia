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
import { MIGRATIONS } from '../src/memory/db/schema.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { operationalValue } from '../src/memory/db/operational.ts';
import { PERSONA_ID, personaKey, placeCollection } from '../src/memory/db/storage-keys.ts';
import type { StorageKey } from '../src/memory/db/storage-keys.ts';
import { ensureUnit } from '../src/memory/db/storage-units.ts';
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

const subjectOf = (key: StorageKey): string => key.subject.id;

/** The seven kinds of the slice with a value of each, keyed as the store and its modules key them. */
const VALUES: Array<{ key: StorageKey; value: unknown }> = [
  { key: personaKey('state'), value: { llmCount: 3, paused: false, job: { done: true } } },
  { key: personaKey('usage'), value: { v: 1, days: { '2026-11-09': { requests: 4 } } } },
  { key: personaKey('metrics'), value: { v: 1, samples: { turn: [[NOW, 1200]] } } },
  { key: personaKey('inner'), value: { v: 1, stopped: false, facts: [], turnIds: ['t1'] } },
  { key: placeCollection('missed', PLACE), value: { candidates: [{ messageId: 'm1', at: NOW }] } },
  { key: personaKey('missed'), value: { candidates: [] } },
  { key: placeCollection('emoji_rails', PLACE), value: { replies: 2, last: ['e1'] } },
];

for (const { key, value } of VALUES) {
  test(`the operational write stores the ${key.kind} row of ${key.subject.type} as the unit write does`, () => {
    // Catches: a direct write that stores another value text, keeps a retired mark or misses a column the unit path set.
    const viaUnit = fresh('unit');
    const direct = fresh('direct');
    try {
      applyMemoryWrite(viaUnit.handle, { kind: 'unit', op: 'value', key, value, now: NOW });
      applyMemoryWrite(direct.handle, {
        kind: 'operational',
        op: 'value',
        of: key.kind,
        subject: subjectOf(key),
        value,
        now: NOW,
      });
      const stored = rowsOf(direct.db);
      assert.equal(stored.length, 1);
      assert.deepEqual(stored, rowsOf(viaUnit.db));
      assert.deepEqual(operationalValue(direct.db, key.kind, subjectOf(key)), { found: true, value });
    } finally {
      viaUnit.close();
      direct.close();
    }
  });
}

test('a second operational value replaces the first, as a second unit write does', () => {
  // Catches: a write that adds a row per value, or keeps the old value beside the new one.
  const viaUnit = fresh('unit-twice');
  const direct = fresh('direct-twice');
  try {
    for (const value of [{ llmCount: 1 }, { llmCount: 2 }]) {
      applyMemoryWrite(viaUnit.handle, { kind: 'unit', op: 'value', key: personaKey('state'), value, now: NOW });
      applyMemoryWrite(direct.handle, {
        kind: 'operational',
        op: 'value',
        of: 'state',
        subject: PERSONA_ID,
        value,
        now: NOW,
      });
    }
    assert.deepEqual(rowsOf(direct.db), rowsOf(viaUnit.db));
    assert.deepEqual(operationalValue(direct.db, 'state', PERSONA_ID), { found: true, value: { llmCount: 2 } });
  } finally {
    viaUnit.close();
    direct.close();
  }
});

test('recall trace lines keep their positions and the newest lines under the cap, as the unit write does', () => {
  // Catches: lines that lose their order, overwrite each other, or keep more than the cap.
  const viaUnit = fresh('unit-trace');
  const direct = fresh('direct-trace');
  const key = placeCollection('recall_trace', PLACE);
  try {
    for (const run of [1, 2, 3]) {
      const lines = [{ record: { run }, maxLines: 2 }];
      applyMemoryWrite(viaUnit.handle, { kind: 'unit', op: 'lines', key, lines, now: NOW });
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
    assert.deepEqual(stored, rowsOf(viaUnit.db));
  } finally {
    viaUnit.close();
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

/** A database at the version before the operational owners, holding rows as the unit path left them. */
function seededBeforeStep(): string {
  const file = path.join(tempDir('operational-step'), 'memory.db');
  const old = openMemoryDb(file, { migrations: MIGRATIONS.slice(0, 42) });
  const db = dbOf(old);
  const insert = db.prepare(
    'INSERT INTO operational (kind, owner, value, owner_file, retired_at, owner_key) VALUES (?, ?, ?, NULL, ?, ?)'
  );
  const state = ensureUnit(db, personaKey('state'));
  insert.run('state', state, '{"llmCount":5}', null, state);
  // An inner unit whose row kept the owner of its old file, and a retired row of the same unit.
  const inner = ensureUnit(db, personaKey('inner'));
  insert.run('inner', 'guilds/1/inner.json', '{"v":1}', null, inner);
  insert.run('inner', inner, '{"v":0}', '2026-11-01T00:00:00.000Z', inner);
  const trace = ensureUnit(db, placeCollection('recall_trace', PLACE));
  insert.run('recall_trace', `${trace}#0`, '{"run":1}', null, trace);
  insert.run('recall_trace', `${trace}#1`, '{"run":2}', null, trace);
  // Emoji rails of a place spelled by its bare native id, which no `places` row holds.
  db.prepare("INSERT INTO places (id, iface, kind, native_id) VALUES (?, 'discord', 'channel', '100')").run(PLACE);
  const rails = ensureUnit(db, placeCollection('emoji_rails', '100'));
  insert.run('emoji_rails', rails, '{"replies":1}', null, rails);
  // A memory kind the step leaves alone.
  const channel = ensureUnit(db, placeCollection('channel', PLACE));
  insert.run('channel', PLACE, '{"$has":[]}', null, channel);
  old.close();
  return file;
}

test('the schema step moves operational rows to their subject and leaves memory kinds alone', () => {
  // Catches: rows the new readers cannot find after the deploy, lines that collide, or a memory kind's owner rewritten.
  const handle = openMemoryDb(seededBeforeStep());
  try {
    const db = dbOf(handle);
    const channelUnit = db.prepare("SELECT id FROM storage_units WHERE kind = 'channel'").get();
    assert.deepEqual(
      db
        .prepare('SELECT kind, owner, value, retired_at, owner_key FROM operational ORDER BY kind, owner')
        .all()
        .map((row) => ({ ...row })),
      [
        {
          kind: 'channel',
          owner: PLACE,
          value: '{"$has":[]}',
          retired_at: null,
          owner_key: channelUnit?.id,
        },
        { kind: 'emoji_rails', owner: PLACE, value: '{"replies":1}', retired_at: null, owner_key: null },
        { kind: 'inner', owner: PERSONA_ID, value: '{"v":1}', retired_at: null, owner_key: null },
        { kind: 'recall_trace', owner: `${PLACE}#0`, value: '{"run":1}', retired_at: null, owner_key: null },
        { kind: 'recall_trace', owner: `${PLACE}#1`, value: '{"run":2}', retired_at: null, owner_key: null },
        { kind: 'state', owner: PERSONA_ID, value: '{"llmCount":5}', retired_at: null, owner_key: null },
      ]
    );
    assert.deepEqual(operationalValue(db, 'state', PERSONA_ID), { found: true, value: { llmCount: 5 } });
    assert.deepEqual(
      db
        .prepare('SELECT kind FROM storage_units WHERE retired_at IS NULL ORDER BY kind')
        .all()
        .map((row) => row.kind),
      ['channel']
    );
  } finally {
    handle.close();
  }
});

test('a recall trace line after the step takes the next position of the moved lines', () => {
  // Catches: a first line after the deploy that overwrites the oldest moved line.
  const handle = openMemoryDb(seededBeforeStep());
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
