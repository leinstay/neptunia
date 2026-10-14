// The meaning index in the store's deletion paths (src/memory/store.js): a forget takes the
// member's rows out of the index (by their chunk's members and by the record lines it drops), the
// deletion ledger takes out what a restored copy brought back, and a wipe removes the index. Over
// a temporary data/ directory with the real record and vector index.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAppendStore } from '../src/memory/append-store.js';
import { createRecord } from '../src/memory/record.js';
import { createStore } from '../src/memory/store.js';
import { createVectors } from '../src/memory/vectors.js';

const GUILD = '600000000000000001';
const ELENI = '411111111111111111';
const NIKOS = '422222222222222222';
const FORGET_AT = Date.UTC(2026, 9, 14, 12, 0, 0);
const quiet = { info() {}, warn() {}, error() {} };

function meta(id, overrides = {}) {
  return {
    kind: 'record', id, revision: 1, occurredAt: '2026-10-12T10:00:00.000Z', channelId: 'c1',
    by: NIKOS, participants: [NIKOS], sourceIds: [id], ...overrides,
  };
}

const vector = (seed) => Float32Array.from([1, seed, 0.5, -seed]);

async function scene() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-store-vectors-'));
  const appendStore = createAppendStore({ fsyncMs: 0, log: quiet });
  const record = createRecord({ appendStore, dataDir, log: quiet });
  await record.append(GUILD, [
    { kind: 'seen', messageId: 'm1', revision: 1, occurredAt: '2026-10-12T09:59:00.000Z', scope: { channel: 'c1' }, by: ELENI, text: 'γεια', participants: [ELENI] },
    { kind: 'seen', messageId: 'm2', revision: 1, occurredAt: '2026-10-12T10:00:00.000Z', scope: { channel: 'c1' }, by: NIKOS, text: 'hi', participants: [NIKOS] },
  ]);
  await appendStore.close();
  const vectors = createVectors({ dataDir, log: quiet, now: () => FORGET_AT });
  await vectors.append(GUILD, [
    { meta: meta('m1', { by: ELENI, participants: [ELENI] }), vector: vector(1) },
    { meta: meta('m2'), vector: vector(2) },
    // A row whose stored members miss her, holding her line: found by the record's message ids.
    { meta: meta('m9', { sourceIds: ['m1', 'm9'] }), vector: vector(3) },
  ]);
  await vectors.append(GUILD, [{ meta: meta('p1', { by: ELENI, participants: [ELENI] }), vector: vector(4) }], { privateUserId: ELENI });
  const store = createStore({ dataDir, vectors });
  return { dataDir, vectors, store };
}

const rowIds = async (vectors, opts = {}) => (await vectors.search(GUILD, vector(2), { k: 10, ...opts })).map((hit) => hit.meta.id).sort();

test('store forget: the meaning index loses the rows naming the member or holding their record lines, and their private index', async () => {
  const { dataDir, vectors, store } = await scene();
  const { counts } = await store.forgetUser(GUILD, ELENI, { vaultDir: 'vault', now: () => FORGET_AT });
  assert.equal(counts.vectors, 3);
  assert.equal(counts.record, 1);
  assert.deepEqual(await rowIds(vectors), ['m2']);
  assert.equal(fs.existsSync(path.join(dataDir, 'guilds', GUILD, 'private', ELENI, 'vectors')), false);
  assert.equal((await vectors.stats(GUILD)).rows, 1, 'rewritten on disk, not only hidden');
});

test('store applyLedger: a restored row from before the forget goes again; one from after stays', async () => {
  const { vectors, store } = await scene();
  await store.forgetUser(GUILD, ELENI, { vaultDir: 'vault', now: () => FORGET_AT });
  await vectors.append(GUILD, [
    { meta: meta('old', { by: ELENI, participants: [ELENI], occurredAt: '2026-10-13T08:00:00.000Z' }), vector: vector(5) },
    { meta: meta('new', { by: ELENI, participants: [ELENI], occurredAt: '2026-10-14T13:00:00.000Z' }), vector: vector(6) },
  ]);
  const counts = await store.applyLedger(GUILD);
  assert.equal(counts.vectors, 1);
  assert.equal((await vectors.stats(GUILD)).rows, 2);
  assert.deepEqual(await rowIds(vectors), ['m2', 'new']);
});

test('store applyLedger: without a meaning index the counts keep their shape', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-store-vectors-'));
  const store = createStore({ dataDir });
  fs.mkdirSync(path.join(dataDir, 'guilds', GUILD), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'guilds', GUILD, 'forgotten.json'), JSON.stringify([{ userId: ELENI, at: new Date(FORGET_AT).toISOString() }]));
  const counts = await store.applyLedger(GUILD);
  assert.equal(Object.hasOwn(counts, 'vectors'), false);
});

test('store wipe: the meaning index goes with the record, after the vault copy', async () => {
  const { dataDir, store } = await scene();
  const counts = store.wipeGuild(GUILD, { vaultDir: 'vault', now: () => FORGET_AT });
  assert.equal(fs.existsSync(path.join(dataDir, 'guilds', GUILD, 'vectors')), false);
  assert.ok(fs.existsSync(path.join(counts.vault, 'guilds', GUILD, 'vectors')), 'the vault holds the index');
  assert.equal(Object.hasOwn(counts, 'vectorFiles'), false, 'the reply counts keep their shape');
});
