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
  const infos = [];
  return { warns, infos, info(name, fields) { infos.push({ name, fields }); }, warn(name, fields) { warns.push({ name, fields }); }, error() {} };
}

/** A temp data/, the real record, a fake index and embed call, and the queue over them. */
function scene({ features = { meaningSearch: true, embedIndex: true }, embedConfig = {}, embedImpl = null, paused = null } = {}) {
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
  /** Rows already in the index before the scene (`chunkKey`s by layer and month). */
  const preIndexed = [];
  const vectors = {
    async append(guildId, rows, opts) {
      appended.push({ guildId, rows, opts });
      return { written: rows.length };
    },
    async has(guildId, month, { privateUserId = null } = {}) {
      const keys = new Set();
      for (const item of [...preIndexed, ...appended.flatMap((a) => a.rows.map((row) => ({ meta: row.meta, privateUserId: a.opts.privateUserId ?? null })))]) {
        if ((item.privateUserId ?? null) === privateUserId && item.meta.occurredAt.slice(0, 7) === month) keys.add(`${item.meta.kind}:${item.meta.id}:${item.meta.revision}`);
      }
      return keys;
    },
    async stats(guildId, { privateUserId = null } = {}) {
      const rows = appended.filter((a) => (a.opts.privateUserId ?? null) === privateUserId).reduce((n, a) => n + a.rows.length, 0);
      return { months: rows > 0 ? 1 : 0, rows, bytes: 0 };
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
    ...(paused ? { paused } : {}),
  });
  /** Record the lines, then queue them, as src/index.js's wrapper does. */
  async function write(lines, opts = {}) {
    await record.append(GUILD, lines, opts);
    return embedder.enqueue(GUILD, lines, opts);
  }
  /** Record the lines only: the queue was down (a stop, a crash, the switches off). */
  const recordOnly = (lines, opts = {}) => record.append(GUILD, lines, opts);
  return { dataDir, record, hot, appended, preIndexed, calls, clock, log, embedder, write, recordOnly, close: () => appendStore.close() };
}

const sentIds = (kit) => kit.appended.flatMap((a) => a.rows.map((row) => `${row.meta.id}:${row.meta.revision}`));

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

test('embedder: close flushes what waits once, then queues nothing more', async () => {
  const kit = scene();
  await kit.write([line('m1', 0, 'a'), line('m2', 1, 'b')]);
  assert.equal(kit.calls.length, 0, 'under the batch: nothing sent yet');
  assert.deepEqual(await kit.embedder.close(), { embedded: 2, dropped: 0, left: 0 });
  assert.equal(kit.calls.length, 1);
  assert.equal(kit.appended[0].rows.length, 2);
  assert.equal(await kit.embedder.close(), null, 'a second close does nothing');
  assert.equal(await kit.write([line('m3', 2, 'c')]), 0, 'nothing is queued after close');
  assert.equal(kit.calls.length, 1);
  await kit.close();
});

test('embedder: close gives up after its timeout without waiting for a hung request', async () => {
  let release;
  const hung = new Promise((resolve) => {
    release = resolve;
  });
  const kit = scene({ embedImpl: () => hung });
  await kit.write([line('m1', 0, 'a')]);
  assert.equal(await kit.embedder.close({ timeoutMs: 20 }), null);
  release([Float32Array.from([1, 0, 0, 0])]);
  await kit.embedder.flush();
  assert.equal(kit.calls.length, 1, 'the one flush, finished after close gave up');
  await kit.close();
});

test('embedder: catchUp at start embeds the lines recorded while the queue was down, each with its channel context', async () => {
  const kit = scene();
  await kit.recordOnly([line('m1', 0, 'who brought the café?', { by: NIKOS, participants: [NIKOS] }), line('m2', 1, 'not me'), line('m3', 2, 'elsewhere', { scope: { channel: 'c2' } })]);
  await kit.recordOnly([line('p1', 3, 'a private word')], { privateUserId: ELENI });
  kit.clock.at = T0 + 3 * 3_600_000;
  const pass = await kit.embedder.catchUp(GUILD);
  assert.equal(pass.queued, 4);
  assert.equal(pass.missing, 4);
  await kit.embedder.flush();
  assert.deepEqual(kit.calls[0].texts, ['Nikós: who brought the café?', 'Nikós: who brought the café?\nΕλένη: not me', 'Ελένη: elsewhere', 'Ελένη: a private word']);
  assert.deepEqual(kit.appended.map((a) => a.opts.privateUserId), [null, ELENI]);
  assert.ok(kit.log.infos.some((i) => i.name === 'embedder: coverage' && i.fields.missing === 4 && i.fields.queued === 4));
  // A second pass finds nothing left.
  assert.equal((await kit.embedder.catchUp(GUILD)).queued, 0);
  assert.equal(kit.embedder.stats().queued, 0);
  await kit.close();
});

test('embedder: catchUp skips what the index holds at that revision and embeds a newer revision', async () => {
  const kit = scene();
  await kit.recordOnly([line('m1', 0, 'kept'), line('m2', 1, 'first'), line('m3', 2, 'new')]);
  await kit.recordOnly([line('m2', 1, 'edited', { revision: 2 })]);
  kit.preIndexed.push(
    { meta: { kind: 'record', id: 'm1', revision: 1, occurredAt: line('m1', 0, '').occurredAt }, privateUserId: null },
    { meta: { kind: 'record', id: 'm2', revision: 1, occurredAt: line('m2', 1, '').occurredAt }, privateUserId: null },
  );
  kit.clock.at = T0 + 3_600_000;
  const pass = await kit.embedder.catchUp(GUILD);
  assert.deepEqual({ messages: pass.messages, indexed: pass.indexed, missing: pass.missing, queued: pass.queued }, { messages: 3, indexed: 1, missing: 2, queued: 2 });
  await kit.embedder.flush();
  assert.deepEqual(sentIds(kit), ['m2:2', 'm3:1']);
  await kit.close();
});

test('embedder: catchUp leaves out a member under a forgetting marker, one the ledger forgot after the line, and their private layer', async () => {
  const kit = scene();
  const guildDir = path.join(kit.dataDir, 'guilds', GUILD);
  const MARTA = '433333333333333333';
  await kit.recordOnly([line('m1', 0, 'by Nikós', { by: NIKOS, participants: [NIKOS] }), line('m2', 1, 'by Eleni'), line('m3', 2, 'by Marta', { by: MARTA, participants: [MARTA] })]);
  await kit.recordOnly([line('p1', 3, 'private to Nikós', { by: NIKOS, participants: [NIKOS] })], { privateUserId: NIKOS });
  fs.writeFileSync(path.join(guildDir, 'forgotten.json'), JSON.stringify([{ userId: NIKOS, at: new Date(T0 + 30 * 60_000).toISOString() }]));
  fs.mkdirSync(path.join(guildDir, 'forgetting'), { recursive: true });
  fs.writeFileSync(path.join(guildDir, 'forgetting', `${MARTA}.json`), '{}');
  kit.clock.at = T0 + 3_600_000;
  const pass = await kit.embedder.catchUp(GUILD);
  assert.equal(pass.queued, 1);
  await kit.embedder.flush();
  assert.deepEqual(sentIds(kit), ['m2:1']);
  assert.deepEqual(kit.calls[0].texts, ['Ελένη: by Eleni'], 'a forgotten context line is left out too');
  await kit.close();
});

test('embedder: coverage counts the record window, the indexed, the missing and the oldest missing, before and after a pass', async () => {
  const kit = scene();
  await kit.recordOnly([line('m0', -48 * 60, 'too old for the window'), line('m1', 0, 'a'), line('m2', 1, 'b')]);
  kit.clock.at = T0 + 3_600_000;
  const before = await kit.embedder.coverage(GUILD, { hours: 24 });
  assert.deepEqual(before, { messages: 2, indexed: 0, missing: 2, oldestMissing: line('m1', 0, '').occurredAt });
  const wide = await kit.embedder.coverage(GUILD, { hours: 72 });
  assert.equal(wide.messages, 3);
  await kit.embedder.catchUp(GUILD);
  await kit.embedder.flush();
  assert.deepEqual(await kit.embedder.coverage(GUILD, { hours: 72 }), { messages: 3, indexed: 3, missing: 0, oldestMissing: null });
  await kit.close();
});

test('embedder: switching the index on later triggers a catch-up on the next tick', async () => {
  const kit = scene({ features: { meaningSearch: true, embedIndex: false } });
  assert.equal(await kit.write([line('m1', 0, 'while off')]), 0);
  kit.clock.at = T0 + 60_000;
  await kit.embedder.tick(GUILD);
  assert.equal(kit.embedder.stats().queued, 0, 'off: no catch-up');
  kit.hot.config.features.embedIndex = true;
  await kit.embedder.tick(GUILD);
  assert.equal(kit.embedder.stats().queued, 1, 'the switch turned on: caught up');
  await kit.embedder.flush();
  assert.deepEqual(sentIds(kit), ['m1:1']);
  await kit.close();
});

test('embedder: no catch-up while paused; the one run on resume queues what the pause left', async () => {
  const state = { paused: true };
  const kit = scene({ paused: () => state.paused });
  await kit.recordOnly([line('m1', 0, 'before the pause')]);
  kit.clock.at = T0 + 60_000;
  assert.equal(await kit.embedder.catchUp(GUILD), null);
  await kit.embedder.tick(GUILD);
  assert.equal(kit.embedder.stats().queued, 0);
  state.paused = false;
  const pass = await kit.embedder.catchUp(GUILD);
  assert.equal(pass.queued, 1);
  await kit.close();
});

test('embedder: the periodic pass runs every embed.catchUpEveryMinutes and finds lines that bypassed the queue', async () => {
  const kit = scene({ embedConfig: { catchUpEveryMinutes: 60 } });
  await kit.embedder.catchUp(GUILD);
  await kit.recordOnly([line('m1', 5, 'a line the queue never heard of')]);
  kit.clock.at = T0 + 59 * 60_000;
  await kit.embedder.tick(GUILD);
  assert.equal(kit.embedder.stats().queued, 0, 'not yet');
  kit.clock.at = T0 + 60 * 60_000;
  await kit.embedder.tick(GUILD);
  assert.equal(kit.embedder.stats().queued + kit.appended.length, 1, 'the hourly pass found it');
  await kit.close();
});

test('embedder: a pass queues at most embed.queueMax; the rest follows once the queue has drained', async () => {
  const kit = scene({ embedConfig: { queueMax: 2, batch: 2, flushSeconds: 60 } });
  await kit.recordOnly([1, 2, 3, 4, 5].map((n) => line(`m${n}`, n, `line ${n}`)));
  kit.clock.at = T0 + 3_600_000;
  const pass = await kit.embedder.catchUp(GUILD);
  assert.deepEqual({ queued: pass.queued, left: pass.left }, { queued: 2, left: 3 });
  assert.ok(!kit.log.warns.some((w) => w.name === 'embedder: queue full'), 'a pass never overfills the queue');
  await kit.embedder.flush();
  for (let i = 0; i < 4; i += 1) {
    kit.clock.at += 60_000;
    await kit.embedder.tick(GUILD);
    await kit.embedder.flush();
  }
  assert.deepEqual(sentIds(kit), ['m1:1', 'm2:1', 'm3:1', 'm4:1', 'm5:1']);
  await kit.close();
});

test('embedder: a line the queue had and lost is warned about as a coverage gap and queued again', async () => {
  const kit = scene({ embedConfig: { queueMax: 1 } });
  await kit.write([line('m1', 0, 'a'), line('m2', 1, 'b')]);
  assert.ok(kit.log.warns.some((w) => w.name === 'embedder: queue full'));
  await kit.embedder.flush();
  assert.deepEqual(sentIds(kit), ['m2:1']);
  kit.clock.at = T0 + 3_600_000;
  const pass = await kit.embedder.catchUp(GUILD);
  assert.equal(pass.lost, 1);
  assert.ok(kit.log.warns.some((w) => w.name === 'embedder: coverage gap' && w.fields.lost === 1 && w.fields.missing === 1));
  await kit.embedder.flush();
  assert.deepEqual(sentIds(kit), ['m2:1', 'm1:1']);
  await kit.close();
});

test('embedder: indexSummary gives the index rows and the last pass\'s missing count', async () => {
  const kit = scene();
  assert.deepEqual(await kit.embedder.indexSummary(GUILD), { rows: 0, missing: null });
  await kit.recordOnly([line('m1', 0, 'a'), line('m2', 1, 'b')]);
  await kit.recordOnly([line('p1', 2, 'c')], { privateUserId: ELENI });
  kit.clock.at = T0 + 3_600_000;
  await kit.embedder.catchUp(GUILD);
  assert.deepEqual(await kit.embedder.indexSummary(GUILD), { rows: 0, missing: 3 });
  await kit.embedder.flush();
  await kit.embedder.catchUp(GUILD);
  assert.deepEqual(await kit.embedder.indexSummary(GUILD), { rows: 3, missing: 0 });
  await kit.close();
});
