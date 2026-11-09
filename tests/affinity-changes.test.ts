// `readAffinityChanges` (src/memory/affinity-changes.ts) over a real memory database: group-audience changes only,
// retired rows left out, newest first, narrowed by person, window and limit, and the limit capped.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { createMemoryDb } from '../src/memory/db/service.ts';
import type { MemoryDbService } from '../src/memory/db/service.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { AFFINITY_CHANGES_MAX, readAffinityChanges } from '../src/memory/affinity-changes.ts';
import { ANNA, BORIS, seedOpaqueWorld } from './fixtures/memory-db/opaque-people.ts';
import { tempDir } from './fixtures/tmp.ts';

const opened: Array<MemoryDbService> = [];
after(async () => {
  for (const service of opened) await service.close();
});

const quiet = { info() {}, debug() {}, warn() {}, error() {} };

function service(rows: number) {
  const dataDir = tempDir('nep-affinity-changes-');
  const seed = openMemoryDb(path.join(dataDir, 'memory.db'));
  const db = dbOf(seed);
  seedOpaqueWorld(db);
  const insert = db.prepare(
    `INSERT INTO affinity_events (id, person_id, at, delta, applied, score, reason, audience_id, scope_kind, writer, retired_at)
     VALUES (?, ?, ?, 1, 1, ?, ?, ?, 'group', 'session', ?)`
  );
  for (let i = 0; i < rows; i++)
    insert.run(
      `ev:${i}`,
      i % 2 === 0 ? ANNA : BORIS,
      `2026-10-${String(1 + (i % 28)).padStart(2, '0')}T10:00:00.000Z`,
      i,
      `r${i}`,
      'aud:group:discord',
      null
    );
  insert.run(
    'ev:retired',
    ANNA,
    '2026-11-01T00:00:00.000Z',
    9,
    'retired',
    'aud:group:discord',
    '2026-11-02T00:00:00.000Z'
  );
  seed.close();
  const memoryDb = createMemoryDb({
    hot: { config: { memoryDb: { session: { mode: 'off' } } } },
    dataDir,
    log: quiet,
    worker: false,
  });
  memoryDb.tick();
  opened.push(memoryDb);
  return memoryDb;
}

test('lists group changes newest first and leaves out retired and private-chat changes', () => {
  const memoryDb = service(3);
  const changes = readAffinityChanges({ memoryDb, log: quiet });
  assert.deepEqual(
    changes.map((change) => change.reason),
    ['r2', 'r1', 'r0']
  );
});

test('narrows by person', () => {
  const memoryDb = service(4);
  const changes = readAffinityChanges({ memoryDb, log: quiet, filter: { personId: BORIS } });
  assert.deepEqual(
    changes.map((change) => change.reason),
    ['r3', 'r1']
  );
});

test('a window includes both of its ends', () => {
  const memoryDb = service(5);
  const changes = readAffinityChanges({
    memoryDb,
    log: quiet,
    filter: { since: '2026-10-02T10:00:00.000Z', until: '2026-10-03T10:00:00.000Z' },
  });
  assert.deepEqual(
    changes.map((change) => change.reason),
    ['r2', 'r1']
  );
});

test('an empty database answers an empty list and the limit is capped', () => {
  assert.deepEqual(readAffinityChanges({ memoryDb: service(0), log: quiet }), []);
  const many = readAffinityChanges({
    memoryDb: service(AFFINITY_CHANGES_MAX + 20),
    log: quiet,
    filter: { limit: 10_000 },
  });
  assert.equal(many.length, AFFINITY_CHANGES_MAX);
});
