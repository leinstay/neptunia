// The write kind `intentions` (src/memory/db/intentions-write.ts): her list of intentions and the records moved out of it
// to the archive, written as `intentions` rows directly instead of through the units `intentions.json` and
// `intentions-archive.jsonl` and their mapper. The first tests write one input both ways and compare the stored rows column
// by column, and the graph nodes the rows project. The ownership columns `owner_key` and `owner_file` are the one
// difference the plan makes, and the unit path's `operational` remainder row is not written. The last tests hold the
// schema step that moves the rows production holds, and the intention store's round trip over a reopen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createIntentionStore } from '../src/intentions/store.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { MIGRATIONS } from '../src/memory/db/schema.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { intentionsArchiveLines, intentionsValue } from '../src/memory/db/readers/intentions.ts';
import { personaKey } from '../src/memory/db/storage-keys.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, MemoryHandle, Row } from '../src/memory/db/types.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';
import { tempDir } from './fixtures/tmp.ts';

const NOW = Date.parse('2026-11-09T10:00:00.000Z');
const ACTIVE = { ...personaKey('intentions'), selector: { collection: 'active' as const } };
const ARCHIVE = { ...personaKey('intentions'), selector: { collection: 'archive' as const } };

function intention(id: string, extra: Row = {}): Row {
  return {
    id,
    purpose: 'ask about the trip',
    status: 'pending',
    createdAt: NOW - 3000,
    updatedAt: NOW - 1000,
    dueAt: NOW + 60_000,
    every: null,
    expiresAt: NOW + 86_400_000,
    awaitingErrandId: null,
    waitDeadline: null,
    destination: null,
    completionCondition: null,
    chainId: null,
    attend: null,
    provenance: { kind: 'self', turnId: 't-1', placeId: 'discord:channel:100', scope: 'group' },
    history: [{ at: NOW - 3000, to: 'pending', by: 'persona' }],
    ...extra,
  };
}

const DM = { provenance: { kind: 'self', turnId: 't-2', placeId: 'discord:dm:7', scope: 'dm', participants: ['7'] } };
const DM_TWO = { provenance: { kind: 'self', scope: 'dm', participants: ['7', '8'] } };

function fresh(name: string): { handle: MemoryHandle; db: Db; close: () => void } {
  const handle = openMemoryDb(path.join(tempDir(`intentions-${name}`), 'memory.db'));
  return { handle, db: dbOf(handle), close: () => handle.close() };
}

/** The stored intentions rows without their ownership, in id order. */
function rowsOf(db: Db): Array<Row> {
  return db
    .prepare('SELECT * FROM intentions ORDER BY id')
    .all()
    .map((row) => {
      const { owner_key: ownerKey, owner_file: ownerFile, ...rest } = row;
      void ownerKey;
      void ownerFile;
      return { ...rest };
    });
}

/** The graph nodes of the intentions and the edges that start or end at one, in id order. */
function nodesOf(db: Db): Array<Row> {
  const nodes = db
    .prepare("SELECT * FROM graph_nodes WHERE kind = 'intention' ORDER BY id")
    .all()
    .map((row) => ({ ...row }));
  const edges = db
    .prepare(
      `SELECT * FROM graph_edges WHERE src IN (SELECT id FROM graph_nodes WHERE kind = 'intention')
       OR dst IN (SELECT id FROM graph_nodes WHERE kind = 'intention') ORDER BY id`
    )
    .all()
    .map((row) => ({ ...row }));
  return [...nodes, ...edges];
}

type Step = { op: 'value'; intentions: Array<Row> } | { op: 'archive'; records: Array<Row> };

function writeBoth(viaUnit: MemoryHandle, direct: MemoryHandle, steps: ReadonlyArray<Step>): void {
  for (const step of steps) {
    if (step.op === 'value')
      applyMemoryWrite(viaUnit, {
        kind: 'unit',
        op: 'value',
        key: ACTIVE,
        value: { intentions: step.intentions },
        now: NOW,
      });
    else applyMemoryWrite(viaUnit, { kind: 'unit', op: 'lines', key: ARCHIVE, lines: step.records, now: NOW });
    applyMemoryWrite(direct, { kind: 'intentions', ...step, now: NOW });
  }
}

const CASES: Array<{ name: string; steps: Array<Step> }> = [
  {
    name: 'a list of group, DM and shared-DM intentions',
    steps: [{ op: 'value', intentions: [intention('i1'), intention('i2', DM), intention('i3', DM_TWO)] }],
  },
  {
    name: 'a record moved to the archive, then the list without it',
    steps: [
      { op: 'value', intentions: [intention('i1'), intention('i2'), intention('i3')] },
      { op: 'archive', records: [intention('i1', { status: 'done' })] },
      { op: 'value', intentions: [intention('i2'), intention('i3')] },
    ],
  },
  {
    name: 'a list that drops a record nobody archived',
    steps: [
      { op: 'value', intentions: [intention('i1'), intention('i2')] },
      { op: 'value', intentions: [intention('i2', { status: 'done' })] },
    ],
  },
  {
    name: 'two archive writes',
    steps: [
      { op: 'archive', records: [intention('a1', { status: 'done' })] },
      { op: 'archive', records: [intention('a2', { status: 'expired' }), intention('a3', { status: 'cancelled' })] },
    ],
  },
];

for (const { name, steps } of CASES) {
  test(`the intentions write stores ${name} as the unit write does`, () => {
    // Catches: a direct write that stores another column, another position or scope, or retires another row.
    const viaUnit = fresh('unit');
    const direct = fresh('direct');
    try {
      writeBoth(viaUnit.handle, direct.handle, steps);
      assert.deepEqual(rowsOf(direct.db), rowsOf(viaUnit.db));
      assert.deepEqual(nodesOf(direct.db), nodesOf(viaUnit.db));
    } finally {
      viaUnit.close();
      direct.close();
    }
  });
}

test('the readers give the list and the archive lines the intentions write stored', () => {
  // Catches: a reader that mixes archived records into the list, or loses the archive's order.
  const direct = fresh('read');
  try {
    applyMemoryWrite(direct.handle, { kind: 'intentions', op: 'value', intentions: [intention('i1')], now: NOW });
    applyMemoryWrite(direct.handle, {
      kind: 'intentions',
      op: 'archive',
      records: [intention('a2', { status: 'done' }), intention('a1', { status: 'done' })],
      now: NOW,
    });
    assert.deepEqual(intentionsValue(direct.db), { found: true, value: { intentions: [intention('i1')] } });
    assert.deepEqual(
      intentionsArchiveLines(direct.db).map((line) => (JSON.parse(line) as Row).id),
      ['a2', 'a1']
    );
  } finally {
    direct.close();
  }
});

test('the intentions write refuses a record without an id', () => {
  // Catches: a record that lands under no key and can never be read or replaced.
  const direct = fresh('refuse');
  try {
    assert.throws(
      () =>
        applyMemoryWrite(direct.handle, {
          kind: 'intentions',
          op: 'value',
          intentions: [{ purpose: 'no id' }],
          now: NOW,
        }),
      { code: 'INTENTIONS_RECORD' }
    );
  } finally {
    direct.close();
  }
});

test('the schema step moves the intention rows off their units and leaves them readable', () => {
  // Catches: rows the new readers cannot find after the deploy, or an active record read as archived.
  const file = path.join(tempDir('intentions-step'), 'memory.db');
  const old = openMemoryDb(file, { migrations: MIGRATIONS.slice(0, 43) });
  applyMemoryWrite(old, {
    kind: 'unit',
    op: 'value',
    key: ACTIVE,
    value: { intentions: [intention('i1'), intention('i2')] },
    now: NOW,
  });
  applyMemoryWrite(old, {
    kind: 'unit',
    op: 'lines',
    key: ARCHIVE,
    lines: [intention('a1', { status: 'done' })],
    now: NOW,
  });
  const before = rowsOf(dbOf(old));
  old.close();
  const handle = openMemoryDb(file);
  try {
    const db = dbOf(handle);
    assert.deepEqual(rowsOf(db), before);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM intentions WHERE owner_key IS NOT NULL').get()?.n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM operational WHERE kind = 'intentions'").get()?.n, 0);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM storage_units WHERE kind = 'intentions' AND retired_at IS NULL").get()?.n,
      0
    );
    applyMemoryWrite(handle, { kind: 'intentions', op: 'value', intentions: [intention('i2')], now: NOW });
    assert.deepEqual(intentionsValue(db), { found: true, value: { intentions: [intention('i2')] } });
    assert.deepEqual(
      intentionsArchiveLines(db).map((line) => (JSON.parse(line) as Row).id),
      ['a1']
    );
  } finally {
    handle.close();
  }
});

test('the intention store keeps its list and its archive over a reopen of the database', async () => {
  // Catches: a store whose writes no new store can read once the first one is gone.
  let mem = await openTestMemory();
  try {
    const first = createIntentionStore({ memoryDb: mem.memoryDb });
    assert.equal(first.add(intention('i1') as never).ok, true);
    await first.flush({ final: true });
    await mem.close();
    mem = await openTestMemory({ dataDir: mem.dataDir });
    const second = createIntentionStore({ memoryDb: mem.memoryDb });
    assert.deepEqual(
      second.list().map((record) => record.id),
      ['i1']
    );
  } finally {
    await mem.close();
    fs.rmSync(mem.dataDir, { recursive: true, force: true });
  }
});
