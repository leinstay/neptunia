// The normalized-message writer and its family catalog, using synthetic envelopes and SQLite only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { observeMessage } from '../src/memory/db/message-families.ts';
import { observe } from '../src/memory/db/observe.ts';
import type { Envelope, ObserveResult } from '../src/memory/db/observe.ts';
import { insertRows } from '../src/memory/db/rows.ts';
import { toRows as recordRows } from '../src/memory/db/map/record.ts';
import { observationOf } from '../src/memory/db/observe-event.ts';
import { openMemoryDb, MIGRATIONS, migrate, schemaVersion } from '../src/memory/db/open.ts';
import { createMemoryDb } from '../src/memory/db/service.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, MemoryHandle } from '../src/memory/db/types.ts';

// These migration cases target V23 even when later schema migrations are available.
const CATALOG_MIGRATIONS = MIGRATIONS.slice(0, 23);

const NOW = Date.parse('2026-10-24T12:00:00Z');
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const options = { now: () => NOW, log: quiet };

function envelope(conversationId = 'room-a', text = 'Original evidence', edited = false): Envelope {
  const mapped = observationOf({
    iface: 'synthetic',
    at: NOW,
    edit: edited,
    conversation: { id: conversationId, kind: 'channel', chatType: 'channel' },
    message: { id: 'same-message', at: NOW - 60000, content: text, author: { id: 'member' } },
  });
  assert.ok(mapped);
  return { ...mapped, messageConversation: { id: conversationId, chatType: 'channel' } };
}

function sourceId(result: ObserveResult): string {
  assert.equal(result.ok, true, JSON.stringify(result));
  if (typeof result.sourceId !== 'string') throw new Error('successful observation has no source ID');
  return result.sourceId;
}

function rows(db: Db, table: string): Array<Record<string, unknown>> {
  return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
}

function snapshot(db: Db): Record<string, Array<Record<string, unknown>>> {
  return Object.fromEntries(
    ['sources', 'graph_nodes', 'graph_edges', 'external_keys', 'ingest', 'turn_reads', 'publications'].map((table) => [
      table,
      rows(db, table),
    ])
  );
}

function families(db: Db): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM message_families ORDER BY conversation_id, message_id').all();
}

function oldHandle(): MemoryHandle {
  return openMemoryDb(':memory:', { migrations: MIGRATIONS.slice(0, 22) });
}

test('normalized messages with one native ID in two conversations receive separate families', () => {
  const handle = openMemoryDb(':memory:');
  try {
    const first = sourceId(
      observeMessage(handle, envelope('room-a', 'First evidence'), { ...options, newKey: () => 'family-a' })
    );
    const second = sourceId(
      observeMessage(handle, envelope('room-b', 'Second evidence'), { ...options, newKey: () => 'family-b' })
    );
    assert.notEqual(first, second);
    assert.deepEqual(
      rows(dbOf(handle), 'sources').map((row) => row.text),
      ['First evidence', 'Second evidence']
    );
    assert.deepEqual(
      families(dbOf(handle)).map((row) => [row.conversation_id, row.message_id, row.native_key]),
      [
        ['room-a', 'same-message', 'family-a'],
        ['room-b', 'same-message', 'family-b'],
      ]
    );
  } finally {
    handle.close();
  }
});

test('replaying a normalized message returns its source without allocating another family', () => {
  const handle = openMemoryDb(':memory:');
  try {
    const first = sourceId(observeMessage(handle, envelope(), { ...options, newKey: () => 'family-a' }));
    const replay = observeMessage(handle, envelope(), {
      ...options,
      newKey: () => {
        throw new Error('replay allocated');
      },
    });
    assert.equal(sourceId(replay), first);
    assert.equal(replay.replayed, true);
    assert.equal(rows(dbOf(handle), 'sources').length, 1);
    assert.equal(families(dbOf(handle)).length, 1);
  } finally {
    handle.close();
  }
});

test('editing one normalized family preserves the other conversation and replays the edit', () => {
  const handle = openMemoryDb(':memory:');
  try {
    sourceId(observeMessage(handle, envelope(), { ...options, newKey: () => 'family-a' }));
    const other = sourceId(
      observeMessage(handle, envelope('room-b', 'Other conversation'), { ...options, newKey: () => 'family-b' })
    );
    const edited = sourceId(observeMessage(handle, envelope('room-a', 'Edited evidence', true), options));
    assert.equal(sourceId(observeMessage(handle, envelope('room-a', 'Edited evidence', true), options)), edited);
    const db = dbOf(handle);
    assert.deepEqual(
      db
        .prepare('SELECT revision, text FROM sources WHERE native_id = ? ORDER BY revision')
        .all('family-a')
        .map((row) => [row.revision, row.text]),
      [
        [1, 'Original evidence'],
        [2, 'Edited evidence'],
      ]
    );
    assert.equal(db.prepare('SELECT text FROM sources WHERE id = ?').get(other)?.text, 'Other conversation');
    assert.equal(rows(db, 'sources').length, 3);
  } finally {
    handle.close();
  }
});

test('generic observation retains tuple identity when a replay changes its place', () => {
  const handle = openMemoryDb(':memory:');
  try {
    const firstEnvelope = envelope();
    const first = sourceId(observe(handle, firstEnvelope, options));
    const changed = { ...firstEnvelope, place: { ...firstEnvelope.place, key: 'channel:room-b' } };
    assert.equal(sourceId(observe(handle, changed, options)), first);
    assert.equal(rows(dbOf(handle), 'sources').length, 1);
  } finally {
    handle.close();
  }
});

test('late verified historical observations are adopted without changing source IDs', () => {
  const handle = openMemoryDb(':memory:');
  try {
    const historical = sourceId(observe(handle, envelope(), options));
    const before = rows(dbOf(handle), 'sources');
    const adopted = observeMessage(handle, envelope(), {
      ...options,
      newKey: () => {
        throw new Error('historical family allocated');
      },
    });
    assert.equal(sourceId(adopted), historical);
    assert.equal(adopted.replayed, true);
    assert.deepEqual(rows(dbOf(handle), 'sources'), before);
    assert.equal(families(dbOf(handle))[0].native_key, 'same-message');
  } finally {
    handle.close();
  }
});

test('a family allocation collision leaves sources and ingestion receipts unchanged', () => {
  const handle = openMemoryDb(':memory:');
  try {
    sourceId(observeMessage(handle, envelope(), { ...options, newKey: () => 'reserved' }));
    const db = dbOf(handle);
    const before = snapshot(db);
    const catalog = families(db);
    const failed = observeMessage(
      handle,
      {
        ...envelope('room-b'),
        ingest: {
          row: { principal: 'adapter', seq: 1, eventId: 'event-b', kind: 'message.received', conversation: 'room-b' },
          keepDays: 7,
        },
      },
      { ...options, newKey: () => 'reserved' }
    );
    assert.deepEqual(failed, { ok: false, code: 'KEY_COLLISION' });
    assert.deepEqual(snapshot(db), before);
    assert.deepEqual(families(db), catalog);
  } finally {
    handle.close();
  }
});

test('a normalized observation commits its supplied ingestion receipt with its source', () => {
  const handle = openMemoryDb(':memory:');
  try {
    sourceId(
      observeMessage(
        handle,
        {
          ...envelope(),
          ingest: {
            row: { principal: 'adapter', seq: 1, eventId: 'event-a', kind: 'message.received', conversation: 'room-a' },
            keepDays: 7,
          },
        },
        { ...options, newKey: () => 'family-a' }
      )
    );
    assert.equal(
      dbOf(handle).prepare('SELECT event_id FROM ingest WHERE principal = ?').get('adapter')?.event_id,
      'event-a'
    );
    assert.equal(rows(dbOf(handle), 'sources').length, 1);
    assert.equal(families(dbOf(handle)).length, 1);
  } finally {
    handle.close();
  }
});

for (const descriptor of [
  undefined,
  { id: 'wrong-room', chatType: 'channel' },
  { id: 'room-a', chatType: 'unknown' },
  { id: 'room-a', chatType: 'dm' },
]) {
  test(`a malformed conversation descriptor ${JSON.stringify(descriptor)} refuses allocation`, () => {
    const handle = openMemoryDb(':memory:');
    try {
      let allocated = 0;
      const before = snapshot(dbOf(handle));
      assert.deepEqual(
        observeMessage(
          handle,
          { ...envelope(), messageConversation: descriptor },
          {
            ...options,
            newKey: () => {
              allocated += 1;
              return 'unused';
            },
          }
        ),
        { ok: false, code: 'BAD_PLACE' }
      );
      assert.equal(allocated, 0);
      assert.deepEqual(snapshot(dbOf(handle)), before);
      assert.deepEqual(families(dbOf(handle)), []);
    } finally {
      handle.close();
    }
  });
}

test('the protocol mapper retains actual DM conversation separately from the partner place', () => {
  const mapped = observationOf({
    iface: 'synthetic',
    at: NOW,
    conversation: { id: 'actual-dm', kind: 'dm', chatType: 'dm', partnerId: 'member' },
    message: { id: 'same-message', at: NOW, content: 'Private evidence', author: { id: 'member' } },
  });
  assert.equal(mapped?.place.key, 'dm:member');
  assert.deepEqual(mapped?.messageConversation, { id: 'actual-dm', chatType: 'dm', partnerId: 'member' });
  assert.equal(mapped?.messageLocator?.conversationId, 'actual-dm');
});

test('V23 creates an empty catalog without rewriting source or graph rows', () => {
  const handle = oldHandle();
  try {
    const db = dbOf(handle);
    const before = snapshot(db);
    migrate(db, CATALOG_MIGRATIONS);
    assert.equal(schemaVersion(db), 23);
    assert.deepEqual(families(db), []);
    assert.deepEqual(snapshot(db), before);
  } finally {
    handle.close();
  }
});

test('V23 adopts verified retained revisions and preserves their source and graph identities', () => {
  const handle = oldHandle();
  try {
    const first = sourceId(observe(handle, envelope(), options));
    sourceId(observe(handle, envelope('room-a', 'Historical edit', true), options));
    const db = dbOf(handle);
    db.prepare('UPDATE sources SET retired_at = ? WHERE revision = 1').run('2026-10-24T11:00:00Z');
    db.prepare(
      "INSERT INTO turn_reads (turn_id, step, context_id, row_kind, row_id) VALUES ('turn-a', '1', '', 'source', ?)"
    ).run(first);
    db.prepare(
      "INSERT INTO publications (id, row_kind, row_id, status, idempotency_key, created_at) VALUES ('publication-a', 'source', ?, 'queued', 'publication-key', ?)"
    ).run(first, new Date(NOW).toISOString());
    const before = snapshot(db);
    migrate(db, CATALOG_MIGRATIONS);
    assert.equal(schemaVersion(db), 23);
    assert.deepEqual(snapshot(db), before);
    assert.deepEqual(
      families(db).map((row) => [row.conversation_id, row.native_key]),
      [['room-a', 'same-message']]
    );
    migrate(db, CATALOG_MIGRATIONS);
    assert.deepEqual(snapshot(db), before);
    assert.equal(families(db).length, 1);
  } finally {
    handle.close();
  }
});

test('V23 leaves generic message keys without verified locator provenance uncatalogued', () => {
  const handle = oldHandle();
  try {
    const generic = envelope();
    delete generic.messageLocator;
    sourceId(observe(handle, generic, options));
    const before = snapshot(dbOf(handle));
    migrate(dbOf(handle), CATALOG_MIGRATIONS);
    assert.equal(schemaVersion(dbOf(handle)), 23);
    assert.deepEqual(families(dbOf(handle)), []);
    assert.deepEqual(snapshot(dbOf(handle)), before);
  } finally {
    handle.close();
  }
});

for (const conflict of ['locator', 'family'] as const) {
  test(`V23 rolls back when historical ${conflict} mappings disagree`, () => {
    const handle = oldHandle();
    try {
      const first = envelope();
      sourceId(observe(handle, first, options));
      const second = envelope('room-a', 'Second historical evidence');
      second.native = {
        ...second.native,
        key: conflict === 'locator' ? 'independent-family' : 'same-message',
        revision: 2,
      };
      const id = sourceId(observe(handle, second, options));
      const db = dbOf(handle);
      if (conflict === 'family')
        db.prepare(
          "UPDATE sources SET extra = json_set(extra, '$.$messageLocator.conversationId', 'room-b') WHERE id = ?"
        ).run(id);
      db.prepare('UPDATE sources SET retired_at = ? WHERE revision = 1').run('2026-10-24T11:00:00Z');
      const before = snapshot(db);
      assert.throws(() => migrate(db, CATALOG_MIGRATIONS), { code: 'CONVERSATION_CONFLICT' });
      assert.equal(schemaVersion(db), 22);
      assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'message_families'").get(), undefined);
      assert.deepEqual(snapshot(db), before);
    } finally {
      handle.close();
    }
  });
}

for (const worker of [false, true]) {
  test(`the normalized writer request preserves families with worker ${worker}`, async () => {
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'message-families-'));
    const service = createMemoryDb({
      dataDir: root,
      hot: { config: { memoryDb: { session: { mode: 'off' } } } },
      worker,
      now: () => NOW,
      log: quiet,
    });
    try {
      await service.tick();
      const first = await service.observeMessage({ ...envelope(), newKey: 'untrusted-key' });
      const second = await service.observeMessage(envelope('room-b', 'Other evidence'));
      assert.deepEqual(
        [first && 'ok' in first ? first.ok : null, second && 'ok' in second ? second.ok : null],
        [true, true]
      );
      const db = service.database();
      assert.ok(db);
      assert.equal(rows(db, 'sources').length, 2);
      assert.equal(families(db).length, 2);
      assert.equal(
        families(db).some((row) => row.native_key === 'untrusted-key'),
        false
      );
    } finally {
      await service.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('an observation refusal rolls back the family reservation and supplied ingestion receipt', () => {
  const handle = openMemoryDb(':memory:');
  try {
    const db = dbOf(handle);
    const before = snapshot(db);
    let allocated = 0;
    const failed = observeMessage(
      handle,
      {
        ...envelope(),
        capture: { role: 'reply', bundle: 'missing-bundle' },
        ingest: {
          row: {
            principal: 'adapter',
            seq: 1,
            eventId: 'refused-event',
            kind: 'message.received',
            conversation: 'room-a',
          },
          keepDays: 7,
        },
      },
      {
        ...options,
        newKey: () => {
          allocated += 1;
          return 'rolled-back';
        },
      }
    );
    assert.deepEqual(failed, { ok: false, code: 'UNKNOWN_BUNDLE' });
    assert.equal(allocated, 1);
    assert.deepEqual(snapshot(db), before);
    assert.deepEqual(families(db), []);
  } finally {
    handle.close();
  }
});

test('late ambiguous historical families refuse adoption without modifying either source', () => {
  const handle = openMemoryDb(':memory:');
  try {
    sourceId(observe(handle, envelope(), options));
    const other = envelope();
    other.native = { ...other.native, key: 'other-family' };
    sourceId(observe(handle, other, options));
    const before = snapshot(dbOf(handle));
    const failed = observeMessage(handle, envelope(), {
      ...options,
      newKey: () => {
        throw new Error('ambiguous family allocated');
      },
    });
    assert.deepEqual(failed, { ok: false, code: 'CONVERSATION_CONFLICT' });
    assert.deepEqual(snapshot(dbOf(handle)), before);
    assert.deepEqual(families(dbOf(handle)), []);
  } finally {
    handle.close();
  }
});

for (const opaque of [false, true]) {
  test(`V23 adopts historical record provenance while preserving ${opaque ? 'opaque' : 'Discord'} source IDs`, () => {
    const handle = oldHandle();
    try {
      const mapping = recordRows('private/member/record/2026-10/2026-10-24.jsonl', {
        v: 1,
        id: 'historical-record',
        kind: 'seen',
        messageId: 'historical-message',
        revision: 1,
        occurredAt: new Date(NOW - 60000).toISOString(),
        recordedAt: new Date(NOW).toISOString(),
        guildId: 'g1',
        scope: { channel: 'actual-historical-dm' },
        by: 'member',
        text: 'Historical record evidence',
        origin: 'live',
      });
      const source = mapping.sources[0];
      // The mapper emits JSON metadata, and this fixture removes its marker to model the historical format.
      const extra: Record<string, unknown> = JSON.parse(String(source.extra)) as Record<string, unknown>;
      delete extra.$messageLocator;
      source.extra = JSON.stringify(extra);
      if (opaque) source.id = 'opaque-historical-source';
      insertRows(dbOf(handle), mapping, { log: quiet });
      const before = snapshot(dbOf(handle));
      migrate(dbOf(handle), CATALOG_MIGRATIONS);
      assert.equal(schemaVersion(dbOf(handle)), 23);
      assert.deepEqual(snapshot(dbOf(handle)), before);
      assert.equal(
        dbOf(handle).prepare('SELECT id FROM sources WHERE native_id = ?').get('historical-message')?.id,
        source.id
      );
      assert.deepEqual(
        families(dbOf(handle)).map((row) => [row.iface, row.conversation_id, row.message_id, row.native_key]),
        [['discord', 'actual-historical-dm', 'historical-message', 'historical-message']]
      );
    } finally {
      handle.close();
    }
  });
}

test('an allocated key that belongs to an uncatalogued generic family is refused', () => {
  const handle = openMemoryDb(':memory:');
  try {
    const generic = envelope('historical-room');
    generic.native = { ...generic.native, key: 'reserved-generic-key' };
    sourceId(observe(handle, generic, options));
    const before = snapshot(dbOf(handle));
    assert.deepEqual(
      observeMessage(handle, envelope('new-room'), { ...options, newKey: () => 'reserved-generic-key' }),
      { ok: false, code: 'KEY_COLLISION' }
    );
    assert.deepEqual(snapshot(dbOf(handle)), before);
    assert.deepEqual(families(dbOf(handle)), []);
  } finally {
    handle.close();
  }
});

test('a locator with a different native message ID refuses normalized allocation', () => {
  const handle = openMemoryDb(':memory:');
  try {
    const value = envelope();
    const failed = observeMessage(
      handle,
      {
        ...value,
        messageLocator: { ...value.messageLocator, messageId: 'different-message' },
      },
      {
        ...options,
        newKey: () => {
          throw new Error('invalid locator allocated');
        },
      }
    );
    assert.deepEqual(failed, { ok: false, code: 'BAD_NATIVE' });
    assert.equal(rows(dbOf(handle), 'sources').length, 0);
    assert.deepEqual(families(dbOf(handle)), []);
  } finally {
    handle.close();
  }
});

test('a mapped place that disagrees with the conversation descriptor refuses allocation', () => {
  const handle = openMemoryDb(':memory:');
  try {
    const value = envelope();
    assert.deepEqual(
      observeMessage(
        handle,
        { ...value, place: { ...value.place, key: 'channel:different-room' } },
        {
          ...options,
          newKey: () => {
            throw new Error('invalid place allocated');
          },
        }
      ),
      { ok: false, code: 'BAD_PLACE' }
    );
    assert.equal(rows(dbOf(handle), 'sources').length, 0);
    assert.deepEqual(families(dbOf(handle)), []);
  } finally {
    handle.close();
  }
});

test('two actual DM conversations with one partner retain distinct normalized families', () => {
  const handle = openMemoryDb(':memory:');
  try {
    const ids = ['dm-a', 'dm-b'].map((id) => {
      const value = envelope(id);
      return sourceId(
        observeMessage(
          handle,
          {
            ...value,
            place: {
              authority: value.authority,
              key: 'dm:member',
              kind: 'dm',
              conversation: 'dm',
              partner: { key: 'member' },
            },
            messageConversation: { id, chatType: 'dm', partnerId: 'member' },
          },
          { ...options, newKey: () => `family-${id}` }
        )
      );
    });
    assert.notEqual(ids[0], ids[1]);
    assert.deepEqual(
      families(dbOf(handle)).map((row) => row.conversation_id),
      ['dm-a', 'dm-b']
    );
    assert.equal(new Set(rows(dbOf(handle), 'sources').map((row) => row.place_id)).size, 1);
  } finally {
    handle.close();
  }
});

test('a reused normalized message ID in a new generation receives another family', () => {
  const handle = openMemoryDb(':memory:');
  try {
    const value = envelope();
    const ids = [1, 2].map((generation) =>
      sourceId(
        observeMessage(
          handle,
          {
            ...value,
            native: { ...value.native, generation },
          },
          { ...options, newKey: () => `family-generation-${generation}` }
        )
      )
    );
    assert.notEqual(ids[0], ids[1]);
    assert.deepEqual(
      dbOf(handle)
        .prepare('SELECT generation FROM message_families ORDER BY generation')
        .all()
        .map((row) => row.generation),
      [1, 2]
    );
  } finally {
    handle.close();
  }
});
