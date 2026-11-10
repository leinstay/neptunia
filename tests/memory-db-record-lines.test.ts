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
import { observationOf } from '../src/memory/db/observe-event.ts';
import { placeOrPersona } from '../src/memory/db/storage-keys.ts';
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
/** One write of a test: the place, its lines and the native references a writer of the live path gives them. */
type Write = { placeId: string | null; lines: Array<Row>; messages?: Array<Ref> };

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

/** A minted id: a family's random key, or a hash of one (a source id, a node, an edge). */
const MINTED = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32}/g;

/**
 * Every table but the full-text indexes, each row as stored, in rowid order. A message family's key is random, so each
 * minted id is named by the order it first appears in: two databases written alike name theirs alike.
 */
function tablesOf(db: Db): string {
  const out: Record<string, Array<Row>> = {};
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL%' ORDER BY name")
    .all()
    .map((row) => String(row.name))
    .filter((name) => !/_(fts|tri)(_|$)/.test(name));
  for (const name of names) out[name] = db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
  const minted = new Map<string, string>();
  return JSON.stringify(out, null, 1).replace(MINTED, (id) => {
    if (!minted.has(id)) minted.set(id, `minted-${minted.size}`);
    return minted.get(id)!;
  });
}

/** The day of a line, as the unit path names its unit. */
const dayOf = (line: Row): string => String(line.occurredAt).slice(0, 10);

/** The unit writes of one write: one per run of lines of one day, the native references of each line beside it. */
function unitWrites(write: Write): Array<Row> {
  const runs: Array<Row> = [];
  for (const line of write.lines) {
    const key = placeOrPersona('record', write.placeId, { partition: dayOf(line) });
    const last = runs.at(-1);
    if (last && JSON.stringify(last.key) === JSON.stringify(key)) (last.lines as Array<Row>).push(line);
    else runs.push({ op: 'lines', key, lines: [line], ...(write.messages ? { messages: write.messages } : {}) });
  }
  return runs;
}

async function fresh(): Promise<Memory> {
  return openTestMemory({ now: () => NOW, iface: () => 'synthetic' });
}

/** An observation of the live path in `room-a` of the root, owned by its day's record. */
async function observed(memory: Memory, messageId: string, text: string): Promise<string> {
  const envelope = observationOf({
    iface: 'synthetic',
    at: NOW,
    chat: { id: 'room-a', kind: 'channel', chatType: 'channel' },
    message: { id: messageId, at: Date.parse(DAY2), content: text, author: { id: 'member' } },
  });
  if (!envelope) throw new Error('synthetic message rejected');
  const done = (await memory.memoryDb.observeMessage(envelope, { placeId: ROOT })) as { sourceId?: unknown };
  if (typeof done?.sourceId !== 'string') throw new Error('observation refused');
  return done.sourceId;
}

type Plan = (memory: Memory) => Array<Write> | Promise<Array<Write>>;

/** Runs a plan through both paths; returns every table of each and the answers of each write. */
async function writeBoth(plan: Plan): Promise<{ unit: [string, Array<unknown>]; direct: [string, Array<unknown>] }> {
  const viaUnit = await fresh();
  const direct = await fresh();
  try {
    const unitAnswers: Array<unknown> = [];
    for (const write of await plan(viaUnit))
      for (const update of unitWrites(write)) unitAnswers.push(await viaUnit.memoryDb.writeUnit(update));
    const directAnswers: Array<unknown> = [];
    for (const write of await plan(direct)) directAnswers.push(await direct.memoryDb.writeRecordLines(write));
    return {
      unit: [tablesOf(dbOf(viaUnit.memoryDb.readHandle()!)), unitAnswers],
      direct: [tablesOf(dbOf(direct.memoryDb.readHandle()!)), directAnswers],
    };
  } finally {
    await viaUnit.close();
    await direct.close();
  }
}

/** The answers of the unit writes summed per write of the direct path: the unit path splits a write by day. */
function summed(answers: Array<unknown>): Row {
  const out: Row = { written: 0, duplicates: 0, adopted: 0 };
  for (const answer of answers as Array<Row>)
    for (const key of ['written', 'duplicates', 'adopted']) out[key] = Number(out[key]) + Number(answer[key] ?? 0);
  return out;
}

test('lines with native references across two days store the same rows both ways', async () => {
  const first = seen('l1', 'm1', DAY1);
  const reply = seen('l2', 'm2', DAY1, {
    replyTo: 'm1',
    media: ['image'],
    links: [{ url: 'https://example.test/a', title: 'A title', description: 'A description', site: 'example' }],
  });
  const deleted = {
    v: 1,
    id: 'l3',
    kind: 'deleted',
    messageId: 'm1',
    occurredAt: DAY1,
    recordedAt: DAY2,
    scope: { channel: 'room-a' },
    participants: ['member'],
    sourceMessageIds: ['m1'],
    origin: 'live',
  };
  const later = seen('l4', 'm4', DAY2);
  const again = seen('l5', 'm1', DAY1);
  const lines = [first, reply, deleted, later];
  const { unit, direct } = await writeBoth(() => [
    { placeId: ROOT, lines, messages: lines.map((line) => ref(line)) },
    { placeId: ROOT, lines: [again], messages: [ref(again)] },
  ]);
  assert.equal(direct[0], unit[0]);
  assert.deepEqual(direct[1][0], summed(unit[1].slice(0, 2)));
  assert.deepEqual(direct[1][1], summed(unit[1].slice(2)));
});

test('her own lines with no reference and a repeated revision store the same rows both ways', async () => {
  const mine = said('s1', 'm7', DAY2);
  const plain = seen('p1', 'm8', DAY2);
  const edit = seen('p2', 'm8', DAY2, { revision: 2, text: 'edited' });
  const { unit, direct } = await writeBoth(() => [
    { placeId: ROOT, lines: [mine, plain] },
    { placeId: ROOT, lines: [{ ...plain, id: 'p1-again' }] },
    { placeId: ROOT, lines: [edit] },
  ]);
  assert.equal(direct[0], unit[0]);
  assert.deepEqual(
    direct[1],
    unit[1].map((answer) => summed([answer]))
  );
});

test('a line the live observation stored first is adopted the same way both ways', async () => {
  const line = seen('o1', 'm9', DAY2, { text: 'observed text' });
  const { unit, direct } = await writeBoth(async (memory) => {
    const sourceId = await observed(memory, 'm9', 'observed text');
    return [{ placeId: ROOT, lines: [line], messages: [ref(line, sourceId)] }];
  });
  assert.equal(direct[0], unit[0]);
  assert.deepEqual(direct[1][0], summed(unit[1]));
  assert.deepEqual(direct[1][0], { written: 1, duplicates: 0, adopted: 1 });
});

test('lines of a direct chat and a feeling of the persona store the same rows both ways', async () => {
  const dmLine = seen('d1', 'm10', DAY2, { scope: { user: 'partner', private: true, channel: 'dm-room' } });
  const felt = {
    v: 1,
    id: 'f1',
    kind: 'felt',
    feltId: 'f-1',
    itemId: null,
    revisionId: 'rv-000000000000',
    occurredAt: DAY2,
    recordedAt: DAY2,
    scope: { user: 'partner' },
    text: 'a feeling',
    participants: ['partner'],
    sourceMessageIds: [],
    origin: 'live',
  };
  const { unit, direct } = await writeBoth(() => [
    { placeId: 'synthetic:dm:partner', lines: [dmLine] },
    { placeId: null, lines: [felt] },
  ]);
  assert.equal(direct[0], unit[0]);
  assert.deepEqual(
    direct[1],
    unit[1].map((answer) => summed([answer]))
  );
});

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
