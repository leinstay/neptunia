// Tests for src/memory/vectors.js: the int8 vector index for meaning search, over a temporary
// directory (never the deployment's data/), with a fixed clock and seeded vectors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createVectors, dequantize, quantize } from '../src/memory/vectors.js';

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

function scene(options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-vectors-'));
  const vectors = createVectors({ dataDir, log: quiet, now: () => OCT, ...options });
  return { dataDir, vectors };
}

function monthDir(dataDir, month, privateUserId = null) {
  return privateUserId
    ? path.join(dataDir, 'guilds', 'g1', 'private', privateUserId, 'vectors', month)
    : path.join(dataDir, 'guilds', 'g1', 'vectors', month);
}

function manifestOf(dataDir, month, privateUserId = null) {
  return JSON.parse(fs.readFileSync(path.join(monthDir(dataDir, month, privateUserId), 'manifest.json'), 'utf8'));
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
  const { vectors } = scene();
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
  const { dataDir, vectors } = scene();
  const rng = seeded(3);
  const q = randomVector(rng, 32);
  await vectors.append('g1', [
    { meta: meta('sep', { occurredAt: '2026-09-30T23:59:00.000Z' }), vector: near(q, rng, 0.05) },
    { meta: meta('oct', { occurredAt: '2026-10-01T00:01:00.000Z' }), vector: near(q, rng, 0.05) },
  ]);
  assert.equal(manifestOf(dataDir, '2026-09').rows, 1);
  assert.equal(manifestOf(dataDir, '2026-10').rows, 1);
  assert.deepEqual(ids(await vectors.search('g1', q, { k: 5, months: ['2026-10'] })), ['oct']);
  assert.deepEqual(ids(await vectors.search('g1', q, { k: 5, to: '2026-09-30T23:59:59.000Z' })), ['sep']);
  assert.deepEqual(ids(await vectors.search('g1', q, { k: 5, from: '2026-10-01T00:00:00.000Z' })), ['oct']);
  assert.equal((await vectors.search('g1', q, { k: 5 })).length, 2);
  const stats = await vectors.stats('g1');
  assert.equal(stats.months, 2);
  assert.equal(stats.rows, 2);
  assert.ok(stats.bytes > 64);
});

test('vectors: bytes past the manifest after a crash are ignored, then cut on the next write', async () => {
  const { dataDir, vectors } = scene();
  const rng = seeded(4);
  const q = randomVector(rng, 16);
  await vectors.append('g1', [{ meta: meta('a'), vector: near(q, rng, 0.1) }]);
  const dir = monthDir(dataDir, '2026-10');
  const m = manifestOf(dataDir, '2026-10');
  // A crash after the data and the jsonl line were written, before the manifest moved.
  fs.appendFileSync(path.join(dir, `${m.gen}.i8`), Buffer.alloc(16, 5));
  fs.appendFileSync(path.join(dir, `${m.gen}.jsonl`), `${JSON.stringify({ row: 1, kind: 'record', id: 'ghost' })}\n{"row":2,`);
  const fresh = createVectors({ dataDir, log: quiet, now: () => OCT });
  assert.deepEqual(ids(await fresh.search('g1', q, { k: 5 })), ['a']);
  await fresh.append('g1', [{ meta: meta('b'), vector: near(q, rng, 0.2) }]);
  const after = manifestOf(dataDir, '2026-10');
  assert.equal(after.rows, 2);
  assert.equal(fs.statSync(path.join(dir, `${after.gen}.i8`)).size, 32);
  const lines = fs.readFileSync(path.join(dir, `${after.gen}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => [l.row, l.id]), [[0, 'a'], [1, 'b']]);
  assert.deepEqual(ids(await createVectors({ dataDir, log: quiet }).search('g1', q, { k: 5 })).sort(), ['a', 'b']);
  // The instance that loaded the month before the crash sees the new row too.
  assert.deepEqual(ids(await vectors.search('g1', q, { k: 5 })).sort(), ['a', 'b']);
});

test('vectors: rewrite writes a new generation, switches the manifest and removes the old files', async () => {
  const { dataDir, vectors } = scene();
  const rng = seeded(5);
  const q = randomVector(rng, 16);
  await vectors.append('g1', ['a', 'b', 'c'].map((id) => ({ meta: meta(id), vector: near(q, rng, 0.3) })), { model: 'mx' });
  const before = manifestOf(dataDir, '2026-10');
  assert.deepEqual(ids(await vectors.search('g1', q, { k: 5 })).sort(), ['a', 'b', 'c']);
  const result = await vectors.rewrite('g1', '2026-10', (m) => m.id !== 'b');
  assert.deepEqual(result, { kept: 2, dropped: 1 });
  const after = manifestOf(dataDir, '2026-10');
  assert.notEqual(after.gen, before.gen);
  assert.equal(after.rows, 2);
  assert.equal(after.model, 'mx');
  const dir = monthDir(dataDir, '2026-10');
  assert.deepEqual(fs.readdirSync(dir).sort(), [`${after.gen}.i8`, `${after.gen}.jsonl`, 'manifest.json'].sort());
  const hits = await vectors.search('g1', q, { k: 5 });
  assert.deepEqual(ids(hits).sort(), ['a', 'c']);
  assert.deepEqual(hits.map((h) => h.meta.row).sort(), [0, 1]);
});

test('vectors: forgetUser drops rows by author, by participant and by a chunk line of theirs', async () => {
  const { dataDir, vectors } = scene();
  const rng = seeded(6);
  const q = randomVector(rng, 16);
  const row = (m) => ({ meta: m, vector: near(q, rng, 0.3) });
  await vectors.append('g1', [
    row(meta('own', { by: 'u9', participants: ['u9'] })),
    row(meta('mentioned', { by: 'u1', participants: ['u1', 'u9'] })),
    row(meta('context', { by: 'u1', participants: ['u1'], sourceIds: ['x-u9', 'x-u2', 'context'] })),
    row(meta('archive', { kind: 'archive', by: null, participants: ['u9'] })),
    row(meta('other', { by: 'u2', participants: ['u2'], sourceIds: ['x-u2', 'other'] })),
  ]);
  await vectors.append('g1', [row(meta('dm', { by: 'u3', participants: ['u3', 'u9'] }))], { privateUserId: 'u3' });
  await vectors.append('g1', [row(meta('own-dm', { by: 'u9', participants: ['u9'] }))], { privateUserId: 'u9' });
  const result = await vectors.forgetUser('g1', 'u9', { messageIds: ['x-u9'] });
  assert.deepEqual(result, { dropped: 4, privateDropped: 2 });
  assert.deepEqual(ids(await vectors.search('g1', q, { k: 10 })), ['other']);
  assert.deepEqual(await vectors.search('g1', q, { k: 10, privateUserId: 'u3' }), []);
  assert.equal(fs.existsSync(path.join(dataDir, 'guilds', 'g1', 'private', 'u9', 'vectors')), false);
  assert.equal(fs.existsSync(path.join(dataDir, 'guilds', 'g1', 'forgetting', 'u9.json')), false);
});

test('vectors: forgetUser with before drops only the earlier rows', async () => {
  const { vectors } = scene();
  const rng = seeded(7);
  const q = randomVector(rng, 16);
  await vectors.append('g1', [
    { meta: meta('early', { by: 'u9', participants: ['u9'], occurredAt: '2026-10-01T00:00:00.000Z' }), vector: near(q, rng, 0.2) },
    { meta: meta('late', { by: 'u9', participants: ['u9'], occurredAt: '2026-10-12T00:00:00.000Z' }), vector: near(q, rng, 0.2) },
  ]);
  const result = await vectors.forgetUser('g1', 'u9', { before: Date.parse('2026-10-05T00:00:00.000Z') });
  assert.equal(result.dropped, 1);
  assert.deepEqual(ids(await vectors.search('g1', q, { k: 10 })), ['late']);
});

test('vectors: search hides a member under a forgetting marker or in the ledger before the rewrite', async () => {
  const { dataDir, vectors } = scene();
  const rng = seeded(8);
  const q = randomVector(rng, 16);
  const row = (m) => ({ meta: m, vector: near(q, rng, 0.2) });
  await vectors.append('g1', [
    row(meta('marked', { by: 'u7', participants: ['u7'] })),
    row(meta('ledger-early', { by: 'u1', participants: ['u1', 'u8'], occurredAt: '2026-10-02T00:00:00.000Z' })),
    row(meta('ledger-late', { by: 'u8', participants: ['u8'], occurredAt: '2026-10-12T00:00:00.000Z' })),
    row(meta('archived', { kind: 'archive', by: null, participants: ['u8'], occurredAt: '2026-10-03T00:00:00.000Z' })),
    row(meta('plain', { by: 'u2', participants: ['u2'] })),
  ]);
  await vectors.append('g1', [row(meta('dm', { by: 'u7', participants: ['u7'] }))], { privateUserId: 'u7' });
  const guildDir = path.join(dataDir, 'guilds', 'g1');
  fs.mkdirSync(path.join(guildDir, 'forgetting'), { recursive: true });
  fs.writeFileSync(path.join(guildDir, 'forgetting', 'u7.json'), JSON.stringify({ userId: 'u7' }));
  fs.writeFileSync(path.join(guildDir, 'forgotten.json'), JSON.stringify([{ userId: 'u8', at: '2026-10-10T00:00:00.000Z' }]));
  assert.deepEqual(ids(await vectors.search('g1', q, { k: 10 })).sort(), ['ledger-late', 'plain']);
  assert.deepEqual(await vectors.search('g1', q, { k: 10, privateUserId: 'u7' }), []);
});

test('vectors: a private layer is kept apart from the guild index and from other private layers', async () => {
  const { dataDir, vectors } = scene();
  const rng = seeded(9);
  const q = randomVector(rng, 16);
  await vectors.append('g1', [{ meta: meta('guild'), vector: near(q, rng, 0.1) }]);
  await vectors.append('g1', [{ meta: meta('dm-a'), vector: near(q, rng, 0.1) }], { privateUserId: 'u3' });
  await vectors.append('g1', [{ meta: meta('dm-b'), vector: near(q, rng, 0.1) }], { privateUserId: 'u4' });
  assert.equal(manifestOf(dataDir, '2026-10', 'u3').rows, 1);
  assert.deepEqual(ids(await vectors.search('g1', q, { k: 10 })), ['guild']);
  assert.deepEqual(ids(await vectors.search('g1', q, { k: 10, privateUserId: 'u3' })), ['dm-a']);
  assert.deepEqual(ids(await vectors.search('g1', q, { k: 10, privateUserId: 'u4' })), ['dm-b']);
  assert.equal((await vectors.stats('g1', { privateUserId: 'u4' })).rows, 1);
});

test('vectors: the cache is bounded by bytes and evicts the least recently used month', async () => {
  const reads = [];
  const countingFs = {
    ...fsp,
    async open(file, flags) {
      if (String(file).endsWith('.i8') && flags === 'r') reads.push(path.basename(path.dirname(file)));
      return fsp.open(file, flags);
    },
  };
  // Each month: 2 rows x 256 bytes plus its jsonl (~400 bytes); two months fit, three do not.
  const { vectors } = scene({ fs: countingFs, maxCacheBytes: 2200 });
  const rng = seeded(10);
  const q = randomVector(rng, 256);
  for (const month of ['2026-08', '2026-09', '2026-10']) {
    await vectors.append('g1', [1, 2].map((n) => ({ meta: meta(`${month}-${n}`, { occurredAt: `${month}-05T00:00:00.000Z` }), vector: randomVector(rng, 256) })));
  }
  reads.length = 0;
  await vectors.search('g1', q, { k: 1, months: ['2026-08'] });
  await vectors.search('g1', q, { k: 1, months: ['2026-09'] });
  await vectors.search('g1', q, { k: 1, months: ['2026-08'] });
  assert.deepEqual(reads, ['2026-08', '2026-09']);
  // 2026-10 pushes out the least recently used month, 2026-09; 2026-08 stays cached.
  await vectors.search('g1', q, { k: 1, months: ['2026-10'] });
  await vectors.search('g1', q, { k: 1, months: ['2026-08'] });
  assert.deepEqual(reads, ['2026-08', '2026-09', '2026-10']);
  await vectors.search('g1', q, { k: 1, months: ['2026-09'] });
  assert.deepEqual(reads, ['2026-08', '2026-09', '2026-10', '2026-09']);
});

test('vectors: search time over 20 000 rows of 1024 dims (measured, not asserted)', async (t) => {
  const { vectors } = scene();
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
