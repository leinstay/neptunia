// Semantic ownership preserves migrated collections and session changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyUnitWrite } from '../src/memory/db/unit-write.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { unitRows } from '../src/memory/db/export.ts';
import { listUnits } from '../src/memory/db/storage-units.ts';
import type { StorageKey } from '../src/memory/db/storage-keys.ts';
import { dbOf, type Db } from '../src/memory/db/types.ts';
import { fixture, NOW } from './fixtures/memory-db/session-rig.ts';
import { a, profile } from './fixtures/memory-db/storage-ownership.ts';

// A second collection of the same account: its scope by root is gone, so a partition keeps the two owners apart.
const b: StorageKey = { ...a, partition: 'second' };

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
    // The profile of an account no row held made the account's meta-person; her session writes about that person.
    const person = String(env.db.prepare('SELECT person_id FROM accounts WHERE id = ?').get(a.subject.id)?.person_id);
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
            subjectId: person,
            kind: 'detail',
            text: 'session fact',
            how: 'said',
            sources: [source],
            when: null,
          },
        ],
        episodes: [],
        descriptions: [],
        affinity: [{ personId: person, delta: 3, reason: 'session reason', sources: [source] }],
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
    assert.equal(env.db.prepare('SELECT affinity FROM people WHERE id = ?').get(person)?.affinity, 5);
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
