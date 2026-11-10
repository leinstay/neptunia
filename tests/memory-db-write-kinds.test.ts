// The writer's own kinds for what the unit write used to carry (src/memory/db/session-write.ts): a name the owner gives a
// person (`owner-name`, src/memory/db/owner-names.ts) and the projection job (`project`, src/memory/db/graph.ts), and the
// unit write itself refused. Synthetic ids and names over a fresh memory database and a test memory service.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db } from '../src/memory/db/types.ts';
import { freshMemoryDb } from './fixtures/memory-db-copy.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';

const NOW = Date.parse('2026-11-10T10:00:00.000Z');

const ownerAliases = (db: Db, person: string): Array<unknown> =>
  db
    .prepare(
      "SELECT text FROM claims WHERE subject_id = ? AND kind = 'alias' AND author = 'owner' AND retired_at IS NULL"
    )
    .all(person)
    .map((row) => row.text);

test('the owner-name kind adds an owner alias once and retires it on a remove', () => {
  const handle = freshMemoryDb();
  try {
    const db = dbOf(handle);
    applyMemoryWrite(handle, { kind: 'owner-name', personId: 'person:self', name: 'Zefira', now: NOW });
    applyMemoryWrite(handle, { kind: 'owner-name', personId: 'person:self', name: 'zefira', now: NOW + 1 });
    assert.deepEqual(ownerAliases(db, 'person:self'), ['Zefira']);
    applyMemoryWrite(handle, { kind: 'owner-name', personId: 'person:self', name: 'ZEFIRA', remove: true, now: NOW });
    assert.deepEqual(ownerAliases(db, 'person:self'), []);
  } finally {
    handle.close();
  }
});

test('the owner-name kind refuses a write with no person or no name', () => {
  const handle = freshMemoryDb();
  try {
    assert.throws(
      () => applyMemoryWrite(handle, { kind: 'owner-name', personId: 'person:self', name: '  ', now: NOW }),
      (error: unknown) => (error as { code?: unknown }).code === 'OWNER_NAME_BAD'
    );
  } finally {
    handle.close();
  }
});

test('a unit write is refused: no writer takes one', () => {
  const handle = freshMemoryDb();
  try {
    assert.throws(
      () =>
        applyMemoryWrite(handle, {
          kind: 'unit',
          op: 'value',
          key: { kind: 'state', subject: { type: 'persona', id: 'persona:local' } },
          value: {},
        }),
      (error: unknown) => (error as { code?: unknown }).code === 'BAD_UPDATE'
    );
  } finally {
    handle.close();
  }
});

test('the service writes an owner name through its own method and offers no unit write', async () => {
  const opened = await openTestMemory({ now: () => NOW });
  try {
    const service = opened.memoryDb as unknown as Record<string, unknown>;
    assert.equal(service.writeUnit, undefined);
    await (service.writeOwnerName as (write: object) => Promise<unknown>)({ personId: 'person:self', name: 'Zefira' });
    const db = dbOf(opened.memoryDb.readHandle() as never);
    assert.deepEqual(ownerAliases(db, 'person:self'), ['Zefira']);
  } finally {
    await opened.close();
  }
});

test('a selfreflection the store writes names the first enabled mirror as the destination of its publications', async () => {
  // Bug: the destination was stamped on the unit write alone, so the direct write left her publications with none.
  const opened = await openTestMemory({ now: () => NOW, iface: () => 'discord' });
  try {
    const db = dbOf(opened.memoryDb.readHandle() as never);
    const writer = dbOf(opened.memoryDb.database() as never);
    writer.exec(`
      INSERT OR IGNORE INTO places (id, iface, kind, native_id) VALUES ('discord:channel:c9', 'discord', 'channel', 'c9');
      INSERT INTO mirrors (id, row_kind, place_id, enabled, created_at, created_by)
        VALUES ('mirror-1', 'selfreflection', 'discord:channel:c9', 1, '2026-11-01T00:00:00.000Z', 'owner');
    `);
    const post = {
      at: NOW,
      kind: 'day',
      gist: 'a quiet day',
      picture: null,
      messageIds: ['m1'],
      search: null,
      itemId: 'd-1',
    };
    await opened.memoryDb.writeSelfreflection({ value: { updatedAt: NOW, posts: [post] } });
    const rows = db
      .prepare("SELECT destination_place_id AS place FROM publications WHERE row_kind = 'selfreflection'")
      .all()
      .map((row) => row.place);
    assert.ok(rows.length > 0, 'the post has a publication');
    assert.deepEqual([...new Set(rows)], ['discord:channel:c9']);
  } finally {
    await opened.close();
  }
});
