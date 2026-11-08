// Lazy normalized-message adoption inspects the requested family without making unrelated history a write gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeMessage } from '../src/memory/db/message-families.ts';
import { observe } from '../src/memory/db/observe.ts';
import type { Envelope, ObserveResult } from '../src/memory/db/observe.ts';
import { observationOf } from '../src/memory/db/observe-event.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { dbOf, type Db } from '../src/memory/db/types.ts';

const NOW = Date.parse('2026-11-03T12:00:00Z');
const options = { now: () => NOW, log: { debug() {}, info() {}, warn() {}, error() {} } };

function envelope(chatId: string, messageId: string, text = 'Synthetic evidence'): Envelope {
  const value = observationOf({
    iface: 'synthetic',
    at: NOW,
    chat: { id: chatId, kind: 'channel', chatType: 'channel' },
    message: { id: messageId, at: NOW - 60000, content: text, author: { id: 'member' } },
  });
  assert.ok(value);
  return { ...value, messageChat: { id: chatId, chatType: 'channel' } };
}

function sourceId(result: ObserveResult): string {
  assert.equal(result.ok, true, JSON.stringify(result));
  if (typeof result.sourceId !== 'string') throw new Error('observation has no source ID');
  return result.sourceId;
}

function snapshot(db: Db): Record<string, Array<Record<string, unknown>>> {
  const tables = [
    'sources',
    'message_families',
    'graph_nodes',
    'graph_edges',
    'external_keys',
    'ingest',
    'turn_reads',
    'publications',
  ];
  return Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

test('an unrelated ambiguous historical locator does not block a distinct new message family', () => {
  // Catches a whole-history conflict scan refusing valid writes in unrelated chats.
  const handle = openMemoryDb(':memory:');
  try {
    sourceId(observe(handle, envelope('old-room', 'old-message'), options));
    const competing = envelope('old-room', 'old-message', 'Separate historical family');
    competing.native = { ...competing.native, key: 'second-old-family' };
    sourceId(observe(handle, competing, options));
    const db = dbOf(handle);
    const historical = db.prepare('SELECT * FROM sources ORDER BY id').all();
    const incoming = envelope('new-room', 'new-message', 'Independent new evidence');
    const result = observeMessage(handle, incoming, { ...options, newKey: () => 'new-opaque-family' });
    const id = sourceId(result);
    assert.equal(db.prepare('SELECT text FROM sources WHERE id = ?').get(id)?.text, 'Independent new evidence');
    assert.deepEqual(db.prepare('SELECT * FROM sources WHERE id <> ? ORDER BY id').all(id), historical);
    assert.deepEqual(
      db
        .prepare('SELECT conversation_id, message_id, native_key FROM message_families')
        .all()
        .map((row) => ({ ...row })),
      [{ conversation_id: 'new-room', message_id: 'new-message', native_key: 'new-opaque-family' }]
    );
    assert.equal(sourceId(observeMessage(handle, incoming, options)), id);
  } finally {
    handle.close();
  }
});

for (const wrongRevision of [1, 2]) {
  test(`adoption refuses a matched family whose retained revision ${wrongRevision} names another chat`, () => {
    // Catches narrowing to locator-matching rows and omitting a conflicting revision of the same native family.
    const handle = openMemoryDb(':memory:');
    try {
      sourceId(observe(handle, envelope('target-room', 'target-message'), options));
      const second = envelope('target-room', 'target-message', 'Second revision evidence');
      second.native = { ...second.native, revision: 2 };
      sourceId(observe(handle, second, options));
      const db = dbOf(handle);
      // A synthetic retained historical row disagrees with its sibling's verified locator.
      db.prepare(
        "UPDATE sources SET extra = json_set(extra, '$.$messageLocator.chatId', 'other-room'), retired_at = ? WHERE revision = ?"
      ).run(new Date(NOW).toISOString(), wrongRevision);
      assert.equal(db.prepare('SELECT count(*) AS n FROM sources').get()?.n, 2);
      const before = snapshot(db);
      const incoming = {
        ...envelope('target-room', 'target-message'),
        ingest: {
          row: {
            principal: 'adapter',
            seq: 7,
            eventId: 'adoption-event',
            kind: 'message.received',
            chat: 'target-room',
          },
          keepDays: 7,
        },
      };
      const result = observeMessage(handle, incoming, { ...options, newKey: () => 'must-not-reserve' });
      assert.deepEqual(result, { ok: false, code: 'CONVERSATION_CONFLICT' });
      assert.deepEqual(snapshot(db), before, 'no catalog reservation, source rewrite or ingestion receipt survives');
    } finally {
      handle.close();
    }
  });
}

test('a message stored before the chat rename, with its chatId key, is found again by its address', () => {
  // Catches: the lookup of a retained family reading only `chatId`, so a replayed message of an old row becomes a second source.
  const handle = openMemoryDb(':memory:');
  try {
    const first = sourceId(observe(handle, envelope('old-room', 'old-message'), options));
    const db = dbOf(handle);
    db.prepare(
      `UPDATE sources SET extra = json_set(json_remove(extra, '$.$messageLocator.chatId'), '$.$messageLocator.conversationId', 'old-room') WHERE id = ?`
    ).run(first);
    const again = observeMessage(handle, envelope('old-room', 'old-message'), {
      ...options,
      newKey: () => 'must-not-reserve',
    });
    assert.equal(sourceId(again), first);
    assert.equal(db.prepare('SELECT count(*) AS n FROM sources').get()?.n, 1);
  } finally {
    handle.close();
  }
});
