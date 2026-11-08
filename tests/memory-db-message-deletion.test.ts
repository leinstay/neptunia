// Authorless normalized deletions share the message family and commit their own accepted receipt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deleteMessage, observeMessage } from '../src/memory/db/message-families.ts';
import { observationOf } from '../src/memory/db/observe-event.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { window } from '../src/memory/db/recall.ts';
import { internalContext } from '../src/memory/db/scope.ts';
import type { ObserveResult } from '../src/memory/db/observe.ts';

const NOW = Date.parse('2026-10-24T12:00:00Z');
const options = { now: () => NOW, log: { debug() {}, info() {}, warn() {}, error() {} } };
const locator = (room: string) => ({ iface: 'synthetic', chatId: room, messageId: 'same-message' });
function input(room: string, eventId = 'delete-event') {
  return {
    v: 1,
    iface: 'synthetic',
    authority: 'synthetic/global',
    messageLocator: { v: 1, origin: 'protocol-message', ...locator(room) },
    messageChat: { id: room, chatType: 'channel' },
    occurredAt: new Date(NOW).toISOString(),
    observedAt: new Date(NOW).toISOString(),
    ingest: {
      row: { principal: 'adapter', seq: null, eventId, kind: 'message.received', chat: room },
      keepDays: 7,
    },
  };
}
function observed(room: string) {
  const result = observationOf({
    iface: 'synthetic',
    at: NOW,
    chat: { id: room, kind: 'channel', chatType: 'channel' },
    message: { id: 'same-message', at: NOW - 60000, content: `Archive ${room}`, author: { id: 'member' } },
  });
  if (!result) throw new Error('synthetic observation refused');
  return result;
}
function source(result: ObserveResult): string {
  assert.equal(result.ok, true, JSON.stringify(result));
  if (typeof result.sourceId !== 'string') throw new Error('writer omitted source');
  return result.sourceId;
}

test('an authorless deletion hides only its chat while retaining archival text and its receipt', () => {
  const handle = openMemoryDb(':memory:');
  try {
    const a = source(observeMessage(handle, observed('room-a'), options));
    const b = source(observeMessage(handle, observed('room-b'), options));
    const deleted = source(deleteMessage(handle, input('room-a'), options));
    const db = dbOf(handle);
    assert.deepEqual(
      db
        .prepare('SELECT text FROM sources WHERE id IN (?, ?) ORDER BY text')
        .all(a, b)
        .map((row) => row.text),
      ['Archive room-a', 'Archive room-b']
    );
    assert.equal(db.prepare('SELECT author_account FROM sources WHERE id = ?').get(deleted)?.author_account, null);
    assert.equal(db.prepare('SELECT source_id FROM ingest WHERE event_id = ?').get('delete-event')?.source_id, deleted);
    for (const room of ['room-a', 'room-b'])
      assert.equal(
        window(db, { ctx: internalContext(), resolvedAnchor: { kind: 'native', locator: locator(room) }, messages: 1 })
          .unknown,
        room === 'room-a'
      );
  } finally {
    handle.close();
  }
});

test('an unseen deletion reserves its family and a later observation cannot revive it', () => {
  const handle = openMemoryDb(':memory:');
  try {
    const deleted = source(deleteMessage(handle, input('room-a'), { ...options, newKey: () => 'reserved-deletion' }));
    observeMessage(handle, observed('room-a'), options);
    const db = dbOf(handle);
    assert.equal(db.prepare('SELECT native_key FROM message_families').get()?.native_key, 'reserved-deletion');
    assert.equal(db.prepare('SELECT native_id FROM sources WHERE id = ?').get(deleted)?.native_id, 'reserved-deletion');
    assert.equal(
      window(db, {
        ctx: internalContext(),
        resolvedAnchor: { kind: 'native', locator: locator('room-a') },
        messages: 1,
      }).unknown,
      true
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM message_families').get()?.n, 1);
  } finally {
    handle.close();
  }
});

test('replaying an accepted deletion returns the original tombstone without duplicating it', () => {
  const handle = openMemoryDb(':memory:');
  try {
    source(observeMessage(handle, observed('room-a'), options));
    const first = source(deleteMessage(handle, input('room-a'), options));
    const before = dbOf(handle).prepare('SELECT * FROM sources ORDER BY id').all();
    assert.equal(source(deleteMessage(handle, input('room-a'), options)), first);
    assert.deepEqual(dbOf(handle).prepare('SELECT * FROM sources ORDER BY id').all(), before);
  } finally {
    handle.close();
  }
});

test('a malformed deletion descriptor writes neither tombstone nor receipt', () => {
  const handle = openMemoryDb(':memory:');
  try {
    const bad = { ...input('room-a'), messageChat: { id: 'other-room', chatType: 'channel' } };
    assert.deepEqual(deleteMessage(handle, bad, options), { ok: false, code: 'BAD_PLACE' });
    for (const table of ['sources', 'ingest', 'message_families'])
      assert.deepEqual(dbOf(handle).prepare(`SELECT * FROM ${table}`).all(), []);
  } finally {
    handle.close();
  }
});
