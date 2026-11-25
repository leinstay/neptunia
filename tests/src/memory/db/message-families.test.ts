// The normalized-message writer and its family catalog, using synthetic envelopes and SQLite only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chatsOfMessage, deleteMessage, observeMessage } from '../../../../src/memory/db/message-families.ts';
import { observe } from '../../../../src/memory/db/observe.ts';
import type { Envelope, ObserveResult } from '../../../../src/memory/db/observe.ts';
import { observationOf } from '../../../../src/memory/db/observe-event.ts';
import { openMemoryDb } from '../../../../src/memory/db/open.ts';
import { window } from '../../../../src/memory/db/recall.ts';
import { internalContext } from '../../../../src/memory/db/scope.ts';
import { createMemoryDb } from '../../../../src/memory/db/service.ts';
import { dbOf } from '../../../../src/memory/db/types.ts';
import type { Db } from '../../../../src/memory/db/types.ts';

const NOW = Date.parse('2026-10-24T12:00:00Z');
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const options = { now: () => NOW, log: quiet };

function envelope(chatId = 'room-a', text = 'Original evidence', edited = false): Envelope {
  const mapped = observationOf({
    iface: 'synthetic',
    at: NOW,
    edit: edited,
    chat: { id: chatId, kind: 'channel', chatType: 'channel' },
    message: { id: 'same-message', at: NOW - 60000, content: text, author: { id: 'member' } },
  });
  assert.ok(mapped);
  return { ...mapped, messageChat: { id: chatId, chatType: 'channel' } };
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

test('normalized messages with one native ID in two chats receive separate families', () => {
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

test('editing one normalized family preserves the other chat and replays the edit', () => {
  const handle = openMemoryDb(':memory:');
  try {
    sourceId(observeMessage(handle, envelope(), { ...options, newKey: () => 'family-a' }));
    const other = sourceId(
      observeMessage(handle, envelope('room-b', 'Other chat'), { ...options, newKey: () => 'family-b' })
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
    assert.equal(db.prepare('SELECT text FROM sources WHERE id = ?').get(other)?.text, 'Other chat');
    assert.equal(rows(db, 'sources').length, 3);
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
          row: { principal: 'adapter', seq: 1, eventId: 'event-b', kind: 'message.received', chat: 'room-b' },
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
            row: { principal: 'adapter', seq: 1, eventId: 'event-a', kind: 'message.received', chat: 'room-a' },
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
  test(`a malformed chat descriptor ${JSON.stringify(descriptor)} refuses allocation`, () => {
    const handle = openMemoryDb(':memory:');
    try {
      let allocated = 0;
      const before = snapshot(dbOf(handle));
      assert.deepEqual(
        observeMessage(
          handle,
          { ...envelope(), messageChat: descriptor },
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

test('an observation refusal rolls back the family reservation and supplied ingestion receipt', () => {
  const handle = openMemoryDb(':memory:');
  try {
    const db = dbOf(handle);
    db.prepare("INSERT INTO interfaces (id, name, contract) VALUES ('elsewhere', 'elsewhere', 1)").run();
    db.prepare("INSERT INTO connections (id, iface) VALUES ('conn:elsewhere', 'elsewhere')").run();
    const before = snapshot(db);
    let allocated = 0;
    const failed = observeMessage(
      handle,
      {
        ...envelope(),
        // Refused while writing: its connection is stored for another interface.
        connection: 'conn:elsewhere',
        ingest: {
          row: {
            principal: 'adapter',
            seq: 1,
            eventId: 'refused-event',
            kind: 'message.received',
            chat: 'room-a',
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
    assert.deepEqual(failed, { ok: false, code: 'BAD_CONNECTION' });
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

test('a mapped place that disagrees with the chat descriptor refuses allocation', () => {
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

test('two actual DM chats with one partner retain distinct normalized families', () => {
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
              chat: 'dm',
              partner: { key: 'member' },
            },
            messageChat: { id, chatType: 'dm', partnerId: 'member' },
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

/** One message of `iface` in the channel `chatId`, as an interface reports it, for the writer to observe. */
function messageIn(iface: string, chatId: string, messageId: string): Envelope {
  const mapped = observationOf({
    iface,
    at: NOW,
    chat: { id: chatId, kind: 'channel', chatType: 'channel' },
    message: { id: messageId, at: NOW - 60000, content: 'Invented evidence', author: { id: 'member' } },
  });
  assert.ok(mapped);
  return { ...mapped, messageChat: { id: chatId, chatType: 'channel' } };
}

/** `chatsOfMessage` asked after each write lands: the writer service observes `messages`, then the read connection answers. */
async function chatsAfterWrites(messages: Array<Envelope>, ask: (db: Db) => Array<string>): Promise<Array<string>> {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'chats-of-message-'));
  const service = createMemoryDb({
    iface: () => 'synthetic',
    dataDir: root,
    hot: { config: { memoryDb: { session: { mode: 'off' } } } },
    worker: true,
    now: () => NOW,
    log: quiet,
  });
  try {
    await service.tick();
    for (const message of messages) {
      const written = await service.observeMessage(message);
      assert.equal(written && 'ok' in written ? written.ok : null, true, JSON.stringify(written));
    }
    const db = service.database();
    assert.ok(db);
    return ask(db);
  } finally {
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// Catches a read that misses the chat the writer stored a message in, so a bare id is looked for in the wrong chat.
test('chatsOfMessage gives the chat the writer observed a message in', async () => {
  const chats = await chatsAfterWrites([messageIn('synthetic', 'room-a', 'msg-1')], (db) =>
    chatsOfMessage(db, 'synthetic', 'msg-1')
  );
  assert.deepEqual(chats, ['room-a']);
});

// Catches a read that stops at the first row, or repeats a chat, when one id lives in two chats of the interface.
test('chatsOfMessage gives each chat of the interface holding the id once', async () => {
  const chats = await chatsAfterWrites(
    [messageIn('synthetic', 'room-a', 'msg-1'), messageIn('synthetic', 'room-b', 'msg-1')],
    (db) => chatsOfMessage(db, 'synthetic', 'msg-1')
  );
  assert.deepEqual([...chats].sort(), ['room-a', 'room-b']);
});

// Catches a read that ignores the interface, so a chat of another platform with the same id is taken for this one.
test('chatsOfMessage leaves out a chat of another interface holding the same id', async () => {
  const chats = await chatsAfterWrites(
    [messageIn('synthetic', 'room-a', 'msg-1'), messageIn('elsewhere', 'room-z', 'msg-1')],
    (db) => chatsOfMessage(db, 'synthetic', 'msg-1')
  );
  assert.deepEqual(chats, ['room-a']);
});

// Catches a read that matches by prefix or returns some chat for an id memory never observed.
test('chatsOfMessage gives an empty list for an id nobody observed', async () => {
  const chats = await chatsAfterWrites([messageIn('synthetic', 'room-a', 'msg-1')], (db) =>
    chatsOfMessage(db, 'synthetic', 'msg')
  );
  assert.deepEqual(chats, []);
});

// Transport receipt replay returns its committed source, independently of later message edits.

function accepted(eventId: string, text: string, edit = false, room = 'room-a', principal = 'adapter') {
  const envelope = observationOf({
    iface: 'synthetic',
    at: NOW,
    edit,
    chat: { id: room, kind: 'channel', chatType: 'channel' },
    message: { id: 'same-message', at: NOW - 60000, content: text, author: { id: 'member' } },
  });
  if (!envelope) throw new Error('synthetic observation rejected');
  return {
    ...envelope,
    ingest: { row: { principal, seq: null, eventId, kind: 'message.received', chat: room }, keepDays: 7 },
  };
}

function receiptSource(result: ObserveResult): string {
  assert.equal(result.ok, true, JSON.stringify(result));
  if (typeof result.sourceId !== 'string') throw new Error('successful observation has no source');
  return result.sourceId;
}

test('replaying an earlier accepted edit returns that exact source after another edit committed', () => {
  const handle = openMemoryDb(':memory:');
  try {
    receiptSource(observeMessage(handle, accepted('initial', 'Original'), options));
    const first = observeMessage(handle, accepted('edit-a', 'First edit', true), options);
    const firstId = receiptSource(first);
    const second = observeMessage(handle, accepted('edit-b', 'Second edit', true), options);
    const secondId = receiptSource(second);
    assert.notEqual(firstId, secondId);
    const before = dbOf(handle).prepare('SELECT * FROM sources ORDER BY id').all();
    const replay = observeMessage(handle, accepted('edit-a', 'First edit', true), options);
    assert.equal(receiptSource(replay), firstId);
    assert.equal(replay.revision, first.revision);
    assert.deepEqual(dbOf(handle).prepare('SELECT * FROM sources ORDER BY id').all(), before);
  } finally {
    handle.close();
  }
});

test('each accepted receipt records its own source when different chats share a native ID', () => {
  const handle = openMemoryDb(':memory:');
  try {
    const a = receiptSource(
      observeMessage(handle, accepted('same-event', 'Alpha', false, 'room-a', 'adapter-a'), options)
    );
    const b = receiptSource(
      observeMessage(handle, accepted('same-event', 'Beta', false, 'room-b', 'adapter-b'), options)
    );
    assert.notEqual(a, b);
    assert.deepEqual(
      dbOf(handle)
        .prepare('SELECT principal, event_id, source_id FROM ingest ORDER BY principal')
        .all()
        .map((row) => [row.principal, row.event_id, row.source_id]),
      [
        ['adapter-a', 'same-event', a],
        ['adapter-b', 'same-event', b],
      ]
    );
  } finally {
    handle.close();
  }
});

test('a refused accepted observation commits neither source nor receipt association', () => {
  const handle = openMemoryDb(':memory:');
  try {
    dbOf(handle).prepare("INSERT INTO interfaces (id, name, contract) VALUES ('elsewhere', 'elsewhere', 1)").run();
    dbOf(handle).prepare("INSERT INTO connections (id, iface) VALUES ('conn:elsewhere', 'elsewhere')").run();
    const result = observeMessage(
      handle,
      // Refused while writing: its connection is stored for another interface.
      { ...accepted('bad', 'Must roll back'), connection: 'conn:elsewhere' },
      options
    );
    assert.deepEqual(result, { ok: false, code: 'BAD_CONNECTION' });
    assert.deepEqual(dbOf(handle).prepare('SELECT * FROM ingest').all(), []);
    assert.deepEqual(dbOf(handle).prepare('SELECT * FROM sources').all(), []);
    assert.deepEqual(dbOf(handle).prepare('SELECT * FROM message_families').all(), []);
  } finally {
    handle.close();
  }
});

test('a reply reserves its parent in the same chat before the parent arrives', () => {
  const handle = openMemoryDb(':memory:');
  try {
    const child = accepted('child-event', 'Child text');
    const childId = receiptSource(
      observeMessage(
        handle,
        {
          ...child,
          messageReply: { iface: 'synthetic', chatId: 'room-a', messageId: 'parent' },
        },
        options
      )
    );
    const parent = accepted('parent-event', 'Parent text');
    const parentId = receiptSource(
      observeMessage(
        handle,
        {
          ...parent,
          native: { ...parent.native, key: 'parent' },
          messageLocator: {
            ...parent.messageLocator,
            v: 1,
            origin: 'protocol-message',
            iface: 'synthetic',
            chatId: 'room-a',
            messageId: 'parent',
          },
        },
        options
      )
    );
    const foreign = accepted('foreign-parent', 'Other parent', false, 'room-b');
    const foreignId = receiptSource(
      observeMessage(
        handle,
        {
          ...foreign,
          native: { ...foreign.native, key: 'parent' },
          messageLocator: {
            v: 1,
            origin: 'protocol-message',
            iface: 'synthetic',
            chatId: 'room-b',
            messageId: 'parent',
          },
        },
        options
      )
    );
    assert.notEqual(parentId, foreignId);
    assert.deepEqual(
      dbOf(handle)
        .prepare("SELECT target_source_id FROM source_relations WHERE source_id = ? AND predicate = 'replies_to'")
        .all(childId)
        .map((row) => row.target_source_id),
      [parentId]
    );
    assert.equal(
      dbOf(handle)
        .prepare(
          "SELECT COUNT(*) AS n FROM message_families WHERE conversation_id = 'room-a' AND message_id = 'parent'"
        )
        .get()?.n,
      1
    );
  } finally {
    handle.close();
  }
});

// Authorless normalized deletions share the message family and commit their own accepted receipt.

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
function deletionSource(result: ObserveResult): string {
  assert.equal(result.ok, true, JSON.stringify(result));
  if (typeof result.sourceId !== 'string') throw new Error('writer omitted source');
  return result.sourceId;
}

test('an authorless deletion hides only its chat while retaining archival text and its receipt', () => {
  const handle = openMemoryDb(':memory:');
  try {
    const a = deletionSource(observeMessage(handle, observed('room-a'), options));
    const b = deletionSource(observeMessage(handle, observed('room-b'), options));
    const deleted = deletionSource(deleteMessage(handle, input('room-a'), options));
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
    const deleted = deletionSource(
      deleteMessage(handle, input('room-a'), { ...options, newKey: () => 'reserved-deletion' })
    );
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
    deletionSource(observeMessage(handle, observed('room-a'), options));
    const first = deletionSource(deleteMessage(handle, input('room-a'), options));
    const before = dbOf(handle).prepare('SELECT * FROM sources ORDER BY id').all();
    assert.equal(deletionSource(deleteMessage(handle, input('room-a'), options)), first);
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

// The normalized-message writer and its family catalog, using synthetic envelopes and SQLite only.

const WORKER_NOW = Date.parse('2026-10-24T12:00:00Z');
const workerQuiet = { debug() {}, info() {}, warn() {}, error() {} };

function workerEnvelope(chatId = 'room-a', text = 'Original evidence', edited = false): Envelope {
  const mapped = observationOf({
    iface: 'synthetic',
    at: WORKER_NOW,
    edit: edited,
    chat: { id: chatId, kind: 'channel', chatType: 'channel' },
    message: { id: 'same-message', at: WORKER_NOW - 60000, content: text, author: { id: 'member' } },
  });
  assert.ok(mapped);
  return { ...mapped, messageChat: { id: chatId, chatType: 'channel' } };
}

function workerRows(db: Db, table: string): Array<Record<string, unknown>> {
  return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
}

function workerFamilies(db: Db): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM message_families ORDER BY conversation_id, message_id').all();
}

for (const worker of [false, true]) {
  test(`the normalized writer request preserves families with worker ${worker}`, async () => {
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'message-families-'));
    const service = createMemoryDb({
      iface: () => 'discord',
      dataDir: root,
      hot: { config: { memoryDb: { session: { mode: 'off' } } } },
      worker,
      now: () => WORKER_NOW,
      log: workerQuiet,
    });
    try {
      await service.tick();
      const first = await service.observeMessage({ ...workerEnvelope(), newKey: 'untrusted-key' });
      const second = await service.observeMessage(workerEnvelope('room-b', 'Other evidence'));
      assert.deepEqual(
        [first && 'ok' in first ? first.ok : null, second && 'ok' in second ? second.ok : null],
        [true, true]
      );
      const db = service.database();
      assert.ok(db);
      assert.equal(workerRows(db, 'sources').length, 2);
      assert.equal(workerFamilies(db).length, 2);
      assert.equal(
        workerFamilies(db).some((row) => row.native_key === 'untrusted-key'),
        false
      );
    } finally {
      await service.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
