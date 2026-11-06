// The owner's removal of a selfreflection entry over rows in the shapes older entries left behind (the lead's run on a
// copy of production, 2026-11-06): her line of a published message that names the message only in `native_id`, with no
// `$messageLocator` and no message family; the turn's `answer` line whose `posted` holds objects with a `messageId` and
// an `opId`, and its `action` day row tied to the turn by that `opId`; the `ingest` receipt of the line's event; and the
// day rows of later turns that list the message in `sourceMessageIds`. The scene is tests/fixtures/selfreflection-removal.ts.
// Invented ids and synthetic text only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insertRows } from '../src/memory/db/rows.ts';
import { HOUR, T0, removalScene, rowsWhere, tablesNaming } from './fixtures/selfreflection-removal.ts';
import type { RemovalScene } from './fixtures/selfreflection-removal.ts';

const PICTURE = { buffer: new Uint8Array([9, 3, 5]), mediaType: 'image/png' };
const SCOPED = { scope_kind: 'group', scope_iface: 'fake', scope_dm: null };

/** One older entry as the scene seeded it. */
type Older = {
  entryId: string;
  message: string;
  lineId: string;
  mediaId: string;
  turnId: string;
  answerId: string;
  actionId: string;
  eventId: string;
};

/**
 * An entry published with one message and one picture, whose line of the picture's message `M` is in the older shape:
 * id `src:fake:<M>:1:said`, `native_id` M, no locator in `extra`, no message family. The line links the entry's picture
 * and holds an external key; its event has an `ingest` receipt. The turn that posted it has an `answer` line whose
 * `posted` is `[{ messageId, opId }]` and an `action` day row that names the turn only through that `opId`.
 */
async function olderEntry(rig: RemovalScene, id: string): Promise<Older> {
  const { db, mirror, scene } = rig;
  const at = T0;
  const stamp = new Date(at).toISOString();
  scene.entry({ id, at, text: `an older evening ${id}`, messages: [`an older evening ${id}`] });
  const publisher = scene.publisher();
  const outcomes = await publisher.publishEntry({ id, messages: [`an older evening ${id}`], pictures: [PICTURE] });
  assert.deepEqual(
    outcomes.map((one) => one.status),
    ['sent']
  );
  const state = publisher.publicationState(id, mirror.placeId);
  assert.ok(state, 'the entry has its publication');
  const message = state.segments.flatMap((segment) => segment.messageIds).at(-1);
  assert.ok(message, 'the picture went out as a message');
  const [mediaId] = rig.mediaOf(id);
  assert.ok(mediaId, 'the entry links its picture');
  const lineId = `src:fake:${message}:1:said`;
  const turnId = `turn-older-${id}`;
  const answerId = `src:turn:${turnId}:1`;
  const actionId = `day-${turnId}-action`;
  const opId = `op-${turnId}`;
  const eventId = `fake:message:${message}`;
  insertRows(
    db,
    {
      sources: [
        {
          id: lineId,
          kind: 'said',
          iface: 'fake',
          native_id: message,
          revision: 1,
          place_id: mirror.placeId,
          occurred_at: stamp,
          recorded_at: stamp,
          text: `an older evening ${id}`,
          extra: JSON.stringify({ placeId: 'd1' }),
          ...SCOPED,
        },
        {
          id: answerId,
          kind: 'answer',
          iface: 'fake',
          place_id: mirror.placeId,
          occurred_at: stamp,
          recorded_at: stamp,
          turn_id: turnId,
          extra: JSON.stringify({ posted: [{ messageId: message, opId }] }),
          ...SCOPED,
        },
      ],
      day: [
        {
          id: actionId,
          at: stamp,
          what: 'action',
          place_id: mirror.placeId,
          turn_id: null,
          extra: JSON.stringify({ opId, name: 'selfreflection', phase: 'succeeded' }),
          ...SCOPED,
        },
      ],
    },
    { at: stamp }
  );
  db.prepare("INSERT INTO media_links (owner_kind, owner_id, position, media_id) VALUES ('source', ?, 0, ?)").run(
    lineId,
    mediaId
  );
  db.prepare("UPDATE media SET description = 'an older harbour', described_at = ? WHERE id = ?").run(stamp, mediaId);
  db.prepare(
    `INSERT OR REPLACE INTO vectors (source_rowid, item_id, chunk_key, model, dims, scale, norm, bytes, context, occurred_at)
     VALUES (NULL, ?, ?, 'test-model', 2, 1, 1, ?, '{}', ?)`
  ).run(mediaId, `media:${mediaId}`, new Uint8Array([1, 2]), stamp);
  const authority = db.prepare('SELECT authority_id AS id FROM places WHERE id = ?').get(mirror.placeId)?.id;
  assert.ok(typeof authority === 'string', 'the mirror place has an authority');
  db.prepare(
    `INSERT INTO external_keys (authority_id, object_kind, native_key, generation, node_id, recorded_at)
     VALUES (?, 'source', ?, 1, ?, ?)`
  ).run(authority, JSON.stringify(['message', message, 1, 'said']), lineId, stamp);
  db.prepare(
    `INSERT INTO ingest (principal, seq, event_id, kind, conversation, committed_at, held, source_id)
     VALUES ('adapter', NULL, ?, 'message.received', 'd1', ?, NULL, ?)`
  ).run(eventId, stamp, lineId);
  return { entryId: id, message, lineId, mediaId, turnId, answerId, actionId, eventId };
}

/** A later turn's day row that read the diary channel: its `sourceMessageIds` list `ids`. */
function laterTurn(rig: RemovalScene, id: string, ids: ReadonlyArray<string>): void {
  const stamp = new Date(T0 + 2 * HOUR).toISOString();
  insertRows(
    rig.db,
    {
      day: [
        {
          id,
          at: stamp,
          what: 'turn',
          outcome: 'spoke',
          place_id: rig.mirror.placeId,
          turn_id: `turn-${id}`,
          extra: JSON.stringify({ sourceMessageIds: ids, mode: 'reply', participants: ['someone'] }),
          ...SCOPED,
        },
      ],
    },
    { at: stamp }
  );
}

/** One `day` row, parsed: its columns and its `extra`. */
function dayRow(rig: RemovalScene, id: string): { columns: Record<string, unknown>; extra: unknown } {
  const row = rig.db.prepare('SELECT * FROM day WHERE id = ?').get(id);
  assert.ok(row, `the day row ${id} is there`);
  const { extra, ...columns } = row;
  return { columns, extra: typeof extra === 'string' ? (JSON.parse(extra) as unknown) : null };
}

test('a line of hers that names the message only in native_id goes, with its picture link, key and vector', async () => {
  // Bug: the line is looked for only through its message family or its locator, and stays with everything it holds.
  const rig = await removalScene();
  const older = await olderEntry(rig, 'entry-older-pier');
  assert.ok('external_keys' in tablesNaming(rig.db, [older.lineId]), 'the scene seeds the key');
  const removal = await rig.remove(older.entryId);
  assert.equal(removal.ok, true, JSON.stringify(removal));
  assert.deepEqual(tablesNaming(rig.db, [older.message, older.lineId, older.mediaId]), {});
});

test('the turn of an older entry goes: its answer line whose posted holds the message, and its action by opId', async () => {
  // Bug: `posted` is read as a list of ids only, so a turn that recorded objects is never found.
  const rig = await removalScene();
  const older = await olderEntry(rig, 'entry-older-pier');
  await rig.remove(older.entryId);
  assert.deepEqual(rowsWhere(rig.db, 'sources', 'id', older.answerId), []);
  assert.deepEqual(rowsWhere(rig.db, 'day', 'id', older.actionId), []);
  assert.deepEqual(tablesNaming(rig.db, [older.turnId, older.answerId, older.actionId]), {});
});

test("the ingest receipt of a removed line's event goes, not only its source id", async () => {
  // Bug: the receipt is kept with its source nulled, a record that the message arrived.
  const rig = await removalScene();
  const older = await olderEntry(rig, 'entry-older-pier');
  await rig.remove(older.entryId);
  assert.deepEqual(rowsWhere(rig.db, 'ingest', 'event_id', older.eventId), []);
});

test("a later turn's day row loses the removed message from sourceMessageIds and keeps the rest", async () => {
  // Bug: the turn that read the diary channel later still names the removed message, or loses its other fields.
  const rig = await removalScene();
  const older = await olderEntry(rig, 'entry-older-pier');
  laterTurn(rig, 'day-later-read', ['fake-other-1', older.message, 'fake-other-2']);
  const before = dayRow(rig, 'day-later-read');
  await rig.remove(older.entryId);
  const after = dayRow(rig, 'day-later-read');
  assert.deepEqual(after.columns, before.columns);
  assert.deepEqual(after.extra, {
    sourceMessageIds: ['fake-other-1', 'fake-other-2'],
    mode: 'reply',
    participants: ['someone'],
  });
});

test("a later turn's day row that read only the removed message stays, with an empty sourceMessageIds", async () => {
  // Bug: the row is deleted with the message, and the later turn loses its own record.
  const rig = await removalScene();
  const older = await olderEntry(rig, 'entry-older-pier');
  laterTurn(rig, 'day-later-only', [older.message]);
  await rig.remove(older.entryId);
  const after = dayRow(rig, 'day-later-only');
  assert.equal(after.columns.turn_id, 'turn-day-later-only');
  assert.deepEqual(after.extra, { sourceMessageIds: [], mode: 'reply', participants: ['someone'] });
});

test('the ingest receipt of a removed line found through its message family goes too', async () => {
  // Bug: the line goes and its receipt stays with `source_id` nulled, still naming the message in its event id.
  const rig = await removalScene();
  const seeded = await rig.published({ id: 'entry-north-pier', picture: false });
  const [message] = seeded.messageIds;
  assert.ok(message);
  const line = rig.db
    .prepare("SELECT id FROM sources WHERE kind = 'said' AND text = ?")
    .get('a quiet hour for entry-north-pier')?.id;
  assert.ok(typeof line === 'string', 'her line is stored');
  const eventId = `fake:message:${message}`;
  rig.db
    .prepare(
      `INSERT INTO ingest (principal, seq, event_id, kind, conversation, committed_at, held, source_id)
       VALUES ('adapter', NULL, ?, 'message.received', 'd1', ?, NULL, ?)`
    )
    .run(eventId, new Date(T0).toISOString(), line);
  await rig.remove(seeded.entryId);
  assert.deepEqual(rowsWhere(rig.db, 'ingest', 'event_id', eventId), []);
});
