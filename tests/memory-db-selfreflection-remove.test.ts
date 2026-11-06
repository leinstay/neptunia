// The owner's removal of a selfreflection entry with everything that points at it (brief 2026-11-06, "the owner removes
// a diary entry"): the memory service's `removeSelfreflectionEntry({ entryId, by, port })`. It refuses before anything
// changes, deletes every message the entry went out as through the interface's own delete, then removes the entry, its
// media, its publications, her lines of those messages and the records of the turn that made it in one write of the
// one writer, with their graph projection. The scene is tests/fixtures/selfreflection-removal.ts, whose head holds the
// contract. "No row names it" is read by scanning every table of the database for the ids. Invented ids only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { auditMemory } from '../src/memory/db/audit.ts';
import { HOUR, T0, removalScene, rowsWhere, tableCounts, tablesNaming } from './fixtures/selfreflection-removal.ts';
import type { RemovalScene, Seeded } from './fixtures/selfreflection-removal.ts';

/** Every id the removal of `seeded` must leave no row naming. */
const idsOf = (seeded: Seeded): Array<string> => [
  seeded.entryId,
  seeded.turnId,
  seeded.answerId,
  ...seeded.messageIds,
  ...seeded.mediaIds,
  ...seeded.dayIds,
  ...seeded.requestIds,
];

/** The mirror's `backfill_high_water`. */
function highWater(rig: RemovalScene): unknown {
  const row = rig.db.prepare('SELECT backfill_high_water AS mark FROM mirrors WHERE id = ?').get(rig.mirror.id);
  return row?.mark ?? null;
}

function setHighWater(rig: RemovalScene, entryId: string): void {
  rig.db.prepare('UPDATE mirrors SET backfill_high_water = ? WHERE id = ?').run(entryId, rig.mirror.id);
}

/** What the database holds of `seeded`, row by row, so a later read can tell whether any of it changed. */
function stateOf(rig: RemovalScene, seeded: Seeded): Record<string, Array<string>> {
  const { db } = rig;
  return {
    entry: rowsWhere(db, 'selfreflection', 'id', seeded.entryId),
    links: rowsWhere(db, 'media_links', 'owner_id', seeded.entryId),
    media: seeded.mediaIds.flatMap((id) => rowsWhere(db, 'media', 'id', id)),
    publications: rowsWhere(db, 'publications', 'row_id', seeded.entryId),
    families: seeded.messageIds.flatMap((id) => rowsWhere(db, 'message_families', 'message_id', id)),
    turn: rowsWhere(db, 'sources', 'turn_id', seeded.turnId),
    day: rowsWhere(db, 'day', 'turn_id', seeded.turnId),
    requests: rowsWhere(db, 'model_requests', 'turn_id', seeded.turnId),
  };
}

// ---- what goes -----------------------------------------------------------------------------------------------------

test('a published entry with a picture leaves no row that names it, its messages, its media or its turn', async () => {
  // Bug: a table the removal forgot (a graph node, a search row, a request of the turn) keeps the entry alive.
  const rig = await removalScene();
  const seeded = await rig.published({ id: 'entry-north-pier' });
  const before = tablesNaming(rig.db, idsOf(seeded));
  for (const table of ['selfreflection', 'media', 'media_links', 'publications', 'sources', 'day', 'model_requests'])
    assert.ok(table in before, `the scene seeds ${table}`);
  const removal = await rig.remove(seeded.entryId);
  assert.equal(removal.ok, true, JSON.stringify(removal));
  assert.deepEqual(tablesNaming(rig.db, idsOf(seeded)), {});
});

test('the removal answers the messages it deleted and the rows it removed by table', async () => {
  // Bug: the owner is told the entry went while a count says nothing, or the counts are of another entry.
  const rig = await removalScene();
  const seeded = await rig.published({ id: 'entry-north-pier' });
  const removal = await rig.remove(seeded.entryId);
  assert.ok(removal.ok, JSON.stringify(removal));
  assert.equal(removal.entryId, seeded.entryId);
  assert.equal(removal.deleted, seeded.messageIds.length);
  assert.equal(removal.removed.selfreflection, 1);
  assert.equal(removal.removed.media, seeded.mediaIds.length);
  assert.equal(removal.removed.model_requests, seeded.requestIds.length);
});

test('the picture file of a removed entry is gone from the media folder', async () => {
  // Bug: the rows go and the file stays under media/, a copy of the picture nobody can find again.
  const rig = await removalScene();
  const seeded = await rig.published({ id: 'entry-north-pier' });
  assert.equal(seeded.files.length, 1);
  assert.ok(
    seeded.files.every((file) => fs.existsSync(file)),
    'the scene keeps the file'
  );
  await rig.remove(seeded.entryId);
  assert.deepEqual(
    seeded.files.filter((file) => fs.existsSync(file)),
    []
  );
});

test('the picture of a removed entry is no longer found by its description', async () => {
  // Bug: the media row is deleted around its search rows, so a search for its words still answers it.
  const rig = await removalScene();
  const seeded = await rig.published({ id: 'entry-north-pier' });
  const count = () =>
    Number(rig.db.prepare("SELECT COUNT(*) AS n FROM media_fts WHERE media_fts MATCH 'lantern'").get()?.n);
  assert.equal(count(), 1);
  await rig.remove(seeded.entryId);
  assert.equal(count(), 0);
});

test('every message the entry went out as is deleted once, in its own conversation, through the port', async () => {
  // Bug: only the first segment is deleted and the picture stays on the platform, or a delete goes to another place.
  const rig = await removalScene();
  const seeded = await rig.published({ id: 'entry-north-pier' });
  await rig.remove(seeded.entryId);
  assert.deepEqual(
    rig.deletes.map((ref) => [ref.iface, ref.conversationId, ref.messageId]).sort(),
    seeded.messageIds.map((id) => ['fake', 'd1', id]).sort()
  );
  assert.deepEqual(rig.scene.transport().posted('d1'), []);
});

test('a message named by an old mirror row of the entry is deleted on the platform too', async () => {
  // Bug: the removal reads the receipts of `publications` only, and a post from before that model stays up.
  const rig = await removalScene();
  const ref = rig.fake.seed('d1', { authorId: 'self', text: 'an older evening' });
  rig.scene.entry({ id: 'entry-old-post', at: T0 - HOUR, text: 'an older evening' });
  rig.scene.receipt('entry-old-post', rig.mirror.placeId, 'fake', [ref.messageId]);
  const removal = await rig.remove('entry-old-post');
  assert.equal(removal.ok, true, JSON.stringify(removal));
  assert.deepEqual(
    rig.deletes.map((one) => one.messageId),
    [ref.messageId]
  );
  assert.deepEqual(tablesNaming(rig.db, ['entry-old-post', ref.messageId]), {});
});

// ---- what stays ----------------------------------------------------------------------------------------------------

test('a picture another entry also links stays, with its file and the other link', async () => {
  // Bug: the media row is deleted because this entry linked it, and the other entry loses its picture.
  const rig = await removalScene();
  const seeded = await rig.published({ id: 'entry-north-pier' });
  const [mediaId] = seeded.mediaIds;
  assert.ok(mediaId);
  rig.scene.entry({ id: 'entry-same-picture', at: T0 + HOUR });
  rig.db
    .prepare("INSERT INTO media_links (owner_kind, owner_id, position, media_id) VALUES ('selfreflection', ?, 0, ?)")
    .run('entry-same-picture', mediaId);
  await rig.remove(seeded.entryId);
  assert.equal(rowsWhere(rig.db, 'media', 'id', mediaId).length, 1);
  assert.deepEqual(rig.mediaOf('entry-same-picture'), [mediaId]);
  assert.ok(
    seeded.files.every((file) => fs.existsSync(file)),
    'the shared file stays'
  );
  assert.deepEqual(rig.mediaOf(seeded.entryId), []);
});

test('removing one of two entries of a day leaves the other whole', async () => {
  // Bug: the turn's records are picked by day or by place, and the other entry's lines and requests go with it.
  const rig = await removalScene();
  const first = await rig.published({ id: 'entry-morning', at: T0 });
  const second = await rig.published({ id: 'entry-evening', at: T0 + 6 * HOUR });
  const before = stateOf(rig, second);
  for (const [part, rows] of Object.entries(before)) assert.ok(rows.length > 0, `the scene seeds the ${part}`);
  await rig.remove(first.entryId);
  assert.deepEqual(stateOf(rig, second), before);
  assert.ok(
    second.files.every((file) => fs.existsSync(file)),
    'the other entry keeps its file'
  );
});

// ---- refusals ------------------------------------------------------------------------------------------------------

test('an id that names no entry is refused as unknown-entry', async () => {
  // Bug: a mistyped id answers ok with zero counts, and the owner thinks the entry is gone.
  const rig = await removalScene();
  await rig.published({ id: 'entry-north-pier' });
  const before = tableCounts(rig.db);
  const removal = await rig.remove('entry-nowhere');
  assert.deepEqual(removal, { ok: false, code: 'unknown-entry' });
  assert.deepEqual(tableCounts(rig.db), before);
  assert.deepEqual(rig.deletes, []);
});

test('an entry already removed is refused as unknown-entry the second time', async () => {
  // Bug: the second run finds the leftovers of the first, or deletes again on the platform.
  const rig = await removalScene();
  const seeded = await rig.published({ id: 'entry-north-pier' });
  await rig.remove(seeded.entryId);
  const deletes = rig.deletes.length;
  assert.deepEqual(await rig.remove(seeded.entryId), { ok: false, code: 'unknown-entry' });
  assert.equal(rig.deletes.length, deletes);
});

test('an entry whose send is uncertain is refused as busy, with nothing removed and no delete', async () => {
  // Bug: the removal runs over a send whose message may still appear, and the post outlives its entry.
  const rig = await removalScene();
  const transport = rig.scene.transport();
  transport.behave = () => 'lost-answer';
  rig.scene.entry({ id: 'entry-unsure' });
  await rig.scene.publisher().publishEntry({ id: 'entry-unsure', messages: ['a message that may have gone'] });
  const before = tableCounts(rig.db);
  const removal = await rig.remove('entry-unsure');
  assert.deepEqual(removal, { ok: false, code: 'busy' });
  assert.deepEqual(tableCounts(rig.db), before);
  assert.deepEqual(rig.deletes, []);
});

test('with the interface down a published entry is refused as interface-down, with nothing removed', async () => {
  // Bug: memory forgets the entry while its posts stay on the platform with nothing pointing at them.
  const rig = await removalScene();
  const seeded = await rig.published({ id: 'entry-north-pier' });
  rig.connect(false);
  const before = tableCounts(rig.db);
  assert.deepEqual(await rig.remove(seeded.entryId), { ok: false, code: 'interface-down' });
  assert.deepEqual(tableCounts(rig.db), before);
  assert.deepEqual(rig.deletes, []);
});

test('a delete the platform refuses with a retryable code stops the removal, names the code and removes nothing', async () => {
  // Bug: the rows go although the post is still up, or the owner is not told why it stopped.
  const rig = await removalScene();
  const seeded = await rig.published({ id: 'entry-north-pier' });
  rig.script(() => ({ status: 'failed', error: { code: 'rate-limited', retryable: true, retryAfterMs: 1000 } }));
  const before = tableCounts(rig.db);
  const removal = await rig.remove(seeded.entryId);
  assert.deepEqual(removal, { ok: false, code: 'delete-failed', platformCode: 'rate-limited' });
  assert.deepEqual(tableCounts(rig.db), before);
  assert.ok(
    seeded.files.every((file) => fs.existsSync(file)),
    'the file stays'
  );
});

test('a message the platform no longer has counts as deleted and the removal goes through', async () => {
  // Bug: a post someone already deleted by hand blocks the removal for good.
  const rig = await removalScene();
  const seeded = await rig.published({ id: 'entry-north-pier' });
  const [gone] = seeded.messageIds;
  assert.ok(gone);
  const done = await rig.fake.delete({ iface: 'fake', conversationId: 'd1', messageId: gone });
  assert.equal(done.status, 'ok');
  const removal = await rig.remove(seeded.entryId);
  assert.ok(removal.ok, JSON.stringify(removal));
  assert.equal(removal.deleted, seeded.messageIds.length);
  assert.deepEqual(tablesNaming(rig.db, idsOf(seeded)), {});
});

// ---- the mirror's boundary -----------------------------------------------------------------------------------------

test("a mirror's boundary on the removed entry moves to the newest remaining entry at or before it", async () => {
  // Bug: the boundary names an entry that no longer exists, and the backfill cannot tell where it stopped.
  const rig = await removalScene();
  rig.scene.entry({ id: 'entry-a', at: T0 });
  rig.scene.entry({ id: 'entry-b', at: T0 + HOUR });
  rig.scene.entry({ id: 'entry-c', at: T0 + 2 * HOUR });
  rig.scene.entry({ id: 'entry-d', at: T0 + 3 * HOUR });
  setHighWater(rig, 'entry-c');
  const removal = await rig.remove('entry-c');
  assert.equal(removal.ok, true, JSON.stringify(removal));
  assert.equal(highWater(rig), 'entry-b');
});

test("a mirror's boundary on the removed entry is null when no entry at or before it remains", async () => {
  // Bug: the boundary falls to an entry after it, so the backfill skips entries it never sent.
  const rig = await removalScene();
  rig.scene.entry({ id: 'entry-a', at: T0 });
  rig.scene.entry({ id: 'entry-b', at: T0 + HOUR });
  setHighWater(rig, 'entry-a');
  await rig.remove('entry-a');
  assert.equal(highWater(rig), null);
});

test("a mirror's boundary on another entry stays where it is", async () => {
  // Bug: every mirror's boundary is recomputed and one on a newer entry moves back.
  const rig = await removalScene();
  rig.scene.entry({ id: 'entry-a', at: T0 });
  rig.scene.entry({ id: 'entry-b', at: T0 + HOUR });
  setHighWater(rig, 'entry-b');
  await rig.remove('entry-a');
  assert.equal(highWater(rig), 'entry-b');
});

// ---- after the removal ---------------------------------------------------------------------------------------------

test('the delete event of a removed message, arriving after the removal, writes no row', async () => {
  // Bug: the platform's echo of our own delete leaves a tombstone, a record that the message existed.
  const rig = await removalScene();
  const seeded = await rig.published({ id: 'entry-north-pier' });
  await rig.remove(seeded.entryId);
  const before = tableCounts(rig.db);
  for (const messageId of seeded.messageIds) {
    const done = (await rig.deleteEvent(messageId)) as { ok?: unknown } | null;
    // The pipeline appends a `deleted` line to the record only when memory answers ok.
    assert.notEqual(done?.ok, true, `the event of ${messageId} is not taken`);
  }
  assert.deepEqual(tableCounts(rig.db), before);
  assert.deepEqual(tablesNaming(rig.db, seeded.messageIds), {});
});

test('the audit finds nothing new and the foreign key check is clean after a removal', async () => {
  // Bug: a link, a vector or a graph edge left pointing at a removed row, which the audit or SQLite reports.
  const rig = await removalScene();
  const seeded = await rig.published({ id: 'entry-north-pier' });
  await rig.published({ id: 'entry-south-gate', at: T0 + HOUR });
  const before = new Map(Object.entries(auditMemory(rig.db).checks));
  await rig.remove(seeded.entryId);
  const after = auditMemory(rig.db).checks;
  const grew = Object.entries(after).filter(([check, count]) => count > (before.get(check) ?? 0));
  assert.deepEqual(grew, []);
  assert.deepEqual(rig.db.prepare('PRAGMA foreign_key_check').all(), []);
});
