// The journal, the record and the archive address a canonical place and hold no root or private-member split: a DM's
// lines belong to its DM place, and the engine's own lines to the persona. Retries run from the key chosen at the write, so
// they need no ambient interface.
// Contract, plan 2026-11-04-cli-and-memory task 5:
//   journal.start(placeId, input), journal.system(record): persona collection
//   record.append(placeId, lines, opts?), record.iterate(placeId, query?)
//   archive.append(placeId, entries), archive.iterate(placeId, query?)
//   `privateAccountId` leaves all three: the DM place is the private address.
// Appendix entries: src/memory/{journal,record,record-index,archive,vectors,embedder,describe,update,root}.ts,
// src/memory/db/readers/{archive,common,record,vectors}.ts, src/memory/db/request-archive.ts, src/turn/journal-notes.ts,
// src/turn/lookup.ts, src/turn/outcome.ts, src/web/lookup.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAppendStore } from '../src/memory/append-store.ts';
import { archiveEntry, createArchive } from '../src/memory/archive.ts';
import { withIface } from '../src/memory/db/current-iface.ts';
import { PERSONA_ID } from '../src/memory/db/ids.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db } from '../src/memory/db/types.ts';
import { createJournal } from '../src/memory/journal.ts';
import { createRecord, toRecordLine } from '../src/memory/record.ts';
import { wrongly } from './fixtures/loose-types.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';

const quiet = { info() {}, warn() {}, error() {} };
const NOW = Date.UTC(2026, 10, 3, 9, 0, 0);
const DM = 'place:dm-a21';
const OTHER = 'place:room-1';

/** The holders of a writer's live rows in `table`: the places, or the persona, whose lines they are. */
const holdersOf = (db: Db, table: string, writer: string): Array<unknown> =>
  db
    .prepare(`SELECT DISTINCT holder_id FROM "${table}" WHERE writer = ? AND retired_at IS NULL ORDER BY holder_id`)
    .all(writer)
    .map((row) => row.holder_id);

const slim = (id: string) => ({
  id,
  placeId: 'native-chat',
  placeName: 'a chat',
  authorId: 'u1',
  authorName: 'Zoé',
  self: false,
  bot: false,
  content: 'Καλημέρα',
  ts: NOW,
  replyToId: null,
  attachments: [],
  links: [],
  stickers: [],
  emojis: [],
  direct: false,
});

async function scene() {
  const mem = await openTestMemory({ iface: () => 'somewhere-else' });
  const read = (): Db => dbOf(wrongly<Parameters<typeof dbOf>[0]>(mem.memoryDb.readHandle()));
  return { mem, read };
}

test('the engine lines of the journal belong to the persona', async () => {
  // Bug: a start line with no root is written under `<iface>:guild:`, an address shared by nobody and everybody.
  const { mem, read } = await scene();
  try {
    const journal = createJournal({ dataDir: mem.dataDir, memoryDb: mem.memoryDb, now: () => NOW, log: quiet });
    await journal.system({ event: 'start', by: 'service' });
    await journal.flush?.();
    assert.deepEqual(holdersOf(read(), 'day', 'journal'), [PERSONA_ID]);
  } finally {
    await mem.close();
  }
});

test('a turn with no place stores its journal rows with no place, never a place that does not exist', async () => {
  // Bug: a service turn runs in the stand-in chat `persona:local`, and the journal scoped its lines to that chat, so the
  // mapper spelled `<iface>:channel:persona:local` into `day.place_id` and `sources.place_id`, a place no row of `places` holds.
  const { mem, read } = await scene();
  try {
    const journal = createJournal({ dataDir: mem.dataDir, memoryDb: mem.memoryDb, now: () => NOW, log: quiet });
    const { turnId, attemptId } = journal.start(PERSONA_ID, {
      placeId: PERSONA_ID,
      mode: 'inner',
      turnId: 't-service',
    });
    await journal.action(PERSONA_ID, { placeId: PERSONA_ID, turnId, name: 'skill', phase: 'started' });
    await journal.turn(PERSONA_ID, { placeId: PERSONA_ID, turnId, attemptId, outcome: 'spoke', posted: ['m-1'] });
    await journal.flush?.();
    const rows = read()
      .prepare(
        `SELECT 'day' AS t, place_id FROM day WHERE turn_id = 't-service'
         UNION ALL SELECT 'sources', place_id FROM sources WHERE turn_id = 't-service'`
      )
      .all();
    assert.deepEqual(rows.map((row) => row.t).sort(), ['day', 'day', 'day', 'sources']);
    assert.deepEqual(
      rows.map((row) => row.place_id),
      [null, null, null, null]
    );
  } finally {
    await mem.close();
  }
});

test('the record of a place is written and read by its id, whatever interface is ambient', async () => {
  // Bug: the write made inside an event and the read made on a wake address two collections of one place.
  const { mem, read } = await scene();
  try {
    const record = createRecord({ dataDir: mem.dataDir, log: quiet, now: () => NOW, memoryDb: mem.memoryDb });
    const written = await withIface('telegram', () => record.append(DM, [toRecordLine(slim('m1'))]));
    assert.equal(written.written, 1);
    const seen: Array<unknown> = [];
    for await (const line of record.iterate(DM)) seen.push(Reflect.get(Object(line), 'messageId'));
    assert.equal(seen.length, 1);
    for await (const line of record.iterate(OTHER))
      assert.fail(`read a line of another place: ${JSON.stringify(line)}`);
    assert.deepEqual(holdersOf(read(), 'sources', 'record'), [DM]);
  } finally {
    await mem.close();
  }
});

test('an archive entry evicted from a DM lands under the DM place and is read back there', async () => {
  // Bug: a private entry goes to `scope: { user }` under a root, so the person view and the place view miss it.
  const { mem, read } = await scene();
  try {
    const appendStore = createAppendStore({ fsyncMs: 0, log: quiet });
    const archive = createArchive({
      appendStore,
      dataDir: mem.dataDir,
      log: quiet,
      now: () => NOW,
      memoryDb: mem.memoryDb,
    });
    const entry = archiveEntry(
      { itemId: 'ep-1', date: '2026-11-01', what: 'a synthetic event', weight: 3, addedAt: '2026-11-01T00:00:00.000Z' },
      { itemKind: 'episode', event: 'evicted', now: () => NOW }
    );
    assert.deepEqual(await archive.append(DM, [entry]), { written: 1, duplicates: 0 });
    const found: Array<unknown> = [];
    for await (const line of archive.iterate(DM)) found.push(line);
    assert.equal(found.length, 1);
    assert.deepEqual(holdersOf(read(), 'claim_versions', 'archive'), [DM]);
  } finally {
    await mem.close();
  }
});
