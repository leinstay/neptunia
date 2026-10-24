// Round trips of vectors.js: one month of the vector index (manifest, jsonl, int8 data) through the real schema.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as mapper from '../src/memory/db/map/vectors.js';
import { roundTrip } from './fixtures/memory-db/roundtrip.js';

const DIR = 'vectors/2026-10';
const DIMS = 4;

const line = (row, extra = {}) => ({
  row, kind: 'record', id: `40000000000000000${row}`, revision: 1, occurredAt: '2026-10-01T00:00:16.011Z', channelId: '200000000000000001',
  by: '100000000000000001', participants: ['100000000000000001', '100000000000000002'], sourceIds: ['400000000000000001'],
  scale: 0.0008625745421319496, norm: 0.9999999997754667, ...extra,
});

function month(lines, i8, manifestExtra = {}) {
  const meta = lines.map((l) => `${JSON.stringify(l)}\n`).join('');
  return {
    manifest: { v: 1, gen: 1, rows: lines.length, bytes: i8.length, metaBytes: Buffer.byteLength(meta), model: 'test/embedder', dims: DIMS, checksum: 'fnv1a32:00000000:00000000', ...manifestExtra },
    meta,
    i8,
  };
}

function assertSame(value, back) {
  assert.deepStrictEqual(back.manifest, value.manifest);
  assert.equal(JSON.stringify(back.manifest), JSON.stringify(value.manifest));
  assert.equal(back.meta, value.meta);
  assert.ok(Buffer.from(back.i8).equals(value.i8), 'the int8 data is byte-exact');
}

test('each jsonl line becomes a vectors row whose bytes are its slice of the int8 data', () => {
  const i8 = Buffer.from([1, 2, 3, 4, 255, 254, 128, 127, 0, 0, 0, 0]);
  const value = month([line(0), line(1), line(2, { kind: 'archive', id: 'rc-1', revision: 'rv-1' })], i8);
  const { rows, back } = roundTrip(mapper, DIR, value);
  assertSame(value, back);
  assert.equal(rows.vectors.length, 3);
  const [first, second, third] = rows.vectors;
  assert.deepEqual([...first.bytes], [1, 2, 3, 4]);
  assert.deepEqual([...second.bytes], [255, 254, 128, 127]);
  assert.equal(first.item_id, '400000000000000000');
  assert.equal(first.chunk_key, 'record:400000000000000000:1');
  assert.equal(third.chunk_key, 'archive:rc-1:rv-1');
  assert.equal(first.model, 'test/embedder');
  assert.equal(first.dims, DIMS);
  assert.equal(first.scale, 0.0008625745421319496);
  assert.equal(first.norm, 0.9999999997754667);
  assert.equal(first.occurred_at, '2026-10-01T00:00:16.011Z');
  assert.equal(first.source_rowid, null);
  assert.deepEqual([first.scope_kind, first.scope_iface], ['group', 'discord']);
  assert.equal(rows.operational[0].kind, 'vectors');
});

test('null fields, a different key order and unknown keys keep the file byte-exact', () => {
  const i8 = Buffer.alloc(DIMS * 3, 7);
  const odd = { norm: 1, scale: 0, id: 'x', row: 1, kind: 'record', revision: null, occurredAt: '2026-10-02T00:00:00.000Z', extra: { deep: [1] } };
  const value = month([line(0, { channelId: null, by: null, participants: [] }), odd, line(2, { revision: '3' })], i8);
  const { back } = roundTrip(mapper, DIR, value);
  assertSame(value, back);
});

test('rows come back in the order of the file even when the database returns them in another', () => {
  const i8 = Buffer.from([1, 1, 1, 1, 2, 2, 2, 2]);
  const value = month([line(0), line(1)], i8);
  const rows = mapper.toRows(DIR, value);
  rows.vectors.reverse();
  const back = mapper.fromRows(rows);
  assertSame(value, back);
});

test('bytes past the manifest count are kept, an empty month and a private layer work', () => {
  const tail = month([line(0)], Buffer.from([1, 2, 3, 4, 9, 9]));
  assertSame(tail, roundTrip(mapper, DIR, tail).back);
  const empty = month([], Buffer.alloc(0), { dims: DIMS });
  const emptyBack = roundTrip(mapper, DIR, empty);
  assert.equal(emptyBack.rows.vectors, undefined);
  assertSame(empty, emptyBack.back);
  const privateValue = month([line(0)], Buffer.from([5, 6, 7, 8]));
  const { rows, back } = roundTrip(mapper, 'private/100000000000000001/vectors/2026-10', privateValue);
  assertSame(privateValue, back);
  assert.deepEqual([rows.vectors[0].scope_kind, rows.vectors[0].scope_dm], ['dm', 'person:discord:100000000000000001']);
  assert.equal(rows.vectors[0].chunk_key, 'private:100000000000000001:record:400000000000000000:1');
});

test('a jsonl the engine would not have written is kept raw, with its data, and still comes back exact', () => {
  const i8 = Buffer.from([1, 2, 3, 4]);
  for (const meta of ['{"row":0,"id":"a"}', '{"row": 0, "id": "a"}\n', 'not json\n', '[1]\n']) {
    const value = { ...month([line(0)], i8), meta };
    const { rows, back } = roundTrip(mapper, DIR, value);
    assert.equal(rows.vectors, undefined, meta);
    assertSame(value, back);
  }
  const noDims = month([line(0)], i8, { dims: null });
  assertSame(noDims, roundTrip(mapper, DIR, noDims).back);
});

test('a repeated chunk key gets a suffix and the lines still come back', () => {
  const value = month([line(0, { id: 'same' }), line(1, { id: 'same' })], Buffer.alloc(DIMS * 2, 3));
  const { rows, back } = roundTrip(mapper, DIR, value);
  assert.deepEqual(rows.vectors.map((row) => row.chunk_key), ['record:same:1', 'record:same:1-2']);
  assertSame(value, back);
});

test('filesOf lists the three files of the month under the generation the manifest names', () => {
  const value = month([line(0)], Buffer.from([1, 2, 3, 4]), { gen: 12 });
  const files = mapper.filesOf(`${DIR}/12.i8`, value);
  assert.deepEqual(files.map((file) => file.rel), [`${DIR}/manifest.json`, `${DIR}/12.i8`, `${DIR}/12.jsonl`]);
  assert.equal(files[0].data.toString(), JSON.stringify(value.manifest));
  assert.ok(files[1].data.equals(value.i8));
  assert.equal(files[2].data.toString(), value.meta);
  assert.equal(mapper.monthDirOf(`${DIR}/manifest.json`), DIR);
  assert.equal(mapper.monthDirOf('private/1/vectors/2026-10/3.jsonl'), 'private/1/vectors/2026-10');
});
