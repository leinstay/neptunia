// Tests for src/memory/embedder.js: the live embedding queue over a real record in a temporary
// data/ directory, with a fake embedding call and a fake vector index (no network, no real data).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAppendStore } from '../src/memory/append-store.js';
import { createRecord } from '../src/memory/record.js';
import { createEmbedder } from '../src/memory/embedder.js';

const GUILD = '600000000000000001';
const ELENI = '411111111111111111';
const NIKOS = '422222222222222222';
const T0 = Date.UTC(2026, 9, 12, 10, 0, 0);
const names = new Map([[ELENI, 'Ελένη'], [NIKOS, 'Nikós']]);

function line(messageId, minute, text, overrides = {}) {
  return {
    v: 1, kind: 'seen', messageId, revision: 1, occurredAt: new Date(T0 + minute * 60_000).toISOString(),
    scope: { channel: 'c1' }, by: ELENI, text, participants: [ELENI], ...overrides,
  };
}

function quietLog() {
  const warns = [];
  return { warns, info() {}, warn(name, fields) { warns.push({ name, fields }); }, error() {} };
}

/** A temp data/, the real record, a fake index and embed call, and the queue over them. */
function scene({ features = { meaningSearch: true, embedIndex: true }, embedConfig = {}, embedImpl = null } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-embedder-'));
  const appendStore = createAppendStore({ fsyncMs: 0, log: quietLog() });
  const record = createRecord({ appendStore, dataDir, log: quietLog() });
  const config = {
    features: { ...features },
    embed: { dimensions: 4, batch: 64, flushSeconds: 180, queueMax: 2000, ...embedConfig },
    classifier: { embed: 'test/embed-model' },
    llm: { maxRequestTokens: 50000 },
  };
  const hot = { config };
  const appended = [];
  const vectors = {
    async append(guildId, rows, opts) {
      appended.push({ guildId, rows, opts });
      return { written: rows.length };
    },
  };
  const calls = [];
  const embed = async (texts, opts) => {
    calls.push({ texts, opts });
    if (embedImpl) return embedImpl(texts, opts);
    return texts.map((_, i) => Float32Array.from([1, i, 0, 0]));
  };
  const clock = { at: T0 };
  const log = quietLog();
  const embedder = createEmbedder({
    hot, vectors, embed, record, dataDir, log, now: () => clock.at,
    nameOf: (guildId, id) => names.get(id) ?? null,
    selfName: () => 'Persona',
  });
  /** Record the lines, then queue them, as src/index.js's wrapper does. */
  async function write(lines, opts = {}) {
    await record.append(GUILD, lines, opts);
    return embedder.enqueue(GUILD, lines, opts);
  }
  return { dataDir, record, hot, appended, calls, clock, log, embedder, write, close: () => appendStore.close() };
}

test('embedder: nothing is queued or sent unless meaningSearch and embedIndex are both on', async () => {
  for (const features of [{ meaningSearch: true, embedIndex: false }, { meaningSearch: false, embedIndex: true }, {}]) {
    const kit = scene({ features });
    assert.equal(await kit.write([line('m1', 0, 'γεια')]), 0);
    await kit.embedder.flush();
    assert.equal(kit.calls.length, 0);
    assert.equal(kit.appended.length, 0);
    await kit.close();
  }
});

test('embedder: a full batch flushes at once: one request, chunks with their channel context, appended with the model', async () => {
  const kit = scene({ embedConfig: { batch: 2 } });
  await kit.write([line('m1', 0, 'who brought the café?', { by: NIKOS, participants: [NIKOS] })]);
  assert.equal(kit.calls.length, 0);
  await kit.write([line('m2', 1, 'not me', { kind: 'said', by: undefined, participants: [] })]);
  await kit.embedder.flush();
  assert.equal(kit.calls.length, 1);
  assert.deepEqual(kit.calls[0].texts, ['Nikós: who brought the café?', 'Nikós: who brought the café?\nPersona: not me']);
  assert.equal(kit.appended.length, 1);
  const { rows, opts } = kit.appended[0];
  assert.equal(opts.model, 'test/embed-model');
  assert.equal(opts.privateUserId, null);
  assert.deepEqual(rows[1].meta.sourceIds, ['m1', 'm2']);
  assert.deepEqual(rows[1].meta.participants, [NIKOS]);
  assert.equal(kit.embedder.stats().queued, 0);
  await kit.close();
});

test('embedder: the tick flushes once embed.flushSeconds have passed', async () => {
  const kit = scene({ embedConfig: { flushSeconds: 60 } });
  await kit.write([line('m1', 0, 'a')]);
  assert.equal(kit.embedder.tick(), null);
  kit.clock.at += 59_000;
  assert.equal(kit.embedder.tick(), null);
  kit.clock.at += 1_000;
  await kit.embedder.tick();
  assert.equal(kit.calls.length, 1);
  assert.equal(kit.appended[0].rows.length, 1);
  await kit.close();
});

test('embedder: a line recorded twice is queued once; a newer revision replaces the older job', async () => {
  const kit = scene();
  assert.equal(await kit.write([line('m1', 0, 'first')]), 1);
  assert.equal(kit.embedder.enqueue(GUILD, [line('m1', 0, 'first')]), 0, 'the same revision again');
  assert.equal(await kit.write([line('m1', 0, 'edited', { revision: 2 })]), 1);
  assert.equal(kit.embedder.enqueue(GUILD, [line('m1', 0, 'first')]), 0, 'an older revision');
  assert.equal(kit.embedder.stats().queued, 1);
  await kit.embedder.flush();
  assert.deepEqual(kit.calls[0].texts, ['Ελένη: edited']);
  assert.equal(kit.appended[0].rows[0].meta.revision, 2);
  await kit.close();
});

test('embedder: a failed request keeps the queue and the next flush sends it', async () => {
  let fail = true;
  const kit = scene({
    embedImpl: (texts) => {
      if (fail) throw Object.assign(new Error('HTTP 503'), { statusCode: 503 });
      return texts.map(() => Float32Array.from([1, 0, 0, 0]));
    },
  });
  await kit.write([line('m1', 0, 'a'), line('m2', 1, 'b')]);
  const first = await kit.embedder.flush();
  assert.deepEqual(first, { embedded: 0, dropped: 0, left: 2 });
  assert.ok(kit.log.warns.some((w) => w.name === 'embedder: embed failed' && w.fields.status === 503));
  fail = false;
  const second = await kit.embedder.flush();
  assert.deepEqual(second, { embedded: 2, dropped: 0, left: 0 });
  await kit.close();
});

test('embedder: the queue is bounded at embed.queueMax, the oldest dropped with a warn', async () => {
  const kit = scene({ embedConfig: { queueMax: 3 } });
  await kit.write([1, 2, 3, 4, 5].map((n) => line(`m${n}`, n, `line ${n}`)));
  assert.equal(kit.embedder.stats().queued, 3);
  assert.ok(kit.log.warns.some((w) => w.name === 'embedder: queue full' && w.fields.dropped === 2));
  await kit.embedder.flush();
  assert.deepEqual(kit.appended[0].rows.map((row) => row.meta.id), ['m3', 'm4', 'm5']);
  await kit.close();
});

test('embedder: a forget landing while the request runs drops the rows naming the member', async () => {
  let kit;
  kit = scene({
    embedImpl: (texts) => {
      const dir = path.join(kit.dataDir, 'guilds', GUILD, 'forgetting');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${NIKOS}.json`), '{}');
      return texts.map(() => Float32Array.from([1, 0, 0, 0]));
    },
  });
  await kit.write([line('m1', 0, 'by Nikós', { by: NIKOS, participants: [NIKOS] })]);
  await kit.write([line('m2', 10, 'unrelated', { scope: { channel: 'c2' } })]);
  const result = await kit.embedder.flush();
  assert.equal(result.embedded, 1);
  assert.equal(result.dropped, 1);
  assert.deepEqual(kit.appended[0].rows.map((row) => row.meta.id), ['m2']);
  await kit.close();
});

test('embedder: a member forgotten after the line is never sent; a context line naming them is left out', async () => {
  const kit = scene();
  const ledger = path.join(kit.dataDir, 'guilds', GUILD, 'forgotten.json');
  await kit.write([line('m1', 0, 'by Nikós', { by: NIKOS, participants: [NIKOS] })]);
  await kit.write([line('m2', 1, 'by Eleni')]);
  fs.writeFileSync(ledger, JSON.stringify([{ userId: NIKOS, at: new Date(T0 + 5 * 60_000).toISOString() }]));
  await kit.embedder.flush();
  assert.equal(kit.calls.length, 1);
  assert.deepEqual(kit.calls[0].texts, ['Ελένη: by Eleni']);
  assert.deepEqual(kit.appended[0].rows[0].meta.sourceIds, ['m2']);
  // What the member wrote after their forget is kept: a forget is not a ban.
  await kit.write([line('m3', 9, 'back again', { by: NIKOS, participants: [NIKOS] })]);
  await kit.embedder.flush();
  assert.deepEqual(kit.appended[1].rows.map((row) => row.meta.id), ['m3']);
  await kit.close();
});

test('embedder: the ring is filled from the record on first use', async () => {
  const kit = scene({ features: { meaningSearch: true, embedIndex: false } });
  await kit.write([line('m1', 0, 'one'), line('m2', 1, 'two'), line('m3', 2, 'three', { scope: { channel: 'c2' } })]);
  kit.hot.config.features.embedIndex = true;
  await kit.write([line('m4', 3, 'four')]);
  await kit.embedder.flush();
  assert.deepEqual(kit.calls[0].texts, ['Ελένη: one\nΕλένη: two\nΕλένη: four']);
  await kit.close();
});

test('embedder: a private line keeps to its own layer and goes to the private index', async () => {
  const kit = scene();
  await kit.write([line('m1', 0, 'public')]);
  await kit.write([line('m2', 1, 'private', { scope: { channel: 'c1' } })], { privateUserId: ELENI });
  await kit.embedder.flush();
  assert.deepEqual(kit.calls[0].texts, ['Ελένη: public', 'Ελένη: private']);
  assert.deepEqual(kit.appended.map((a) => a.opts.privateUserId), [null, ELENI]);
  await kit.close();
});

test('embedder: a wiped record (its day file gone) sends nothing', async () => {
  const kit = scene();
  await kit.write([line('m1', 0, 'a')]);
  // The record's files closed first, as the wipe's writer lock flushes them (Windows keeps open files).
  await kit.close();
  fs.rmSync(path.join(kit.dataDir, 'guilds', GUILD, 'record'), { recursive: true, force: true });
  const result = await kit.embedder.flush();
  assert.deepEqual(result, { embedded: 0, dropped: 1, left: 0 });
  assert.equal(kit.calls.length, 0);
});
