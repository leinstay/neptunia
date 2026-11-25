// A unit flush over a sealed claim version (src/memory/db/upsert.ts#writeMapping): the flush of a legacy upsert meets a
// version the memory session sealed and leaves it as it was. Synthetic text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeMapping } from '../../../../src/memory/db/upsert.ts';
import { NOW } from '../../../fixtures/memory-db/session-rig.ts';
import {
  ALEX,
  addEntity,
  addSource,
  commit,
  semanticWorld,
  worksOn,
} from '../../../fixtures/memory-db/semantic-world.ts';
import { observationOf } from '../../../../src/memory/db/observe-event.ts';
import { linkVectors } from '../../../../src/memory/db/upsert.ts';
import { topPlaceSpelled } from '../../../../src/memory/db/ids.ts';
import { openTestMemory } from '../../../fixtures/memory-db/service.ts';
import type { Db, Row } from '../../../../src/memory/db/types.ts';

/** A world with one sealed claim version, and a reader of its version, evidence and assertion rows. */
function sealedVersion() {
  const world = semanticWorld();
  const source = addSource(world, 'public', 'Alex works on Lumen');
  const { entityId } = addEntity(world, 'project', 'Lumen', [source]);
  const result = commit(world, worksOn(ALEX, entityId, [source], { text: 'her exact words' })) as {
    claimId: string;
    versionId: string;
  };
  const read = () => ({
    version: { ...world.db.prepare('SELECT * FROM claim_versions WHERE id = ?').get(result.versionId) },
    evidence: world.db
      .prepare('SELECT * FROM claim_version_sources WHERE version_id = ?')
      .all(result.versionId)
      .map((row) => ({ ...row })),
    assertion: {
      ...world.db.prepare('SELECT * FROM semantic_assertion_versions WHERE version_id = ?').get(result.versionId),
    },
  });
  return { world, source, result, read };
}

const FLUSHED_AT = new Date(NOW).toISOString();

test('a unit flush that carries a sealed id succeeds and leaves the version byte for byte', () => {
  // Bug: the seal's trigger aborts the whole flush and a member's history stops saving, or the flush rewrites the persona's words.
  const { world, result, read } = sealedVersion();
  const before = read();
  writeMapping(
    world.db,
    {
      people: [{ id: 'person:flushed', first_seen_at: FLUSHED_AT }],
      claim_versions: [
        { id: result.versionId, claim_id: result.claimId, text: 'a file wrote this', recorded_at: FLUSHED_AT },
      ],
    },
    { at: FLUSHED_AT }
  );
  assert.deepEqual(read(), before);
  assert.equal(world.db.prepare("SELECT COUNT(*) AS n FROM people WHERE id = 'person:flushed'").get()?.n, 1);
  world.handle.close();
});

// One sent line, one `sources` row. The interface echoes the persona's own message to the core, the observation stores it under the
// key of its message family, and the record line of the same send (src/turn/journal-notes.ts#recordSaid and its siblings,
// all `record.append(placeId, [line], {})`) arrives with no descriptor, so it must find that family by itself.
// Synthetic data only.

const SAID_ROWS_SINGLE_NOW = Date.parse('2026-10-24T12:00:00.000Z');
const SENT = SAID_ROWS_SINGLE_NOW - 60_000;
const IFACE = 'synthetic';
const ROOT = 'root';
// The place that holds the record of the chat's tree, as the pipeline names it (src/memory/addresses.ts#sharedPlaceOf).
const TOP = topPlaceSpelled(IFACE, ROOT);
const ROOM = 'room-a';
const SELF_ID = 'her-account';
const MEMBER = 'member-account';
const WORDS = 'κουνέλι στον κήπο';

type Memory = Awaited<ReturnType<typeof openTestMemory>>;

/** The `message.received` event of a line: the persona's when `author` is their id, as the interface delivers their own echo. */
function lineEvent({
  id = 'sent-1',
  author = SELF_ID,
  at = SENT,
  text = WORDS,
  replyToId,
  mentionedAccountIds = [],
}: {
  id?: string;
  author?: string;
  at?: number;
  text?: string;
  replyToId?: string;
  mentionedAccountIds?: Array<string>;
} = {}) {
  return {
    iface: IFACE,
    at,
    chat: { id: ROOM, kind: 'channel', chatType: 'channel', rootId: ROOT },
    addressing: { mentionedAccountIds },
    message: {
      id,
      at,
      content: text,
      author: { id: author, self: author === SELF_ID },
      ...(replyToId ? { replyToId } : {}),
    },
  };
}

async function observeLine(memory: Memory, options: Parameters<typeof lineEvent>[0] = {}): Promise<string> {
  const envelope = observationOf(lineEvent(options), { selfId: SELF_ID });
  if (!envelope) throw new Error('the synthetic event was refused');
  const done = await memory.memoryDb.observeMessage(envelope, { placeId: TOP });
  if (!done || !('sourceId' in done) || typeof done.sourceId !== 'string')
    throw new Error('the observation was refused');
  return done.sourceId;
}

function database(memory: Memory): Db {
  const db = memory.memoryDb.database();
  if (!db) throw new Error('database unavailable');
  return db;
}

test('a vector of an observed line links to its row by the protocol id in its chunk key', async () => {
  // Bug: the link looks for the chunk key's protocol id in native_id, which holds the family key, so meaning search
  // never reaches the line. A fix of the persona's rows moves them onto family keys, so it depends on this link.
  const memory = await openTestMemory({ now: () => SAID_ROWS_SINGLE_NOW, iface: () => IFACE });
  try {
    const sourceId = await observeLine(memory, { id: 'member-1', author: MEMBER });
    const db = database(memory);
    // The row as writeLineVectors builds it: the line's message id in `item_id`, its revision in `context`.
    const row: Row = { chunk_key: 'record:member-1:1', kind: 'record', item_id: 'member-1', context: '{"revision":1}' };
    linkVectors(db, [row]);
    assert.equal(row.source_rowid, db.prepare('SELECT rowid FROM sources WHERE id = ?').get(sourceId)?.rowid);
  } finally {
    await memory.close();
  }
});

test("a line's second vector in a month, whose chunk key carries the writer's -2, links to the line too", async () => {
  // Bug: the link read the revision out of the chunk key, `1-2` is no number, so the second vector of a line linked to
  // nothing and a search by meaning never reached the line through it.
  const memory = await openTestMemory({ now: () => SAID_ROWS_SINGLE_NOW, iface: () => IFACE });
  try {
    const sourceId = await observeLine(memory, { id: 'member-2', author: MEMBER });
    const line = {
      row: 0,
      kind: 'record',
      id: 'member-2',
      revision: 1,
      occurredAt: new Date(SENT).toISOString(),
      placeId: ROOM,
      sourceIds: ['member-2'],
      scale: 0.01,
      norm: 2,
    };
    const write = { op: 'append' as const, placeId: TOP, month: '2026-10', model: 'test/embedder' };
    await memory.memoryDb.writeLineVectors({ ...write, lines: [{ line, bytes: Uint8Array.from([1, 2, 3, 4]) }] });
    await memory.memoryDb.writeLineVectors({ ...write, lines: [{ line, bytes: Uint8Array.from([4, 3, 2, 1]) }] });
    const db = database(memory);
    const own = db.prepare('SELECT rowid FROM sources WHERE id = ?').get(sourceId)?.rowid;
    const links = db
      .prepare("SELECT chunk_key, source_rowid FROM vectors WHERE item_id = 'member-2' ORDER BY chunk_key")
      .all()
      .map((row) => [row.chunk_key, row.source_rowid]);
    assert.deepEqual(links, [
      ['record:member-2:1', own],
      ['record:member-2:1-2', own],
    ]);
  } finally {
    await memory.close();
  }
});
