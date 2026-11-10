// The write kind `record-lines` (src/memory/db/record-lines.ts): the lines of the record written as `sources` rows of
// their place's day directly instead of through the record mapper of a unit write. The first tests write the same lines
// through the unit write of each day and through the write kind, and compare every table column by column: the rows,
// their day's unit, the message families, the media and the relations. Then the store over a reopen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRecord } from '../src/memory/record.ts';
import { MIGRATIONS, openMemoryDb } from '../src/memory/db/open.ts';
import { BASELINE_VERSION } from '../src/memory/db/schema-baseline.ts';
import { recordLines } from '../src/memory/db/record-lines.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { placeOrPersona } from '../src/memory/db/storage-keys.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Row } from '../src/memory/db/types.ts';
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

test('a stored line whose author no account row holds reads its author back once version 51 has run', () => {
  // Bug: the author was cut out of the account id's text; read from rows, a line of an account nobody stored lost it.
  const dir = tempDataDir();
  const handle = openMemoryDb(path.join(dir, 'memory.db'));
  try {
    const db = dbOf(handle);
    const line = seen('o2', 'm31', DAY2, { by: 'gone-member' });
    applyMemoryWrite(handle, { kind: 'record-lines', placeId: ROOT, lines: [line], iface: 'synthetic', now: NOW });
    // A line of an older release: its author account was stored by id only, and nothing beside the column.
    db.prepare("UPDATE sources SET extra = NULL WHERE native_id = 'm31'").run();
    // Version 51 by its place in the steps above the baseline (version 45 is the first), not the last step.
    const step = MIGRATIONS[51 - (BASELINE_VERSION + 1)];
    if (typeof step === 'string') db.exec(step);
    else step?.(db);
    const [stored] = recordLines(db, placeOrPersona('record', ROOT, { partition: dayOf(line) }));
    assert.equal((JSON.parse(String(stored)) as Row).by, 'gone-member');
  } finally {
    handle.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
