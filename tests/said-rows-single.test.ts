// One sent line, one `sources` row. The interface echoes her own message to the core, the observation stores it under the
// key of its message family, and the record line of the same send (src/turn/journal-notes.ts#recordSaid and its siblings,
// all `record.append(placeId, [line], {})`) arrives with no descriptor, so it must find that family by itself.
// Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecord, toRecordLine } from '../src/memory/record.ts';
import { observationOf } from '../src/memory/db/observe-event.ts';
import { batchOf } from '../src/memory/db/session.ts';
import { search } from '../src/memory/db/recall.ts';
import { recountDaily } from '../src/memory/db/focus.ts';
import { linkVectors } from '../src/memory/db/upsert.ts';
import { groupContext, groupScope } from '../src/memory/db/scope.ts';
import { topPlaceSpelled } from '../src/memory/db/ids.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';
import type { Db, Row } from '../src/memory/db/types.ts';

const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const SENT = NOW - 60_000;
const IFACE = 'synthetic';
const COMMUNITY = 'community';
// The place that holds the record of the conversation's tree, as the pipeline names it (src/memory/addresses.ts#sharedPlaceOf).
const TOP = topPlaceSpelled(IFACE, COMMUNITY);
const ROOM = 'room-a';
const HER = 'her-account';
const MEMBER = 'member-account';
const WORDS = 'κουνέλι στον κήπο';

type Memory = Awaited<ReturnType<typeof openTestMemory>>;

/** The `message.received` event of a line: hers when `author` is her id, as the interface delivers her own echo. */
function lineEvent({
  id = 'sent-1',
  author = HER,
  at = SENT,
  text = WORDS,
  replyToId,
  mentionedUserIds = [],
}: {
  id?: string;
  author?: string;
  at?: number;
  text?: string;
  replyToId?: string;
  mentionedUserIds?: Array<string>;
} = {}) {
  return {
    iface: IFACE,
    at,
    conversation: { id: ROOM, kind: 'channel', chatType: 'channel', communityId: COMMUNITY },
    addressing: { mentionedUserIds },
    message: {
      id,
      at,
      content: text,
      author: { id: author, self: author === HER },
      ...(replyToId ? { replyToId } : {}),
    },
  };
}

async function observeLine(memory: Memory, options: Parameters<typeof lineEvent>[0] = {}): Promise<string> {
  const envelope = observationOf(lineEvent(options), { selfId: HER });
  if (!envelope) throw new Error('the synthetic event was refused');
  const done = await memory.memoryDb.observeMessage(envelope, { placeId: TOP });
  if (!done || !('sourceId' in done) || typeof done.sourceId !== 'string')
    throw new Error('the observation was refused');
  return done.sourceId;
}

/** The record line of her send, as recordSaid builds it, appended with no descriptor as every said writer does. */
async function recordSent(memory: Memory, { mentionedUserIds = [] }: { mentionedUserIds?: Array<string> } = {}) {
  const line = toRecordLine(
    { id: 'sent-1', placeId: ROOM, content: WORDS, ts: SENT, replyToId: null, mentionedUserIds },
    { kind: 'said', now: () => NOW, turnId: 't-1', opId: 'op-1' }
  );
  await createRecord({ ...memory, now: () => NOW }).append(TOP, [line], {});
}

function database(memory: Memory): Db {
  const db = memory.memoryDb.database();
  if (!db) throw new Error('database unavailable');
  return db;
}

const saidRows = (db: Db): Array<Row> => db.prepare("SELECT * FROM sources WHERE kind = 'said' ORDER BY rowid").all();

async function withEchoedLine(run: (memory: Memory, db: Db) => Promise<void> | void): Promise<void> {
  const memory = await openTestMemory({ now: () => NOW, iface: () => IFACE });
  try {
    await observeLine(memory);
    await recordSent(memory);
    await run(memory, database(memory));
  } finally {
    await memory.close();
  }
}

test('her sent line leaves one said row when its echo was observed before the record line', async () => {
  // Bug: the record line takes the protocol id as its key, the echo its family's, and each stands as her line.
  await withEchoedLine((_memory, db) => {
    assert.equal(saidRows(db).length, 1);
  });
});

test('the one row of her echoed line carries the turn and the post operation', async () => {
  // Bug: the row the rest of memory attaches to (replies, episodes) has no turn, so nothing joins it to her attempt.
  await withEchoedLine((_memory, db) => {
    const withTurn = saidRows(db).filter((row) => row.turn_id === 't-1');
    assert.equal(withTurn.length, 1);
    assert.equal(withTurn[0]?.op_id, 'op-1');
    assert.equal(saidRows(db).filter((row) => row.turn_id === null).length, 0);
  });
});

test('a record line retried after the echo adds no row', async () => {
  // Bug: the duplicate check looks for the protocol id, which the adopted row no longer holds as its native id.
  await withEchoedLine(async (memory, db) => {
    await recordSent(memory);
    assert.equal(saidRows(db).length, 1);
  });
});

test('a member reply to her echoed line points at the row that carries her turn', async () => {
  // Bug: the reply resolves to the echo's row, so the turn's row looks unanswered.
  await withEchoedLine(async (memory, db) => {
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

test('the session batch holds her echoed line once', async () => {
  // Bug: both rows are current lines, so the session writer reads and cites one sentence as two.
  await withEchoedLine((_memory, db) => {
    const batch = batchOf(db, groupScope(IFACE), {
      cursor: 0,
      since: null,
      maxMessages: 50,
      settleBefore: NOW,
    }).filter((line) => line.kind === 'said');
    assert.equal(batch.length, 1);
  });
});

test('recall finds her echoed line once', async () => {
  // Bug: a word search returns the same sentence twice and spends two of its slots on it.
  await withEchoedLine((_memory, db) => {
    const found = search(db, {
      ctx: groupContext(IFACE),
      plan: { forms: ['κουνέλι'], who: [], from: null, to: null },
      now: NOW,
    });
    const lines = JSON.stringify(found).split(WORDS).length - 1;
    assert.equal(lines, 1);
  });
});

test('the record lists her echoed line once under its protocol id', async () => {
  // Bug: every reader of the record (a conversation read, the inner places, the heartbeat view) shows it twice.
  await withEchoedLine(async (memory) => {
    const lines: Array<{ kind?: unknown; messageId?: unknown }> = [];
    for await (const item of createRecord({ ...memory, now: () => NOW }).iterate(TOP)) lines.push(item);
    assert.deepEqual(
      lines.filter((line) => line.kind === 'said').map((line) => line.messageId),
      ['sent-1']
    );
  });
});

test('her echoed line naming a member counts once as addressed by her', async () => {
  // Bug: the daily count keys a line by its native id, so the two rows raise addressed_by_her by two.
  const memory = await openTestMemory({ now: () => NOW, iface: () => IFACE });
  try {
    await observeLine(memory, { id: 'hello-1', author: MEMBER, at: SENT - 1000 });
    await observeLine(memory, { mentionedUserIds: [MEMBER] });
    await recordSent(memory, { mentionedUserIds: [MEMBER] });
    const db = database(memory);
    const account = db.prepare('SELECT id, authority_id FROM accounts WHERE native_key = ?').get(MEMBER);
    db.prepare("INSERT INTO people (id, kind, first_seen_at) VALUES ('person:member', 'person', ?)").run(
      new Date(SENT - 1000).toISOString()
    );
    db.prepare(
      `INSERT INTO account_person_links (id, account_id, person_id, state, valid_from_at, recorded_at)
       VALUES ('link:member', ?, 'person:member', 'verified', NULL, ?)`
    ).run(account?.id, new Date(SENT - 1000).toISOString());
    recountDaily({ db }, { from: SENT, to: SENT });
    const row = db
      .prepare("SELECT addressed_by_her AS her FROM relationship_daily WHERE person_id = 'person:member'")
      .get();
    assert.equal(row?.her, 1);
  } finally {
    await memory.close();
  }
});

test('a vector of an observed line links to its row by the protocol id in its chunk key', async () => {
  // Bug: the link looks for the chunk key's protocol id in native_id, which holds the family key, so meaning search
  // never reaches the line. A fix of her rows moves them onto family keys, so it depends on this link.
  const memory = await openTestMemory({ now: () => NOW, iface: () => IFACE });
  try {
    const sourceId = await observeLine(memory, { id: 'member-1', author: MEMBER });
    const db = database(memory);
    const row: Row = { chunk_key: 'record:member-1:1' };
    linkVectors(db, [row]);
    assert.equal(row.source_rowid, db.prepare('SELECT rowid FROM sources WHERE id = ?').get(sourceId)?.rowid);
  } finally {
    await memory.close();
  }
});
