// Tests for schema v16 of the memory database (src/memory/db/schema.js): the `ingest` table holds one row per event
// the core committed, scoped by the principal that sent it, and `ingest_cursor` the watermark acknowledged to each
// principal. An event id and a seq are each unique within a principal, so a redelivered event can never be taken
// twice, while two principals may use the same id and the same seq. The database is in memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/memory/db/open.js';

type Db = { prepare(sql: string): { run(...args: Array<unknown>): unknown; get(...args: Array<unknown>): unknown } };

const INSERT =
  'INSERT INTO ingest (principal, seq, event_id, kind, conversation, committed_at) VALUES (?, ?, ?, ?, ?, ?)';
const AT = '2026-10-27T12:00:00.000Z';

function opened(): { db: Db; close(): void } {
  const handle = openMemoryDb(':memory:');
  return { db: handle.db as Db, close: () => handle.close() };
}

test('the same event id of one principal is refused a second time under another seq', () => {
  const memory = opened();
  const { db } = memory;
  try {
    db.prepare(INSERT).run('fake', 1, 'fake:message:m1', 'message.received', 'c1', AT);
    assert.throws(() => db.prepare(INSERT).run('fake', 2, 'fake:message:m1', 'message.received', 'c1', AT), /UNIQUE/);
  } finally {
    memory.close();
  }
});

test('the same seq of one principal is refused a second time under another event id', () => {
  const memory = opened();
  const { db } = memory;
  try {
    db.prepare(INSERT).run('fake', 1, 'fake:message:m1', 'message.received', 'c1', AT);
    assert.throws(() => db.prepare(INSERT).run('fake', 1, 'fake:message:m2', 'message.received', 'c1', AT), /UNIQUE/);
  } finally {
    memory.close();
  }
});

test('two principals may each commit the same event id under the same seq', () => {
  const memory = opened();
  const { db } = memory;
  try {
    db.prepare(INSERT).run('fake', 1, 'shared:1', 'reaction.changed', 'c1', AT);
    db.prepare(INSERT).run('other', 1, 'shared:1', 'reaction.changed', 'c1', AT);
    assert.deepEqual({ ...(db.prepare('SELECT COUNT(*) AS n FROM ingest').get() as object) }, { n: 2 });
  } finally {
    memory.close();
  }
});

test('ingest_cursor keeps one watermark per principal', () => {
  const memory = opened();
  const { db } = memory;
  try {
    db.prepare('INSERT INTO ingest_cursor (principal, acked_seq) VALUES (?, ?)').run('fake', 3);
    assert.throws(() => db.prepare('INSERT INTO ingest_cursor (principal, acked_seq) VALUES (?, ?)').run('fake', 4));
  } finally {
    memory.close();
  }
});
