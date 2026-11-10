// Transport receipt replay returns its committed source, independently of later message edits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeMessage } from '../src/memory/db/message-families.ts';
import { observationOf } from '../src/memory/db/observe-event.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { ObserveResult } from '../src/memory/db/observe.ts';

const NOW = Date.parse('2026-10-24T12:00:00Z');
const options = { now: () => NOW, log: { debug() {}, info() {}, warn() {}, error() {} } };

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

function source(result: ObserveResult): string {
  assert.equal(result.ok, true, JSON.stringify(result));
  if (typeof result.sourceId !== 'string') throw new Error('successful observation has no source');
  return result.sourceId;
}

test('replaying an earlier accepted edit returns that exact source after another edit committed', () => {
  const handle = openMemoryDb(':memory:');
  try {
    source(observeMessage(handle, accepted('initial', 'Original'), options));
    const first = observeMessage(handle, accepted('edit-a', 'First edit', true), options);
    const firstId = source(first);
    const second = observeMessage(handle, accepted('edit-b', 'Second edit', true), options);
    const secondId = source(second);
    assert.notEqual(firstId, secondId);
    const before = dbOf(handle).prepare('SELECT * FROM sources ORDER BY id').all();
    const replay = observeMessage(handle, accepted('edit-a', 'First edit', true), options);
    assert.equal(source(replay), firstId);
    assert.equal(replay.revision, first.revision);
    assert.deepEqual(dbOf(handle).prepare('SELECT * FROM sources ORDER BY id').all(), before);
  } finally {
    handle.close();
  }
});

test('each accepted receipt records its own source when different chats share a native ID', () => {
  const handle = openMemoryDb(':memory:');
  try {
    const a = source(observeMessage(handle, accepted('same-event', 'Alpha', false, 'room-a', 'adapter-a'), options));
    const b = source(observeMessage(handle, accepted('same-event', 'Beta', false, 'room-b', 'adapter-b'), options));
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
    const result = observeMessage(
      handle,
      // Refused while writing: the thread its participant is scoped to is stored nowhere.
      {
        ...accepted('bad', 'Must roll back'),
        author: { kind: 'participant', token_kind: 'thread_token', key: 't-1', scope_place: 'thread:none' },
      },
      options
    );
    assert.deepEqual(result, { ok: false, code: 'UNKNOWN_SCOPE_PLACE' });
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
    const childId = source(
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
    const parentId = source(
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
    const foreignId = source(
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
