// The rewrite of stored lines to stable names (src/memory/db/stable-names-rewrite.ts) and its write kind
// `stable-names-rewrite` (session-write.ts): a line tied to its emoji by its own media links gets `:eN:` in its text, a
// line with no link gets `:eN:` and its link where exactly one known emoji holds the name, the media rows get their stable
// names, and a name two emoji hold waits for a choice. Synthetic ids and names over a temp database. The other stored
// texts are in tests/stable-names-texts.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { applyMediaNamesWrite, mediaNameRows } from '../src/memory/db/media-names.ts';
import { planStableNamesRewrite } from '../src/memory/db/stable-names-rewrite.ts';
import type { StableNamesPlan } from '../src/memory/db/stable-names-rewrite.ts';
import { fillStems, loadStemmer, stemsOf, stemsPending } from '../src/memory/db/stems.ts';
import { graphNodeId, projectRow } from '../src/memory/db/graph.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Config, Db, MemoryHandle, Row } from '../src/memory/db/types.ts';
import { applyReembed, reembedTouched } from '../src/memory/db/index-policy.ts';
import { quantize } from '../src/memory/vectors.ts';

const T0 = Date.parse('2026-11-17T10:00:00Z');

function openTemp(): { handle: MemoryHandle; db: Db } {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'stable-names-'));
  const handle = openMemoryDb(path.join(root, 'memory.db'));
  return { handle, db: dbOf(handle) };
}

function line(db: Db, id: string, text: string): void {
  db.prepare("INSERT INTO sources (id, kind, iface, text) VALUES (?, 'seen', 'fake', ?)").run(id, text);
}

function media(db: Db, id: string, kind: 'emoji' | 'sticker', nativeId: string, name: string): void {
  const extra = JSON.stringify({ name, animated: false });
  const insert = db.prepare("INSERT INTO media (id, kind, native_ref, extra, scope_iface) VALUES (?, ?, ?, ?, 'fake')");
  insert.run(id, kind, nativeId, extra);
}

function link(db: Db, sourceId: string, position: number, mediaId: string): void {
  const insert = db.prepare(
    "INSERT INTO media_links (owner_kind, owner_id, position, media_id) VALUES ('source', ?, ?, ?)"
  );
  insert.run(sourceId, position, mediaId);
}

function textOf(db: Db, id: string): unknown {
  return db.prepare('SELECT text FROM sources WHERE id = ?').get(id)?.text;
}

function mediaName(db: Db, id: string): unknown {
  return db.prepare("SELECT json_extract(extra, '$.name') AS name FROM media WHERE id = ?").get(id)?.name;
}

function linksOf(db: Db, sourceId: string): Array<unknown> {
  const rows = db
    .prepare("SELECT media_id FROM media_links WHERE owner_kind = 'source' AND owner_id = ? ORDER BY position")
    .all(sourceId);
  return rows.map((row) => row.media_id);
}

/** The stable name and platform name `media_names` binds to a platform id, empty when it binds none. */
function boundOf(db: Db, nativeId: string): Array<unknown> {
  const row = db.prepare('SELECT name, platform_name FROM media_names WHERE native_id = ?').get(nativeId);
  return row ? [row.name, row.platform_name] : [];
}

function held(handle: MemoryHandle, name: string, nativeId: string, platformName: string): void {
  const row = { name, kind: 'emoji', iface: 'fake', nativeId, platformName, animated: false };
  applyMediaNamesWrite(handle, { rows: [row], now: T0 });
}

function apply(handle: MemoryHandle, plan: StableNamesPlan): unknown {
  return applyMemoryWrite(handle, { kind: 'stable-names-rewrite', ...plan, now: T0 });
}

test('rewrites a linked emoji token to its issued stable name and binds the name to the platform id', () => {
  const { handle, db } = openTemp();
  media(db, 'm1', 'emoji', '901', 'pog');
  line(db, 'l1', 'that was :pog: indeed');
  link(db, 'l1', 0, 'm1');
  apply(handle, planStableNamesRewrite(db));
  assert.equal(textOf(db, 'l1'), 'that was :e1: indeed');
  assert.equal(mediaName(db, 'm1'), 'e1');
  const bound = mediaNameRows(db).map((row) => [row.name, row.kind, row.iface, row.nativeId, row.platformName]);
  assert.deepEqual(bound, [['e1', 'emoji', 'fake', '901', 'pog']]);
});

test('keeps the stable name an emoji already holds and issues no second row', () => {
  const { handle, db } = openTemp();
  const held = { name: 'e7', kind: 'emoji', iface: 'fake', nativeId: '901', platformName: 'pog', animated: false };
  applyMediaNamesWrite(handle, { rows: [held], now: T0 });
  media(db, 'm1', 'emoji', '901', 'pog');
  line(db, 'l1', ':pog:');
  link(db, 'l1', 0, 'm1');
  const plan = planStableNamesRewrite(db);
  assert.deepEqual(plan.issue, []);
  apply(handle, plan);
  assert.equal(textOf(db, 'l1'), ':e7:');
  assert.deepEqual(
    mediaNameRows(db).map((row) => row.name),
    ['e7']
  );
});

test('leaves the text of a line that links two emoji of one platform name and counts it as not tied', () => {
  const { handle, db } = openTemp();
  media(db, 'm1', 'emoji', '901', 'pog');
  media(db, 'm2', 'emoji', '902', 'pog');
  const text = ':pog: then :pog:';
  line(db, 'l1', text);
  link(db, 'l1', 0, 'm1');
  link(db, 'l1', 1, 'm2');
  const plan = planStableNamesRewrite(db);
  assert.equal(plan.counts.untied, 1);
  assert.equal(plan.counts.tokens, 0);
  apply(handle, plan);
  assert.equal(textOf(db, 'l1'), text);
});

// This test asserted that a line with no link stays as it is. The owner's order of 2026-11-17 is that no emoji stays
// without a link to its line: a name exactly one known emoji holds now ties the line to it.
test('rewrites a line that holds a known emoji name with no link and links the line to that emoji', () => {
  const { handle, db } = openTemp();
  media(db, 'm1', 'emoji', '901', 'pog');
  line(db, 'l2', 'no link here :pog: ok');
  apply(handle, planStableNamesRewrite(db));
  assert.equal(textOf(db, 'l2'), 'no link here :e1: ok');
  assert.deepEqual(linksOf(db, 'l2'), ['m1']);
  assert.deepEqual(boundOf(db, '901'), ['e1', 'pog']);
});

test('renames a linked sticker media row to its stable name', () => {
  const { handle, db } = openTemp();
  media(db, 'm1', 'sticker', '801', 'wave_hello');
  line(db, 'l1', '');
  link(db, 'l1', 0, 'm1');
  apply(handle, planStableNamesRewrite(db));
  assert.equal(mediaName(db, 'm1'), 's1');
});

test('leaves a token inside a code span and rewrites the one outside it', () => {
  const { handle, db } = openTemp();
  media(db, 'm1', 'emoji', '901', 'pog');
  line(db, 'l1', 'type `:pog:` to get :pog:');
  link(db, 'l1', 0, 'm1');
  apply(handle, planStableNamesRewrite(db));
  assert.equal(textOf(db, 'l1'), 'type `:pog:` to get :e1:');
});

test('plans nothing and changes nothing when applied a second time', () => {
  const { handle, db } = openTemp();
  media(db, 'm1', 'emoji', '901', 'pog');
  media(db, 'm2', 'sticker', '801', 'wave_hello');
  line(db, 'l1', ':pog:');
  link(db, 'l1', 0, 'm1');
  link(db, 'l1', 1, 'm2');
  apply(handle, planStableNamesRewrite(db));
  const again = planStableNamesRewrite(db);
  assert.deepEqual([again.issue, again.lines, again.media], [[], [], []]);
  apply(handle, again);
  assert.equal(textOf(db, 'l1'), ':e1:');
  assert.equal(mediaNameRows(db).length, 2);
});

test('writes nothing when one line of the plan no longer holds the text it was planned from', () => {
  const { handle, db } = openTemp();
  media(db, 'm1', 'emoji', '901', 'pog');
  line(db, 'l1', ':pog: first');
  line(db, 'l2', ':pog: second');
  link(db, 'l1', 0, 'm1');
  link(db, 'l2', 0, 'm1');
  const plan = planStableNamesRewrite(db);
  db.prepare("UPDATE sources SET text = ':pog: changed' WHERE id = 'l2'").run();
  assert.throws(() => apply(handle, plan), { code: 'STABLE_NAMES_STALE' });
  assert.equal(textOf(db, 'l1'), ':pog: first');
  assert.equal(mediaName(db, 'm1'), 'pog');
  assert.deepEqual(mediaNameRows(db), []);
});

test('marks the rewritten line for stems so the word search finds it under its new text', () => {
  const { handle, db } = openTemp();
  media(db, 'm1', 'emoji', '901', 'pog');
  line(db, 'l1', 'bananas are :pog:');
  link(db, 'l1', 0, 'm1');
  fillStems(db);
  apply(handle, planStableNamesRewrite(db));
  assert.equal(stemsPending(db), true);
  fillStems(db);
  const { stem } = loadStemmer(db);
  const stored = db.prepare("SELECT stems FROM sources WHERE id = 'l1'").get()?.stems;
  assert.equal(stored, stemsOf(stem, 'bananas are :e1:'));
  const found = db
    .prepare('SELECT s.id FROM sources_fts f JOIN sources s ON s.rowid = f.rowid WHERE sources_fts MATCH ?')
    .all('text:e1')
    .map((row) => row.id);
  assert.deepEqual(found, ['l1']);
});

test('makes the media row of an emoji only media_names knows and links the unlinked line to it', () => {
  const { handle, db } = openTemp();
  held(handle, 'e5', '905', 'pog');
  line(db, 'l1', ':pog:');
  apply(handle, planStableNamesRewrite(db));
  assert.equal(textOf(db, 'l1'), ':e5:');
  const made = db.prepare("SELECT id, native_ref FROM media WHERE kind = 'emoji'").all();
  assert.deepEqual(
    made.map((row) => row.native_ref),
    ['905']
  );
  assert.deepEqual(linksOf(db, 'l1'), [made[0]?.id]);
});

test('leaves an unlinked line whose name two emoji hold and counts it as left for a shared name', () => {
  const { handle, db } = openTemp();
  media(db, 'm1', 'emoji', '901', 'aga');
  media(db, 'm2', 'emoji', '902', 'aga');
  line(db, 'l1', 'so :aga:');
  const plan = planStableNamesRewrite(db);
  const { left } = plan.counts;
  assert.equal(left.sharedName, 1);
  apply(handle, plan);
  assert.equal(textOf(db, 'l1'), 'so :aga:');
  assert.deepEqual(linksOf(db, 'l1'), []);
});

test('ties an unlinked line whose name two emoji hold to the emoji the choice names', () => {
  const { handle, db } = openTemp();
  media(db, 'm1', 'emoji', '901', 'aga');
  media(db, 'm2', 'emoji', '902', 'aga');
  line(db, 'l1', 'so :aga:');
  const plan = planStableNamesRewrite(db, { choose: { aga: '902' } });
  const { left } = plan.counts;
  assert.equal(left.sharedName, 0);
  apply(handle, plan);
  const [chosen] = boundOf(db, '902');
  assert.equal(textOf(db, 'l1'), `so :${String(chosen)}:`);
  assert.deepEqual(linksOf(db, 'l1'), ['m2']);
});

test('rewrites a known emoji name in her think by the same rule as a line', () => {
  const { handle, db } = openTemp();
  media(db, 'm1', 'emoji', '901', 'pog');
  db.prepare("INSERT INTO sources (id, kind, iface, text, think) VALUES ('a1', 'answer', 'fake', '', ?)").run(
    'I will send :pog: back'
  );
  apply(handle, planStableNamesRewrite(db));
  assert.equal(db.prepare("SELECT think FROM sources WHERE id = 'a1'").get()?.think, 'I will send :e1: back');
});

test('gives an emoji media row under its platform name its stable name when no line links it', () => {
  const { handle, db } = openTemp();
  media(db, 'm1', 'emoji', '901', 'pog');
  apply(handle, planStableNamesRewrite(db));
  assert.equal(mediaName(db, 'm1'), 'e1');
  assert.deepEqual(boundOf(db, '901'), ['e1', 'pog']);
});

test('gives a sticker media row under its platform name its stable name when no line links it', () => {
  const { handle, db } = openTemp();
  media(db, 'm1', 'sticker', '801', 'wave_hello');
  apply(handle, planStableNamesRewrite(db));
  assert.equal(mediaName(db, 'm1'), 's1');
});

test('rewrites an old sticker reference of a line that links one sticker to the current form with its stable name', () => {
  const { handle, db } = openTemp();
  media(db, 'm1', 'sticker', '801', 'wave_hello');
  line(db, 'l1', 'hi [sticker: wave_hello]');
  link(db, 'l1', 0, 'm1');
  apply(handle, planStableNamesRewrite(db));
  assert.equal(textOf(db, 'l1'), 'hi [sticker s1]');
});

test('rewrites a sticker reference in the current form under its platform name when the line links that sticker', () => {
  const { handle, db } = openTemp();
  media(db, 'm1', 'sticker', '801', 'wave_hello');
  line(db, 'l1', '[sticker wave_hello]');
  link(db, 'l1', 0, 'm1');
  apply(handle, planStableNamesRewrite(db));
  assert.equal(textOf(db, 'l1'), '[sticker s1]');
});

test('leaves an old sticker reference of a line that links no sticker and counts it', () => {
  const { handle, db } = openTemp();
  media(db, 'm1', 'sticker', '801', 'wave_hello');
  line(db, 'l1', 'hi [sticker: wave_hello]');
  const plan = planStableNamesRewrite(db);
  const { left } = plan.counts;
  assert.equal(left.unlinkedSticker, 1);
  apply(handle, plan);
  assert.equal(textOf(db, 'l1'), 'hi [sticker: wave_hello]');
});

test('counts the rows of each table the plan touches', () => {
  const { db } = openTemp();
  media(db, 'm1', 'emoji', '901', 'pog');
  line(db, 'l1', ':pog:');
  line(db, 'l2', 'and :pog:');
  const { tables } = planStableNamesRewrite(db).counts;
  assert.deepEqual([tables.sources, tables.media, tables.media_links, tables.media_names], [2, 1, 2, 1]);
});

test('plans no change after an apply and still counts what it leaves', () => {
  const { handle, db } = openTemp();
  media(db, 'm1', 'emoji', '901', 'pog');
  media(db, 'm2', 'emoji', '902', 'aga');
  media(db, 'm3', 'emoji', '903', 'aga');
  line(db, 'l1', ':pog:');
  line(db, 'l2', ':aga:');
  apply(handle, planStableNamesRewrite(db));
  const again = planStableNamesRewrite(db);
  assert.deepEqual(again.counts.tables, {});
  assert.deepEqual(again.issue, []);
  const { left } = again.counts;
  assert.equal(left.sharedName, 1);
});

test('ties an unlinked line in one pass to an emoji whose name only raw markup in another table tells', () => {
  const { handle, db } = openTemp();
  db.prepare(
    "INSERT INTO media (id, kind, native_ref, extra, scope_iface) VALUES ('m1', 'emoji', '901', '{}', 'fake')"
  ).run();
  const extra = JSON.stringify({ note: 'was <:pog:901>' });
  db.prepare("INSERT INTO claim_versions (id, claim_id, text, extra) VALUES ('v1', 'c1', '', ?)").run(extra);
  line(db, 'l1', 'so :pog:');
  apply(handle, planStableNamesRewrite(db));
  assert.equal(textOf(db, 'l1'), 'so :e1:');
  assert.deepEqual(linksOf(db, 'l1'), ['m1']);
  assert.deepEqual(boundOf(db, '901'), ['e1', 'pog']);
  assert.deepEqual(planStableNamesRewrite(db).counts.tables, {});
});

/** A line of `kind` on interface `iface`, or with no interface when it is null. */
function lineOf(db: Db, id: string, kind: string, iface: string | null, text: string): void {
  db.prepare('INSERT INTO sources (id, kind, iface, text) VALUES (?, ?, ?, ?)').run(id, kind, iface, text);
}

test('rewrites a memory note with no interface to the stable name of the one emoji of that name and links nothing', () => {
  const { handle, db } = openTemp();
  media(db, 'm1', 'emoji', '901', 'pog');
  lineOf(db, 'n1', 'memory_session', null, 'they love :pog:');
  apply(handle, planStableNamesRewrite(db));
  assert.equal(textOf(db, 'n1'), 'they love :e1:');
  assert.deepEqual(linksOf(db, 'n1'), []);
});

test('rewrites a line of another interface to the stable name of the one emoji of that name and links nothing', () => {
  const { handle, db } = openTemp();
  media(db, 'm1', 'emoji', '901', 'pog');
  lineOf(db, 'c1', 'seen', 'cli', 'typed :pog:');
  apply(handle, planStableNamesRewrite(db));
  assert.equal(textOf(db, 'c1'), 'typed :e1:');
  assert.deepEqual(linksOf(db, 'c1'), []);
});

test('leaves a memory note whose name an emoji of each of two interfaces holds and counts it as a shared name', () => {
  const { handle, db } = openTemp();
  media(db, 'm1', 'emoji', '901', 'pog');
  const extra = JSON.stringify({ name: 'pog', animated: false });
  db.prepare("INSERT INTO media (id, kind, native_ref, extra, scope_iface) VALUES ('m2', 'emoji', '77', ?, 'cli')").run(
    extra
  );
  lineOf(db, 'n1', 'description_review', null, 'they love :pog:');
  const plan = planStableNamesRewrite(db);
  const { left } = plan.counts;
  assert.equal(left.sharedName, 1);
  apply(handle, plan);
  assert.equal(textOf(db, 'n1'), 'they love :pog:');
});

test('leaves a token that differs from a known emoji name only in letter case', () => {
  const { handle, db } = openTemp();
  media(db, 'm1', 'emoji', '901', 'pog');
  line(db, 'l1', 'loud :POG:');
  apply(handle, planStableNamesRewrite(db));
  assert.equal(textOf(db, 'l1'), 'loud :POG:');
  assert.deepEqual(linksOf(db, 'l1'), []);
});

test('names an emoji media row with no name by the stable name media_names holds for its id', () => {
  const { handle, db } = openTemp();
  held(handle, 'e5', '905', 'pog');
  db.prepare(
    "INSERT INTO media (id, kind, native_ref, extra, scope_iface) VALUES ('m1', 'emoji', '905', '{}', 'fake')"
  ).run();
  apply(handle, planStableNamesRewrite(db));
  assert.equal(mediaName(db, 'm1'), 'e5');
});

test('leaves an emoji media row with no name when media_names holds nothing for its id', () => {
  const { handle, db } = openTemp();
  db.prepare(
    "INSERT INTO media (id, kind, native_ref, extra, scope_iface) VALUES ('m1', 'emoji', '905', '{}', 'fake')"
  ).run();
  apply(handle, planStableNamesRewrite(db));
  const extra = db.prepare("SELECT extra FROM media WHERE id = 'm1'").get()?.extra;
  assert.equal(extra, '{}');
});

/** An answer row whose text holds no token and whose think holds `think`. */
function answer(db: Db, id: string, think: string): void {
  db.prepare("INSERT INTO sources (id, kind, iface, text, think) VALUES (?, 'answer', 'fake', '', ?)").run(id, think);
}

function thinkOf(db: Db, id: string): unknown {
  return db.prepare('SELECT think FROM sources WHERE id = ?').get(id)?.think;
}

test('rewrites a think whose name two emoji hold to the emoji the choice names when its text holds no token', () => {
  const { handle, db } = openTemp();
  media(db, 'm1', 'emoji', '901', 'aga');
  media(db, 'm2', 'emoji', '902', 'aga');
  answer(db, 'a1', 'send :aga: now');
  apply(handle, planStableNamesRewrite(db, { choose: { aga: '902' } }));
  const [chosen] = boundOf(db, '902');
  assert.equal(thinkOf(db, 'a1'), `send :${String(chosen)}: now`);
});

test('rewrites a think by the choice when its line links both emoji of that name and its text stays', () => {
  const { handle, db } = openTemp();
  media(db, 'm1', 'emoji', '901', 'aga');
  media(db, 'm2', 'emoji', '902', 'aga');
  const insert = db.prepare("INSERT INTO sources (id, kind, iface, text, think) VALUES ('a1', 'said', 'fake', ?, ?)");
  insert.run(':aga: :aga:', 'maybe :aga:');
  link(db, 'a1', 0, 'm1');
  link(db, 'a1', 1, 'm2');
  apply(handle, planStableNamesRewrite(db, { choose: { aga: '902' } }));
  const [chosen] = boundOf(db, '902');
  assert.equal(thinkOf(db, 'a1'), `maybe :${String(chosen)}:`);
  assert.equal(textOf(db, 'a1'), ':aga: :aga:');
});

test('leaves a think whose name two emoji hold with no choice and counts it as a shared name', () => {
  const { handle, db } = openTemp();
  media(db, 'm1', 'emoji', '901', 'aga');
  media(db, 'm2', 'emoji', '902', 'aga');
  answer(db, 'a1', 'send :aga: now');
  const plan = planStableNamesRewrite(db);
  const { left } = plan.counts;
  assert.equal(left.sharedName, 1);
  apply(handle, plan);
  assert.equal(thinkOf(db, 'a1'), 'send :aga: now');
});

/** A media row of a kept file, its path and `sha1` given. */
function fileRow(db: Db, id: string, filePath: string, sha1: string): void {
  const insert = db.prepare(
    "INSERT INTO media (id, kind, path, sha1, extra, scope_iface) VALUES (?, 'image', ?, ?, '{}', 'fake')"
  );
  insert.run(id, filePath, sha1);
}

test('removes an unlinked media row whose path and sha1 a linked row holds and counts it', () => {
  // Bug: a diary picture relinked to its posted attachment left its old row behind, a second row of one file. A row of
  // the same path with another sha1 is another file and stays.
  const { handle, db } = openTemp();
  const kept = 'media/diary/d-1-1.png';
  fileRow(db, 'media:fake:att-1', kept, 'aa01');
  fileRow(db, 'media:diary:d-1-1', kept, 'aa01');
  fileRow(db, 'media:diary:d-2-1', kept, 'bb02');
  line(db, 'l1', 'a picture');
  link(db, 'l1', 0, 'media:fake:att-1');
  const plan = planStableNamesRewrite(db);
  const { tables } = plan.counts;
  assert.equal(tables.media, 1);
  apply(handle, plan);
  const ids = db.prepare('SELECT id FROM media ORDER BY id').all();
  assert.deepEqual(
    ids.map((row) => row.id),
    ['media:diary:d-2-1', 'media:fake:att-1']
  );
});

/** A line vector of `sourceId` as the catch-up writes one: bytes of four dims, made from the line alone. */
function vector(db: Db, sourceId: string): void {
  const rowid = db.prepare('SELECT rowid FROM sources WHERE id = ?').get(sourceId)?.rowid;
  const insert = db.prepare(
    `INSERT INTO vectors (source_rowid, item_id, chunk_key, model, dims, scale, norm, bytes, context, kind)
     VALUES (?, ?, ?, 'test/embedder', 4, 1, 1, ?, '{}', 'record')`
  );
  insert.run(rowid, sourceId, `record:${sourceId}`, Buffer.from([1, 2, 3, 4]));
}

/** The bytes and eviction mark of the vector of `sourceId`. */
function vectorState(db: Db, sourceId: string): { live: boolean; evicted: boolean } {
  const row = db.prepare('SELECT bytes, evicted_at FROM vectors WHERE chunk_key = ?').get(`record:${sourceId}`);
  return { live: row?.bytes !== null, evicted: row?.evicted_at !== null };
}

/** Runs the re-embed job with a fake embedder and returns the texts it was asked to embed. */
async function reembedInputs(handle: MemoryHandle, db: Db): Promise<Array<string>> {
  const inputs: Array<string> = [];
  const embed = (texts: ReadonlyArray<string>): Promise<unknown> => {
    inputs.push(...texts);
    return Promise.resolve(texts.map(() => Float32Array.from([1, 0, 0, 0])));
  };
  const write = (update: Row): Promise<Row> =>
    Promise.resolve(applyReembed(handle, { rows: Array.isArray(update.rows) ? update.rows : [] }));
  const config: Config = { recall: { db: { reembed: true } } };
  await reembedTouched({
    db,
    write,
    embed,
    config,
    now: T0 + 1000,
    quantize,
    model: 'test/embedder',
    chunkOf: (line: Row): unknown => line.text,
  });
  return inputs;
}

test('evicts the vector of a line whose text the rewrite changes', () => {
  const { handle, db } = openTemp();
  media(db, 'm1', 'emoji', '901', 'pog');
  line(db, 'l1', 'that was :pog: indeed');
  link(db, 'l1', 0, 'm1');
  vector(db, 'l1');
  apply(handle, planStableNamesRewrite(db));
  assert.deepEqual(vectorState(db, 'l1'), { live: false, evicted: true });
});

test('the re-embed job embeds a rewritten line from its present text', async () => {
  const { handle, db } = openTemp();
  media(db, 'm1', 'emoji', '901', 'pog');
  line(db, 'l1', 'that was :pog: indeed');
  link(db, 'l1', 0, 'm1');
  vector(db, 'l1');
  apply(handle, planStableNamesRewrite(db));
  assert.deepEqual(await reembedInputs(handle, db), ['that was :e1: indeed']);
  assert.deepEqual(vectorState(db, 'l1'), { live: true, evicted: false });
});

test('keeps the vector of a line the rewrite leaves as it is', () => {
  const { handle, db } = openTemp();
  media(db, 'm1', 'emoji', '901', 'pog');
  line(db, 'l1', 'that was :pog: indeed');
  link(db, 'l1', 0, 'm1');
  line(db, 'l2', 'plain words only');
  vector(db, 'l2');
  apply(handle, planStableNamesRewrite(db));
  assert.deepEqual(vectorState(db, 'l2'), { live: true, evicted: false });
});

// The schema cannot tell a line rewritten before this change: `sources` holds no stamp of its text and a line vector
// holds no hash of the text it was made from. The plan takes the ids of such lines as a one-time input instead.
test('evicts the vectors of the lines the plan is given as rewritten before', () => {
  const { handle, db } = openTemp();
  line(db, 'l9', 'that was :e1: indeed');
  vector(db, 'l9');
  line(db, 'l8', 'plain words only');
  vector(db, 'l8');
  apply(handle, planStableNamesRewrite(db, { rewritten: ['l9'] }));
  assert.deepEqual(vectorState(db, 'l9'), { live: false, evicted: true });
  assert.deepEqual(vectorState(db, 'l8'), { live: true, evicted: false });
});

// Diagnosis 2026-11-18, graph orphans: the rewrite deleted a twin's row and left its node and witness in the graph.
test('a twin the rewrite deletes leaves no node in the graph', () => {
  const { handle, db } = openTemp();
  const file = db.prepare(
    "INSERT INTO media (id, kind, path, sha1, scope_iface) VALUES (?, 'image', 'media/t1.png', 'h1', 'fake')"
  );
  file.run('m-kept');
  file.run('m-twin');
  line(db, 'l1', 'a picture');
  link(db, 'l1', 0, 'm-kept');
  projectRow(handle, 'media', { id: 'm-twin' }, { at: T0 });
  apply(handle, planStableNamesRewrite(db));
  const node = graphNodeId('media', 'm-twin');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM media WHERE id = 'm-twin'").get()?.n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM graph_nodes WHERE id = ?').get(node)?.n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM node_access WHERE node_id = ?').get(node)?.n, 0);
});
