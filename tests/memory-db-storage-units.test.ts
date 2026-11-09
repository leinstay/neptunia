// Semantic ownership preserves migrated collections, session changes and accepted pending writes.
import { legacyServerPlaceId } from '../src/memory/migration/paths.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createMemoryDb } from '../src/memory/db/service.ts';
import { applyUnitWrite } from '../src/memory/db/unit-write.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { unitLines } from '../src/memory/db/readers/common.ts';
import { unitRows } from '../src/memory/db/export.ts';
import { listUnits } from '../src/memory/db/storage-units.ts';
import type { StorageKey } from '../src/memory/db/storage-keys.ts';
import { personId } from '../src/memory/db/ids.ts';
import { dbOf, type Db } from '../src/memory/db/types.ts';
import { fixture, NOW } from './fixtures/memory-db/session-rig.ts';
import { tempDir } from './fixtures/tmp.ts';
import { a, profile } from './fixtures/memory-db/storage-ownership.ts';

// A second collection of the same account: its scope by root is gone, so a partition keeps the two owners apart.
const b: StorageKey = { ...a, partition: 'second' };
const day: StorageKey = {
  kind: 'record',
  subject: { type: 'place', id: legacyServerPlaceId('discord', 'g1') },
  partition: '2026-10-20',
};
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function json(text: string): unknown {
  return JSON.parse(text);
}

function evidence(db: Db, id: unknown) {
  return db
    .prepare('SELECT source_id, position, retired_at FROM claim_sources WHERE claim_id = ? ORDER BY rowid')
    .all(id)
    .map((row) => [row.source_id, row.position, row.retired_at]);
}

test('collection replacement retains session-owned rows, evidence and held affinity fields', () => {
  const env = fixture();
  try {
    applyUnitWrite(env.handle, { op: 'value', key: a, value: profile });
    const source = env.say({ native: 'session-evidence', minutesAgo: 1, text: 'a synthetic source', author: 'u1' });
    applyMemoryWrite(env.handle, {
      kind: 'session',
      mode: 'apply',
      now: NOW,
      maxDelta: 5,
      run: {
        id: 'run:ownership',
        sweepId: 'sweep:ownership',
        scopeKey: 'group:discord',
        scope: env.group,
        batchKey: 'ownership',
        startedAt: new Date(NOW).toISOString(),
        finishedAt: new Date(NOW).toISOString(),
        cursorFrom: 0,
        cursorTo: 1,
        sourcesN: 1,
        outcome: 'ok',
        counts: {},
        errors: [],
      },
      plan: {
        claims: [
          {
            op: 'add',
            subjectKind: 'person',
            subjectId: personId('discord', 'u1'),
            kind: 'detail',
            text: 'session fact',
            how: 'said',
            sources: [source],
            when: null,
          },
        ],
        episodes: [],
        descriptions: [],
        affinity: [{ personId: personId('discord', 'u1'), delta: 3, reason: 'session reason', sources: [source] }],
      },
    });
    const claim = env.db.prepare("SELECT id, owner_key FROM claims WHERE text = 'session fact'").get();
    assert.ok(claim);
    assert.equal(claim.owner_key, null);
    const links = evidence(env.db, claim.id);
    assert.deepEqual(
      links.map((row) => row[0]),
      [source]
    );
    applyUnitWrite(env.handle, { op: 'value', key: a, value: profile });
    assert.deepEqual(evidence(env.db, claim.id), links);
    assert.equal(
      env.db.prepare('SELECT affinity FROM people WHERE id = ?').get(personId('discord', 'u1'))?.affinity,
      5
    );
    assert.equal(
      unitRows(env.db, a).claims.some((row) => row.id === claim.id),
      true
    );
  } finally {
    env.done();
  }
});

test('replacement omitting a shared primary claim preserves its surviving co-owner and evidence', () => {
  const env = fixture();
  const handle = env.handle;
  try {
    applyUnitWrite(handle, { op: 'value', key: a, value: profile });
    applyUnitWrite(handle, { op: 'value', key: b, value: profile });
    const db = dbOf(handle);
    const claim = db.prepare("SELECT id FROM claims WHERE text = 'likes café mornings'").get();
    assert.ok(claim);
    const source = env.say({
      native: 'shared-evidence',
      minutesAgo: 1,
      text: 'evidence of the shared claim',
      author: 'u1',
    });
    const [ownerUnit] = listUnits(db, b);
    assert.ok(ownerUnit);
    db.prepare('INSERT INTO claim_sources(claim_id,source_id,position,owner_key) VALUES (?,?,0,?)').run(
      claim.id,
      source,
      ownerUnit.id
    );
    const links = evidence(db, claim.id);
    assert.deepEqual(links, [[source, 0, null]]);
    applyUnitWrite(handle, { op: 'value', key: a, value: { ...profile, details: [] } });
    const [survivor] = listUnits(db, b);
    assert.ok(survivor);
    const saved = db.prepare('SELECT owner_key,retired_at FROM claims WHERE id = ?').get(claim.id);
    assert.deepEqual([saved?.owner_key, saved?.retired_at], [survivor.id, null]);
    assert.deepEqual(evidence(db, claim.id), links);
    assert.equal(
      unitRows(db, b).claims.some((row) => row.id === claim.id),
      true
    );
  } finally {
    handle.close();
  }
});

test('accepted legacy pending append translates once and keeps order across semantic append and reopen', async () => {
  const dataDir = tempDir('neutral-owner-pending-');
  const hot = { config: { memoryDb: { session: { mode: 'off' } } } };
  const first = {
    v: 1,
    id: 'legacy-row',
    kind: 'seen',
    messageId: 'm1',
    placeId: 'g1',
    scope: { channel: 'c1' },
    occurredAt: new Date(NOW).toISOString(),
    recordedAt: new Date(NOW).toISOString(),
    text: 'legacy accepted line',
  };
  const second = { ...first, id: 'semantic-row', messageId: 'm2', text: 'semantic appended line' };
  let service = createMemoryDb({ hot, dataDir, log: quiet, worker: false, now: () => NOW });
  service.keepPending({ op: 'lines', owner: 'guilds/g1/record/2026-10/2026-10-20.jsonl', lines: [first] });
  try {
    await service.open();
    assert.deepEqual(
      unitLines(service.database(), day).map((line) => json(line)),
      [first]
    );
    assert.deepEqual(fs.readdirSync(path.join(dataDir, 'memory-pending')), []);
    await service.writeUnit({ op: 'lines', key: day, lines: [second] });
    await service.close();
    service = createMemoryDb({ hot, dataDir, log: quiet, worker: false, now: () => NOW });
    await service.open();
    assert.deepEqual(
      unitLines(service.database(), day).map((line) => json(line)),
      [first, second]
    );
    assert.equal(listUnits(service.database()!, day)[0].lines, 2);
  } finally {
    await service.close();
  }
});
