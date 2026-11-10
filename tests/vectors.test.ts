// Tests for src/memory/vectors.ts: the int8 vector index for meaning search, in the memory database of a
// temporary directory (never the deployment's data/), with a fixed clock and seeded vectors.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createVectors, dequantize, quantize } from '../src/memory/vectors.ts';
import { lineVectorShape } from '../src/memory/db/line-vectors.ts';
import type { Db } from '../src/memory/db/types.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';

const quiet = { info() {}, warn() {}, error() {} };
const OCT = Date.UTC(2026, 9, 13, 9, 0, 0);

/** A seeded generator (mulberry32). */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomVector(rng: () => number, dims: number) {
  const v = new Float32Array(dims);
  for (let i = 0; i < dims; i += 1) v[i] = rng() * 2 - 1;
  return v;
}

/** `base` nudged by noise of size `amount`. */
function near(base: Float32Array, rng: () => number, amount: number) {
  const v = new Float32Array(base.length);
  for (let i = 0; i < base.length; i += 1) v[i] = base[i] + (rng() * 2 - 1) * amount;
  return v;
}

function cosine(a: ArrayLike<number>, b: ArrayLike<number>) {
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

function meta(id: string, overrides: Record<string, unknown> = {}) {
  return {
    kind: 'record',
    id,
    revision: 1,
    occurredAt: '2026-10-12T10:00:00.000Z',
    placeId: 'c1',
    by: 'u1',
    participants: ['u1'],
    sourceIds: [id],
    ...overrides,
  };
}

/** The test databases opened here; closed when the file is done. */
const OPENED: Array<Awaited<ReturnType<typeof openTestMemory>>> = [];
after(async () => {
  for (const mem of OPENED) await mem.close();
});

async function scene(options: Partial<Parameters<typeof createVectors>[0]> = {}) {
  const mem = await openTestMemory();
  OPENED.push(mem);
  const { dataDir, memoryDb } = mem;
  const vectors = createVectors({ dataDir, log: quiet, now: () => OCT, memoryDb, ...options });
  return { dataDir, memoryDb, vectors };
}

type MemoryDb = Awaited<ReturnType<typeof scene>>['memoryDb'];

/** The rows of a month of a place's index the database holds (src/memory/db/line-vectors.ts). */
function monthRows(memoryDb: MemoryDb, month: string, placeId = 'g1'): number {
  const handle = memoryDb.readHandle();
  if (!handle) throw new Error('the memory database is not open');
  return lineVectorShape(handle.db as Db, placeId, month)?.rows ?? 0;
}

const ids = (hits: ReadonlyArray<{ meta: object }>) => hits.map((hit) => (hit.meta as { id: string }).id);

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
  const filtered = await vectors.search('g1', target, { k: 1, filter: (m: { id?: string }) => m.id !== 'm-near' });
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
  assert.equal(monthRows(memoryDb, '2026-09'), 1);
  assert.equal(monthRows(memoryDb, '2026-10'), 1);
  assert.deepEqual(ids(await vectors.search('g1', q, { k: 5, months: ['2026-10'] })), ['oct']);
  assert.deepEqual(ids(await vectors.search('g1', q, { k: 5, to: '2026-09-30T23:59:59.000Z' })), ['sep']);
  assert.deepEqual(ids(await vectors.search('g1', q, { k: 5, from: '2026-10-01T00:00:00.000Z' })), ['oct']);
  assert.equal((await vectors.search('g1', q, { k: 5 })).length, 2);
  const stats = await vectors.stats('g1');
  assert.equal(stats.months, 2);
  assert.equal(stats.rows, 2);
  assert.ok(stats.bytes > 64);
});

test('vectors: a private layer is kept apart from the root index and from other private layers', async () => {
  const { memoryDb, vectors } = await scene();
  const rng = seeded(9);
  const q = randomVector(rng, 16);
  await vectors.append('g1', [{ meta: meta('root'), vector: near(q, rng, 0.1) }]);
  // A private chat is its own place, so its index is that place's.
  await vectors.append('dm-u3', [{ meta: meta('dm-a'), vector: near(q, rng, 0.1) }]);
  await vectors.append('dm-u4', [{ meta: meta('dm-b'), vector: near(q, rng, 0.1) }]);
  assert.equal(monthRows(memoryDb, '2026-10', 'dm-u3'), 1);
  assert.deepEqual(ids(await vectors.search('g1', q, { k: 10 })), ['root']);
  assert.deepEqual(ids(await vectors.search('dm-u3', q, { k: 10 })), ['dm-a']);
  assert.deepEqual(ids(await vectors.search('dm-u4', q, { k: 10 })), ['dm-b']);
  assert.equal((await vectors.stats('dm-u4')).rows, 1);
});

test('vectors: has lists the kind, id and revision of every row of a month, kept current across appends and layers', async () => {
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
  assert.equal((await vectors.has('g1', '2026-09')).size, 0, 'another month');
  await vectors.append('dm-u9', [{ meta: meta('p'), vector: randomVector(rng, 8) }]);
  assert.deepEqual([...(await vectors.has('dm-u9', '2026-10'))], ['record:p:1']);
  assert.equal(
    (await vectors.has('g1', '2026-10')).has('record:p:1'),
    false,
    'a private row stays out of the root month'
  );
  await assert.rejects(vectors.has('g1', 'october'), TypeError);
});

test('vectors: has sees a month another instance wrote', async () => {
  const { dataDir, memoryDb, vectors } = await scene();
  const other = createVectors({ dataDir, log: quiet, now: () => OCT, memoryDb });
  const rng = seeded(12);
  await vectors.append('g1', [{ meta: meta('a'), vector: randomVector(rng, 8) }]);
  assert.equal((await vectors.has('g1', '2026-10')).size, 1);
  await other.append('g1', [{ meta: meta('b'), vector: randomVector(rng, 8) }]);
  assert.ok((await vectors.has('g1', '2026-10')).has('record:b:1'));
});
