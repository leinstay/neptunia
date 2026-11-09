// An episode of the participation store that expires leaves an archive line, which the database keeps as a
// `claim_versions` row naming the episode (`claim_id` = its `pt-` item id, src/memory/db/archive-lines.ts). The episode
// stays as a retired row of `episodes`, so the version must resolve to a row that exists (a claim or an episode) and the
// memory audit's `danglingLinks` must stay 0. Which side moves, the audit's parent set or a stub claim, is the fix's
// choice; the test holds both. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { createAppendStore } from '../src/memory/append-store.ts';
import { createArchive } from '../src/memory/archive.ts';
import { auditMemory } from '../src/memory/db/audit.ts';
import { placeOfRoot } from '../src/memory/addresses.ts';
import { createRecord } from '../src/memory/record.ts';
import { createStore } from '../src/memory/store.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';

const NOW = Date.parse('2026-11-06T07:20:05.000Z');
const HOUR = 3_600_000;
const CHANNEL = '200000000000000001';
const quiet = { info() {}, debug() {}, warn() {}, error() {} };
const settle = async (rounds = 12) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const episode = (n: number, itemId: string, lastOwnAt: number) => ({
  itemId,
  id: `p${n}`,
  placeId: CHANNEL,
  startAt: lastOwnAt,
  lastAt: lastOwnAt,
  lastOwnAt,
  continues: null,
  messages: [
    {
      id: `native-${itemId}`,
      ts: lastOwnAt,
      self: true,
      text: 'a synthetic line',
      authorId: 'bot',
      name: 'persona',
      replyTo: null,
      caption: null,
    },
  ],
});

// Bug (production 2026-11-06): the archive line of an expired participation episode became a live claim_versions
// row whose claim_id names a `pt-` episode that is in no row of `claims`, so the audit counted it dangling.
test('an expired participation episode leaves no claim version without its claim', async () => {
  const env = await openTestMemory({ now: () => NOW, config: { features: { record: true, archive: true } } });
  const appendStore = createAppendStore({ log: quiet, now: () => NOW });
  try {
    const { memoryDb, dataDir } = env;
    const record = createRecord({ dataDir, log: quiet, now: () => NOW, memoryDb });
    const archive = createArchive({ appendStore, dataDir, log: quiet, now: () => NOW, memoryDb });
    const store = createStore({ dataDir, record, recordOn: () => true, archive, archiveOn: () => true, memoryDb });
    const place = placeOfRoot(store, 'g1');
    const settings = { hours: 24 };
    store.setParticipation(
      place,
      { nextId: 3, episodes: [episode(1, 'pt-old', NOW - 30 * HOUR), episode(2, 'pt-new', NOW - HOUR)] },
      { settings, now: NOW - 31 * HOUR }
    );
    await settle();
    // The write past `hours` expires pt-old.
    const kept = store.getParticipation(place);
    const { dropped } = store.setParticipation(place, kept, { settings, now: NOW });
    assert.deepEqual(
      dropped.map((victim) => (victim as { itemId: string }).itemId),
      ['pt-old']
    );
    store.flush();
    await store.flushSettled({});
    await settle();
    await store.flushSettled({ final: true });
    await memoryDb.tick();

    const db = new DatabaseSync(path.join(dataDir, 'memory.db'));
    try {
      const versions = db
        .prepare("SELECT claim_id FROM claim_versions WHERE event = 'expired' AND retired_at IS NULL")
        .all();
      assert.deepEqual(
        versions.map((row) => row.claim_id),
        ['pt-old'],
        'the expiry was archived as a live version'
      );
      const orphans = db
        .prepare(
          `SELECT COUNT(*) AS n FROM claim_versions v WHERE v.retired_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM claims c WHERE c.id = v.claim_id)
           AND NOT EXISTS (SELECT 1 FROM episodes e WHERE e.id = v.claim_id)`
        )
        .get();
      assert.equal(orphans?.n, 0, 'a live version names a row that is in neither claims nor episodes');
      // The rows the test's own synthetic messages leave (a place and sources nothing recorded) are in the audit either
      // way; what the expiry's version adds to `danglingLinks` is the difference to the same database without it.
      const withVersion = auditMemory(db).checks.danglingLinks;
      db.prepare("DELETE FROM claim_versions WHERE event = 'expired'").run();
      assert.equal(withVersion, auditMemory(db).checks.danglingLinks, 'the version counts as dangling');
    } finally {
      db.close();
    }
  } finally {
    await appendStore.close();
    await env.close();
  }
});
