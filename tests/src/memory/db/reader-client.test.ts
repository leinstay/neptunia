// Tests for src/memory/db/reader-client.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { dbSettings } from '../../../../src/memory/db/recall.ts';
import { channelPlaceId, dmPlaceId } from '../../../../src/memory/db/ids.ts';
import { personId } from '../../../fixtures/memory-db/spelled-ids.ts';
import { openMemoryDb } from '../../../../src/memory/db/open.ts';
import { dmScope, groupContext } from '../../../../src/memory/db/scope.ts';
import { createMemoryDb } from '../../../../src/memory/db/service.ts';
import { fixture } from '../../../fixtures/memory-db-recall.ts';
import { fillEnvAudiences } from '../../../fixtures/memory-db/audiences.ts';
import { insertRows } from '../../../../src/memory/db/rows.ts';
import { labels } from '../../../fixtures/labels.ts';
import { config } from '../../../fixtures/recall-run-kit.ts';

// `search` (src/memory/db/recall.ts) off the main thread: the service's `searchRecord` runs it in the reader worker
// (src/memory/db/reader-worker.ts) on a read-only connection with the results and the audience of the synchronous call,
// the event loop stays free meanwhile, a deadline abandons a slow search, a dead reader is a concrete error the turn
// survives, and shutdown closes the reader before the writer. Slowness comes from a stand-in worker that blocks in front
// of the real reader, so no test depends on how fast this machine scans vectors. Synthetic data only.

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
    prompts: { labels },
  };
  const service = createMemoryDb({
    iface: () => 'discord',
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
