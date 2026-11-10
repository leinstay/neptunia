// Semantic ownership preserves migrated collections and session changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyUnitUpdate } from './fixtures/memory-db/unit-writes.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { unitValue } from '../src/memory/db/readers/common.ts';
import type { Db } from '../src/memory/db/types.ts';
import { fixture, NOW } from './fixtures/memory-db/session-rig.ts';
import { a, profile } from './fixtures/memory-db/storage-ownership.ts';

// A second collection of the same account: its scope by root is gone, so a partition keeps the two owners apart.

function evidence(db: Db, id: unknown) {
  return db
    .prepare('SELECT source_id, position, retired_at FROM claim_sources WHERE claim_id = ? ORDER BY rowid')
    .all(id)
    .map((row) => [row.source_id, row.position, row.retired_at]);
}

test('collection replacement retains session-owned rows, evidence and held affinity fields', () => {
  const env = fixture();
  try {
    applyUnitUpdate(env.handle, { op: 'value', key: a, value: profile });
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
    applyUnitUpdate(env.handle, { op: 'value', key: a, value: profile });
    assert.deepEqual(evidence(env.db, claim.id), links);
    assert.equal(env.db.prepare('SELECT affinity FROM people WHERE id = ?').get(person)?.affinity, 5);
    assert.ok(JSON.stringify((unitValue(env.db, a) as { value?: unknown }).value).includes('session fact'));
  } finally {
    env.done();
  }
});
