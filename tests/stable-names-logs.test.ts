// The rewrite of the request log `model_requests` and the recall traces (`operational` rows of kind `recall_trace`) to
// stable names (src/memory/db/stable-names-logs.ts). `planLogBatches` reads the two tables in batches of at most
// `batchSize` rows by key and yields one plan per batch, shaped as a plan of `planStableNamesRewrite`, which the write
// kind `stable-names-rewrite` applies with its stale check. A stop between batches and a new run finish the rest, and a run
// after the last changes nothing. Synthetic ids, names and request texts over a temp database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { planStableNamesRewrite } from '../src/memory/db/stable-names-rewrite.ts';
import type { StableNamesPlan } from '../src/memory/db/stable-names-rewrite.ts';
import { planLogBatches } from '../src/memory/db/stable-names-logs.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, MemoryHandle } from '../src/memory/db/types.ts';

const T0 = Date.parse('2026-11-17T10:00:00Z');

function openTemp(): { handle: MemoryHandle; db: Db } {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'stable-names-logs-'));
  const handle = openMemoryDb(path.join(root, 'memory.db'));
  return { handle, db: dbOf(handle) };
}

function media(db: Db, id: string, kind: 'emoji' | 'sticker', nativeId: string, name: string): void {
  const extra = JSON.stringify({ name, animated: false });
  const insert = db.prepare("INSERT INTO media (id, kind, native_ref, extra, scope_iface) VALUES (?, ?, ?, ?, 'fake')");
  insert.run(id, kind, nativeId, extra);
}

function apply(handle: MemoryHandle, plan: StableNamesPlan): void {
  applyMemoryWrite(handle, { kind: 'stable-names-rewrite', ...plan, now: T0 });
}

/**
 * A deployment after the rewrite of its lines: the emoji `pog` (platform id 901) holds `e1`, the sticker `wave_hello`
 * (platform id 801) holds `s1`.
 */
function named(): { handle: MemoryHandle; db: Db } {
  const opened = openTemp();
  media(opened.db, 'm1', 'emoji', '901', 'pog');
  media(opened.db, 'm2', 'sticker', '801', 'wave_hello');
  apply(opened.handle, planStableNamesRewrite(opened.db));
  return opened;
}

type RequestCols = { system_text?: string; messages?: string; response_text?: string; think?: string };

function request(db: Db, id: string, cols: RequestCols): void {
  const insert = db.prepare(
    `INSERT INTO model_requests (id, schema_version, status, started_at, system_text, messages, response_text, think)
     VALUES (?, 1, 'ok', '2026-11-01T00:00:00Z', ?, ?, ?, ?)`
  );
  insert.run(id, cols.system_text ?? null, cols.messages ?? '[]', cols.response_text ?? null, cols.think ?? null);
}

function requestCol(db: Db, id: string, column: string): unknown {
  return db.prepare(`SELECT ${column} AS value FROM model_requests WHERE id = ?`).get(id)?.value;
}

function trace(db: Db, owner: string, record: unknown): void {
  const insert = db.prepare("INSERT INTO operational (kind, owner, value) VALUES ('recall_trace', ?, ?)");
  insert.run(owner, JSON.stringify(record));
}

function traceOf(db: Db, owner: string): unknown {
  const row = db.prepare("SELECT value FROM operational WHERE kind = 'recall_trace' AND owner = ?").get(owner);
  return JSON.parse(String(row?.value));
}

type Options = { batchSize: number; choose?: Record<string, string>; markupIface?: string | null };

/** Every batch of one run, each applied as soon as it is yielded. */
function runAll(handle: MemoryHandle, db: Db, options: Options): Array<StableNamesPlan> {
  const done: Array<StableNamesPlan> = [];
  for (const batch of planLogBatches(db, options)) {
    apply(handle, batch);
    done.push(batch);
  }
  return done;
}

/** The rows each batch changes, summed per table. */
function tablesOf(batches: ReadonlyArray<StableNamesPlan>): Record<string, number> {
  const sums: Record<string, number> = {};
  for (const batch of batches)
    for (const [table, count] of Object.entries(batch.counts.tables)) sums[table] = (sums[table] ?? 0) + count;
  return sums;
}

/** One user message whose content is one text block. */
const userMessage = (text: string): string =>
  JSON.stringify([{ role: 'user', content: [{ type: 'text', text }], name: 'pog' }]);

test('rewrites a known emoji name in the system text of a request', () => {
  const { handle, db } = named();
  request(db, 'r1', { system_text: 'she likes :pog: a lot' });
  runAll(handle, db, { batchSize: 10 });
  assert.equal(requestCol(db, 'r1', 'system_text'), 'she likes :e1: a lot');
});

test('rewrites only the string values of the messages of a request and keeps their structure and keys', () => {
  const { handle, db } = named();
  request(db, 'r1', { messages: userMessage('look :pog: here') });
  runAll(handle, db, { batchSize: 10 });
  const stored: unknown = JSON.parse(String(requestCol(db, 'r1', 'messages')));
  assert.deepEqual(stored, [{ role: 'user', content: [{ type: 'text', text: 'look :e1: here' }], name: 'pog' }]);
});

test('rewrites a known emoji name in the response text of a request', () => {
  const { handle, db } = named();
  request(db, 'r1', { response_text: 'sure :pog:' });
  runAll(handle, db, { batchSize: 10 });
  assert.equal(requestCol(db, 'r1', 'response_text'), 'sure :e1:');
});

test('rewrites a known emoji name in the think of a request', () => {
  const { handle, db } = named();
  request(db, 'r1', { think: 'I will answer with :pog:' });
  runAll(handle, db, { batchSize: 10 });
  assert.equal(requestCol(db, 'r1', 'think'), 'I will answer with :e1:');
});

test('rewrites the string values of a recall trace and keeps its structure', () => {
  const { handle, db } = named();
  trace(db, 'place-1#0001', { at: 1000, query: 'who sent :pog:', hits: [{ id: 'l1', text: 'me :pog:' }] });
  runAll(handle, db, { batchSize: 10 });
  const expected = { at: 1000, query: 'who sent :e1:', hits: [{ id: 'l1', text: 'me :e1:' }] };
  assert.deepEqual(traceOf(db, 'place-1#0001'), expected);
});

test('rewrites raw markup of a static and of an animated emoji to the stable name of its id', () => {
  const { handle, db } = named();
  request(db, 'r1', { response_text: 'a <:renamed:901> and <a:dance:907>' });
  runAll(handle, db, { batchSize: 10, markupIface: 'fake' });
  assert.match(String(requestCol(db, 'r1', 'response_text')), /^a :e1: and :e\d+:$/);
  assert.doesNotMatch(String(requestCol(db, 'r1', 'response_text')), /<a?:/);
});

test('rewrites the old sticker reference of a name one sticker holds to the current form', () => {
  const { handle, db } = named();
  request(db, 'r1', { messages: userMessage('hi [sticker: wave_hello]') });
  runAll(handle, db, { batchSize: 10 });
  assert.match(String(requestCol(db, 'r1', 'messages')), /"hi \[sticker s1\]"/);
});

test('rewrites the old sticker reference with a description to the current form', () => {
  const { handle, db } = named();
  request(db, 'r1', { messages: userMessage('hi [sticker: wave_hello — a cat waving]') });
  runAll(handle, db, { batchSize: 10 });
  assert.match(String(requestCol(db, 'r1', 'messages')), /"hi \[sticker s1\]"/);
});

test('rewrites the old sticker reference of an unreadable sticker to the current form', () => {
  const { handle, db } = named();
  request(db, 'r1', { messages: userMessage('hi [sticker: wave_hello, not readable]') });
  runAll(handle, db, { batchSize: 10 });
  assert.match(String(requestCol(db, 'r1', 'messages')), /"hi \[sticker s1\]"/);
});

test('leaves an old sticker reference of a name no sticker holds and counts it', () => {
  const { handle, db } = named();
  request(db, 'r1', { response_text: 'hi [sticker: unknown_one]' });
  const batches = runAll(handle, db, { batchSize: 10 });
  assert.equal(requestCol(db, 'r1', 'response_text'), 'hi [sticker: unknown_one]');
  assert.equal(
    batches.reduce((sum, batch) => {
      const { left } = batch.counts;
      return sum + left.unlinkedSticker;
    }, 0),
    1
  );
});

// A stored request is not rebuilt: only its names are brought to today's form. The description an old inline emoji form
// carried is dropped from the line and is not moved into a `<media>` block, since that block would be a request she
// never received.
test('rewrites the old inline emoji form to the stable name and drops its description', () => {
  const { handle, db } = named();
  request(db, 'r1', { messages: userMessage('then [:pog: a grinning frog] came') });
  runAll(handle, db, { batchSize: 10 });
  const stored = String(requestCol(db, 'r1', 'messages'));
  assert.match(stored, /"then :e1: came"/);
  assert.doesNotMatch(stored, /grinning frog|<media>/);
});

test('leaves a name two emoji hold and counts it, and ties it when the caller chooses', () => {
  const { handle, db } = named();
  media(db, 'm3', 'emoji', '902', 'aga');
  media(db, 'm4', 'emoji', '903', 'aga');
  apply(handle, planStableNamesRewrite(db, { choose: { aga: '902' } }));
  request(db, 'r1', { response_text: 'ok :aga:' });
  const left = runAll(handle, db, { batchSize: 10 });
  assert.equal(requestCol(db, 'r1', 'response_text'), 'ok :aga:');
  assert.equal(
    left.reduce((sum, batch) => {
      const { left: held } = batch.counts;
      return sum + held.sharedName;
    }, 0),
    1
  );
  runAll(handle, db, { batchSize: 10, choose: { aga: '902' } });
  assert.match(String(requestCol(db, 'r1', 'response_text')), /^ok :e\d+:$/);
});

test('leaves a token inside a code span of a request', () => {
  const { handle, db } = named();
  request(db, 'r1', { response_text: 'type `:pog:` to get :pog:' });
  runAll(handle, db, { batchSize: 10 });
  assert.equal(requestCol(db, 'r1', 'response_text'), 'type `:pog:` to get :e1:');
});

test('keeps the bytes of a request and a trace with nothing to rewrite and plans no cell for them', () => {
  const { handle, db } = named();
  const messages = '[ { "role" : "user", "content" : "plain :e1: words" } ]';
  request(db, 'r1', { system_text: 'no names', messages, think: 'calm' });
  db.prepare("INSERT INTO operational (kind, owner, value) VALUES ('recall_trace', 'place-1#0001', ?)").run(
    '{ "query" : "nothing here" }'
  );
  const before = [db.prepare("SELECT * FROM model_requests WHERE id = 'r1'").get(), traceOf(db, 'place-1#0001')];
  const raw = db.prepare("SELECT value FROM operational WHERE owner = 'place-1#0001'").get()?.value;
  const batches = runAll(handle, db, { batchSize: 10 });
  assert.deepEqual(
    batches.flatMap((batch) => batch.cells),
    []
  );
  assert.deepEqual(
    [db.prepare("SELECT * FROM model_requests WHERE id = 'r1'").get(), traceOf(db, 'place-1#0001')],
    before
  );
  assert.equal(db.prepare("SELECT value FROM operational WHERE owner = 'place-1#0001'").get()?.value, raw);
});

test('rewrites every row once when a batch boundary falls between them and counts both tables', () => {
  const { handle, db } = named();
  for (const id of ['r1', 'r2', 'r3', 'r4', 'r5']) request(db, id, { response_text: `${id} :pog:` });
  for (const owner of ['place-1#0001', 'place-1#0002', 'place-1#0003']) trace(db, owner, { query: ':pog:' });
  const batches = runAll(handle, db, { batchSize: 2 });
  assert.ok(batches.length >= 4);
  assert.ok(batches.every((batch) => batch.cells.length <= 2));
  const keys = batches.flatMap((batch) => batch.cells.map((cell) => `${cell.table} ${cell.column} ${cell.id}`));
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(tablesOf(batches), { model_requests: 5, operational: 3 });
  for (const id of ['r1', 'r2', 'r3', 'r4', 'r5']) assert.equal(requestCol(db, id, 'response_text'), `${id} :e1:`);
  assert.deepEqual(traceOf(db, 'place-1#0003'), { query: ':e1:' });
});

test('finishes the rest on a second run after a stop past the first batch, and a third run changes nothing', () => {
  const { handle, db } = named();
  for (const id of ['r1', 'r2', 'r3', 'r4', 'r5']) request(db, id, { think: `${id} :pog:` });
  const first = planLogBatches(db, { batchSize: 2 }).next();
  assert.equal(first.done, false);
  if (!first.done) apply(handle, first.value);
  const rest = runAll(handle, db, { batchSize: 2 });
  assert.deepEqual(tablesOf(rest), { model_requests: 3 });
  for (const id of ['r1', 'r2', 'r3', 'r4', 'r5']) assert.equal(requestCol(db, id, 'think'), `${id} :e1:`);
  const again = runAll(handle, db, { batchSize: 2 });
  assert.deepEqual(
    again.flatMap((batch) => batch.cells),
    []
  );
});
