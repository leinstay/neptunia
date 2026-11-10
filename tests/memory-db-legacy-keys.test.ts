// The `legacy/local` authority leaves the database (src/memory/db/legacy-keys.ts): its keys named each person, and each
// account and place spelled the old Discord way, by its own id, and nothing read them. The writers stop adding them, and
// version step 56 deletes the keys, the authority row and its graph node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { observationOf } from '../src/memory/db/observe-event.ts';
import { MIGRATIONS } from '../src/memory/db/schema.ts';
import { BASELINE_VERSION } from '../src/memory/db/schema-baseline.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db } from '../src/memory/db/types.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';
import { tempDir } from './fixtures/tmp.ts';

const NOW = Date.parse('2026-11-10T10:00:00.000Z');
const LEGACY = 'legacy/local';

const legacyKeys = (db: Db): number =>
  Number(db.prepare('SELECT COUNT(*) AS n FROM external_keys WHERE authority_id = ?').get(LEGACY)?.n);

test('an observed Discord message and a profile write add no key under the legacy authority', async () => {
  // Catches: a writer that still registers a row's own id under `legacy/local`, which nothing reads.
  const memory = await openTestMemory({ now: () => NOW, iface: () => 'discord' });
  try {
    const observed = observationOf({
      iface: 'discord',
      at: NOW,
      chat: { id: '700000000000000001', kind: 'channel', chatType: 'channel' },
      message: { id: '800000000000000001', at: NOW, content: 'a synthetic line', author: { id: '900000000000000001' } },
    });
    if (!observed) throw new Error('synthetic message rejected');
    await memory.memoryDb.observeMessage(observed, {});
    const db = dbOf(memory.memoryDb.readHandle()!);
    const account = 'discord:900000000000000001';
    assert.equal(db.prepare('SELECT id FROM accounts WHERE native_id = ?').get('900000000000000001')?.id, account);
    await memory.memoryDb.memoryWrite({
      kind: 'account-profile',
      accountId: account,
      value: { names: ['Synthetic'] },
      iface: 'discord',
      now: NOW,
    });
    // The profile wrote the account's person, the row the people branch of the key writer names.
    assert.equal(
      db.prepare("SELECT id FROM people WHERE writer = 'profile' AND holder_id = ?").get(account)?.id,
      db.prepare('SELECT person_id FROM accounts WHERE id = ?').get(account)?.person_id
    );
    assert.equal(legacyKeys(db), 0);
  } finally {
    await memory.close();
  }
});

test('version step 56 deletes the legacy keys, the authority row and its node, and keeps every other key', () => {
  // Catches: a legacy key, the authority or its node left behind, or a native key of the same node deleted with them.
  const file = path.join(tempDir('legacy-keys'), 'memory.db');
  const old = openMemoryDb(file, { migrations: MIGRATIONS.slice(0, 55 - BASELINE_VERSION) });
  const at = '2026-11-01T00:00:00.000Z';
  const key = dbOf(old).prepare(
    'INSERT INTO external_keys (authority_id, object_kind, native_key, generation, node_id, recorded_at) VALUES (?, ?, ?, 1, ?, ?)'
  );
  key.run(LEGACY, 'person', 'person:p1', 'person:p1', at);
  key.run(LEGACY, 'account', 'discord:u1', 'discord:u1', at);
  key.run('discord/global', 'account', 'u1', 'discord:u1', at);
  old.close();
  const handle = openMemoryDb(file);
  try {
    const db = dbOf(handle);
    assert.equal(legacyKeys(db), 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM authorities WHERE id = ?').get(LEGACY)?.n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM graph_nodes WHERE id = ?').get(`authority:${LEGACY}`)?.n, 0);
    assert.equal(
      db.prepare("SELECT node_id FROM external_keys WHERE authority_id = 'discord/global' AND native_key = 'u1'").get()
        ?.node_id,
      'discord:u1'
    );
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    handle.close();
  }
});
