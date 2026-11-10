// The `legacy/local` authority is no part of the database: its keys named each person, and each account and place
// spelled the old Discord way, by its own id, and nothing read them. The writers add none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observationOf } from '../src/memory/db/observe-event.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db } from '../src/memory/db/types.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';

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
