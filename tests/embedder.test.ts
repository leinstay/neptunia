// Tests for src/memory/embedder.ts: the live embedding queue over a real record in the memory
// database of a temporary data/ directory, with a fake embedding call and a fake vector index (no
// network, no real data).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecord } from '../src/memory/record.ts';
import { createEmbedder } from '../src/memory/embedder.ts';
import { openTestMemorySync } from './fixtures/memory-db/service.ts';
import type { Untyped } from '../src/tools/types.ts';

// The records come back typed as `object` or `unknown`; the tests read their fields through `loose`.
const loose = (value: unknown): Record<string, Untyped> => value as Record<string, Untyped>;

// The fakes hold only the part of the real object that the code under test reads, so each is cast once, here.
const fakeOf = <T>(value: object): T => value as T;

const GUILD = '600000000000000001';
const ELENI = '411111111111111111';
const NIKOS = '422222222222222222';
const T0 = Date.UTC(2026, 9, 12, 10, 0, 0);
const names = new Map([
  [ELENI, 'Ελένη'],
  [NIKOS, 'Nikós'],
]);

function line(messageId: string, minute: Untyped, text: string, overrides = {}) {
  return {
    v: 1,
    kind: 'seen',
    messageId,
    revision: 1,
    occurredAt: new Date(T0 + minute * 60_000).toISOString(),
    scope: { channel: 'c1' },
    by: ELENI,
    text,
    participants: [ELENI],
    ...overrides,
  };
}

function quietLog() {
  const warns: Array<Untyped> = [];
  const infos: Array<Untyped> = [];
  return {
    warns,
    infos,
    info(name: string, fields: Untyped) {
      infos.push({ name, fields });
    },
    warn(name: string, fields: Untyped) {
      warns.push({ name, fields });
    },
    error() {},
  };
}

/** The test databases opened here; closed when the file is done. */
const OPENED: Array<Untyped> = [];
after(async () => {
  for (const mem of OPENED) await mem.close();
});

/** A temp data/ with its database, the real record, a fake index and embed call, and the queue over them. */
// PR 7d: the index switches are code and the queue's measures constants of src/memory/embedder.ts (a batch of 64, a
// flush after 180 s, a queue of 2000, a catch-up every 60 minutes), so the config holds only the dimensions.
function scene({
  embedImpl = null,
  paused = null,
}: {
  embedImpl?: ((texts: Untyped, opts?: Untyped) => Untyped) | null;
  paused?: (() => boolean) | null;
} = {}) {
  const mem = openTestMemorySync();
  OPENED.push(mem);
  const { dataDir, memoryDb } = mem;
  const record = createRecord({ dataDir, log: quietLog(), memoryDb });
  const config = {
    embed: { dimensions: 4 },
    models: { base: { embedding: 'test/embed-model' } },
    llm: { maxRequestTokens: 50000 },
  };
  const hot = { config };
  const appended: Array<Untyped> = [];
  /** Rows already in the index before the scene (`chunkKey`s by layer and month). */
  const preIndexed: Array<Untyped> = [];
  const vectors = fakeOf<Parameters<typeof createEmbedder>[0]['vectors']>({
    async append(guildId: string, rows: Untyped, opts: Untyped) {
      appended.push({ guildId, rows, opts });
      return { written: rows.length };
    },
    async has(guildId: string, month: Untyped, { privateUserId = null } = {}) {
      const keys = new Set();
      for (const item of [
        ...preIndexed,
        ...appended.flatMap((a) =>
          a.rows.map((row: Untyped) => ({ meta: row.meta, privateUserId: a.opts.privateUserId ?? null }))
        ),
      ]) {
        if ((item.privateUserId ?? null) === privateUserId && item.meta.occurredAt.slice(0, 7) === month)
          keys.add(`${item.meta.kind}:${item.meta.id}:${item.meta.revision}`);
      }
      return keys;
    },
    async stats(guildId: string, { privateUserId = null } = {}) {
      const rows = appended
        .filter((a) => (a.opts.privateUserId ?? null) === privateUserId)
        .reduce((n, a) => n + a.rows.length, 0);
      return { months: rows > 0 ? 1 : 0, rows, bytes: 0 };
    },
  });
  const calls: Array<Untyped> = [];
  const embed = async (texts: Untyped, opts: Untyped) => {
    calls.push({ texts, opts });
    if (embedImpl) return embedImpl(texts, opts);
    return texts.map((_: Untyped, i: Untyped) => Float32Array.from([1, i, 0, 0]));
  };
  const clock = { at: T0 };
  const log = quietLog();
  const embedder = createEmbedder({
    hot,
    vectors,
    embed,
    record,
    memoryDb,
    log,
    now: () => clock.at,
    nameOf: (guildId, id) => names.get(id) ?? null,
    selfName: () => 'Persona',
    ...(paused ? { paused } : {}),
  });
  /** Record the lines, then queue them, as src/index.ts's wrapper does. */
  async function write(lines: Untyped, opts = {}) {
    await record.append(GUILD, lines, opts);
    return embedder.enqueue(GUILD, lines, opts);
  }
  /** Record the lines only: the queue was down (a stop, a crash, the switches off). */
  const recordOnly = (lines: Untyped, opts = {}) => record.append(GUILD, lines, opts);
  return {
    dataDir,
    record,
    hot,
    appended,
    preIndexed,
    calls,
    clock,
    log,
    embedder,
    write,
    recordOnly,
    close: async () => {},
  };
}

const sentIds = (kit: Untyped) =>
  kit.appended.flatMap((a: Untyped) => a.rows.map((row: Untyped) => `${row.meta.id}:${row.meta.revision}`));

test('embedder: a full batch flushes at once: one request, chunks with their channel context, appended with the model', async () => {
  const kit = scene();
  await kit.write([line('m1', 0, 'who brought the café?', { by: NIKOS, participants: [NIKOS] })]);
  assert.equal(kit.calls.length, 0);
  await kit.write([line('m2', 1, 'not me', { kind: 'said', by: undefined, participants: [] })]);
  await kit.embedder.flush();
  assert.equal(kit.calls.length, 1);
  assert.deepEqual(kit.calls[0].texts, [
    'Nikós: who brought the café?',
    'Nikós: who brought the café?\nPersona: not me',
  ]);
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
  const kit = scene();
  await kit.write([line('m1', 0, 'a')]);
  assert.equal(kit.embedder.tick(), null);
  kit.clock.at += 179_000;
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
    embedImpl: (texts: Untyped) => {
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

/** `count` lines m1..m<count>, 0.6 s apart. */
const many = (count: number) => [...Array(count).keys()].map((i) => line(`m${i + 1}`, (i + 1) / 100, `line ${i + 1}`));

/**
 * Flushes until the queue is empty: one flush sends one batch.
 */
async function drain(kit: { embedder: { stats: () => { queued: number }; flush: () => Promise<unknown> } }) {
  while (kit.embedder.stats().queued > 0) await kit.embedder.flush();
}

// PR 7d: `embed.queueMax` is the constant 2000, so the queue is overfilled by two of 2002 lines.
test('embedder: the queue is bounded at embed.queueMax, the oldest dropped with a warn', async () => {
  const kit = scene();
  await kit.write(many(2002));
  assert.equal(kit.embedder.stats().queued, 2000);
  assert.ok(kit.log.warns.some((w) => w.name === 'embedder: queue full' && w.fields.dropped === 2));
  await drain(kit);
  assert.deepEqual(sentIds(kit).slice(0, 2), ['m3:1', 'm4:1']);
  await kit.close();
});

// PR 7d: the index is code, so the lines before the first use are recorded without the queue.
test('embedder: the ring is filled from the record on first use', async () => {
  const kit = scene();
  await kit.recordOnly([
    line('m1', 0, 'one'),
    line('m2', 1, 'two'),
    line('m3', 2, 'three', { scope: { channel: 'c2' } }),
  ]);
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
  assert.deepEqual(
    kit.appended.map((a) => a.opts.privateUserId),
    [null, ELENI]
  );
  await kit.close();
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
  let release: (vectors: Array<Float32Array>) => void = () => {};
  const hung = new Promise<Array<Float32Array>>((resolve) => {
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
  await kit.recordOnly([
    line('m1', 0, 'who brought the café?', { by: NIKOS, participants: [NIKOS] }),
    line('m2', 1, 'not me'),
    line('m3', 2, 'elsewhere', { scope: { channel: 'c2' } }),
  ]);
  await kit.recordOnly([line('p1', 3, 'a private word')], { privateUserId: ELENI });
  kit.clock.at = T0 + 3 * 3_600_000;
  const pass = await kit.embedder.catchUp(GUILD);
  assert.equal(loose(pass).queued, 4);
  assert.equal(loose(pass).missing, 4);
  await kit.embedder.flush();
  assert.deepEqual(kit.calls[0].texts, [
    'Nikós: who brought the café?',
    'Nikós: who brought the café?\nΕλένη: not me',
    'Ελένη: elsewhere',
    'Ελένη: a private word',
  ]);
  assert.deepEqual(
    kit.appended.map((a) => a.opts.privateUserId),
    [null, ELENI]
  );
  assert.ok(
    kit.log.infos.some((i) => i.name === 'embedder: coverage' && i.fields.missing === 4 && i.fields.queued === 4)
  );
  // A second pass finds nothing left.
  assert.equal(loose(await kit.embedder.catchUp(GUILD)).queued, 0);
  assert.equal(kit.embedder.stats().queued, 0);
  await kit.close();
});

test('embedder: catchUp skips what the index holds at that revision and embeds a newer revision', async () => {
  const kit = scene();
  await kit.recordOnly([line('m1', 0, 'kept'), line('m2', 1, 'first'), line('m3', 2, 'new')]);
  await kit.recordOnly([line('m2', 1, 'edited', { revision: 2 })]);
  kit.preIndexed.push(
    { meta: { kind: 'record', id: 'm1', revision: 1, occurredAt: line('m1', 0, '').occurredAt }, privateUserId: null },
    { meta: { kind: 'record', id: 'm2', revision: 1, occurredAt: line('m2', 1, '').occurredAt }, privateUserId: null }
  );
  kit.clock.at = T0 + 3_600_000;
  const pass = await kit.embedder.catchUp(GUILD);
  assert.deepEqual(
    {
      messages: loose(pass).messages,
      indexed: loose(pass).indexed,
      missing: loose(pass).missing,
      queued: loose(pass).queued,
    },
    { messages: 3, indexed: 1, missing: 2, queued: 2 }
  );
  await kit.embedder.flush();
  assert.deepEqual(sentIds(kit), ['m2:2', 'm3:1']);
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
  assert.deepEqual(await kit.embedder.coverage(GUILD, { hours: 72 }), {
    messages: 3,
    indexed: 3,
    missing: 0,
    oldestMissing: null,
  });
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
  assert.equal(loose(pass).queued, 1);
  await kit.close();
});

test('embedder: the periodic pass runs every embed.catchUpEveryMinutes and finds lines that bypassed the queue', async () => {
  const kit = scene();
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

// PR 7d: `embed.queueMax` is the constant 2000, so the pass is given 2003 lines.
test('embedder: a pass queues at most embed.queueMax; the rest follows once the queue has drained', async () => {
  const kit = scene();
  await kit.recordOnly(many(2003));
  kit.clock.at = T0 + 3_600_000;
  const pass = await kit.embedder.catchUp(GUILD);
  assert.deepEqual({ queued: loose(pass).queued, left: loose(pass).left }, { queued: 2000, left: 3 });
  assert.ok(!kit.log.warns.some((w) => w.name === 'embedder: queue full'), 'a pass never overfills the queue');
  await drain(kit);
  for (let i = 0; i < 4; i += 1) {
    kit.clock.at += 180_000;
    await kit.embedder.tick(GUILD);
    await drain(kit);
  }
  assert.deepEqual(
    sentIds(kit),
    many(2003).map((l) => `${l.messageId}:1`)
  );
  await kit.close();
});

// PR 7d: `embed.queueMax` is the constant 2000, so the queue loses the first of 2001 lines.
test('embedder: a line the queue had and lost is warned about as a coverage gap and queued again', async () => {
  const kit = scene();
  await kit.write(many(2001));
  assert.ok(kit.log.warns.some((w) => w.name === 'embedder: queue full'));
  await drain(kit);
  assert.deepEqual(
    sentIds(kit),
    many(2001)
      .slice(1)
      .map((l) => `${l.messageId}:1`)
  );
  kit.clock.at = T0 + 3_600_000;
  const pass = await kit.embedder.catchUp(GUILD);
  assert.equal(loose(pass).lost, 1);
  assert.ok(
    kit.log.warns.some((w) => w.name === 'embedder: coverage gap' && w.fields.lost === 1 && w.fields.missing === 1)
  );
  await kit.embedder.flush();
  assert.deepEqual(sentIds(kit), [
    ...many(2001)
      .slice(1)
      .map((l) => `${l.messageId}:1`),
    'm1:1',
  ]);
  await kit.close();
});

test("embedder: indexSummary gives the index rows and the last pass's missing count", async () => {
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
