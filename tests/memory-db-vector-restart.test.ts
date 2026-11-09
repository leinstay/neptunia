// What a restart of the core finds in the meaning index. The catch-up asks the index which records it holds and embeds
// the rest, so a month the index cannot answer for is embedded again at every restart, and that spends money. Synthetic
// data only; the embedding call is a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMemory } from './fixtures/memory-db/service.ts';
import type { TestMemory } from './fixtures/memory-db/service.ts';
import { sendDeliveries } from '../src/behavior/inner/deliveries.ts';
import { personaRecord } from '../src/behavior/inner/persona-sources.ts';
import type { InnerContext } from '../src/behavior/inner/types.ts';
import { createEmbedder } from '../src/memory/embedder.ts';
import { OBSERVATION_VERSION } from '../src/memory/db/observe.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { applyWakeQueueWrite } from '../src/memory/db/wake-queue.ts';
import { createRecord } from '../src/memory/record.ts';
import { createAddressing } from '../src/memory/store-addresses.ts';
import { createVectors } from '../src/memory/vectors.ts';
import { chainsOf } from './fixtures/chains.ts';

const MONTH = '2026-11';
const AT = Date.parse('2026-11-03T10:00:00.000Z');
const NOW = AT + 3_600_000;
const CLI_DM = 'cli:dm:owner';
const DISCORD_DM = 'discord:dm:owner';

type Warned = { message: string; fields?: Record<string, unknown> };

function logged() {
  const warnings: Array<Warned> = [];
  return {
    warnings,
    log: {
      info() {},
      debug() {},
      error() {},
      warn: (message: string, fields?: Record<string, unknown>) => warnings.push({ message, fields }),
    },
  };
}

/** An observed DM on `iface` with the native partner `owner`. */
const observedDm = (iface: string) => ({
  v: OBSERVATION_VERSION,
  iface,
  authority: `${iface}/global`,
  native: { kind: 'message', key: `${iface}-first`, revision: 1 },
  place: { authority: `${iface}/global`, key: 'dm:owner', kind: 'dm', chat: 'dm' },
  author: { kind: 'account', key: 'owner' },
  occurredAt: '2026-11-03T09:00:00.000Z',
  observedAt: '2026-11-03T09:00:01.000Z',
  text: 'a synthetic opening line',
  mentions: [],
  direct: true,
  relations: [],
});

const recordLine = (id: string, minute: number) => ({
  v: 1,
  kind: 'seen',
  messageId: id,
  revision: 1,
  occurredAt: new Date(AT + minute * 60_000).toISOString(),
  scope: {},
  by: 'owner',
  text: `a synthetic line ${id}`,
  participants: ['owner'],
});

/** A row the embedder would append for the record `id`. */
const vectorRow = (id: string, minute: number) => ({
  meta: {
    kind: 'record',
    id,
    revision: 1,
    occurredAt: new Date(AT + minute * 60_000).toISOString(),
    placeId: null,
    by: 'owner',
    participants: ['owner'],
    sourceIds: [id],
  },
  vector: Float32Array.from([0.5, 0.5, minute + 1, 0.25]),
});

const CONFIG = { embed: { dimensions: 4 }, models: { routes: chainsOf({ embedding: 'test/embedder' }) }, llm: {} };

/** One life of the core over `env`: its own index and embedding queue. What `embed` was asked goes in `sent`. */
function coreLife(env: TestMemory, log: ReturnType<typeof logged>['log']) {
  const { dataDir, memoryDb } = env;
  const record = createRecord({ dataDir, log, memoryDb });
  const vectors = createVectors({ dataDir, log, memoryDb });
  const sent: Array<string> = [];
  const embedder = createEmbedder({
    hot: { config: CONFIG },
    vectors,
    record,
    log,
    memoryDb,
    now: () => NOW,
    embed: (texts: Array<string>) => {
      sent.push(...texts);
      return Promise.resolve(texts.map(() => Float32Array.from([0.5, 0.25, 0.25, 0.5])));
    },
  });
  return { record, vectors, embedder, sent };
}

const readDb = (env: TestMemory) => dbOf(env.memoryDb.readHandle()!);

/** The live rows of the month of a place's index, in the order they were written (src/memory/db/line-vectors.ts). */
const stored = (env: TestMemory, placeId: string) => ({
  rows: readDb(env)
    .prepare(
      'SELECT item_id, audience_id FROM vectors WHERE place_id = ? AND substr(occurred_at, 1, 7) = ? AND retired_at IS NULL ORDER BY rowid'
    )
    .all(placeId, MONTH)
    .map((row) => ({ ...row })),
});

test('a clean month of a cli DM is seen whole by the next life of the core', async () => {
  // Bug: the same records appended under a suffixed key at every restart of a non-default interface.
  const { log } = logged();
  const env = await openTestMemory({ log });
  try {
    await env.memoryDb.observe(observedDm('cli'), null);
    const first = coreLife(env, log);
    await first.record.append(CLI_DM, [recordLine('m1', 0)]);
    await first.embedder.catchUp(CLI_DM);
    await first.embedder.flush();
    const restarted = coreLife(env, log);
    await restarted.embedder.catchUp(CLI_DM);
    await restarted.embedder.flush();
    assert.deepEqual(restarted.sent, []);
    assert.equal(stored(env, CLI_DM).rows.length, first.sent.length);
  } finally {
    await env.close();
  }
});

test('a record another DM unit already holds under the same key lands in its own month', async () => {
  // Bug: a chunk key names only the partner's native id, so two DM places of one native id spell the same key. The second
  // writer's row went to `co_owners` and never landed, and the month read short for good.
  const { log, warnings } = logged();
  const env = await openTestMemory({ log });
  try {
    await env.memoryDb.observe(observedDm('cli'), null);
    await env.memoryDb.observe(observedDm('discord'), null);
    const { vectors } = coreLife(env, log);
    await vectors.append(DISCORD_DM, [vectorRow('shared', 0)], { model: 'test/embedder' });

    await vectors.append(CLI_DM, [vectorRow('own', 1), vectorRow('shared', 0)], { model: 'test/embedder' });
    await vectors.append(CLI_DM, [vectorRow('later', 2)], { model: 'test/embedder' });

    const { rows } = stored(env, CLI_DM);
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((row) => [row.item_id, row.audience_id]),
      [
        ['own', 'aud:dm:cli:dm:owner'],
        ['shared', 'aud:dm:cli:dm:owner'],
        ['later', 'aud:dm:cli:dm:owner'],
      ]
    );
    assert.deepEqual(
      stored(env, DISCORD_DM).rows.map((row) => [row.item_id, row.audience_id]),
      [['shared', 'aud:dm:discord:dm:owner']]
    );
    assert.deepEqual([...(await vectors.has(CLI_DM, MONTH))].sort(), [
      'record:later:1',
      'record:own:1',
      'record:shared:1',
    ]);
    const found = await vectors.search(CLI_DM, [1, 1, 1, 1], { k: 10 });
    assert.equal(found.length, 3);
    assert.deepEqual(
      warnings.filter((one) => /unreadable|checksum/.test(one.message)),
      []
    );
  } finally {
    await env.close();
  }
});

test("a wake's post into a cli DM is recorded under that DM, not the home interface's", async () => {
  // Bug: a wake runs outside any event, so a DM named by its partner alone took the home interface: the line of a cli DM
  // went to `discord:dm:<partner>`, with its vector, where a Discord reader of the same native id finds it.
  const handle = openMemoryDb(':memory:');
  try {
    const appended: Array<string> = [];
    const record = {
      iterate() {
        throw new Error('not read');
      },
      append(placeId: string) {
        appended.push(placeId);
      },
    };
    const memoryDb = { readHandle: () => null, namespace: () => 'discord' };
    const seam = { db: () => dbOf(handle), run: <T>(work: () => T): T => work() };
    const store = createAddressing({ memoryDb, seam }).methods();
    const db = dbOf(handle);
    db.prepare(
      "INSERT INTO wakes (id, kind, queued_at, payload, state) VALUES ('w1', 'heartbeat', 0, '{}', 'running')"
    ).run();
    const payload = {
      chat: { iface: 'cli', chatId: CLI_DM },
      content: { text: 'a synthetic post' },
      said: { text: 'a synthetic post', replyId: null, repliedAuthorId: null, accountIds: [] },
    };
    db.prepare(
      "INSERT INTO deliveries (key, wake_id, target, payload, state, queued_at) VALUES ('d1', 'w1', ?, ?, 'queued', ?)"
    ).run(CLI_DM, JSON.stringify(payload), NOW);
    const life = {
      log: { info() {}, warn() {}, error() {}, debug() {} },
      now: () => NOW,
      dataDir: '/nowhere',
      writes: Promise.resolve(),
      wakes: {
        backend: {
          read: () => handle,
          write: (update: Parameters<typeof applyWakeQueueWrite>[1]) =>
            Promise.resolve(applyWakeQueueWrite(handle, update)),
        },
        loaded: true,
      },
      states: new Map([['persona', { stopped: false }]]),
      port: {
        send: () => Promise.resolve({ status: 'ok', ref: { messageId: 'sent-1' }, parts: [], at: NOW }),
      },
      reads: {
        chatInfo: () => Promise.resolve({ chat: { rootId: null, partnerId: 'owner' } }),
      },
      record: personaRecord(record, store, () => []),
    };

    await sendDeliveries(life as unknown as InnerContext, ['d1']);

    assert.deepEqual(appended, [CLI_DM]);
  } finally {
    handle.close();
  }
});
