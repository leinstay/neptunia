// Tests for src/errands/service.ts: the secrets every run carries to its agent runner. Over a real
// task store (a temp data/ directory) with a FAKE journal, a FAKE errand client and a FAKE log:
// a run carries the key of its agent's model role as the bot resolves a role's key
// (`llm.keyByRole`), never the persona's main key; the scout agent also gets the proxy in its http
// form and the search key, the server agent neither; without the role's key no secrets go out;
// and no secret reaches a log call, a journal line or the store's files. The runner's health flag
// (over a real errand client and a fake runner socket): a runner known unreachable refuses a new
// task at once with `runner-down`, and a ping that succeeds flips the flag back.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

import { createTaskStores } from '../src/errands/store.ts';
import { createErrandService, RUNNER_RECHECK_MS } from '../src/errands/service.ts';
import { createErrandClient } from '../src/errands/client.ts';
import { encodeLine } from '../src/agent-runner/protocol.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { tempDir } from './fixtures/tmp.js';
import { openTestMemorySync, unitFile } from './fixtures/memory-db/service.js';

/** The memory database of each data directory used here, opened once; closed when the file is done. */
const MEMORY = new Map();
after(async () => {
  for (const { close } of MEMORY.values()) await close();
});
function memoryOf(dataDir) {
  if (!MEMORY.has(dataDir)) MEMORY.set(dataDir, openTestMemorySync({ dataDir }));
  return MEMORY.get(dataDir).memoryDb;
}

const SECRETS = ['sk-agent-SECRET', 'sk-persona-SECRET', 'pw-SECRET', 'search-SECRET', 'sk-dev-SECRET'];

/** A fake errand client: records each run and ends it at once. */
function fakeClient() {
  const runs = [];
  return {
    runs,
    configured: () => true,
    async run(task) {
      runs.push(task);
      return { status: 'done', result: { text: 'found it' }, usage: { usd: 0.01 } };
    },
    cancel: () => true,
  };
}

/** A fake log that records every call. */
function fakeLog() {
  const calls = [];
  const record = (level) => (msg, fields) => calls.push({ level, msg, fields });
  return { calls, info: record('info'), warn: record('warn'), error: record('error') };
}

function makeService(env, { keyByRole } = {}) {
  const rootDir = tempDir('nep-errands-service-');
  const hot = {
    config: {
      features: { journal: true },
      llm: {
        keyByRole: keyByRole ?? {
          scout: 'OPENROUTER_ERRAND_KEY',
          server: 'OPENROUTER_ERRAND_KEY',
          dev: 'OPENROUTER_DEV_KEY',
        },
      },
      errands: { maxOpen: 3 },
      agents: { scout: { enabled: true, daily: { tasks: 10 } }, server: { enabled: true, daily: { tasks: 10 } } },
    },
  };
  const journalLines = [];
  const journal = { action: async (guildId, line) => journalLines.push(line) };
  const log = fakeLog();
  const client = fakeClient();
  const stores = createTaskStores({
    memoryDb: memoryOf(path.join(rootDir, 'data')),
    config: () => hot.config,
    journal,
    log,
  });
  const errands = createErrandService({ client, stores, hot, env, getGuildId: () => 'g1', log, defer: (fn) => fn() });
  const cleanup = () => fs.rmSync(rootDir, { recursive: true, force: true });
  return { errands, client, log, journalLines, rootDir, cleanup };
}

const ask = (agent) => ({
  agent,
  goal: 'find the changelog',
  requester: { userId: '7', kind: 'member' },
  origin: { channelId: 'c1', messageId: 'm1' },
  scope: 'group',
});

/** Every file under `dir`, read as text and joined. */
function filesText(dir) {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => fs.readFileSync(path.join(entry.parentPath ?? entry.path, entry.name), 'utf8'))
    .join('\n');
}

const ENV = {
  OPENROUTER_CORE_KEY: 'sk-persona-SECRET',
  OPENROUTER_ERRAND_KEY: 'sk-agent-SECRET',
  OPENROUTER_DEV_KEY: 'sk-dev-SECRET',
  MEDIA_VIDEO_PROXY: 'socks5h://user:pw-SECRET@proxy.example:1080',
  OPENCODE_WEBSEARCH_KEY: 'search-SECRET',
};

test("errands service: a scout run carries its role's key, the proxy in its http form and the search key; no secret in a log, a journal line or a file", async () => {
  const { errands, client, log, journalLines, rootDir, cleanup } = makeService(ENV);
  try {
    const { logs } = await withCapturedLogs(async () => {
      assert.equal(errands.submit(ask('scout')).ok, true);
      await errands.idle();
    });
    assert.equal(client.runs.length, 1);
    assert.deepEqual(client.runs[0].secrets, {
      openrouterKey: 'sk-agent-SECRET',
      proxy: 'http://user:pw-SECRET@proxy.example:1080',
      searchKey: 'search-SECRET',
    });
    assert.ok(journalLines.length >= 2, 'the task was journaled');
    assert.ok(log.calls.length > 0, 'the run was logged');
    const recorded = JSON.stringify({ calls: log.calls, journalLines, logs }) + filesText(rootDir);
    for (const secret of SECRETS) assert.ok(!recorded.includes(secret), `${secret} never recorded`);
  } finally {
    cleanup();
  }
});

test("errands service: a server run carries only its role's key; never the persona's or the development key", async () => {
  const { errands, client, cleanup } = makeService(ENV);
  try {
    await withCapturedLogs(async () => {
      errands.submit(ask('server'));
      await errands.idle();
    });
    assert.deepEqual(client.runs[0].secrets, { openrouterKey: 'sk-agent-SECRET' });
  } finally {
    cleanup();
  }
});

test('errands service: the key follows llm.keyByRole read now; an http proxy is sent as it is; no search key, none sent', async () => {
  const env = {
    ...ENV,
    OPENROUTER_WEB_ONLY: 'sk-web-only',
    MEDIA_VIDEO_PROXY: 'http://proxy.example:8000',
    OPENCODE_WEBSEARCH_KEY: '',
  };
  const { errands, client, cleanup } = makeService(env, { keyByRole: { scout: 'OPENROUTER_WEB_ONLY' } });
  try {
    await withCapturedLogs(async () => {
      errands.submit(ask('scout'));
      await errands.idle();
    });
    assert.deepEqual(client.runs[0].secrets, { openrouterKey: 'sk-web-only', proxy: 'http://proxy.example:8000' });
  } finally {
    cleanup();
  }
});

test("errands service: without the role's key no secrets are sent (never the main key); the missing name is logged, never a value", async () => {
  const env = {
    OPENROUTER_CORE_KEY: 'sk-persona-SECRET',
    MEDIA_VIDEO_PROXY: 'socks5h://user:pw-SECRET@proxy.example:1080',
  };
  const { errands, client, log, cleanup } = makeService(env, { keyByRole: { scout: 'OPENROUTER_UNSET_AGENT_KEY' } });
  try {
    const { logs } = await withCapturedLogs(async () => {
      errands.submit(ask('scout'));
      errands.submit(ask('server'));
      await errands.idle();
    });
    assert.equal(client.runs.length, 2);
    for (const run of client.runs) assert.equal(Object.hasOwn(run, 'secrets'), false, run.agent);
    const missing = logs.filter((entry) => entry.msg === 'llm: role key missing');
    assert.deepEqual(
      missing.map((entry) => [entry.role, entry.name]),
      [['scout', 'OPENROUTER_UNSET_AGENT_KEY']]
    );
    const recorded = JSON.stringify({ calls: log.calls, logs });
    for (const secret of SECRETS) assert.ok(!recorded.includes(secret), `${secret} never recorded`);
  } finally {
    cleanup();
  }
});

test("errands service: a task carries context.recent, the origin channel's last errands.recentLines lines as of its queuing; a dm task sends none", async () => {
  const rootDir = tempDir('nep-errands-service-');
  const hot = {
    config: { errands: { maxOpen: 5, recentLines: 3 }, agents: { scout: { enabled: true, daily: { tasks: 10 } } } },
  };
  const buffer = [
    { channelId: 'c1', authorName: 'Ελένη', content: 'πρώτη' },
    { channelId: 'c2', authorName: 'Νίκος', content: 'elsewhere' },
    { channelId: 'c1', authorName: 'Νίκος', content: 'δεύτερη\n  με   κενά' },
    { channelId: 'c1', authorName: 'Ελένη', content: '' },
    { channelId: 'c1', authorName: 'A'.repeat(250), content: 'x'.repeat(250) },
    { channelId: 'c1', authorName: 'Ελένη', content: 'τελευταία' },
    { channelId: 'dm1', authorName: 'Ελένη', content: 'ιδιωτικό' },
  ];
  // The channel's newest lines with text, oldest first, as src/index.js reads them from the memory database.
  const memory = {
    recentLines: (guildId, channelId, count) =>
      (guildId === 'g1' ? buffer : [])
        .filter((line) => line.channelId === channelId && line.content)
        .map((line) => ({ author: line.authorName, text: line.content }))
        .slice(-count),
  };
  const client = fakeClient();
  const deferred = [];
  const stores = createTaskStores({
    memoryDb: memoryOf(path.join(rootDir, 'data')),
    config: () => hot.config,
    log: fakeLog(),
  });
  const errands = createErrandService({
    client,
    stores,
    hot,
    memory,
    getGuildId: () => 'g1',
    log: fakeLog(),
    defer: (fn) => deferred.push(fn),
  });
  errands.submit(ask('scout'));
  errands.submit({ ...ask('scout'), origin: { channelId: 'dm1', messageId: null }, scope: 'dm' });
  // A line after the queuing is not in the task's context.
  buffer.push({ channelId: 'c1', authorName: 'Νίκος', content: 'later' });
  for (const fn of deferred.splice(0)) fn();
  await errands.idle();
  const [group, dm] = client.runs;
  assert.deepEqual(group.context.recent, [
    { author: 'Νίκος', text: 'δεύτερη με κενά' },
    { author: 'A'.repeat(200), text: 'x'.repeat(200) },
    { author: 'Ελένη', text: 'τελευταία' },
  ]);
  assert.deepEqual([group.context.scope, group.context.channel, group.context.asker], ['group', 'c1', '7']);
  assert.deepEqual(dm.context.recent, [], 'nothing of a private chat');
  assert.equal(dm.context.scope, 'dm');
  hot.config.errands.recentLines = 0;
  errands.submit(ask('scout'));
  for (const fn of deferred.splice(0)) fn();
  await errands.idle();
  assert.deepEqual(client.runs[2].context.recent, []);
  fs.rmSync(rootDir, { recursive: true, force: true });
});

/** A fake ledger mirror (src/errands/ledger.ts's shape): records each call; `add` answers a ledger id at once. */
function fakeMirror() {
  const calls = [];
  let n = 0;
  return {
    calls,
    enabled: () => true,
    add(task, { guildId, limits, onLedgerId }) {
      calls.push(['add', task.id, task.state, guildId, limits]);
      n += 1;
      onLedgerId?.(`L${n}`);
      return true;
    },
    start(task, { limits, model }) {
      calls.push(['start', task.id, task.state, limits, model]);
      return true;
    },
    progress(task) {
      calls.push(['progress', task.id]);
      return true;
    },
    finish(task, { maxChars }) {
      calls.push(['finish', task.id, task.state, task.error, task.ledgerId ?? null, maxChars]);
      return true;
    },
    cancel(task, { by }) {
      calls.push(['cancel', task.id, by]);
      return true;
    },
    mirrorOpen(tasks, { guildId, limitsOf, onLedgerId }) {
      const missing = tasks.filter((task) => !task.ledgerId);
      calls.push(['mirrorOpen', missing.map((task) => task.id), guildId, missing.map((task) => limitsOf(task))]);
      for (const task of missing) onLedgerId(task, `R-${task.id}`);
      return missing.length;
    },
  };
}

test("errands service: the ledger mirror is called at the queuing (limits), the start (limits, the role's model), each progress, the end, a cancel (who) and a forget; the ledger id is kept on the task", async () => {
  const rootDir = tempDir('nep-errands-service-');
  const hot = {
    config: {
      models: { errands: { scout: 'openrouter/vendor/web-model' } },
      errands: { maxOpen: 5, resultMaxChars: 1234 },
      agents: { scout: { enabled: true, daily: { tasks: 10 }, limits: { steps: 9, usd: 0.3, seconds: 90 } } },
    },
  };
  const gates = new Map();
  const listeners = [];
  const client = {
    configured: () => true,
    run: (task) => new Promise((resolve) => gates.set(task.id, resolve)),
    cancel(task) {
      gates.get(task.id)?.({ status: 'cancelled', error: 'cancelled' });
      return true;
    },
    onProgress(fn) {
      listeners.push(fn);
      return () => {};
    },
  };
  const ledger = fakeMirror();
  const stores = createTaskStores({
    memoryDb: memoryOf(path.join(rootDir, 'data')),
    config: () => hot.config,
    log: fakeLog(),
  });
  const errands = createErrandService({
    client,
    stores,
    hot,
    getGuildId: () => 'g1',
    log: fakeLog(),
    defer: (fn) => fn(),
    ledger,
  });
  try {
    assert.equal(errands.ledger, ledger);
    const done = errands.submit(ask('scout')).task.id;
    assert.equal(errands.store('g1').get(done).ledgerId, 'L1', 'the ledger id is kept');
    await new Promise((resolve) => setImmediate(resolve));
    for (const fn of listeners) fn({ agent: 'scout', id: done, step: 1, tool: 'fetch', note: '' });
    for (const fn of listeners) fn({ agent: 'scout', id: 'tunknown', step: 1, tool: null, note: '' });
    gates.get(done)({ status: 'done', result: { text: 'found it' }, usage: { usd: 0.01, steps: 2 } });
    await errands.idle();
    // After its end, a late progress is not mirrored.
    for (const fn of listeners) fn({ agent: 'scout', id: done, step: 3, tool: null, note: '' });
    const cancelled = errands.submit(ask('scout')).task.id;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(errands.cancel({ guildId: 'g1', id: cancelled, by: 'owner' }).ok, true);
    await errands.idle();
    const limits = { steps: 9, seconds: 90 };
    assert.deepEqual(
      ledger.calls,
      [
        ['add', done, 'queued', 'g1', limits],
        ['start', done, 'running', limits, 'openrouter/vendor/web-model'],
        ['progress', done],
        ['finish', done, 'done', null, 'L1', 1234],
        ['add', cancelled, 'queued', 'g1', limits],
        ['start', cancelled, 'running', limits, 'openrouter/vendor/web-model'],
        ['cancel', cancelled, 'owner'],
      ],
      "a cancelled task's late end is not mirrored twice"
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("errands service: at start the open tasks without a ledger id are mirrored, then each one's restart failure; a mirror that throws never stops an errand", async () => {
  const rootDir = tempDir('nep-errands-service-');
  const hot = { config: { errands: { maxOpen: 5 }, agents: { scout: { enabled: true, daily: { tasks: 10 } } } } };
  const dataDir = path.join(rootDir, 'data');
  try {
    // Before the restart: two open tasks, one of them already mirrored.
    const before = createTaskStores({ memoryDb: memoryOf(dataDir), config: () => hot.config, log: fakeLog() }).get(
      'g1'
    );
    const first = before.add(ask('scout')).task.id;
    const second = before.add(ask('scout')).task.id;
    before.start(second);
    before.setLedgerId(second, 'L5');
    await before.flush();
    const ledger = fakeMirror();
    const stores = createTaskStores({ memoryDb: memoryOf(dataDir), config: () => hot.config, log: fakeLog() });
    const errands = createErrandService({
      client: fakeClient(),
      stores,
      hot,
      getGuildId: () => 'g1',
      log: fakeLog(),
      defer: (fn) => fn(),
      ledger,
    });
    assert.equal(errands.start('g1'), 2);
    assert.deepEqual(ledger.calls, [
      ['mirrorOpen', [first], 'g1', [errands.limitsOf('scout')]],
      ['finish', first, 'failed', 'restarted', `R-${first}`, 3000],
      ['finish', second, 'failed', 'restarted', 'L5', 3000],
    ]);
    assert.equal(stores.get('g1').get(first).ledgerId, `R-${first}`);

    // A mirror that throws at every call: the errand runs and ends as before, the failure is logged.
    const throwing = Object.fromEntries(
      ['add', 'start', 'progress', 'finish', 'cancel', 'mirrorOpen'].map((name) => [
        name,
        () => {
          throw new Error('mirror down');
        },
      ])
    );
    const log = fakeLog();
    const client = fakeClient();
    const other = createErrandService({
      client,
      stores,
      hot,
      getGuildId: () => 'g1',
      log,
      defer: (fn) => fn(),
      ledger: throwing,
    });
    const id = other.submit(ask('scout')).task.id;
    await other.idle();
    assert.equal(stores.get('g1').get(id).state, 'done');
    assert.ok(log.calls.some((call) => call.msg === 'errands: ledger mirror failed' && call.fields.id === id));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('errands service: without agents.ledger the default mirror is disabled and the errand runs as before', async () => {
  const { errands, client, cleanup } = makeService(ENV);
  try {
    assert.equal(errands.ledger.enabled(), false);
    await withCapturedLogs(async () => {
      errands.submit(ask('scout'));
      await errands.idle();
    });
    assert.equal(client.runs.length, 1);
    assert.equal(errands.store('g1').recent(1)[0].ledgerId, undefined);
  } finally {
    cleanup();
  }
});

// The runner's health flag: a runner known unreachable refuses a new task at once.

/** A fake runner on a Unix socket at `sock` that answers every ping with a pong. */
async function pongRunner(sock) {
  const connections = [];
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
  await new Promise((resolve) => server.listen(sock, resolve));
  return {
    close: () =>
      new Promise((resolve) => {
        for (const conn of connections) conn.destroy();
        server.close(() => resolve());
        if (fs.existsSync(sock)) fs.unlinkSync(sock);
      }),
  };
}

test('errands service: with the runner socket absent the flag goes down, submit refuses runner-down at once and writes no task; a ping that succeeds flips it back', async () => {
  const rootDir = tempDir('nep-errands-service-');
  const sock = path.join(os.tmpdir(), `errand-health-${process.pid}-${Math.random().toString(36).slice(2)}.sock`);
  const hot = {
    config: {
      errands: { maxOpen: 3 },
      agents: { scout: { enabled: true, socket: sock, daily: { tasks: 10 } }, server: { enabled: false } },
    },
  };
  let clock = 1_000_000;
  const log = fakeLog();
  const client = createErrandClient({ hot, log, setTimer: (fn, ms) => setTimeout(fn, Math.max(ms, 60_000)) });
  const stores = createTaskStores({ memoryDb: memoryOf(path.join(rootDir, 'data')), config: () => hot.config, log });
  const errands = createErrandService({ client, stores, hot, getGuildId: () => 'g1', log, now: () => clock });
  let runner = null;
  try {
    assert.equal(errands.runnerUp('scout'), null, 'unknown before anything is known');
    assert.equal(await errands.check('scout'), false);
    assert.equal(errands.runnerUp('scout'), false);
    const refused = errands.submit(ask('scout'));
    assert.deepEqual(refused, { ok: false, code: 'runner-down' }, 'refused synchronously');
    assert.deepEqual(errands.store('g1').recent(10), [], 'no task row');
    const downs = log.calls.filter((c) => c.msg === 'errands: runner down');
    assert.equal(downs.length, 1, 'logged once per change');
    assert.equal(downs[0].fields.agent, 'scout');

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
    assert.equal(errands.store('g1').recent(10).length, 1);
    errands.cancel({ guildId: 'g1', id: queued.task.id, by: 'owner' });
  } finally {
    client.close();
    await errands.idle();
    if (runner) await runner.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("errands service: the connect loop's outcomes set the flag; start pings the enabled agents; a fake client without ping or onLink never refuses", async () => {
  let linkListener = null;
  const pinged = [];
  const log = fakeLog();
  const client = {
    configured: (agent) => agent === 'scout',
    onLink: (fn) => {
      linkListener = fn;
    },
    ping: async (agent) => (pinged.push(agent), { ok: false, error: 'disconnected' }),
    run: async () => ({ status: 'done', result: { text: '' }, usage: {} }),
  };
  const rootDir = tempDir('nep-errands-service-');
  const hot = { config: { errands: { maxOpen: 3 }, agents: { scout: { enabled: true, daily: { tasks: 10 } } } } };
  const stores = createTaskStores({ memoryDb: memoryOf(path.join(rootDir, 'data')), config: () => hot.config, log });
  const errands = createErrandService({ client, stores, hot, getGuildId: () => 'g1', log, defer: (fn) => fn() });
  try {
    errands.start('g1');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(pinged, ['scout'], 'only the enabled agent');
    assert.equal(errands.runnerUp('scout'), false);
    linkListener({ agent: 'scout', up: true });
    linkListener({ agent: 'scout', up: true });
    assert.equal(errands.runnerUp('scout'), true);
    assert.equal(log.calls.filter((c) => c.msg === 'errands: runner up').length, 1, 'once per change');
    assert.equal(errands.submit(ask('scout')).ok, true);
    linkListener({ agent: 'scout', up: false, code: 'ENOENT' });
    assert.equal(errands.submit(ask('scout')).code, 'runner-down');
    assert.equal(
      log.calls.find((c) => c.msg === 'errands: runner down').fields.code,
      'disconnected',
      'the first down came from the ping'
    );
    await errands.idle();

    const plain = makeService(ENV);
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
function finishedTask(store, { scope = 'group', channelId = 'c1', result = { text: 'found it' } } = {}) {
  const id = store.add({ ...ask('scout'), scope, origin: { channelId, messageId: 'm1' } }).task.id;
  store.start(id);
  store.finish(id, { status: 'done', result, usage: { usd: 0.01 } });
  return id;
}

test('errands service: view lists the open tasks, then the unread finished ones; reading or resolving takes one out; a seen result stays until it is read', () => {
  const rootDir = tempDir('nep-errands-service-');
  const hot = { config: { errands: { maxOpen: 5 }, agents: { scout: { enabled: true, daily: { tasks: 10 } } } } };
  try {
    const stores = createTaskStores({
      memoryDb: memoryOf(path.join(rootDir, 'data')),
      config: () => hot.config,
      log: fakeLog(),
    });
    const errands = createErrandService({
      client: fakeClient(),
      stores,
      hot,
      getGuildId: () => 'g1',
      log: fakeLog(),
      defer: (fn) => fn(),
    });
    const store = stores.get('g1');
    const a = finishedTask(store);
    const b = finishedTask(store);
    const open = store.add(ask('scout')).task.id;
    assert.deepEqual(
      errands.view({ guildId: 'g1' }).map((task) => task.id),
      [open, a, b]
    );
    errands.markSeen({ guildId: 'g1', ids: [a, b] });
    assert.deepEqual(
      errands.view({ guildId: 'g1' }).map((task) => task.id),
      [open, a, b],
      'the result turn having run hides nothing'
    );
    assert.equal(errands.markRead({ guildId: 'g1', ids: [a] }), 1);
    assert.deepEqual(
      errands.view({ guildId: 'g1' }).map((task) => task.id),
      [open, b]
    );
    store.resolve(b);
    assert.deepEqual(
      errands.view({ guildId: 'g1' }).map((task) => task.id),
      [open]
    );
    assert.equal(store.get(b).resolvedAt > 0, true);
    assert.equal(store.resolve(open), null, 'an open task cannot be resolved');
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("errands service: a private chat's unread result is in the view only in that chat; the unread list survives a restart of the store", async () => {
  const rootDir = tempDir('nep-errands-service-');
  const hot = { config: { errands: { maxOpen: 5 }, agents: { scout: { enabled: true, daily: { tasks: 10 } } } } };
  const dataDir = path.join(rootDir, 'data');
  try {
    const stores = createTaskStores({ memoryDb: memoryOf(dataDir), config: () => hot.config, log: fakeLog() });
    const errands = createErrandService({
      client: fakeClient(),
      stores,
      hot,
      getGuildId: () => 'g1',
      log: fakeLog(),
      defer: (fn) => fn(),
    });
    const dm = finishedTask(stores.get('g1'), { scope: 'dm', channelId: 'dm1' });
    const group = finishedTask(stores.get('g1'));
    assert.deepEqual(
      errands.view({ guildId: 'g1' }).map((task) => task.id),
      [group]
    );
    assert.deepEqual(
      errands.view({ guildId: 'g1', privateChannelId: 'dm1' }).map((task) => task.id),
      [dm, group]
    );
    assert.deepEqual(
      errands.view({ guildId: 'g1', privateChannelId: 'dm2' }).map((task) => task.id),
      [group]
    );
    await stores.get('g1').flush();
    const again = createTaskStores({ memoryDb: memoryOf(dataDir), config: () => hot.config, log: fakeLog() }).get('g1');
    assert.deepEqual(
      again.unread().map((task) => task.id),
      [dm, group]
    );
    // A record from before readAt: seen counts as read, unseen as unread.
    const list = JSON.parse(unitFile(memoryOf(dataDir), 'guilds/g1/errands.json'));
    for (const task of list.errands) {
      delete task.readAt;
      delete task.resolvedAt;
    }
    list.errands[0].seen = true;
    await memoryOf(dataDir).writeUnit({ op: 'value', owner: 'guilds/g1/errands.json', value: list });
    const legacy = createTaskStores({ memoryDb: memoryOf(dataDir), config: () => hot.config, log: fakeLog() }).get(
      'g1'
    );
    assert.deepEqual(
      legacy.unread().map((task) => task.id),
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
    const before = createTaskStores({ memoryDb: memoryOf(dataDir), config: () => hot.config, log: fakeLog() }).get(
      'g1'
    );
    const unseen = finishedTask(before);
    const seen = finishedTask(before);
    before.markSeen(seen);
    const running = before.add(ask('scout')).task.id;
    before.start(running);
    await before.flush();
    const reopened = [];
    const stores = createTaskStores({ memoryDb: memoryOf(dataDir), config: () => hot.config, log: fakeLog() });
    const errands = createErrandService({
      client: fakeClient(),
      stores,
      hot,
      getGuildId: () => 'g1',
      log: fakeLog(),
      defer: (fn) => fn(),
      onFinished: (task, guildId) => reopened.push([task.id, guildId]),
    });
    assert.equal(errands.start('g1'), 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      reopened.map(([id]) => id).sort(),
      [running, unseen].sort(),
      'the restart-failed task and the unseen one'
    );
    assert.equal(
      reopened.every(([, guildId]) => guildId === 'g1'),
      true
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("errands service: the file of an expired task is a marker, not a path; a private chat's only in that chat", () => {
  const rootDir = tempDir('nep-errands-service-');
  const out = path.join(rootDir, 'out');
  fs.mkdirSync(out, { recursive: true });
  const hot = { config: { errands: { maxOpen: 5 }, agents: { scout: { enabled: true, out, daily: { tasks: 10 } } } } };
  try {
    const stores = createTaskStores({
      memoryDb: memoryOf(path.join(rootDir, 'data')),
      config: () => hot.config,
      log: fakeLog(),
    });
    const errands = createErrandService({
      client: fakeClient(),
      stores,
      hot,
      getGuildId: () => 'g1',
      log: fakeLog(),
      defer: (fn) => fn(),
    });
    const store = stores.get('g1');
    const group = finishedTask(store, { result: { text: 'ok', files: [{ path: '/x/a.png', name: 'a.png' }] } });
    const dm = finishedTask(store, {
      scope: 'dm',
      channelId: 'dm1',
      result: { text: 'ok', files: [{ path: '/x/b.png', name: 'b.png' }] },
    });
    const handle = `file:${group}/a.png`;
    const found = errands.fileOf({ guildId: 'g1', handle });
    assert.equal(found?.expired, true);
    assert.equal(found.path, undefined);
    assert.equal(
      errands.fileOf({ guildId: 'g1', handle: `file:${group}/other.png` }),
      null,
      'a name the result does not list'
    );
    assert.equal(
      errands.fileOf({ guildId: 'g1', handle: `file:${dm}/b.png` }),
      null,
      "a private chat's file elsewhere"
    );
    assert.equal(errands.fileOf({ guildId: 'g1', handle: `file:${dm}/b.png`, privateChannelId: 'dm1' })?.expired, true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
