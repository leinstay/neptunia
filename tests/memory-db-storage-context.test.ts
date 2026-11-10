// The context a writer gives the row builders of a stored value (src/memory/db/storage-context.ts): the subject as the
// database holds it, and the interface of the write for a subject no row holds yet. Synthetic ids over a fresh database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storageContext } from '../src/memory/db/storage-context.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { freshMemoryDb } from './fixtures/memory-db-copy.ts';

test('a stored account names its interface, native id and person', () => {
  const handle = freshMemoryDb();
  try {
    const db = dbOf(handle);
    db.exec(`
      INSERT OR IGNORE INTO interfaces (id, name, contract) VALUES ('chat', 'chat', 1);
      INSERT OR IGNORE INTO authorities (id, iface, namespace) VALUES ('chat/global', 'chat', 'global');
      INSERT OR IGNORE INTO people (id, first_seen_at) VALUES ('person:p1', '2026-11-01T00:00:00.000Z');
      INSERT INTO accounts (id, iface, native_id, native_key, authority_id, generation, kind, person_id, link, linked_by)
        VALUES ('chat:n1', 'chat', 'n1', 'n1', 'chat/global', 1, 'user', 'person:p1', 'verified', 'owner');
    `);
    const ctx = storageContext(db, { kind: 'user', subject: { type: 'account', id: 'chat:n1' } }, 'other');
    assert.equal(ctx.iface, 'chat');
    assert.equal(ctx.subjectNativeId, 'n1');
    assert.equal(ctx.subjectPersonId, 'person:p1');
  } finally {
    handle.close();
  }
});

test('an account no row holds takes the interface of the write', () => {
  const handle = freshMemoryDb();
  try {
    const ctx = storageContext(dbOf(handle), { kind: 'user', subject: { type: 'account', id: 'chat:n9' } }, 'other');
    assert.equal(ctx.iface, 'other');
    assert.equal(ctx.subjectNativeId, undefined);
  } finally {
    handle.close();
  }
});
