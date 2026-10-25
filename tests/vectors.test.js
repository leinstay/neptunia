// Tests for src/memory/vectors.js: the int8 vector index for meaning search, in the memory database of a
// temporary directory (never the deployment's data/), with a fixed clock and seeded vectors.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createVectors, dequantize, quantize } from '../src/memory/vectors.js';
import { classify } from '../src/memory/db/map/index.js';
import { filesOfUnit } from '../src/memory/db/export.js';
import { openTestMemory } from './fixtures/memory-db/service.js';

const quiet = { info() {}, warn() {}, error() {} };
const OCT = Date.UTC(2026, 9, 13, 9, 0, 0);

/** A seeded generator (mulberry32). */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomVector(rng, dims) {
  const v = new Float32Array(dims);
  for (let i = 0; i < dims; i += 1) v[i] = rng() * 2 - 1;
  return v;
}

/** `base` nudged by noise of size `amount`. */
function near(base, rng, amount) {
  const v = new Float32Array(base.length);
  for (let i = 0; i < base.length; i += 1) v[i] = base[i] + (rng() * 2 - 1) * amount;
  return v;
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / Math.sqrt(na * nb);
}

function meta(id, overrides = {}) {
  return {
    kind: 'record',
    id,
    revision: 1,
    occurredAt: '2026-10-12T10:00:00.000Z',
    channelId: 'c1',
    by: 'u1',
    participants: ['u1'],
    sourceIds: [id],
    ...overrides,
  };
}

/** The test databases opened here; closed when the file is done. */
const OPENED = [];
after(async () => {
  for (const mem of OPENED) await mem.close();
});

async function scene(options = {}) {
  const mem = await openTestMemory();
  OPENED.push(mem);
  const { dataDir, memoryDb } = mem;
  const vectors = createVectors({ dataDir, log: quiet, now: () => OCT, memoryDb, ...options });
  return { dataDir, memoryDb, vectors };
}

/** The files a month of the index stands for (`manifest.json`, `<gen>.i8`, `<gen>.jsonl`), from the database: name -> bytes. */
function monthFiles(memoryDb, month, privateUserId = null) {
  const rel = privateUserId ? `guilds/g1/private/${privateUserId}/vectors/${month}/manifest.json` : `guilds/g1/vectors/${month}/manifest.json`;
  const info = classify(rel);
  const full = `guilds/g1/${info.unit}`;
  return new Map(filesOfUnit(memoryDb.readHandle().db, info.unit, info, full).map((file) => [file.rel.split('/').at(-1), file.data]));
}

function manifestOf(memoryDb, month, privateUserId = null) {
  return JSON.parse(monthFiles(memoryDb, month, privateUserId).get('manifest.json').toString('utf8'));
}

const ids = (hits) => hits.map((hit) => hit.meta.id);

test('vectors: quantise and dequantise round trip within half a step of the row scale', () => {
  const rng = seeded(1);
  const v = randomVector(rng, 64);
  v[5] = 3.5;
  const { bytes, scale, norm } = quantize(v);
  assert.equal(bytes.length, 64);
  assert.ok(Math.abs(scale - 3.5 / 127) < 1e-6);
  assert.ok(Math.abs(norm - Math.sqrt(v.reduce((s, x) => s + x * x, 0))) < 1e-4);
  const back = dequantize(bytes, scale);
  for (let i = 0; i < v.length; i += 1) assert.ok(Math.abs(back[i] - v[i]) <= scale / 2 + 1e-6);
  assert.ok(cosine(back, v) > 0.999);
  const zero = quantize(new Float32Array(8));
  assert.equal(zero.scale, 0);
  assert.equal(zero.norm, 0);
});

test('vectors: append then search returns the nearest rows with a plausible cosine', async () => {
  const { memoryDb, vectors } = await scene();
  const rng = seeded(2);
  const target = randomVector(rng, 128);
  const rows = [
    { meta: meta('m-near'), vector: near(target, rng, 0.1) },
    { meta: meta('m-mid'), vector: near(target, rng, 0.6) },
  ];
  for (let i = 0; i < 30; i += 1) rows.push({ meta: meta(`m-${i}`), vector: randomVector(rng, 128) });
  await vectors.append('g1', rows, { model: 'test-model' });
  const hits = await vectors.search('g1', target, { k: 2 });
  assert.deepEqual(ids(hits), ['m-near', 'm-mid']);
  assert.ok(Math.abs(hits[0].score - cosine(rows[0].vector, target)) < 0.01);
  assert.ok(hits[0].score > hits[1].score);
  assert.ok(hits[1].score > 0.5);
  const filtered = await vectors.search('g1', target, { k: 1, filter: (m) => m.id !== 'm-near' });
  assert.deepEqual(ids(filtered), ['m-mid']);
  assert.equal((await vectors.stats('g1')).rows, 32);
});

test('vectors: rows go to the month of their occurredAt; months and from/to narrow the search', async () => {
  const { memoryDb, vectors } = await scene();
  const rng = seeded(3);
  const q = randomVector(rng, 32);
  await vectors.append('g1', [
    { meta: meta('sep', { occurredAt: '2026-09-30T23:59:00.000Z' }), vector: near(q, rng, 0.05) },
    { meta: meta('oct', { occurredAt: '2026-10-01T00:01:00.000Z' }), vector: near(q, rng, 0.05) },
  ]);
  assert.equal(manifestOf(memoryDb, '2026-09').rows, 1);
  assert.equal(manifestOf(memoryDb, '2026-10').rows, 1);
  assert.deepEqual(ids(await vectors.search('g1', q, { k: 5, months: ['2026-10'] })), ['oct']);
  assert.deepEqual(ids(await vectors.search('g1', q, { k: 5, to: '2026-09-30T23:59:59.000Z' })), ['sep']);
  assert.deepEqual(ids(await vectors.search('g1', q, { k: 5, from: '2026-10-01T00:00:00.000Z' })), ['oct']);
  assert.equal((await vectors.search('g1', q, { k: 5 })).length, 2);
  const stats = await vectors.stats('g1');
  assert.equal(stats.months, 2);
  assert.equal(stats.rows, 2);
  assert.ok(stats.bytes > 64);
});

test('vectors: rewrite writes a new generation, switches the manifest and removes the old files', async () => {
  const { memoryDb, vectors } = await scene();
  const rng = seeded(5);
  const q = randomVector(rng, 16);
  await vectors.append('g1', ['a', 'b', 'c'].map((id) => ({ meta: meta(id), vector: near(q, rng, 0.3) })), { model: 'mx' });
  const before = manifestOf(memoryDb, '2026-10');
  assert.deepEqual(ids(await vectors.search('g1', q, { k: 5 })).sort(), ['a', 'b', 'c']);
  const result = await vectors.rewrite('g1', '2026-10', (m) => m.id !== 'b');
  assert.deepEqual(result, { kept: 2, dropped: 1 });
  const after = manifestOf(memoryDb, '2026-10');
  assert.notEqual(after.gen, before.gen);
  assert.equal(after.rows, 2);
  assert.equal(after.model, 'mx');
  assert.deepEqual([...monthFiles(memoryDb, '2026-10').keys()].sort(), [`${after.gen}.i8`, `${after.gen}.jsonl`, 'manifest.json'].sort());
  const hits = await vectors.search('g1', q, { k: 5 });
  assert.deepEqual(ids(hits).sort(), ['a', 'c']);
  assert.deepEqual(hits.map((h) => h.meta.row).sort(), [0, 1]);
});

test('vectors: a private layer is kept apart from the guild index and from other private layers', async () => {
  const { memoryDb, vectors } = await scene();
  const rng = seeded(9);
  const q = randomVector(rng, 16);
  await vectors.append('g1', [{ meta: meta('guild'), vector: near(q, rng, 0.1) }]);
  await vectors.append('g1', [{ meta: meta('dm-a'), vector: near(q, rng, 0.1) }], { privateUserId: 'u3' });
  await vectors.append('g1', [{ meta: meta('dm-b'), vector: near(q, rng, 0.1) }], { privateUserId: 'u4' });
  assert.equal(manifestOf(memoryDb, '2026-10', 'u3').rows, 1);
  assert.deepEqual(ids(await vectors.search('g1', q, { k: 10 })), ['guild']);
  assert.deepEqual(ids(await vectors.search('g1', q, { k: 10, privateUserId: 'u3' })), ['dm-a']);
  assert.deepEqual(ids(await vectors.search('g1', q, { k: 10, privateUserId: 'u4' })), ['dm-b']);
  assert.equal((await vectors.stats('g1', { privateUserId: 'u4' })).rows, 1);
});

test('vectors: search time over 20 000 rows of 1024 dims (measured, not asserted)', async (t) => {
  const { memoryDb, vectors } = await scene();
  const rng = seeded(11);
  const dims = 1024;
  const rows = [];
  for (let i = 0; i < 20000; i += 1) rows.push({ meta: meta(`r${i}`), vector: randomVector(rng, dims) });
  await vectors.append('g1', rows);
  const q = randomVector(rng, dims);
  const cold = performance.now();
  await vectors.search('g1', q, { k: 80 });
  const coldMs = performance.now() - cold;
  const warm = performance.now();
  const hits = await vectors.search('g1', q, { k: 80 });
  const warmMs = performance.now() - warm;
  assert.equal(hits.length, 80);
  for (let i = 1; i < hits.length; i += 1) assert.ok(hits[i - 1].score >= hits[i].score);
  const message = `vectors: 20000 x 1024 search cold ${coldMs.toFixed(1)} ms (load included), warm ${warmMs.toFixed(1)} ms`;
  t.diagnostic(message);
  console.log(message);
});

test('vectors: replace builds a month as a new generation, keeps the rows asked, and switches the manifest', async () => {
  const { memoryDb, vectors } = await scene();
  const rng = seeded(21);
  const q = randomVector(rng, 16);
  await vectors.append('g1', [
    { meta: meta('old-1'), vector: randomVector(rng, 16) },
    { meta: meta('live-2'), vector: randomVector(rng, 16) },
  ], { model: 'm-a' });
  const before = manifestOf(memoryDb, '2026-10');
  const result = await vectors.replace('g1', '2026-10', [{ meta: meta('old-1'), vector: near(q, rng, 0.01) }], {
    model: 'm-a',
    keep: (m) => m.id !== 'old-1',
  });
  assert.deepEqual(result, { written: 1, kept: 1, dropped: 1 });
  const after = manifestOf(memoryDb, '2026-10');
  assert.equal(after.gen, before.gen + 1);
  assert.equal(after.rows, 2);
  assert.deepEqual([...monthFiles(memoryDb, '2026-10').keys()].filter((n) => /^\d+\./.test(n)).sort(), [`${after.gen}.i8`, `${after.gen}.jsonl`]);
  assert.deepEqual(ids(await vectors.search('g1', q, { k: 1 })), ['old-1']);
  assert.deepEqual(ids(await vectors.search('g1', q, { k: 5 })).sort(), ['live-2', 'old-1']);
});

test('vectors: replace with another model or length keeps none of the old rows; a row of another month is refused', async () => {
  const { memoryDb, vectors } = await scene();
  const rng = seeded(22);
  await vectors.append('g1', [{ meta: meta('a'), vector: randomVector(rng, 16) }], { model: 'm-a' });
  const result = await vectors.replace('g1', '2026-10', [{ meta: meta('b'), vector: randomVector(rng, 8) }], { model: 'm-b', keep: () => true });
  assert.deepEqual(result, { written: 1, kept: 0, dropped: 1 });
  const manifest = manifestOf(memoryDb, '2026-10');
  assert.equal(manifest.dims, 8);
  assert.equal(manifest.model, 'm-b');
  await assert.rejects(
    vectors.replace('g1', '2026-10', [{ meta: meta('c', { occurredAt: '2026-09-01T00:00:00.000Z' }), vector: randomVector(rng, 8) }]),
    /a row of 2026-09/,
  );
});

test('vectors: has lists the kind, id and revision of every row of a month, kept current across append, rewrite and layers', async () => {
  const { memoryDb, vectors } = await scene();
  const rng = seeded(11);
  assert.deepEqual([...(await vectors.has('g1', '2026-10'))], [], 'no month yet');
  await vectors.append('g1', [
    { meta: meta('a'), vector: randomVector(rng, 8) },
    { meta: meta('b', { revision: 2 }), vector: randomVector(rng, 8) },
    { meta: meta('ep1', { kind: 'archive', revision: 'rv-1' }), vector: randomVector(rng, 8) },
  ]);
  assert.deepEqual([...(await vectors.has('g1', '2026-10'))].sort(), ['archive:ep1:rv-1', 'record:a:1', 'record:b:2']);
  await vectors.append('g1', [{ meta: meta('c'), vector: randomVector(rng, 8) }]);
  assert.ok((await vectors.has('g1', '2026-10')).has('record:c:1'), 'an append shows at once');
  await vectors.rewrite('g1', '2026-10', (m) => m.id !== 'a');
  assert.deepEqual([...(await vectors.has('g1', '2026-10'))].sort(), ['archive:ep1:rv-1', 'record:b:2', 'record:c:1'], 'a rewrite shows at once');
  assert.equal((await vectors.has('g1', '2026-09')).size, 0, 'another month');
  await vectors.append('g1', [{ meta: meta('p'), vector: randomVector(rng, 8) }], { privateUserId: 'u9' });
  assert.deepEqual([...(await vectors.has('g1', '2026-10', { privateUserId: 'u9' }))], ['record:p:1']);
  assert.equal((await vectors.has('g1', '2026-10')).has('record:p:1'), false, 'a private row stays out of the guild month');
  await assert.rejects(vectors.has('g1', 'october'), TypeError);
});

test('vectors: has sees a month another instance wrote (by its manifest)', async () => {
  const { dataDir, memoryDb, vectors } = await scene();
  const other = createVectors({ dataDir, log: quiet, now: () => OCT, memoryDb });
  const rng = seeded(12);
  await vectors.append('g1', [{ meta: meta('a'), vector: randomVector(rng, 8) }]);
  assert.equal((await vectors.has('g1', '2026-10')).size, 1);
  await other.append('g1', [{ meta: meta('b'), vector: randomVector(rng, 8) }]);
  assert.ok((await vectors.has('g1', '2026-10')).has('record:b:1'));
  await other.replace('g1', '2026-10', [{ meta: meta('z'), vector: randomVector(rng, 8) }]);
  assert.deepEqual([...(await vectors.has('g1', '2026-10'))], ['record:z:1']);
});
