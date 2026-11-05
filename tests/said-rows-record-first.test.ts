// The other order of one send: the record line lands before the interface's echo of the same message. The two must
// still be one `sources` row, and that row must read as the one the echo-first order leaves. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecord, toRecordLine } from '../src/memory/record.ts';
import { observationOf } from '../src/memory/db/observe-event.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';
import type { Db, Row } from '../src/memory/db/types.ts';

const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const SENT = NOW - 60_000;
const IFACE = 'synthetic';
const COMMUNITY = 'community';
const ROOM = 'room-a';
const HER = 'her-account';
const MEMBER = 'member-account';
const WORDS = 'τα κλειδιά στο συρτάρι';

type Memory = Awaited<ReturnType<typeof openTestMemory>>;

async function observeLine(
  memory: Memory,
  {
    id = 'sent-1',
    author = HER,
    at = SENT,
    replyToId,
  }: { id?: string; author?: string; at?: number; replyToId?: string } = {}
): Promise<string> {
  const event = {
    iface: IFACE,
    at,
    conversation: { id: ROOM, kind: 'channel', chatType: 'channel', communityId: COMMUNITY },
    addressing: { mentionedUserIds: [] },
    message: {
      id,
      at,
      content: WORDS,
      author: { id: author, self: author === HER },
      ...(replyToId ? { replyToId } : {}),
    },
  };
  const envelope = observationOf(event, { selfId: HER });
  if (!envelope) throw new Error('the synthetic event was refused');
  const done = await memory.memoryDb.observeMessage(envelope, { guildId: COMMUNITY });
  if (!done || !('sourceId' in done) || typeof done.sourceId !== 'string')
    throw new Error('the observation was refused');
  return done.sourceId;
}

async function recordSent(memory: Memory): Promise<void> {
  const line = toRecordLine(
    { id: 'sent-1', channelId: ROOM, content: WORDS, ts: SENT, replyToId: null, mentionedUserIds: [] },
    { kind: 'said', now: () => NOW, turnId: 't-1', opId: 'op-1' }
  );
  await createRecord({ ...memory, now: () => NOW }).append(COMMUNITY, [line], {});
}

function database(memory: Memory): Db {
  const db = memory.memoryDb.database();
  if (!db) throw new Error('database unavailable');
  return db;
}

const saidRows = (db: Db): Array<Row> => db.prepare("SELECT * FROM sources WHERE kind = 'said' ORDER BY rowid").all();

async function withOrder(
  order: 'record-first' | 'echo-first',
  run: (memory: Memory, db: Db) => Promise<void> | void
): Promise<void> {
  const memory = await openTestMemory({ now: () => NOW, iface: () => IFACE });
  try {
    if (order === 'record-first') {
      await recordSent(memory);
      await observeLine(memory);
    } else {
      await observeLine(memory);
      await recordSent(memory);
    }
    await run(memory, database(memory));
  } finally {
    await memory.close();
  }
}

test('a record line landing before its echo leaves one said row carrying the turn', async () => {
  // Bug: the record line takes a key the echo does not know, and the echo writes a second row beside it.
  await withOrder('record-first', (_memory, db) => {
    const rows = saidRows(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.turn_id, 't-1');
    assert.equal(rows[0]?.op_id, 'op-1');
  });
});

test('both orders of one send key the line by its message family', async () => {
  // Bug: a line recorded first holds the protocol id, so vector links and replies take another route to it.
  await withOrder('record-first', (_memory, db) => {
    const family = db.prepare("SELECT native_key FROM message_families WHERE message_id = 'sent-1'").get();
    assert.equal(saidRows(db)[0]?.native_id, family?.native_key);
  });
  await withOrder('echo-first', (_memory, db) => {
    const family = db.prepare("SELECT native_key FROM message_families WHERE message_id = 'sent-1'").get();
    assert.equal(saidRows(db)[0]?.native_id, family?.native_key);
  });
});

test('a line recorded before its echo stands in the place the echo names', async () => {
  // Bug: the record line derives its place by another route, so the line leaves the room's window and audience.
  await withOrder('record-first', async (memory, db) => {
    await observeLine(memory, { id: 'member-1', author: MEMBER, at: SENT + 1000 });
    const member = db.prepare("SELECT place_id, audience_id FROM sources WHERE kind = 'seen'").get();
    const hers = saidRows(db)[0];
    assert.equal(hers?.place_id, member?.place_id);
    assert.equal(hers?.audience_id, member?.audience_id);
  });
});

test('a line recorded before its echo names her account as its author', async () => {
  // Bug: the echo is a replay that leaves the row alone, so her line keeps no author account.
  await withOrder('record-first', (_memory, db) => {
    const account = db.prepare('SELECT id FROM accounts WHERE native_key = ?').get(HER);
    const row = saidRows(db)[0];
    assert.equal(row?.author_kind, 'self');
    assert.equal(row?.author_account, account?.id);
  });
});

test('a member reply to a line recorded before its echo points at the row with her turn', async () => {
  // Bug: the reply resolves its target through the family and misses a row keyed by anything else.
  await withOrder('record-first', async (memory, db) => {
    const reply = await observeLine(memory, { id: 'reply-1', author: MEMBER, at: SENT + 1000, replyToId: 'sent-1' });
    const target = db
      .prepare(
        `SELECT t.turn_id FROM source_relations r JOIN sources t ON t.id = r.target_source_id
         WHERE r.source_id = ? AND r.predicate = 'replies_to'`
      )
      .get(reply);
    assert.equal(target?.turn_id, 't-1');
  });
});

test('a record line retried after a record-first send and its echo adds no row', async () => {
  // Bug: the retry looks for the protocol id, which the row does not hold.
  await withOrder('record-first', async (memory, db) => {
    await recordSent(memory);
    assert.equal(saidRows(db).length, 1);
  });
});

test('the echo of her line in a second room with the same message id stays its own row', async () => {
  // Bug: a lookup by the message id alone joins two conversations' lines of an interface with per-room ids.
  await withOrder('echo-first', async (memory, db) => {
    const line = toRecordLine(
      { id: 'sent-1', channelId: 'room-b', content: WORDS, ts: SENT, replyToId: null, mentionedUserIds: [] },
      { kind: 'said', now: () => NOW, turnId: 't-2', opId: 'op-2' }
    );
    await createRecord({ ...memory, now: () => NOW }).append(COMMUNITY, [line], {});
    assert.deepEqual(
      saidRows(db)
        .map((row) => row.turn_id)
        .sort(),
      ['t-1', 't-2']
    );
  });
});

test('the revision of her line reads by its protocol id once it holds a family key', async () => {
  // Bug: an edit asks the newest revision by the protocol id, finds none and writes revision 1 over her line's slot.
  await withOrder('echo-first', async (memory) => {
    const record = createRecord({ ...memory, now: () => NOW });
    assert.equal(await record.newestRevision(COMMUNITY, 'sent-1', new Date(SENT).toISOString()), 1);
  });
});

function publishTo(db: Db, id: string, place: unknown): void {
  db.prepare(
    `INSERT INTO publications (id, row_kind, row_id, status, idempotency_key, receipts, created_at, destination_place_id)
     VALUES (?, 'diary', 'entry-1', 'sent', ?, ?, ?, ?)`
  ).run(
    id,
    id,
    JSON.stringify([{ authority: `${IFACE}/global`, kind: 'message', key: 'sent-1' }]),
    new Date(SENT).toISOString(),
    place
  );
}

const publicationEdges = (db: Db): Array<unknown> =>
  db
    .prepare("SELECT evidence_id FROM graph_edges WHERE predicate = 'publication_source' AND retired_at IS NULL")
    .all()
    .map((row) => row.evidence_id);

test('a publication sent before her line reaches the line that holds the family key', async () => {
  // Bug: the receipt names the protocol id, the stored line the family key, so the edge never forms.
  const memory = await openTestMemory({ now: () => NOW, iface: () => IFACE });
  try {
    const db = database(memory);
    await observeLine(memory, { id: 'member-1', author: MEMBER, at: SENT - 1000 });
    const place = db.prepare("SELECT place_id FROM sources WHERE kind = 'seen'").get()?.place_id;
    publishTo(db, 'pub-1', place);
    await observeLine(memory);
    await recordSent(memory);
    assert.deepEqual(publicationEdges(db), [saidRows(db)[0]?.id]);
  } finally {
    await memory.close();
  }
});
