// Version step 54 (src/memory/db/own-lines.ts): a line of hers that the record also stored as a member's `seen` line
// under her own account is retired, so a read of that chat shows her line once. Synthetic rows over a fresh database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retireOwnLinesSeenTwice } from '../src/memory/db/own-lines.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db } from '../src/memory/db/types.ts';
import { freshMemoryDb } from './fixtures/memory-db-copy.ts';

const AT = '2026-11-10T12:00:00.000Z';
const PLACE = 'chat:channel:c1';

function world(db: Db): void {
  db.exec(`
    INSERT OR IGNORE INTO interfaces (id, name, contract) VALUES ('chat', 'chat', 1);
    INSERT OR IGNORE INTO authorities (id, iface, namespace) VALUES ('chat/global', 'chat', 'global');
    INSERT OR IGNORE INTO people (id, first_seen_at) VALUES ('person:other', '2026-10-01T00:00:00.000Z');
    INSERT INTO accounts (id, iface, native_id, native_key, authority_id, generation, kind, person_id, link, linked_by)
      VALUES ('chat:her', 'chat', 'her', 'her', 'chat/global', 1, 'user', 'person:self', 'verified', 'owner'),
             ('chat:ann', 'chat', 'ann', 'ann', 'chat/global', 1, 'user', 'person:other', 'verified', 'owner');
  `);
  const line = db.prepare(
    `INSERT INTO sources (id, kind, iface, native_id, revision, place_id, author_account, text, occurred_at, recorded_at)
     VALUES (?, ?, 'chat', ?, 1, ?, ?, ?, '2026-10-20T10:00:00.000Z', '2026-10-20T10:00:00.000Z')`
  );
  line.run('src:said-1', 'said', 'u-1', PLACE, null, 'the tide is out');
  line.run('src:seen-dup', 'seen', 'm-1', PLACE, 'chat:her', 'the tide is out');
  line.run('src:seen-other', 'seen', 'm-2', PLACE, 'chat:ann', 'the tide is out');
  line.run('src:seen-alone', 'seen', 'm-3', PLACE, 'chat:her', 'a line the record holds once');
  line.run('src:seen-elsewhere', 'seen', 'm-4', 'chat:channel:c2', 'chat:her', 'the tide is out');
}

const retired = (db: Db, id: string): unknown =>
  db.prepare('SELECT retired_at FROM sources WHERE id = ?').get(id)?.retired_at ?? null;

test('her line stored again as a seen line of her account in the same chat is retired, and nothing else', () => {
  const handle = freshMemoryDb();
  try {
    const db = dbOf(handle);
    world(db);
    assert.equal(retireOwnLinesSeenTwice(db, AT), 1);
    assert.equal(retired(db, 'src:seen-dup'), AT);
    for (const id of ['src:said-1', 'src:seen-other', 'src:seen-alone', 'src:seen-elsewhere'])
      assert.equal(retired(db, id), null, id);
  } finally {
    handle.close();
  }
});

test('a second run retires nothing more', () => {
  const handle = freshMemoryDb();
  try {
    const db = dbOf(handle);
    world(db);
    retireOwnLinesSeenTwice(db, AT);
    assert.equal(retireOwnLinesSeenTwice(db, AT), 0);
  } finally {
    handle.close();
  }
});
