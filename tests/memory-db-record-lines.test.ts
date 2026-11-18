// The write kind `record-lines` (src/memory/db/record-lines.ts): the lines of the record written as `sources` rows of
// their place's day directly instead of through the record mapper of a unit write. The first tests write the same lines
// through the unit write of each day and through the write kind, and compare every table column by column: the rows,
// their day's unit, the message families, the media and the relations. Then the store over a reopen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRecord, toRecordLine } from '../src/memory/record.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { recordLines } from '../src/memory/db/record-lines.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { placeOrPersona } from '../src/memory/db/unit-keys.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, Row } from '../src/memory/db/types.ts';
import { addAccount, addChannelPlace } from './fixtures/memory-db/opaque-people.ts';
import { openTestMemory, tempDataDir } from './fixtures/memory-db/service.ts';

const NOW = Date.parse('2026-11-09T10:00:00.000Z');
const ROOT = 'synthetic:root:1';
const DAY1 = '2026-11-08T09:00:00.000Z';
const DAY2 = '2026-11-09T08:00:00.000Z';

type Memory = Awaited<ReturnType<typeof openTestMemory>>;
type Ref = { lineId: string; locator: { iface: string; chatId: string; messageId: string }; observedSourceId?: string };

const seen = (id: string, messageId: string, occurredAt: string, extra: Row = {}): Row => ({
  v: 1,
  id,
  kind: 'seen',
  messageId,
  revision: 1,
  occurredAt,
  recordedAt: occurredAt,
  scope: { channel: 'room-a' },
  by: 'member',
  replyTo: null,
  text: `text of ${id}`,
  media: [],
  mentions: [],
  direct: false,
  participants: ['member'],
  sourceMessageIds: [messageId],
  origin: 'live',
  ...extra,
});

const said = (id: string, messageId: string, occurredAt: string, extra: Row = {}): Row => ({
  v: 1,
  id,
  kind: 'said',
  messageId,
  revision: 1,
  occurredAt,
  recordedAt: occurredAt,
  scope: { channel: 'room-a' },
  replyTo: null,
  text: `her words ${id}`,
  media: [],
  mentions: [],
  turnId: 'turn-1',
  opId: 'op-1',
  participants: [],
  sourceMessageIds: [messageId],
  origin: 'live',
  ...extra,
});

const ref = (line: Row, observedSourceId?: string): Ref => ({
  lineId: String(line.id),
  locator: { iface: 'synthetic', chatId: 'room-a', messageId: String(line.messageId) },
  ...(observedSourceId ? { observedSourceId } : {}),
});

/** The day of a line, as the unit path names its unit. */
const dayOf = (line: Row): string => String(line.occurredAt).slice(0, 10);

async function fresh(): Promise<Memory> {
  return openTestMemory({ now: () => NOW, iface: () => 'synthetic' });
}

test('a write with a reference that names no line of it is refused with a code', async () => {
  const memory = await fresh();
  try {
    const line = seen('r1', 'm11', DAY2);
    await assert.rejects(
      memory.memoryDb.writeRecordLines({ placeId: ROOT, lines: [line], messages: [{ ...ref(line), lineId: 'other' }] }),
      { code: 'BAD_NATIVE' }
    );
  } finally {
    await memory.close();
  }
});

test('the record reads back what it wrote after the database is closed and opened again', async () => {
  const dataDir = tempDataDir();
  const lines = [seen('a1', 'm20', DAY1), said('a2', 'm21', DAY2), seen('a3', 'm22', DAY2, { revision: 2 })];
  const first = await openTestMemory({ dataDir, now: () => NOW, iface: () => 'synthetic' });
  const written: Array<object> = [];
  try {
    const record = createRecord({ ...first, now: () => NOW });
    await record.append(ROOT, lines);
    for await (const line of record.iterate(ROOT)) written.push(line);
  } finally {
    await first.close();
  }
  const second = await openTestMemory({ dataDir, now: () => NOW, iface: () => 'synthetic' });
  try {
    const record = createRecord({ ...second, now: () => NOW });
    const read: Array<object> = [];
    for await (const line of record.iterate(ROOT)) read.push(line);
    assert.equal(read.length, 3);
    assert.deepEqual(read, written);
    assert.deepEqual(await record.stats(ROOT), { messages: 3, days: 2, first: '2026-11-08' });
    assert.equal(await record.newestRevision(ROOT, 'm22', DAY2), 2);
  } finally {
    await second.close();
  }
});

test('a line names the stored rows of its author and chat when their ids spell nothing, and reads back as written', () => {
  const dir = tempDataDir();
  const handle = openMemoryDb(path.join(dir, 'memory.db'));
  try {
    const db = dbOf(handle);
    addAccount(db, {
      id: 'account:7f3e',
      iface: 'synthetic',
      authority: 'synthetic/global',
      native: 'member',
      person: 'person:5a1c',
    });
    addChannelPlace(db, { id: 'place:9b20', iface: 'synthetic', authority: 'synthetic/global', native: 'room-a' });
    const line = seen('o1', 'm30', DAY2);
    applyMemoryWrite(handle, {
      kind: 'record-lines',
      placeId: 'place:9b20',
      lines: [line],
      iface: 'synthetic',
      now: NOW,
    });
    const row = db.prepare('SELECT author_account, place_id, extra FROM sources WHERE native_id = ?').get('m30');
    assert.equal(row?.author_account, 'account:7f3e');
    assert.equal(row?.place_id, 'place:9b20');
    const [stored] = recordLines(db, placeOrPersona('record', 'place:9b20', { partition: dayOf(line) }));
    const read = JSON.parse(String(stored)) as Row;
    assert.equal(read.by, 'member');
    assert.deepEqual(read.scope, { channel: 'room-a' });
  } finally {
    handle.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** The emoji and stickers a line links, as `[kind, platform id, name]`, sorted. */
function linkedOf(db: Db, messageId: string): Array<Array<unknown>> {
  const rows = db
    .prepare(
      `SELECT m.kind AS kind, m.native_ref AS ref, json_extract(m.extra, '$.name') AS name
       FROM sources s JOIN media_links l ON l.owner_kind = 'source' AND l.owner_id = s.id
       JOIN media m ON m.id = l.media_id
       WHERE s.native_id = ? AND m.kind IN ('emoji', 'sticker')`
    )
    .all(messageId);
  return rows.map((row) => [row.kind, row.ref, row.name]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
}

test('a record line of a message with a custom emoji and a sticker links both by platform id and stable name', async () => {
  const memory = await fresh();
  try {
    const line = toRecordLine(
      {
        id: 'm40',
        placeId: 'room-a',
        authorId: 'member',
        content: 'look :e4:',
        ts: Date.parse(DAY2),
        emojis: [{ id: '901', name: 'e4' }],
        stickers: [{ id: '801', name: 's2', animated: false, url: null }],
      },
      { now: () => NOW }
    );
    await createRecord({ ...memory, now: () => NOW }).append(ROOT, [line]);
    const db = memory.memoryDb.database() as Db;
    assert.deepEqual(linkedOf(db, 'm40'), [
      ['emoji', '901', 'e4'],
      ['sticker', '801', 's2'],
    ]);
  } finally {
    await memory.close();
  }
});

// Diagnosis 2026-11-18, graph orphans: a stored line named an author account no row held, so its `authored_by` edge
// ended at nothing and its author resolved to no one. The live observation writes the account of a line's author; a
// record line carries the author's platform id alone (`by`), so the row holds that id and no name.
test('a line by an author memory does not know writes that author account with the platform id the line carries', () => {
  const dir = tempDataDir();
  const handle = openMemoryDb(path.join(dir, 'memory.db'));
  try {
    const db = dbOf(handle);
    addChannelPlace(db, { id: 'place:4c11', iface: 'synthetic', authority: 'synthetic/global', native: 'room-a' });
    const line = seen('u1', 'm40', DAY2, { by: 'stranger-7', participants: ['stranger-7'] });
    applyMemoryWrite(handle, {
      kind: 'record-lines',
      placeId: 'place:4c11',
      lines: [line],
      iface: 'synthetic',
      now: NOW,
    });
    const author = db.prepare('SELECT author_account FROM sources WHERE native_id = ?').get('m40')?.author_account;
    const account = db.prepare('SELECT iface, native_id FROM accounts WHERE id = ?').get(author);
    assert.deepEqual(
      { iface: account?.iface, native: account?.native_id },
      { iface: 'synthetic', native: 'stranger-7' }
    );
  } finally {
    handle.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
