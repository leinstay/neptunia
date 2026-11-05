// `search` (src/memory/db/recall.ts) off the main thread: the service's `searchRecord` runs it in the reader worker
// (src/memory/db/reader-worker.ts) on a read-only connection with the results and the audience of the synchronous call,
// the event loop stays free meanwhile, a deadline abandons a slow search, a dead reader is a concrete error the turn
// survives, and shutdown closes the reader before the writer. Slowness comes from a stand-in worker that blocks in front
// of the real reader, so no test depends on how fast this machine scans vectors. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { createRecall } from '../src/behavior/recall-run.ts';
import { dbSettings, search } from '../src/memory/db/recall.ts';
import { channelPlaceId, dmPlaceId, messageSourceId, personId } from '../src/memory/db/ids.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { dmScope, internalContext, groupContext, dmContext } from '../src/memory/db/scope.ts';
import { createMemoryDb } from '../src/memory/db/service.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { fixture } from './fixtures/memory-db-recall.ts';
import { fillEnvAudiences } from './fixtures/memory-db/audiences.ts';
import { insertRows } from '../src/memory/db/rows.ts';
import { labels } from './fixtures/labels.ts';
import { channel, rig } from './fixtures/reads-rig.ts';
import { config } from './fixtures/recall-run-kit.ts';

const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const MINUTE = 60_000;
const MAIN = channelPlaceId('discord', 'main');
const OTHER = channelPlaceId('discord', 'other');
const ALICE = 'u-alice';
const BOB = 'u-bob';
const ALICE_PERSON = personId('discord', ALICE);
const BOB_PERSON = personId('discord', BOB);
const VECTOR = [1, 0, 0, 0];
const REAL_READER = pathToFileURL(path.resolve('src/memory/db/reader-worker.ts')).href;
const SLOW_MS = 1000;
const STALE_MS = 60_000;

const tmpRoot = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-off-main-'));

/** A file database with group lines in two channels, one DM line each for two people, an account and vectors. */
function writeFixtureDb(file: string): void {
  const env = fixture();
  try {
    insertRows(env.db, {
      places: [
        { id: MAIN, iface: 'discord', kind: 'channel', native_id: 'main', scope_kind: 'group', name: 'main' },
        { id: OTHER, iface: 'discord', kind: 'channel', native_id: 'other', scope_kind: 'group', name: 'other' },
        {
          id: dmPlaceId('discord', ALICE),
          iface: 'discord',
          kind: 'dm',
          native_id: null,
          scope_kind: 'dm',
          partner_person: ALICE_PERSON,
        },
        {
          id: dmPlaceId('discord', BOB),
          iface: 'discord',
          kind: 'dm',
          native_id: null,
          scope_kind: 'dm',
          partner_person: BOB_PERSON,
        },
      ],
    });
    env.account(ALICE, ['Alice']);
    env.account(BOB, ['Bob']);
    env.say({ native: 'main-1', at: NOW - 5 * MINUTE, text: 'the rabbit left the garden' });
    env.say({ native: 'main-2', at: NOW - 4 * MINUTE, text: 'a rabbit came back at dusk', author: BOB });
    env.say({ native: 'main-3', at: NOW - 3 * MINUTE, text: 'nothing about animals in this line' });
    env.say({ native: 'other-1', at: NOW - 2 * MINUTE, text: 'the rabbit in the other channel', place: OTHER });
    env.say({
      native: 'dm-alice',
      at: NOW - MINUTE,
      text: 'the secret rabbit of alice',
      place: dmPlaceId('discord', ALICE),
      scope: dmScope(ALICE_PERSON, 'discord'),
    });
    env.say({
      native: 'dm-bob',
      at: NOW - MINUTE,
      text: 'the secret rabbit of bob',
      author: BOB,
      place: dmPlaceId('discord', BOB),
      scope: dmScope(BOB_PERSON, 'discord'),
    });
    env.vector('main-3', VECTOR);
    env.vector('main-1', [0.9, 0.1, 0, 0]);
    env.vector('dm-alice', VECTOR, { scope: dmScope(ALICE_PERSON, 'discord') });
    env.stem();
    fillEnvAudiences(env);
    env.db.prepare('VACUUM INTO ?').run(file);
  } finally {
    env.done();
  }
}

/** A stand-in reader that reads `<root>/mode` at each message but `open` and `close`, then lets the real reader answer. */
function standInReader(root: string): URL {
  const file = pathToFileURL(path.join(root, 'stand-in-reader.mjs'));
  fs.writeFileSync(
    file,
    `
import { parentPort } from 'node:worker_threads';
import fs from 'node:fs';
const root = ${JSON.stringify(root)};
const block = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const once = (name) => {
  if (fs.existsSync(root + '/' + name)) return false;
  fs.writeFileSync(root + '/' + name, '1');
  return true;
};
parentPort.on('message', (message) => {
  if (message.type === 'open' || message.type === 'close') return;
  let mode = '';
  try { mode = fs.readFileSync(root + '/mode', 'utf8'); } catch { /* none */ }
  if (mode === 'slow') block(${SLOW_MS});
  if (mode === 'hang') block(${STALE_MS});
  if (mode === 'hang-once' && once('hung')) block(${STALE_MS});
  if (mode === 'crash-once' && once('crashed')) process.exit(3);
});
await import(${JSON.stringify(REAL_READER)});
`
  );
  return file;
}

// Two words, so the lane searches them as a phrase: without a vector a prefetch keeps a line only for a phrase or two terms.
const LANES = [{ kind: 'message', text: 'the rabbit', words: 'the rabbit' }];
const RUN_ARGS = {
  placeId: 'g1',
  channel: channel('main'),
  partnerId: null,
  selfId: 'self',
  selfName: 'Persona',
  history: [],
  candidate: { content: 'rabbit' },
};

/** The fixture database, a service over it and a config both read. `standIn` puts the blocking worker before the reader. */
async function setup({
  standIn = false,
  memoryDb = {},
  recall = {},
  options = {},
}: {
  standIn?: boolean;
  memoryDb?: Record<string, unknown>;
  recall?: Record<string, unknown>;
  options?: Record<string, unknown>;
} = {}) {
  const root = tmpRoot();
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  const file = path.join(data, 'memory.db');
  writeFixtureDb(file);
  const hot = {
    config: config({
      features: { recall: true, meaningSearch: false },
      // A short close bound: a stand-in may still hold the reader when the test closes the service.
      memoryDb: { session: { mode: 'off' }, closeTimeoutMs: 500, ...memoryDb },
      recall: {
        prefetch: {
          deadlineMs: 100,
          maxTokens: 1500,
          contextTokens: 500,
          minFormsMatched: 1,
          singleTermScore: 0,
          maxTermShare: 1,
          trivial: [],
        },
        ...recall,
      },
    }),
    prompts: { labels, 'recall-summary': 'Synthetic summary prompt' },
  };
  const service = createMemoryDb({
    hot,
    dataDir: data,
    now: () => NOW,
    ...(standIn ? { readerFile: standInReader(root) } : {}),
    ...options,
  });
  await service.open();
  return {
    root,
    file,
    hot,
    service,
    mode: (value: string) => fs.writeFileSync(path.join(root, 'mode'), value),
    done: async () => {
      await service.close().catch(() => {});
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const rabbit = (extra: Record<string, unknown> = {}) => ({
  ctx: groupContext('discord'),
  plan: { forms: ['rabbit'], who: [], from: null, to: null },
  limit: 8,
  now: NOW,
  settings: dbSettings({}),
  ...extra,
});
const messageIds = (found: { hits: Array<{ messageId: unknown }> }) => found.hits.map((hit) => hit.messageId);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The code a promise rejects with. A promise that answers fails the test. */
async function codeOfRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: unknown } | null)?.code;
  }
  return assert.fail('the search answered; a rejection with a code was expected');
}

// The runner answers more than its types name (the status and stats the tests read), and these fakes carry only what a
// search calls, so it is read through the shape the tests use.
type RecallInput = Parameters<typeof createRecall>[0];
const recallOver = (hot: object, memoryDb: object) =>
  createRecall({
    reads: rig().reads,
    hot,
    store: {},
    now: () => NOW,
    llm: { capLeft: () => 100, complete: () => Promise.reject(new Error('unexpected model call')) },
    memoryDb,
  } as RecallInput) as unknown as {
    run(args: Record<string, unknown>): Promise<{ outcome: { kind: string }; quotes: Array<{ lines: string }> }>;
    prefetch(args: Record<string, unknown>): Promise<{
      status: string;
      partial?: boolean;
      excerpts: Array<{ lines: string }>;
      stats?: { failed: number };
    } | null>;
  };

// ---------- the same results ----------

const SAME_RESULT_CASES: Array<[string, Record<string, unknown>]> = [
  ['a group reader', {}],
  ['a DM reader of the person', { ctx: dmContext(ALICE_PERSON, 'discord') }],
  ['a DM reader of another person', { ctx: dmContext(BOB_PERSON, 'discord') }],
  ['an internal reader', { ctx: internalContext() }],
  ['the place rule of the caller', { allowPlace: (place: string) => place !== OTHER }],
  [
    'the names of the caller',
    {
      nameOf: (id: string) => (id === ALICE ? 'Alicia' : null),
      channelNameOf: (id: string) => (id === 'main' ? 'general' : null),
      selfName: 'Persona',
    },
  ],
  ['a query vector as a typed array', { vector: Float32Array.from(VECTOR), model: 'test/embedder' }],
  ['a query vector as a plain array', { vector: VECTOR, model: 'test/embedder' }],
  ['a query vector of another model', { vector: VECTOR, model: 'other/embedder' }],
  ['a person in the plan', { plan: { forms: [], who: ['Alice'], from: null, to: null } }],
  ['a closed range', { plan: { forms: ['rabbit'], who: [], from: NOW - 5 * MINUTE, to: NOW - 3 * MINUTE } }],
  ['one channel', { plan: { forms: ['rabbit'], who: [], from: null, to: null, placeId: 'other' } }],
  ['excluded ids as a set', { exclude: new Set([messageSourceId('discord', 'main-1', 1, 'seen')]) }],
  [
    'exclusions by source',
    { exclusions: [{ kind: 'source', sourceId: messageSourceId('discord', 'main-1', 1, 'seen') }] },
  ],
  ['a limit of one', { limit: 1 }],
  ['forms nothing holds', { plan: { forms: ['zzzqqq'], who: [], from: null, to: null } }],
];

for (const [name, extra] of SAME_RESULT_CASES) {
  test(`the reader answers ${name} exactly as the synchronous search does`, async () => {
    const env = await setup();
    try {
      const args = rabbit(extra);
      const expected = search(env.service.database(), args);
      assert.deepEqual(await env.service.searchRecord(args), expected);
    } finally {
      await env.done();
    }
  });
}

test('the audience holds in the reader: a DM line reaches its person and no other reader', async () => {
  const env = await setup();
  try {
    const find = (ctx: unknown) => env.service.searchRecord(rabbit({ ctx }));
    assert.ok(messageIds(await find(dmContext(ALICE_PERSON, 'discord'))).includes('dm-alice'));
    const bob = messageIds(await find(dmContext(BOB_PERSON, 'discord')));
    assert.ok(bob.includes('dm-bob'));
    assert.ok(!bob.includes('dm-alice'));
    const group = messageIds(await find(groupContext('discord')));
    assert.ok(group.includes('main-1'));
    assert.ok(!group.includes('dm-alice') && !group.includes('dm-bob'));
  } finally {
    await env.done();
  }
});

test('a query vector in the reader finds a line by meaning alone, and only in its audience', async () => {
  const env = await setup();
  try {
    const meaning = (ctx: unknown) =>
      env.service.searchRecord(
        rabbit({
          ctx,
          plan: { forms: [], who: [], from: null, to: null },
          vector: Float32Array.from(VECTOR),
          model: 'test/embedder',
        })
      );
    const group = await meaning(groupContext('discord'));
    assert.ok(messageIds(group).includes('main-3'));
    assert.ok(!messageIds(group).includes('dm-alice'));
    assert.ok(group.stats.meaning > 0);
    assert.ok(messageIds(await meaning(dmContext(ALICE_PERSON, 'discord'))).includes('dm-alice'));
  } finally {
    await env.done();
  }
});

test('the place rule holds in the reader: a refused channel returns no line', async () => {
  const env = await setup();
  try {
    const found = await env.service.searchRecord(rabbit({ allowPlace: (place: string) => place !== OTHER }));
    assert.ok(messageIds(found).includes('main-1'));
    assert.ok(!messageIds(found).includes('other-1'));
  } finally {
    await env.done();
  }
});

test('the names of the caller reach the messages of the answer', async () => {
  const env = await setup();
  try {
    const found = await env.service.searchRecord(
      rabbit({
        nameOf: (id: string) => (id === ALICE ? 'Alicia' : null),
        channelNameOf: (id: string) => (id === 'main' ? 'general' : null),
      })
    );
    const window = found.windows.find((one) => one.placeId === 'main');
    assert.equal(window?.channelName, 'general');
    assert.ok(window?.messages.some((message) => message.authorName === 'Alicia'));
  } finally {
    await env.done();
  }
});

test('a search without a valid context is refused in the reader', async () => {
  const env = await setup();
  try {
    await assert.rejects(env.service.searchRecord(rabbit({ ctx: { kind: 'group' } })));
    await assert.rejects(env.service.searchRecord(rabbit({ ctx: undefined })));
  } finally {
    await env.done();
  }
});

test('a line the writer committed after the reader opened is found by the next search', async () => {
  const env = await setup();
  try {
    await env.service.tick();
    await env.service.searchRecord(rabbit());
    const observed = await env.service.observe(
      {
        v: 1,
        iface: 'discord',
        authority: 'discord/global',
        native: { kind: 'message', key: '600000000000000001', subtype: 'seen', revision: 1 },
        place: { authority: 'discord/global', key: 'channel:main', kind: 'channel', conversation: 'group' },
        author: { kind: 'account', key: 'u-carol', account_kind: 'user' },
        occurredAt: new Date(NOW - 30_000).toISOString(),
        observedAt: new Date(NOW - 30_000).toISOString(),
        text: 'a fresh pangolin line',
        mentions: [],
        direct: false,
        relations: [],
      },
      { placeId: 'g1' }
    );
    assert.equal((observed as { ok: boolean }).ok, true);
    const plan = { forms: ['pangolin'], who: [], from: null, to: null };
    assert.ok(messageIds(await env.service.searchRecord(rabbit({ plan }))).includes('600000000000000001'));
  } finally {
    await env.done();
  }
});

test('a service without a worker answers the same search on its own connection', async () => {
  const env = await setup({ options: { worker: false } });
  try {
    const args = rabbit();
    const found = await env.service.searchRecord(args);
    assert.ok(found.hits.length > 0);
    assert.deepEqual(found, search(env.service.database(), args));
  } finally {
    await env.done();
  }
});

// ---------- the event loop and the deadline ----------

test('a timer fires on time while a slow search runs in the reader', async () => {
  const env = await setup({ standIn: true });
  try {
    env.mode('slow');
    let ticks = 0;
    let answered = false;
    let ticksBeforeAnswer = 0;
    const ticker = setInterval(() => {
      ticks += 1;
      if (!answered) ticksBeforeAnswer = ticks;
    }, 25);
    const started = performance.now();
    try {
      const found = await env.service.searchRecord(rabbit());
      answered = true;
      assert.ok(found.hits.length > 0);
    } finally {
      clearInterval(ticker);
    }
    // The answer took the stand-in's block, so the search did pass through the worker.
    assert.ok(performance.now() - started >= SLOW_MS - 50);
    // 1000 ms at one tick per 25 ms is 40 ticks on a free loop; a blocked loop fires at most one.
    assert.ok(ticksBeforeAnswer >= 10, `ticks during the search: ${ticksBeforeAnswer}`);
  } finally {
    await env.done();
  }
});

test('an aborted signal abandons a stuck search at once with SEARCH_ABANDONED', async () => {
  const env = await setup({ standIn: true });
  try {
    env.mode('hang');
    const controller = new AbortController();
    const started = performance.now();
    const pending = env.service.searchRecord(rabbit(), { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    assert.equal(await codeOfRejection(pending), 'SEARCH_ABANDONED');
    assert.ok(performance.now() - started < 2000);
  } finally {
    await env.done();
  }
});

test('a signal already aborted answers SEARCH_ABANDONED', async () => {
  const env = await setup();
  try {
    const controller = new AbortController();
    controller.abort();
    const code = await codeOfRejection(env.service.searchRecord(rabbit(), { signal: controller.signal }));
    assert.equal(code, 'SEARCH_ABANDONED');
  } finally {
    await env.done();
  }
});

test('the next search answers after a stuck one was abandoned', async () => {
  const env = await setup({ standIn: true });
  try {
    env.mode('hang-once');
    const controller = new AbortController();
    const stuck = env.service.searchRecord(rabbit(), { signal: controller.signal });
    await wait(50);
    controller.abort();
    assert.equal(await codeOfRejection(stuck), 'SEARCH_ABANDONED');
    const started = performance.now();
    const found = await env.service.searchRecord(rabbit());
    assert.ok(found.hits.length > 0);
    assert.ok(performance.now() - started < STALE_MS / 2);
  } finally {
    await env.done();
  }
});

test('abandoning one search still answers the search of another turn queued behind it', async () => {
  const env = await setup({ standIn: true });
  try {
    env.mode('hang-once');
    const controller = new AbortController();
    const stuck = env.service.searchRecord(rabbit(), { signal: controller.signal });
    await wait(50);
    const behind = env.service.searchRecord(rabbit());
    await wait(50);
    controller.abort();
    assert.equal(await codeOfRejection(stuck), 'SEARCH_ABANDONED');
    assert.ok((await behind).hits.length > 0);
  } finally {
    await env.done();
  }
});

test('a prefetch over a stuck reader answers timeout on its deadline while the loop runs', async () => {
  const env = await setup({ standIn: true });
  try {
    env.mode('hang');
    let ticks = 0;
    const ticker = setInterval(() => {
      ticks += 1;
    }, 10);
    const started = performance.now();
    try {
      const out = await recallOver(env.hot, env.service).prefetch({ ...RUN_ARGS, lanes: LANES });
      assert.equal(out?.status, 'timeout');
      assert.equal(out?.partial, true);
    } finally {
      clearInterval(ticker);
    }
    // deadlineMs is 100; the stand-in holds the reader for 60 s.
    assert.ok(performance.now() - started < 5000);
    assert.ok(ticks >= 3, `ticks during the prefetch: ${ticks}`);
  } finally {
    await env.done();
  }
});

test('the prefetch after a timed out one finds its excerpts', async () => {
  const env = await setup({ standIn: true });
  try {
    env.mode('hang-once');
    const recall = recallOver(env.hot, env.service);
    assert.equal((await recall.prefetch({ ...RUN_ARGS, lanes: LANES }))?.status, 'timeout');
    // The second one gets a long deadline: the reader may have to start again.
    (env.hot.config.recall as { prefetch: { deadlineMs: number } }).prefetch.deadlineMs = 20_000;
    const again = await recall.prefetch({ ...RUN_ARGS, lanes: LANES });
    assert.equal(again?.status, 'ok');
    assert.ok(again?.excerpts.some((excerpt) => excerpt.lines.includes('rabbit')));
  } finally {
    await env.done();
  }
});

test('the prefetch aborts the signal of a search still out at its deadline', async () => {
  const env = await setup();
  try {
    const signals: Array<AbortSignal> = [];
    const recall = recallOver(env.hot, {
      database: () => env.service.database(),
      searchRecord: (_args: unknown, options: { signal: AbortSignal }) => {
        signals.push(options.signal);
        return new Promise(() => {});
      },
    });
    const out = await recall.prefetch({ ...RUN_ARGS, lanes: LANES });
    assert.equal(out?.status, 'timeout');
    assert.equal(signals.length, 1);
    assert.equal(signals[0].aborted, true);
  } finally {
    await env.done();
  }
});

test('the persona search over a stuck reader answers timeout at recall.timeoutMs', async () => {
  const env = await setup({ recall: { timeoutMs: 100 } });
  // The recall timers are unref'd in production; this keeps the test process alive until they fire.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const signals: Array<AbortSignal> = [];
    const recall = recallOver(env.hot, {
      database: () => env.service.database(),
      searchRecord: (_args: unknown, options: { signal: AbortSignal }) => {
        signals.push(options.signal);
        return new Promise(() => {});
      },
    });
    const found = await recall.run({
      ...RUN_ARGS,
      server: { forms: ['rabbit'], who: [], from: null, to: null },
      quotes: true,
    });
    assert.equal(found.outcome.kind, 'timeout');
    assert.equal(signals[0].aborted, true);
  } finally {
    clearInterval(keepAlive);
    await env.done();
  }
});

// ---------- a dead reader ----------

test('a reader that dies rejects its search with WORKER_EXIT and the next search answers', async () => {
  const env = await setup({ standIn: true });
  try {
    env.mode('crash-once');
    assert.equal(await codeOfRejection(env.service.searchRecord(rabbit())), 'WORKER_EXIT');
    assert.ok((await env.service.searchRecord(rabbit())).hits.length > 0);
  } finally {
    await env.done();
  }
});

test('a reader that dies leaves the writer writing', async () => {
  const env = await setup({ standIn: true });
  try {
    env.mode('crash-once');
    await codeOfRejection(env.service.searchRecord(rabbit()));
    await env.service.writeUnit({
      op: 'value',
      owner: 'guilds/g1/users/u-new.json',
      value: { id: 'u-new', names: ['New'] },
    });
    const row = env.service
      .database()
      ?.prepare('SELECT COUNT(*) AS n FROM files WHERE path = ?')
      .get('guilds/g1/users/u-new.json');
    assert.equal(row?.n, 1);
  } finally {
    await env.done();
  }
});

test('a prefetch goes on when its search fails, and the log names the code', async () => {
  const env = await setup();
  try {
    const recall = recallOver(env.hot, {
      database: () => env.service.database(),
      searchRecord: () => Promise.reject(Object.assign(new Error('memory db worker stopped'), { code: 'WORKER_EXIT' })),
    });
    const { result, logs } = await withCapturedLogs(() => recall.prefetch({ ...RUN_ARGS, lanes: LANES }));
    assert.deepEqual(result?.excerpts, []);
    assert.ok((result?.stats?.failed ?? 0) >= 1);
    const failed = logs.find((entry) => entry.msg === 'recall: prefetch failed' && entry.stage === 'db');
    assert.equal(failed?.code, 'WORKER_EXIT');
  } finally {
    await env.done();
  }
});

test('the persona search answers an error outcome when its search fails, and the log names the code', async () => {
  const env = await setup();
  try {
    const recall = recallOver(env.hot, {
      database: () => env.service.database(),
      searchRecord: () => Promise.reject(Object.assign(new Error('memory db worker stopped'), { code: 'WORKER_EXIT' })),
    });
    const { result, logs } = await withCapturedLogs(() =>
      recall.run({ ...RUN_ARGS, server: { forms: ['rabbit'], who: [], from: null, to: null }, quotes: true })
    );
    assert.equal(result.outcome.kind, 'error');
    const failed = logs.find((entry) => entry.msg === 'recall: failed');
    assert.equal(failed?.code, 'WORKER_EXIT');
  } finally {
    await env.done();
  }
});

// ---------- one writer and the close order ----------

/** A reader worker driven by hand: `ask` posts one message and answers with the reply. */
function readerByHand() {
  const worker = new Worker(new URL(REAL_READER));
  let seq = 0;
  const ask = (type: string, payload: Record<string, unknown> = {}) =>
    new Promise<{ ok: boolean; code?: unknown }>((resolve, reject) => {
      seq += 1;
      const id = seq;
      const onMessage = (message: { id?: number; ok: boolean; code?: unknown }) => {
        if (message.id !== id) return;
        worker.off('message', onMessage);
        resolve(message);
      };
      worker.on('message', onMessage);
      worker.once('error', reject);
      worker.postMessage({ ...payload, id, type });
    });
  return { ask, stop: () => worker.terminate() };
}

test('the reader opens while another connection holds the writer lock and refuses every write message', async () => {
  const root = tmpRoot();
  const file = path.join(root, 'memory.db');
  writeFixtureDb(file);
  const writer = openMemoryDb(file);
  const reader = readerByHand();
  try {
    const count = () => dbOf(writer).prepare('SELECT COUNT(*) AS n FROM files').get()?.n;
    const before = count();
    assert.equal((await reader.ask('open', { path: file })).ok, true);
    const update = { kind: 'unit', op: 'value', owner: 'guilds/g1/users/x.json', value: { id: 'x', names: ['X'] } };
    for (const type of [
      'memoryWrite',
      'observe',
      'observeMessage',
      'deleteMessage',
      'diaryApply',
      'focus',
      'turnReads',
    ]) {
      assert.equal((await reader.ask(type, { update })).ok, false, type);
    }
    assert.equal(count(), before);
    assert.equal((await reader.ask('close')).ok, true);
  } finally {
    await reader.stop();
    writer.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a clean close leaves no WAL behind: the reader is gone before the writer closes', async () => {
  const env = await setup();
  try {
    assert.ok((await env.service.searchRecord(rabbit())).hits.length > 0);
    await env.service.close();
    assert.equal(fs.existsSync(`${env.file}-wal`), false);
    assert.equal(fs.existsSync(`${env.file}.lock`), false);
  } finally {
    await env.done();
  }
});

test('a close during a stuck search rejects it with DB_CLOSED, ends within its bound and frees the database', async () => {
  const env = await setup({ standIn: true, memoryDb: { closeTimeoutMs: 200 } });
  try {
    env.mode('hang');
    const pending = env.service.searchRecord(rabbit());
    const code = codeOfRejection(pending);
    await wait(50);
    const started = performance.now();
    await env.service.close();
    assert.ok(performance.now() - started < 5000);
    assert.equal(await code, 'DB_CLOSED');
    const writer = openMemoryDb(env.file);
    writer.close();
  } finally {
    await env.done();
  }
});

test('a search after the close is refused with DB_CLOSED', async () => {
  const env = await setup();
  try {
    await env.service.close();
    assert.equal(await codeOfRejection(env.service.searchRecord(rabbit())), 'DB_CLOSED');
  } finally {
    await env.done();
  }
});
