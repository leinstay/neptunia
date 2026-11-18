// Tests for src/errands/service.ts: the secrets every run carries to its agent runner. Over a real
// task store (a temp data/ directory) with a FAKE journal, a FAKE errand client and a FAKE log:
// a run with no route carries no key, never one of the persona's; the engine proxy in force goes in its http form
// (stage Z: from the core's monitor, not MEDIA_VIDEO_PROXY); without a route key or a proxy no secrets go out;
// and no secret reaches a log call, a journal line or the store's files. The runner's health flag
// (over a real errand client and a fake runner socket): a runner known unreachable refuses a new
// task at once with `runner-down`, and a ping that succeeds flips the flag back.
import { consumers, consumerRig } from './fixtures/agent-consumers.ts';
import type { RunRequest } from '../src/errands/types.ts';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';

import { createErrandStores } from '../src/errands/store.ts';
import { createErrandService, RUNNER_RECHECK_MS } from '../src/errands/service.ts';
import { createErrandClient } from '../src/errands/client.ts';
import { encodeLine } from '../src/agent-runner/protocol.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { tempDir } from './fixtures/tmp.ts';
import { openTestMemorySync } from './fixtures/memory-db/service.ts';
import type { Untyped } from '../src/tools/types.ts';
import { keysPath, writeKeysFile } from './fixtures/keys-file.ts';

// The records come back typed as `object` or `unknown`; the tests read their fields through `loose`.
const loose = (value: unknown): Record<string, Untyped> => value as Record<string, Untyped>;

/** The memory database of each data directory used here, opened once; closed when the file is done. */
const MEMORY = new Map<string, ReturnType<typeof openTestMemorySync>>();
after(async () => {
  for (const { close } of MEMORY.values()) await close();
});
// A store the service hands out is null only before its first use; every read here follows a write.
function present<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('the test expects this store to exist');
  return value;
}

function memoryOf(dataDir: string) {
  let memory = MEMORY.get(dataDir);
  if (memory === undefined) {
    memory = openTestMemorySync({ dataDir });
    MEMORY.set(dataDir, memory);
  }
  return memory.memoryDb;
}

const SECRETS = ['pw-SECRET'];

/** A fake errand client: records each run and ends it at once. */
function fakeClient() {
  const runs: Array<Record<string, Untyped>> = [];
  return {
    runs,
    configured: () => true,
    async run(task: Untyped) {
      runs.push(task);
      return { status: 'done' as const, result: { text: 'found it' }, usage: { usd: 0.01 } };
    },
    cancel: () => true,
  };
}

/** A fake log that records every call. */
function fakeLog() {
  const calls: Array<{ level: string; msg: string; fields: Record<string, Untyped> }> = [];
  const record =
    (level: string) =>
    (msg: string, fields: Record<string, Untyped> = {}) =>
      calls.push({ level, msg, fields });
  return { calls, info: record('info'), warn: record('warn'), error: record('error') };
}

// Stage Z: the proxy comes from the core's monitor (`proxy`), never from the environment.
function makeService({ proxy = null }: { proxy?: string | null } = {}) {
  const rootDir = tempDir('nep-errands-service-');
  const hot = {
    config: {
      errands: { maxOpen: 3 },
      agents: { scout: { enabled: true, daily: { tasks: 10 } }, server: { enabled: true, daily: { tasks: 10 } } },
    },
  };
  const journalLines: Array<Untyped> = [];
  const journal = { action: async (placeId: string, line: string) => journalLines.push(line) };
  const log = fakeLog();
  const client = fakeClient();
  const stores = createErrandStores({
    memoryDb: memoryOf(path.join(rootDir, 'data')),
    config: () => hot.config,
    journal,
    log,
  });
  const errands = createErrandService({
    // @ts-expect-error: the stand-in's result carries only the text; the real client adds sources and files
    client,
    stores,
    hot,
    log,
    defer: (fn) => fn(),
    proxy: () => proxy,
  });
  const cleanup = () => fs.rmSync(rootDir, { recursive: true, force: true });
  return { errands, client, log, journalLines, rootDir, cleanup };
}

const ask = (agent: string) => ({
  agent,
  goal: 'find the changelog',
  requester: { accountId: '7', kind: 'member' },
  origin: { placeId: 'c1', messageId: 'm1' },
  scope: 'group' as const,
});

/** Every file under `dir`, read as text and joined. */
function filesText(dir: string) {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => fs.readFileSync(path.join(entry.parentPath ?? loose(entry).path, entry.name), 'utf8'))
    .join('\n');
}

const SOCKS_PROXY = 'socks5h://user:pw-SECRET@proxy.example:1080';

test('errands service: a scout run with no route carries the proxy in its http form and no key; no secret in a log, a journal line or a file', async () => {
  // Stage Z: the proxy is the engine proxy in force, handed by the core, in place of MEDIA_VIDEO_PROXY.
  const { errands, client, log, journalLines, rootDir, cleanup } = makeService({ proxy: SOCKS_PROXY });
  try {
    const { logs } = await withCapturedLogs(async () => {
      assert.equal(errands.submit(ask('scout')).ok, true);
      await errands.idle();
    });
    assert.equal(client.runs.length, 1);
    // The key of the agent's role came from `llm.keyByRole` over `.env`, which is gone: a run spends the extra key of
    // its route alone, and this run has none.
    assert.deepEqual(client.runs[0].secrets, { proxy: 'http://user:pw-SECRET@proxy.example:1080' });
    assert.ok(journalLines.length >= 2, 'the task was journaled');
    assert.ok(log.calls.length > 0, 'the run was logged');
    const recorded = JSON.stringify({ calls: log.calls, journalLines, logs }) + filesText(rootDir);
    for (const secret of SECRETS) assert.ok(!recorded.includes(secret), `${secret} never recorded`);
  } finally {
    cleanup();
  }
});

test('errands service: a run with no route and no proxy carries no secrets, never a key of the persona', async () => {
  // Catches: an errand with no route of its own handed a core key, so the agent spends the persona's budget.
  const { errands, client, cleanup } = makeService();
  try {
    await withCapturedLogs(async () => {
      errands.submit(ask('scout'));
      errands.submit({ ...ask('server'), requester: { accountId: '7', kind: 'owner' } });
      await errands.idle();
    });
    assert.equal(client.runs.length, 2);
    for (const run of client.runs) assert.equal(Object.hasOwn(run, 'secrets'), false, run.agent);
  } finally {
    cleanup();
  }
});

test('errands service: an http proxy is sent as it is', async () => {
  // Catches: an http proxy rewritten on its way to the runner, so the harness child cannot reach it.
  const { errands, client, cleanup } = makeService({ proxy: 'http://proxy.example:8000' });
  try {
    await withCapturedLogs(async () => {
      errands.submit(ask('scout'));
      await errands.idle();
    });
    assert.deepEqual(client.runs[0].secrets, { proxy: 'http://proxy.example:8000' });
  } finally {
    cleanup();
  }
});

// PR 7d: `errands.recentLines` is the constant 6, so the channel's four lines with text all go.
// The owner on 2026-11-16: a line given to an errand agent is kept whole; the limit of 200 is gone.
test("errands service: a run's context carries the UTC day it is sent and the folder of the engine's checkout", async () => {
  const rootDir = tempDir('nep-errands-service-');
  const engine = path.resolve(import.meta.dirname, '..');
  const hot = { config: { errands: { maxOpen: 5 }, agents: { scout: { enabled: true, daily: { tasks: 10 } } } } };
  const client = fakeClient();
  const stores = createErrandStores({
    memoryDb: memoryOf(path.join(rootDir, 'data')),
    config: () => hot.config,
    log: fakeLog(),
  });
  const errands = createErrandService({
    // @ts-expect-error: the stand-in's result carries only the text; the real client adds sources and files
    client,
    stores,
    hot,
    agentPaths: { rootDir: engine, dataDir: path.join(rootDir, 'data') },
    log: fakeLog(),
    defer: (fn) => fn(),
    now: () => Date.UTC(2026, 10, 17, 23, 30),
  });
  errands.submit(ask('scout'));
  await errands.idle();
  const context = loose(loose(client.runs[0]).context);
  assert.deepEqual([context.today, context.engine], ['2026-11-17', engine]);
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test('errands service: submit refuses an errand that names no agent and runs nothing', async () => {
  const { errands, client, cleanup } = makeService();
  // A caller that bypasses the types: an errand with no agent cannot be filed.
  const refused = errands.submit({ ...ask('scout'), agent: null as unknown as string });
  await errands.idle();
  assert.deepEqual(refused, { ok: false, code: 'unknown-agent' });
  assert.equal(client.runs.length, 0);
  assert.equal(errands.store()?.open().length ?? 0, 0);
  cleanup();
});

test("errands service: a task carries context.recent, the origin channel's last errands.recentLines lines as of its queuing, whole; a dm task sends none", async () => {
  const rootDir = tempDir('nep-errands-service-');
  const hot = {
    config: { errands: { maxOpen: 5 }, agents: { scout: { enabled: true, daily: { tasks: 10 } } } },
  };
  const buffer = [
    { placeId: 'c1', authorName: 'Ελένη', content: 'πρώτη' },
    { placeId: 'c2', authorName: 'Νίκος', content: 'elsewhere' },
    { placeId: 'c1', authorName: 'Νίκος', content: 'δεύτερη\n  με   κενά' },
    { placeId: 'c1', authorName: 'Ελένη', content: '' },
    { placeId: 'c1', authorName: 'A'.repeat(1500), content: 'x'.repeat(1500) },
    { placeId: 'c1', authorName: 'Ελένη', content: 'τελευταία' },
    { placeId: 'dm1', authorName: 'Ελένη', content: 'ιδιωτικό' },
  ];
  // The channel's newest lines with text, oldest first, as src/index.ts reads them from the memory database.
  const memory = {
    recentLines: (chatId: string, count: number) =>
      buffer
        .filter((line) => line.placeId === chatId && line.content)
        .map((line) => ({ author: line.authorName, text: line.content }))
        .slice(-count),
  };
  const client = fakeClient();
  const deferred: Array<() => void> = [];
  const stores = createErrandStores({
    memoryDb: memoryOf(path.join(rootDir, 'data')),
    config: () => hot.config,
    log: fakeLog(),
  });
  const errands = createErrandService({
    // @ts-expect-error: the stand-in's result carries only the text; the real client adds sources and files
    client,
    stores,
    hot,
    memory,
    log: fakeLog(),
    defer: (fn) => deferred.push(fn),
  });
  errands.submit(ask('scout'));
  errands.submit({ ...ask('scout'), origin: { placeId: 'dm1', messageId: null }, scope: 'dm' });
  // A line after the queuing is not in the task's context.
  buffer.push({ placeId: 'c1', authorName: 'Νίκος', content: 'later' });
  for (const fn of deferred.splice(0)) fn();
  await errands.idle();
  const [group, dm] = client.runs;
  assert.deepEqual(group.context.recent, [
    { author: 'Ελένη', text: 'πρώτη' },
    { author: 'Νίκος', text: 'δεύτερη με κενά' },
    { author: 'A'.repeat(1500), text: 'x'.repeat(1500) },
    { author: 'Ελένη', text: 'τελευταία' },
  ]);
  assert.deepEqual([group.context.scope, group.context.channel, group.context.asker], ['group', 'c1', '7']);
  assert.deepEqual(dm.context.recent, [], 'nothing of a private chat');
  assert.equal(dm.context.scope, 'dm');
  fs.rmSync(rootDir, { recursive: true, force: true });
});

// The runner's health flag: a runner known unreachable refuses a new task at once.

/** A fake runner on a Unix socket at `sock` that answers every ping with a pong. */
async function pongRunner(sock: Untyped) {
  const connections: Array<net.Socket> = [];
  const server = net.createServer((conn) => {
    connections.push(conn);
    conn.setEncoding('utf8');
    let buffer = '';
    conn.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const request = JSON.parse(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        if (request.op === 'ping') conn.write(encodeLine({ event: 'pong', profile: 'scout', busy: false, queued: 0 }));
      }
    });
    conn.on('error', () => {});
  });
  await new Promise<void>((resolve) => server.listen(sock, resolve));
  return {
    close: () =>
      new Promise<void>((resolve) => {
        for (const conn of connections) conn.destroy();
        server.close(() => resolve());
        if (fs.existsSync(sock)) fs.unlinkSync(sock);
      }),
  };
}

test('errands service: with the runner socket absent the flag goes down, submit refuses runner-down at once and writes no task; a ping that succeeds flips it back', async () => {
  const rootDir = tempDir('nep-errands-service-');
  // Changed: the socket is the scout unit's, which a user unit keeps under its runtime folder.
  const runtime = tempDir('nep-errands-runtime-');
  fs.mkdirSync(path.join(runtime, 'neptunia-agent-scout'));
  const sock = path.join(runtime, 'neptunia-agent-scout', 'sock');
  const agentPaths = { env: { NEPTUNIA_UNIT_SCOPE: 'user', XDG_RUNTIME_DIR: runtime } };
  const hot = {
    config: {
      errands: { maxOpen: 3 },
      agents: { scout: { enabled: true, daily: { tasks: 10 } }, server: { enabled: false } },
    },
  };
  let clock = 1_000_000;
  const log = fakeLog();
  const client: Untyped = createErrandClient({
    hot,
    log,
    agentPaths,
    setTimer: (fn, ms) => setTimeout(fn, Math.max(ms, 60_000)),
  });
  const stores = createErrandStores({ memoryDb: memoryOf(path.join(rootDir, 'data')), config: () => hot.config, log });
  const errands = createErrandService({ client, stores, hot, log, now: () => clock });
  let runner = null;
  try {
    assert.equal(errands.runnerUp('scout'), null, 'unknown before anything is known');
    assert.equal(await errands.check('scout'), false);
    assert.equal(errands.runnerUp('scout'), false);
    const refused = errands.submit(ask('scout'));
    assert.deepEqual(refused, { ok: false, code: 'runner-down' }, 'refused synchronously');
    assert.deepEqual(present(errands.store()).recent(10), [], 'no task row');
    const downs = log.calls.filter((c) => c.msg === 'errands: runner down');
    assert.equal(downs.length, 1, 'logged once per change');
    // Changed: the flag is the unit's.
    assert.equal(downs[0].fields.unit, 'scout');

    // Another refusal within RUNNER_RECHECK_MS sends no recheck and logs nothing new.
    errands.submit(ask('scout'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(log.calls.filter((c) => c.msg === 'errands: runner down').length, 1);

    // The runner is back; past RUNNER_RECHECK_MS the next refusal rechecks it and the flag flips up.
    runner = await pongRunner(sock);
    clock += RUNNER_RECHECK_MS;
    assert.equal(errands.submit(ask('scout')).code, 'runner-down', 'the asking refusal itself still falls back');
    for (let i = 0; i < 100 && errands.runnerUp('scout') !== true; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(errands.runnerUp('scout'), true);
    assert.equal(log.calls.filter((c) => c.msg === 'errands: runner up').length, 1);
    const queued = errands.submit(ask('scout'));
    assert.equal(queued.ok, true);
    assert.equal(present(errands.store()).recent(10).length, 1);
    errands.cancel({ id: queued.errand.id, by: 'owner' });
  } finally {
    client.close();
    await errands.idle();
    if (runner) await runner.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(runtime, { recursive: true, force: true });
  }
});

test("errands service: the connect loop's outcomes set the flag; start pings the enabled agents; a fake client without ping or onLink never refuses", async () => {
  let linkListener: ((link: Untyped) => void) | null = null as ((link: Untyped) => void) | null; // assigned inside a callback, so no narrowing to null
  const pinged: Array<Untyped> = [];
  const log = fakeLog();
  const client: Untyped = {
    configured: (agent: string) => agent === 'scout',
    onLink: (fn: Untyped) => {
      linkListener = fn;
    },
    ping: async (agent: string) => (pinged.push(agent), { ok: false, error: 'disconnected' }),
    run: async () => ({ status: 'done', result: { text: '' }, usage: {} }),
  };
  const rootDir = tempDir('nep-errands-service-');
  const hot = { config: { errands: { maxOpen: 3 }, agents: { scout: { enabled: true, daily: { tasks: 10 } } } } };
  const stores = createErrandStores({ memoryDb: memoryOf(path.join(rootDir, 'data')), config: () => hot.config, log });
  const errands = createErrandService({ client, stores, hot, log, defer: (fn) => fn() });
  try {
    errands.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(pinged, ['scout'], 'only the enabled agent');
    assert.equal(errands.runnerUp('scout'), false);
    // Changed: a link event names the unit, which is the agent's own.
    linkListener?.({ unit: 'scout', up: true });
    linkListener?.({ unit: 'scout', up: true });
    assert.equal(errands.runnerUp('scout'), true);
    assert.equal(errands.runnerUp('server'), null, 'the server unit is not known');
    assert.equal(log.calls.filter((c) => c.msg === 'errands: runner up').length, 1, 'once per change');
    assert.equal(errands.submit(ask('scout')).ok, true);
    linkListener?.({ unit: 'scout', up: false, code: 'ENOENT' });
    assert.equal(errands.submit(ask('scout')).code, 'runner-down');
    assert.equal(
      log.calls.find((c) => c.msg === 'errands: runner down')?.fields.code,
      'disconnected',
      'the first down came from the ping'
    );
    await errands.idle();

    const plain = makeService();
    try {
      assert.equal(plain.errands.submit(ask('scout')).ok, true);
      await plain.errands.idle();
    } finally {
      plain.cleanup();
    }
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

/** A store with one finished task of `agent` (done), asked in `scope`. */
function finishedTask(
  store: ReturnType<ReturnType<typeof createErrandStores>['get']>,
  {
    scope = 'group',
    placeId = 'c1',
    result = { text: 'found it' },
  }: { scope?: 'dm' | 'group'; placeId?: string; result?: Untyped } = {}
) {
  const held = present(store);
  const id = String(loose(held.add({ ...ask('scout'), scope, origin: { placeId, messageId: 'm1' } }).errand).id);
  held.start(id);
  held.finish(id, { status: 'done', result, usage: { usd: 0.01 } });
  return id;
}

test('errands service: view lists the open tasks, then the unread finished ones; reading or resolving takes one out; a seen result stays until it is read', () => {
  const rootDir = tempDir('nep-errands-service-');
  const hot = { config: { errands: { maxOpen: 5 }, agents: { scout: { enabled: true, daily: { tasks: 10 } } } } };
  try {
    const stores = createErrandStores({
      memoryDb: memoryOf(path.join(rootDir, 'data')),
      config: () => hot.config,
      log: fakeLog(),
    });
    const errands = createErrandService({
      // @ts-expect-error: the stand-in's result carries only the text; the real client adds sources and files
      client: fakeClient(),
      stores,
      hot,
      log: fakeLog(),
      defer: (fn) => fn(),
    });
    const store = stores.get();
    const a = finishedTask(store);
    const b = finishedTask(store);
    const open = loose(store).add(ask('scout')).errand.id;
    assert.deepEqual(
      errands.view({}).map((task) => task.id),
      [open, a, b]
    );
    errands.markSeen({ ids: [a, b] });
    assert.deepEqual(
      errands.view({}).map((task) => task.id),
      [open, a, b],
      'the result turn having run hides nothing'
    );
    assert.equal(errands.markRead({ ids: [a] }), 1);
    assert.deepEqual(
      errands.view({}).map((task) => task.id),
      [open, b]
    );
    loose(store).resolve(b);
    assert.deepEqual(
      errands.view({}).map((task) => task.id),
      [open]
    );
    assert.equal(loose(store).get(b).resolvedAt > 0, true);
    assert.equal(loose(store).resolve(open), null, 'an open task cannot be resolved');
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('errands service: with context.memory.openPrivate on, a dm errand carries its recent lines and memory and shows in a group view', async () => {
  // Bug: the switch opens her memory but an errand asked in a direct chat still runs blind and stays out of every group.
  const rootDir = tempDir('nep-errands-service-');
  const hot = {
    config: {
      errands: { maxOpen: 5 },
      agents: { scout: { enabled: true, daily: { tasks: 10 } } },
      context: { memory: { openPrivate: true } },
    },
  };
  // The core finds a direct chat's place by its scope: a channel of the same id holds none of its lines.
  const memory = {
    recentLines: (chatId: string, _count: number, scope: string) =>
      chatId === 'dm1' && scope === 'dm' ? [{ author: 'Ελένη', text: 'ιδιωτικό' }] : [],
  };
  const client = fakeClient();
  const deferred: Array<() => void> = [];
  const stores = createErrandStores({
    memoryDb: memoryOf(path.join(rootDir, 'data')),
    config: () => hot.config,
    log: fakeLog(),
  });
  const errands = createErrandService({
    // @ts-expect-error: the stand-in's result carries only the text; the real client adds sources and files
    client,
    stores,
    hot,
    memory,
    retrieve: () =>
      Promise.resolve({ assertions: [{ text: 'ΓΕΓΟΝΟΣ', state: 'current', polarity: 'positive' }] } as never),
    log: fakeLog(),
    defer: (fn) => deferred.push(fn),
  });
  errands.submit({ ...ask('scout'), origin: { placeId: 'dm1', messageId: null }, scope: 'dm' });
  assert.equal(errands.view({}).length, 1);
  for (const fn of deferred.splice(0)) fn();
  await errands.idle();
  const [dm] = client.runs as Array<{ context: { recent: unknown; memory?: Array<{ text: string }>; scope: string } }>;
  assert.deepEqual(dm.context.recent, [{ author: 'Ελένη', text: 'ιδιωτικό' }]);
  const { memory: facts } = dm.context;
  assert.deepEqual(
    facts?.map((fact) => fact.text),
    ['ΓΕΓΟΝΟΣ']
  );
  assert.equal(dm.context.scope, 'dm');
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test("errands service: a private chat's unread result is in the view only in that chat; the unread list survives a restart of the store", async () => {
  const rootDir = tempDir('nep-errands-service-');
  const hot = { config: { errands: { maxOpen: 5 }, agents: { scout: { enabled: true, daily: { tasks: 10 } } } } };
  const dataDir = path.join(rootDir, 'data');
  try {
    const stores = createErrandStores({ memoryDb: memoryOf(dataDir), config: () => hot.config, log: fakeLog() });
    const errands = createErrandService({
      // @ts-expect-error: the stand-in's result carries only the text; the real client adds sources and files
      client: fakeClient(),
      stores,
      hot,
      log: fakeLog(),
      defer: (fn) => fn(),
    });
    const dm = finishedTask(stores.get(), { scope: 'dm', placeId: 'dm1' });
    const group = finishedTask(stores.get());
    assert.deepEqual(
      errands.view({}).map((task) => task.id),
      [group]
    );
    assert.deepEqual(
      errands.view({ dmChatId: 'dm1' }).map((task) => task.id),
      [dm, group]
    );
    assert.deepEqual(
      errands.view({ dmChatId: 'dm2' }).map((task) => task.id),
      [group]
    );
    await present(stores.get()).flush();
    const again = createErrandStores({ memoryDb: memoryOf(dataDir), config: () => hot.config, log: fakeLog() }).get();
    assert.deepEqual(
      present(again)
        .unread()
        .map((task: Untyped) => task.id),
      [dm, group]
    );
    // A record from before readAt: seen counts as read, unseen as unread. PR 6d, errands on the board: such a record
    // reaches the store only from the archive board v3 moved, so it is written onto the board through the writer's
    // kind `errand`.
    for (const [id, seen] of [
      [dm, true],
      [group, false],
    ]) {
      const task = present(again).get(id);
      delete loose(task).readAt;
      delete loose(task).resolvedAt;
      await memoryOf(dataDir).writeErrand({
        id: String(id),
        at: Date.now(),
        errand: { ...task, seen },
        delivered: false,
        closing: null,
      });
    }
    const legacy = createErrandStores({ memoryDb: memoryOf(dataDir), config: () => hot.config, log: fakeLog() }).get();
    assert.deepEqual(
      present(legacy)
        .unread()
        .map((task: Untyped) => task.id),
      [group]
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('errands service: at start the finished errands whose result turn never ran get it again; the seen ones do not', async () => {
  const rootDir = tempDir('nep-errands-service-');
  const hot = { config: { errands: { maxOpen: 5 }, agents: { scout: { enabled: true, daily: { tasks: 10 } } } } };
  const dataDir = path.join(rootDir, 'data');
  try {
    const before = createErrandStores({ memoryDb: memoryOf(dataDir), config: () => hot.config, log: fakeLog() }).get();
    const unseen = finishedTask(before);
    const nowhere = finishedTask(before, { placeId: null as unknown as string });
    const seen = finishedTask(before);
    present(before).markSeen(seen);
    const running = loose(present(before).add(ask('scout')).errand).id;
    present(before).start(running);
    await present(before).flush();
    const reopened: Array<Untyped> = [];
    const stores = createErrandStores({ memoryDb: memoryOf(dataDir), config: () => hot.config, log: fakeLog() });
    const errands = createErrandService({
      // @ts-expect-error: the stand-in's result carries only the text; the real client adds sources and files
      client: fakeClient(),
      stores,
      hot,
      log: fakeLog(),
      defer: (fn) => fn(),
      onFinished: (task) => reopened.push([task.id, task.origin?.placeId]),
    });
    assert.equal(errands.start(), 1);
    await new Promise((resolve) => setImmediate(resolve));
    // Changed: an unseen end with no place is reopened too, since its result turn runs with no chat.
    assert.deepEqual(
      reopened.map(([id]) => id).sort(),
      [running, unseen, nowhere].sort(),
      'the restart-failed task, the unseen one and the one with no place'
    );
    // The callback takes no root since places: each reopened task names the place it was asked in, or none.
    assert.deepEqual(reopened.map(([, placeId]) => placeId ?? null).sort(), ['c1', 'c1', null].sort());
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("errands service: the file of an expired task is a marker, not a path; a private chat's only in that chat", () => {
  const rootDir = tempDir('nep-errands-service-');
  // Changed: the out folder is the scout unit's, which a user unit keeps under its state folder.
  const agentPaths = { env: { NEPTUNIA_UNIT_SCOPE: 'user', XDG_STATE_HOME: path.join(rootDir, 'state') } };
  fs.mkdirSync(path.join(rootDir, 'state', 'neptunia-agent-scout', 'out'), { recursive: true });
  const hot = { config: { errands: { maxOpen: 5 }, agents: { scout: { enabled: true, daily: { tasks: 10 } } } } };
  try {
    const stores = createErrandStores({
      memoryDb: memoryOf(path.join(rootDir, 'data')),
      config: () => hot.config,
      log: fakeLog(),
      agentPaths,
    });
    const errands = createErrandService({
      // @ts-expect-error: the stand-in's result carries only the text; the real client adds sources and files
      client: fakeClient(),
      stores,
      hot,
      log: fakeLog(),
      defer: (fn) => fn(),
    });
    const store = stores.get();
    const group = finishedTask(store, { result: { text: 'ok', files: [{ path: '/x/a.png', name: 'a.png' }] } });
    const dm = finishedTask(store, {
      scope: 'dm',
      placeId: 'dm1',
      result: { text: 'ok', files: [{ path: '/x/b.png', name: 'b.png' }] },
    });
    const handle = `file:${group}/a.png`;
    const found = errands.fileOf({ handle });
    assert.equal(loose(found)?.expired, true);
    assert.equal(loose(found).path, undefined);
    assert.equal(errands.fileOf({ handle: `file:${group}/other.png` }), null, 'a name the result does not list');
    assert.equal(errands.fileOf({ handle: `file:${dm}/b.png` }), null, "a private chat's file elsewhere");
    assert.equal(loose(errands.fileOf({ handle: `file:${dm}/b.png`, dmChatId: 'dm1' }))?.expired, true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('the running service forwards fresh personal limits with live config precedence', async () => {
  const rig = consumerRig();
  rig.override({ limits: { seconds: 17, steps: 7 }, daily: { tasks: 4 } });
  const hot = { config: { errands: { maxOpen: 3 }, agents: { scout: { limits: { steps: 2 } } } } };
  const runs: Array<RunRequest> = [];
  const stores = consumers.stores({ agentPaths: rig.options, config: () => hot.config });
  const service = consumers.service({
    agentPaths: rig.options,
    hot,
    stores,
    client: {
      configured: () => true,
      run: (request) => {
        runs.push(request);
        return Promise.resolve({
          status: 'done' as const,
          result: { text: 'synthetic result', sources: [], files: [] },
          usage: { input: 0, output: 0, usd: 0, steps: 0, seconds: 0 },
        });
      },
    },
    defer: (fn) => fn(),
  });
  try {
    assert.equal(service.submit(ask('scout')).ok, true);
    await service.idle();
    rig.override({ limits: { seconds: 29, steps: 11 }, daily: { tasks: 4 } });
    assert.equal(service.submit(ask('scout')).ok, true);
    await service.idle();
    assert.deepEqual(
      runs.map((run) => run.limits),
      [
        { steps: 2, seconds: 17 },
        { steps: 2, seconds: 29 },
      ]
    );
    assert.equal(service.store()?.today('scout').caps.tasks, 4);
  } finally {
    rig.close();
  }
});

test('a profile made invalid after submission closes the deferred errand without calling its client', async () => {
  const rig = consumerRig();
  rig.override({ limits: { seconds: 17 } });
  const hot = { config: { errands: { maxOpen: 3 }, agents: {} } };
  const deferred: Array<() => unknown> = [];
  const runs: Array<RunRequest> = [];
  const stores = consumers.stores({ agentPaths: rig.options, config: () => hot.config });
  const service = consumers.service({
    agentPaths: rig.options,
    hot,
    stores,
    defer: (fn) => deferred.push(fn),
    client: {
      configured: () => true,
      run: (request) => {
        runs.push(request);
        return Promise.resolve({
          status: 'done' as const,
          result: { text: 'synthetic result', sources: [], files: [] },
          usage: { input: 0, output: 0, usd: 0, steps: 0, seconds: 0 },
        });
      },
    },
  });
  try {
    const accepted = service.submit(ask('scout'));
    assert.equal(accepted.ok, true);
    if (!accepted.ok) return;
    assert.equal(service.store()?.get(accepted.errand.id)?.state, 'queued');
    assert.equal(deferred.length, 1);
    rig.override({ limits: { seconds: 0 } });
    deferred[0]?.();
    await service.idle();
    const finished = service.store()?.get(accepted.errand.id);
    assert.deepEqual([finished?.state, finished?.error], ['failed', 'client-error']);
    assert.equal(runs.length, 0);
  } finally {
    rig.close();
  }
});

// src/errands/service.ts: an errand of any agent on an OpenCode route carries the stored `exa` service key (keys.json
// `services.exa`) as `secrets.searchKey`. With no stored key, or on a claude or codex route, it carries none. The store is real over a temp memory database, the errand client is a fake
// that records each run, and keys.json lives in a temp dir.

const EXA = 'exa-stored-SECRET-0123';

const closers: Array<() => Promise<void> | void> = [];

const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

type Run = { route?: { backend?: string }; secrets?: { openrouterKey?: string; searchKey?: string } | null };

function rig(privateDir: string) {
  const agents = Object.fromEntries(['scout', 'server'].map((n) => [n, { enabled: true, daily: { tasks: 10 } }]));
  const hot = { config: { errands: { maxOpen: 3 }, agents } };
  const memory = openTestMemorySync({ dataDir: path.join(tempDir('nep-errands-exa-'), 'data') });
  closers.push(memory.close);
  const runs: Array<Run> = [];
  const client = {
    configured: () => true,
    run: (task: Run) => {
      runs.push(task);
      return Promise.resolve({
        status: 'done' as const,
        result: { text: 'ok', sources: [], files: [] },
        usage: { input: 0, output: 0, usd: 0, steps: 0, seconds: 0 },
      });
    },
    cancel: () => true,
  };
  const stores = createErrandStores({ memoryDb: memory.memoryDb, config: () => hot.config, log: quiet });
  const errands = createErrandService({ client, stores, hot, privateDir, log: quiet, defer: (fn) => fn() });
  return { errands, runs };
}

const exaKeyAsk = (agent: string) => ({
  agent,
  goal: 'find the changelog',
  requester: { accountId: '7', kind: 'owner' },
  origin: { channelId: 'c1', messageId: 'm1' },
  scope: 'group' as const,
});

/** keys.json with `agent` on `backend` and, when `exa` is a string, the stored Exa service key. */
function keys(privateDir: string, backend: 'claude' | 'codex' | 'opencode', agent: string, exa: string | null) {
  writeKeysFile(privateDir, {
    extra: { ex: 'sk-extra-OR' },
    subharness: { backends: [backend], key: 'ex', modes: {}, uses: { [agent]: backend } },
  });
  if (exa === null) return;
  const stored = JSON.parse(fs.readFileSync(keysPath(privateDir), 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(keysPath(privateDir), JSON.stringify({ ...stored, services: { exa } }), { mode: 0o600 });
}

async function dispatch(agent: string, backend: 'claude' | 'codex' | 'opencode', exa: string | null): Promise<Run> {
  const privateDir = tempDir('nep-errands-exa-');
  keys(privateDir, backend, agent, exa);
  const { errands, runs } = rig(privateDir);
  errands.submit(exaKeyAsk(agent));
  await errands.idle();
  assert.equal(runs.length, 1);
  const [run] = runs;
  assert.ok(run, 'the errand was dispatched');
  return run;
}
after(async () => {
  for (const close of closers) await close();
});

test('the scout errand on an opencode route carries the stored exa key as secrets.searchKey beside the route key', async () => {
  // Catches: the stored Exa key never leaving keys.json, so OpenCode's deep search stays keyless and rate limited.
  const run = await dispatch('scout', 'opencode', EXA);
  assert.equal(run.secrets?.searchKey, EXA);
  assert.equal(run.secrets?.openrouterKey, 'sk-extra-OR');
});

test('the scout errand on an opencode route carries no searchKey when no exa key is stored', async () => {
  // Catches: an empty or placeholder key sent, which would replace the keyless free endpoint with a failing one.
  const run = await dispatch('scout', 'opencode', null);
  assert.equal(Object.hasOwn(run.secrets ?? {}, 'searchKey'), false);
  assert.equal(run.secrets?.openrouterKey, 'sk-extra-OR');
});

test('the server errand on an opencode route carries the stored exa key as well', async () => {
  // Changed: the prompt is an agent's only limit (owner, 2026-11-17), so every opencode run searches with exa.
  // Catches: an agent's OpenCode search stays keyless and rate limited although a key is stored.
  const run = await dispatch('server', 'opencode', EXA);
  assert.equal(run.secrets?.searchKey, EXA);
});

for (const backend of ['claude', 'codex'] as const) {
  test(`the scout errand on a ${backend} route carries no searchKey although an exa key is stored`, async () => {
    // Catches: the Exa key reaching a harness that has web tools of its own and no use for it.
    const run = await dispatch('scout', backend, EXA);
    assert.equal(run.route?.backend, backend);
    assert.equal(Object.hasOwn(run.secrets ?? {}, 'searchKey'), false);
  });
}

// ---- Waiting for an errand inside a service turn ------------------------------------------------------------------

/**
 * A service over a client whose runs wait until the test ends them, with the wait's timers held by the test: `fire()`
 * runs every timer armed so far. `finished` records, for each end the service reports, whether the store already
 * held the errand as read.
 */
function waitingService() {
  const rootDir = tempDir('nep-errands-wait-');
  const hot = { config: { errands: { maxOpen: 3 }, agents: { scout: { enabled: true, daily: { tasks: 10 } } } } };
  const gates = new Map<string, (outcome: Untyped) => void>();
  const client = {
    configured: () => true,
    run: (task: { id: string }) => new Promise((resolve) => gates.set(task.id, resolve)),
    cancel: (task: { id: string }) => {
      gates.get(task.id)?.({ status: 'cancelled', error: 'cancelled' });
      return true;
    },
  };
  const timers: Array<() => void> = [];
  const finished: Array<{ id: string; read: boolean }> = [];
  const stores = createErrandStores({
    memoryDb: memoryOf(path.join(rootDir, 'data')),
    config: () => hot.config,
    log: fakeLog(),
  });
  const errands = createErrandService({
    // @ts-expect-error: the stand-in's result carries only the text; the real client adds sources and files
    client,
    stores,
    hot,
    log: fakeLog(),
    defer: (fn) => fn(),
    setTimer: (fn: () => void) => {
      timers.push(fn);
      return setTimeout(() => {}, 0);
    },
    onFinished: (task) => {
      finished.push({ id: task.id, read: Boolean(stores.get()?.get(task.id)?.readAt) });
    },
  });
  const end = (id: string) => gates.get(id)?.({ status: 'done', result: { text: 'found it' }, usage: { usd: 0.01 } });
  const fire = () => {
    for (const fn of timers.splice(0)) fn();
  };
  const queued = () => String(loose(loose(errands.submit(ask('scout'))).errand).id);
  const cleanup = () => fs.rmSync(rootDir, { recursive: true, force: true });
  return { errands, stores, finished, end, fire, queued, gates, cleanup };
}

/** Lets the deferred run reach the client. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** `promise`, or a rejection when it has not settled within two seconds: a wait that never ends fails the test. */
function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('the wait never ended')), 2000);
  });
  return Promise.race([promise, hung]).finally(() => clearTimeout(timer));
}

test('errands service: a waited end is marked read before the finished hook runs, and the wait resolves with it', async () => {
  // Bug caught: the end of an errand she waited for opens a second, separate result turn.
  const rig = waitingService();
  try {
    const id = rig.queued();
    const waiting = rig.errands.wait({ id, ms: 600_000 });
    await settle();
    rig.end(id);
    const waited = await within(waiting);
    await rig.errands.idle();
    assert.deepEqual([waited.ended, waited.errand?.state], [true, 'done']);
    assert.deepEqual(rig.finished, [{ id, read: true }]);
  } finally {
    rig.cleanup();
  }
});

test('errands service: the wait answers not ended and leaves the errand unread when its timer fires first', async () => {
  // Bug caught: a wait cut by the turn's budget marks the errand read, so its result never reaches her.
  const rig = waitingService();
  try {
    const id = rig.queued();
    const waiting = rig.errands.wait({ id, ms: 600_000 });
    await settle();
    rig.fire();
    const waited = await within(waiting);
    assert.deepEqual([waited.ended, waited.errand?.state], [false, 'running']);
    rig.end(id);
    await rig.errands.idle();
    assert.deepEqual(rig.finished, [{ id, read: false }]);
  } finally {
    rig.cleanup();
  }
});

test('errands service: the wait resolves with the cancelled record when the errand is cancelled', async () => {
  // Bug caught: a cancelled errand leaves the waiting call hanging until the turn's budget is spent.
  const rig = waitingService();
  try {
    const id = rig.queued();
    const waiting = rig.errands.wait({ id, ms: 600_000 });
    await settle();
    rig.errands.cancel({ id, by: 'owner' });
    const waited = await within(waiting);
    assert.deepEqual([waited.ended, waited.errand?.state], [true, 'cancelled']);
  } finally {
    rig.cleanup();
  }
});
