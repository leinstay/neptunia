// The scene of the owner's removal of a selfreflection entry (tests/memory-db-selfreflection-remove.test.ts and
// tests/commands-memory-selfreflection-remove.test.ts): the mirror scene (real memory service, fake interface transport,
// the real publisher) with one enabled mirror on `d1`, and entries as production leaves them. An entry is published
// through the publisher, so its publication, its receipts, its media rows and files are the writer's own; her own lines
// of the published messages are observed through the service as the interface echoes them; the turn that made the entry
// is its `answer` line (whose `posted` names the published messages), its `day` rows and its `model_requests` rows; a
// picture gets a description (its search rows) and a vector. The port the removal deletes through wraps the fake
// adapter and records every delete; a test scripts what one answers. Invented ids and synthetic text only.
//
// The contract the removal tests are typed against, which the implementer builds:
//   MemoryDbService.removeSelfreflectionEntry({ entryId, by, port }): Promise<EntryRemoval>
//     port: (iface: string) => Pick<Adapter, 'delete'> | null   the interface's own delete, null while it is down
//   EntryRemoval =
//     | { ok: true; entryId: string; deleted: number; removed: Record<string, number> }
//         deleted: the messages deleted on the platform, one already gone counted; removed: rows removed per table
//     | { ok: false; code: 'unknown-entry' | 'busy' | 'interface-down' }
//     | { ok: false; code: 'delete-failed'; platformCode: string }   the port's own error code
//   ConsoleDeps.port?: (iface: string) => Pick<Adapter, 'delete'> | null    what `/memory selfreflection remove` deletes through
//   `/memory selfreflection remove <id>` parses to `memory.selfreflection.remove` with `{ id }`; a refusal answers the code.
import assert from 'node:assert/strict';
import { insertRows } from '../../src/memory/db/rows.ts';
import { answerSourceId } from '../../src/memory/db/ids.ts';
import { deletionOf, observationOf } from '../../src/memory/db/observe-event.ts';
import type { Db } from '../../src/memory/db/types.ts';
import type { MemoryDbService } from '../../src/memory/db/service.ts';
import type { PortResult } from '../../src/protocol/actions.ts';
import type { Adapter, MessageRef } from '../../src/protocol/adapter.ts';
import { HOUR, T0, mirrorScene } from './mirror-scene.ts';
import type { Scene } from './mirror-scene.ts';
import { seedMirror } from './selfreflection-mirror.ts';

export { HOUR, T0 };

/** The conversation of the scene's one mirror. */
export const CONVERSATION = 'd1';

/** The answer of a removal: what the service's answer must be assignable to (see the head of this file). */
export type EntryRemoval =
  | { ok: true; entryId: string; deleted: number; removed: Record<string, number> }
  | { ok: false; code: 'unknown-entry' | 'busy' | 'interface-down' }
  | { ok: false; code: 'delete-failed'; platformCode: string };

/** The service as the removal tests reach it: its own type, with the removal the implementer adds. */
type RemovingService = MemoryDbService & {
  removeSelfreflectionEntry(request: {
    entryId: string;
    by: string;
    port: (iface: string) => DeletePort | null;
  }): Promise<EntryRemoval>;
};

/** What the removal deletes through: the interface's own delete of a message. */
export type DeletePort = Pick<Adapter, 'delete'>;

/** One entry as the scene seeded it: its ids, the messages it went out as and the files memory keeps of it. */
export type Seeded = {
  entryId: string;
  turnId: string;
  answerId: string;
  messageIds: Array<string>;
  mediaIds: Array<string>;
  files: Array<string>;
  dayIds: Array<string>;
  requestIds: Array<string>;
};

const PICTURE = { buffer: new Uint8Array([7, 1, 4, 2]), mediaType: 'image/png' };

/** The scene: see the head of this file. */
// The scene's type is what it returns; a test file reads it through `RemovalScene`.
// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export async function removalScene() {
  const scene: Scene = await mirrorScene();
  // The service is typed with the removal once the implementer adds it; until then this line is the type error that says so.
  const memoryDb: RemovingService = scene.memory.memoryDb;
  const mirror = seedMirror(memoryDb, { iface: 'fake', conversationId: CONVERSATION, at: T0 });
  const { fake } = scene.transport();
  const publisher = scene.publisher();
  const deletes: Array<MessageRef> = [];
  let up = true;
  /** What a delete answers instead of the fake's own, or null for the fake's own. */
  let scripted: (ref: MessageRef) => PortResult | null = () => null;
  const port: DeletePort = {
    async delete(ref) {
      deletes.push(ref);
      return scripted(ref) ?? fake.delete(ref);
    },
  };
  const portOf = (iface: string): DeletePort | null => (up && iface === 'fake' ? port : null);

  /** Her own line of a message she posted, observed as the interface echoes it. */
  async function ownLine(messageId: string, text: string, at: number): Promise<void> {
    const envelope = observationOf(
      {
        iface: 'fake',
        at,
        conversation: { id: CONVERSATION, kind: 'channel', chatType: 'channel' },
        message: { id: messageId, at, content: text, author: { id: 'self' } },
      },
      { selfId: 'self' }
    );
    assert.ok(envelope, 'her line maps to an observation');
    const done = (await memoryDb.observeMessage(envelope)) as { ok?: unknown } | null;
    assert.equal(done?.ok, true, 'her line is stored');
  }

  /** The turn that made the entry: its answer line naming the posted messages, two day rows and two requests. */
  function turnRows(turnId: string, messageIds: ReadonlyArray<string>, at: number) {
    const stamp = new Date(at).toISOString();
    const answerId = answerSourceId(turnId, 1);
    const dayIds = [`day-${turnId}-start`, `day-${turnId}-end`];
    const requestIds = [`req-${turnId}-plan`, `req-${turnId}-write`];
    const scoped = { scope_kind: 'group', scope_iface: 'fake', scope_dm: null };
    insertRows(
      scene.db,
      {
        sources: [
          {
            id: answerId,
            kind: 'answer',
            iface: 'fake',
            place_id: mirror.placeId,
            occurred_at: stamp,
            recorded_at: stamp,
            turn_id: turnId,
            think: 'a thought of the wake',
            extra: JSON.stringify({ posted: messageIds }),
            ...scoped,
          },
        ],
        day: [
          { id: dayIds[0], at: stamp, what: 'turn.start', place_id: mirror.placeId, turn_id: turnId, ...scoped },
          {
            id: dayIds[1],
            at: stamp,
            what: 'turn',
            outcome: 'spoke',
            place_id: mirror.placeId,
            turn_id: turnId,
            source_id: answerId,
            ...scoped,
          },
        ],
        model_requests: requestIds.map((id, step) => ({
          id,
          schema_version: 1,
          turn_id: turnId,
          attempt_id: '1',
          step,
          role: 'core',
          purpose: step === 0 ? 'selfreflection-planner' : 'selfreflection',
          status: 'ok',
          started_at: stamp,
          finished_at: stamp,
          messages: '[]',
        })),
      },
      { at: stamp }
    );
    return { answerId, dayIds, requestIds };
  }

  /** The entry's pictures given a description and a vector, as the media jobs leave them. */
  function describe(mediaIds: ReadonlyArray<string>, words: string): void {
    for (const id of mediaIds) {
      scene.db.prepare("UPDATE media SET description = ?, described_at = ? WHERE id = ?").run(words, new Date(T0).toISOString(), id);
      scene.db
        .prepare(
          `INSERT INTO vectors (source_rowid, item_id, chunk_key, model, dims, scale, norm, bytes, context, occurred_at)
           VALUES (NULL, ?, ?, 'test-model', 2, 1, 1, ?, '{}', ?)`
        )
        .run(id, `media:${id}`, new Uint8Array([1, 2]), new Date(T0).toISOString());
    }
  }

  /**
   * An entry `id` recorded at `at`, published once to the mirror with one message and, unless `picture` is false, one
   * picture; her lines of what went out, and the turn `turn-<id>` that made it.
   */
  async function published({
    id,
    at = scene.now(),
    text = `a quiet hour for ${id}`,
    picture = true,
  }: {
    id: string;
    at?: number;
    text?: string;
    picture?: boolean;
  }): Promise<Seeded> {
    scene.entry({ id, at, text, messages: [text] });
    const outcomes = await publisher.publishEntry({ id, messages: [text], pictures: picture ? [PICTURE] : [] });
    assert.deepEqual(
      outcomes.map((one) => one.status),
      ['sent'],
      'the entry went out once'
    );
    const state = publisher.publicationState(id, mirror.placeId);
    assert.ok(state, 'the entry has its publication');
    const messageIds = state.segments.flatMap((segment) => segment.messageIds);
    for (const messageId of messageIds) await ownLine(messageId, text, at);
    const turnId = `turn-${id}`;
    const turn = turnRows(turnId, messageIds, at);
    const mediaIds = mediaOf(id);
    describe(mediaIds, `lantern harbour ${id}`);
    return { entryId: id, turnId, messageIds, mediaIds, files: scene.mediaFiles(id), ...turn };
  }

  /** The media ids the entry links, in their order. */
  const mediaOf = (entryId: string): Array<string> =>
    scene.db
      .prepare("SELECT media_id FROM media_links WHERE owner_kind = 'selfreflection' AND owner_id = ? ORDER BY position")
      .all(entryId)
      .map((row) => String(row.media_id));

  /** The removal of `entryId` through the memory service, as the owner. */
  const remove = (entryId: string): Promise<EntryRemoval> =>
    memoryDb.removeSelfreflectionEntry({ entryId, by: 'owner', port: portOf });

  /** The platform's delete event of `messageId`, arriving after the command, through the service. */
  function deleteEvent(messageId: string): Promise<object> | null {
    const envelope = deletionOf({
      iface: 'fake',
      at: scene.now(),
      deleted: true,
      conversation: { id: CONVERSATION, kind: 'channel', chatType: 'channel' },
      message: { id: messageId, at: scene.now() - HOUR },
    });
    assert.ok(envelope, 'the delete event maps to a deletion');
    return memoryDb.deleteMessage(envelope);
  }

  return {
    scene,
    db: scene.db,
    memoryDb,
    mirror,
    fake,
    deletes,
    port: portOf,
    published,
    remove,
    deleteEvent,
    mediaOf,
    /** Every delete from now on answers what `answer` gives, or the fake's own for null. */
    script(answer: (ref: MessageRef) => PortResult | null): void {
      scripted = answer;
    },
    /** The interface goes down, or comes back. */
    connect(on: boolean): void {
      up = on;
    },
  };
}

export type RemovalScene = Awaited<ReturnType<typeof removalScene>>;

/** Whether `text` holds `needle` as a whole word: a message id `fake-1` is not found inside `fake-12`. */
function namesWord(text: string, needle: string): boolean {
  let from = text.indexOf(needle);
  while (from >= 0) {
    const before = from === 0 ? '' : text.charAt(from - 1);
    const after = text.charAt(from + needle.length);
    if (!/[A-Za-z0-9]/.test(before) && !/[A-Za-z0-9]/.test(after)) return true;
    from = text.indexOf(needle, from + 1);
  }
  return false;
}

/**
 * Every table with a row whose text names one of `needles`, each table with the needles it names. Every table of the
 * database is read whole, so a row nobody thought of still counts.
 */
export function tablesNaming(db: Db, needles: ReadonlyArray<string>): Record<string, Array<string>> {
  const found: Record<string, Array<string>> = {};
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => String(row.name));
  for (const table of tables) {
    const hits = new Set<string>();
    for (const row of db.prepare(`SELECT * FROM "${table}"`).all())
      for (const value of Object.values(row))
        if (typeof value === 'string') for (const needle of needles) if (namesWord(value, needle)) hits.add(needle);
    if (hits.size > 0) found[table] = [...hits].sort();
  }
  return found;
}

/** Every row of `table` whose `column` is `value`, as JSON text in rowid order: a row's whole state, to compare. */
export function rowsWhere(db: Db, table: string, column: string, value: string): Array<string> {
  return db
    .prepare(`SELECT * FROM "${table}" WHERE "${column}" = ? ORDER BY rowid`)
    .all(value)
    .map((row) => JSON.stringify(row));
}

/** The row count of every table, to compare a database before and after. */
export function tableCounts(db: Db): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
    const name = String(row.name);
    counts[name] = Number(db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get()?.n);
  }
  return counts;
}
