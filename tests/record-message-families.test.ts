// Qualified record writes adopt exact observed sources and preserve protocol IDs on export.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecord } from '../src/memory/record.ts';
import { observationOf } from '../src/memory/db/observe-event.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';

const NOW = Date.parse('2026-10-24T12:00:00Z');
const AT = new Date(NOW - 60000).toISOString();
const locator = (room: string) => ({ iface: 'synthetic', conversationId: room, messageId: 'same-message' });
const line = (id: string, room: string, text: string, revision: number) => ({
  v: 1,
  id,
  kind: 'seen',
  messageId: 'same-message',
  revision,
  occurredAt: AT,
  recordedAt: new Date(NOW).toISOString(),
  guildId: 'community',
  scope: { channel: room },
  by: 'member',
  text,
  origin: 'live',
});

function observedId(result: object | null): string {
  if (!result || !('sourceId' in result) || typeof result.sourceId !== 'string') throw new Error('observation refused');
  return result.sourceId;
}

function envelope(room: string, text: string, edited = false) {
  const result = observationOf({
    iface: 'synthetic',
    at: NOW,
    edit: edited,
    conversation: { id: room, kind: 'channel', chatType: 'channel' },
    message: { id: 'same-message', at: NOW - 60000, content: text, author: { id: 'member' } },
  });
  if (!result) throw new Error('synthetic message rejected');
  return result;
}

test('recording an observed edit enriches that exact revision without adding a source or incrementing again', async () => {
  const memory = await openTestMemory({ now: () => NOW });
  try {
    const record = createRecord({ ...memory, now: () => NOW });
    observedId(await memory.memoryDb.observeMessage(envelope('room-a', 'Original'), { guildId: 'community' }));
    const editedId = observedId(
      await memory.memoryDb.observeMessage(envelope('room-a', 'Edited', true), { guildId: 'community' })
    );
    const db = memory.memoryDb.database();
    if (!db) throw new Error('database unavailable');
    const before = db.prepare('SELECT id, revision, text FROM sources ORDER BY revision').all();
    const data = line('edit-record', 'room-a', 'Edited', 2);
    const opts = { messages: [{ lineId: data.id, locator: locator('room-a'), observedSourceId: editedId }] };
    await record.append('community', [data], opts);
    await record.append('community', [data], opts);
    assert.deepEqual(db.prepare('SELECT id, revision, text FROM sources ORDER BY revision').all(), before);
    assert.equal(await record.newestRevision('community', 'same-message', AT, { locator: locator('room-a') }), 2);
    const exported: Array<object> = [];
    for await (const item of record.iterate('community')) exported.push(item);
    assert.ok(
      exported.some(
        (item) => 'messageId' in item && item.messageId === 'same-message' && 'revision' in item && item.revision === 2
      )
    );
  } finally {
    await memory.close();
  }
});

test('qualified records with one native ID retain separate revisions and actual conversation IDs', async () => {
  const memory = await openTestMemory({ now: () => NOW });
  try {
    const record = createRecord({ ...memory, now: () => NOW });
    for (const [room, revision] of [
      ['room-a', 3],
      ['room-b', 1],
    ] as const) {
      const data = line(`record-${room}`, room, `Text ${room}`, revision);
      await record.append('community', [data], { messages: [{ lineId: data.id, locator: locator(room) }] });
    }
    assert.equal(await record.newestRevision('community', 'same-message', AT, { locator: locator('room-a') }), 3);
    assert.equal(await record.newestRevision('community', 'same-message', AT, { locator: locator('room-b') }), 1);
    const exported: Array<object> = [];
    for await (const item of record.iterate('community')) exported.push(item);
    assert.equal(exported.length, 2);
    assert.ok(exported.every((item) => 'messageId' in item && item.messageId === 'same-message'));
  } finally {
    await memory.close();
  }
});

test('a supplied source belonging to another conversation cannot receive record metadata', async () => {
  const memory = await openTestMemory({ now: () => NOW });
  try {
    const record = createRecord({ ...memory, now: () => NOW });
    const foreignId = observedId(await memory.memoryDb.observeMessage(envelope('room-b', 'Foreign original')));
    const db = memory.memoryDb.database();
    if (!db) throw new Error('database unavailable');
    const before = db.prepare('SELECT * FROM sources ORDER BY id').all();
    const data = line('forged-reference', 'room-a', 'Must not attach', 1);
    await assert.rejects(
      record.append('community', [data], {
        messages: [{ lineId: data.id, locator: locator('room-a'), observedSourceId: foreignId }],
      })
    );
    assert.deepEqual(db.prepare('SELECT * FROM sources ORDER BY id').all(), before);
  } finally {
    await memory.close();
  }
});

test('exporting a normalized record restores native message and reply IDs rather than family keys', async () => {
  const memory = await openTestMemory({ now: () => NOW });
  try {
    const record = createRecord({ ...memory, now: () => NOW });
    const child = envelope('room-a', 'Child');
    const childId = observedId(
      await memory.memoryDb.observeMessage(
        {
          ...child,
          messageReply: { iface: 'synthetic', conversationId: 'room-a', messageId: 'native-parent' },
        },
        { guildId: 'community' }
      )
    );
    const data = { ...line('child-record', 'room-a', 'Child', 1), replyTo: 'native-parent' };
    await record.append('community', [data], {
      messages: [{ lineId: data.id, locator: locator('room-a'), observedSourceId: childId }],
    });
    const exported: Array<object> = [];
    for await (const item of record.iterate('community')) exported.push(item);
    assert.deepEqual(
      exported.map((item) => ['messageId' in item ? item.messageId : null, 'replyTo' in item ? item.replyTo : null]),
      [['same-message', 'native-parent']]
    );
    const db = memory.memoryDb.database();
    if (!db) throw new Error('database unavailable');
    assert.deepEqual(
      db
        .prepare("SELECT id FROM sources WHERE kind = 'seen'")
        .all()
        .map((row) => row.id),
      [childId]
    );
  } finally {
    await memory.close();
  }
});

test('recording an observed deletion adopts its tombstone without inventing a revision', async () => {
  const memory = await openTestMemory({ now: () => NOW });
  try {
    const record = createRecord({ ...memory, now: () => NOW });
    const deletedId = observedId(
      await memory.memoryDb.deleteMessage(
        {
          v: 1,
          iface: 'synthetic',
          authority: 'synthetic/global',
          messageLocator: { v: 1, origin: 'protocol-message', ...locator('room-a') },
          messageConversation: { id: 'room-a', chatType: 'channel' },
          occurredAt: AT,
          observedAt: new Date(NOW).toISOString(),
        },
        { guildId: 'community' }
      )
    );
    const data = {
      v: 1,
      id: 'deleted-record',
      kind: 'deleted',
      messageId: 'same-message',
      occurredAt: AT,
      recordedAt: new Date(NOW).toISOString(),
      guildId: 'community',
      scope: { channel: 'room-a' },
      origin: 'live',
    };
    const options = { messages: [{ lineId: data.id, locator: locator('room-a'), observedSourceId: deletedId }] };
    await record.append('community', [data], options);
    await record.append('community', [data], options);
    const db = memory.memoryDb.database();
    if (!db) throw new Error('database unavailable');
    assert.deepEqual(
      db
        .prepare("SELECT id, revision FROM sources WHERE kind = 'deleted'")
        .all()
        .map((row) => ({ ...row })),
      [{ id: deletedId, revision: null }]
    );
    const exported: Array<object> = [];
    for await (const item of record.iterate('community')) exported.push(item);
    assert.deepEqual(
      exported.map((item) => ('messageId' in item ? item.messageId : null)),
      ['same-message']
    );
  } finally {
    await memory.close();
  }
});
