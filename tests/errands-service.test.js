// Tests for src/errands/service.js: the secrets every run carries to its agent runner. Over a real
// task store (a temp data/ directory) with a FAKE journal, a FAKE errand client and a FAKE log:
// a run carries the key of its agent's model role as the bot resolves a role's key
// (`llm.keyByRole`), never the persona's main key; the web agent also gets the proxy in its http
// form and the search key, the server agent neither; without the role's key no secrets go out;
// and no secret reaches a log call, a journal line or the store's files. The runner's health flag
// (over a real errand client and a fake runner socket): a runner known unreachable refuses a new
// task at once with `runner-down`, and a ping that succeeds flips the flag back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

import { createTaskStores } from '../src/errands/store.js';
import { createErrandService, RUNNER_RECHECK_MS } from '../src/errands/service.js';
import { createErrandClient } from '../src/errands/client.js';
import { encodeLine } from '../src/agent-runner/protocol.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';

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
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-errands-service-'));
  const hot = {
    config: {
      features: { journal: true },
      llm: { keyByRole: keyByRole ?? { 'agent.web': 'OPENROUTER_AGENT_KEY', 'agent.server': 'OPENROUTER_AGENT_KEY', 'agent.dev': 'OPENROUTER_DEV_KEY' } },
      agents: { maxOpen: 3, web: { enabled: true, daily: { tasks: 10, usd: 5 } }, server: { enabled: true, daily: { tasks: 10, usd: 5 } } },
    },
  };
  const journalLines = [];
  const journal = { action: async (guildId, line) => journalLines.push(line) };
  const log = fakeLog();
  const client = fakeClient();
  const stores = createTaskStores({ dataDir: path.join(rootDir, 'data'), config: () => hot.config, journal, log });
  const errands = createErrandService({ client, stores, hot, env, getGuildId: () => 'g1', log, defer: (fn) => fn() });
  const cleanup = () => fs.rmSync(rootDir, { recursive: true, force: true });
  return { errands, client, log, journalLines, rootDir, cleanup };
}

const ask = (agent) => ({ agent, goal: 'find the changelog', requester: { userId: '7', kind: 'member' }, origin: { channelId: 'c1', messageId: 'm1' }, scope: 'group' });

/** Every file under `dir`, read as text and joined. */
function filesText(dir) {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => fs.readFileSync(path.join(entry.parentPath ?? entry.path, entry.name), 'utf8'))
    .join('\n');
}

const ENV = {
  OPENROUTER_API_KEY: 'sk-persona-SECRET',
  OPENROUTER_AGENT_KEY: 'sk-agent-SECRET',
  OPENROUTER_DEV_KEY: 'sk-dev-SECRET',
  MEDIA_VIDEO_PROXY: 'socks5h://user:pw-SECRET@proxy.example:1080',
  OPENCODE_WEBSEARCH_KEY: 'search-SECRET',
};

test('errands service: a web run carries its role\'s key, the proxy in its http form and the search key; no secret in a log, a journal line or a file', async () => {
  const { errands, client, log, journalLines, rootDir, cleanup } = makeService(ENV);
  try {
    const { logs } = await withCapturedLogs(async () => {
      assert.equal(errands.submit(ask('web')).ok, true);
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

test('errands service: a server run carries only its role\'s key; never the persona\'s or the development key', async () => {
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
  const env = { ...ENV, OPENROUTER_WEB_ONLY: 'sk-web-only', MEDIA_VIDEO_PROXY: 'http://proxy.example:8000', OPENCODE_WEBSEARCH_KEY: '' };
  const { errands, client, cleanup } = makeService(env, { keyByRole: { 'agent.web': 'OPENROUTER_WEB_ONLY' } });
  try {
    await withCapturedLogs(async () => {
      errands.submit(ask('web'));
      await errands.idle();
    });
    assert.deepEqual(client.runs[0].secrets, { openrouterKey: 'sk-web-only', proxy: 'http://proxy.example:8000' });
  } finally {
    cleanup();
  }
});

test('errands service: without the role\'s key no secrets are sent (never the main key); the missing name is logged, never a value', async () => {
  const env = { OPENROUTER_API_KEY: 'sk-persona-SECRET', MEDIA_VIDEO_PROXY: 'socks5h://user:pw-SECRET@proxy.example:1080' };
  const { errands, client, log, cleanup } = makeService(env, { keyByRole: { 'agent.web': 'OPENROUTER_UNSET_AGENT_KEY' } });
  try {
    const { logs } = await withCapturedLogs(async () => {
      errands.submit(ask('web'));
      errands.submit(ask('server'));
      await errands.idle();
    });
    assert.equal(client.runs.length, 2);
    for (const run of client.runs) assert.equal(Object.hasOwn(run, 'secrets'), false, run.agent);
    const missing = logs.filter((entry) => entry.msg === 'llm: role key missing');
    assert.deepEqual(missing.map((entry) => [entry.role, entry.name]), [['agent.web', 'OPENROUTER_UNSET_AGENT_KEY']]);
    const recorded = JSON.stringify({ calls: log.calls, logs });
    for (const secret of SECRETS) assert.ok(!recorded.includes(secret), `${secret} never recorded`);
  } finally {
    cleanup();
  }
});

test('errands service: forgetUser cancels the member\'s running task at its runner, then drops their tasks; wipe empties the guild\'s', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-errands-service-'));
  const hot = { config: { agents: { maxOpen: 5, web: { enabled: true, daily: { tasks: 10, usd: 5 } } } } };
  const gates = new Map();
  const cancels = [];
  const client = {
    configured: () => true,
    run: (task) => new Promise((resolve) => gates.set(task.id, resolve)),
    cancel(task) {
      cancels.push(task.id);
      gates.get(task.id)?.({ status: 'cancelled', error: 'cancelled' });
      return true;
    },
  };
  const log = fakeLog();
  const stores = createTaskStores({ dataDir: path.join(rootDir, 'data'), config: () => hot.config, log });
  const errands = createErrandService({ client, stores, hot, getGuildId: () => 'g1', log, defer: (fn) => fn() });
  const mine = errands.submit(ask('web')).task.id;
  const theirs = errands.submit({ ...ask('web'), requester: { userId: '8', kind: 'member' } }).task.id;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errands.forgetUser('g1', '7'), { removed: 1, lines: 2 });
  assert.deepEqual(cancels, [mine], 'only the member\'s running task is cancelled');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errands.store('g1').get(mine), null, 'its late end writes nothing back');
  assert.ok(errands.store('g1').get(theirs));
  gates.get(theirs)({ status: 'done', result: { text: 'ok' } });
  await errands.idle();
  assert.deepEqual(errands.wipe('g1'), { files: 2 });
  assert.deepEqual(errands.store('g1').recent(10), []);
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test('errands service: a task carries context.recent, the origin channel\'s last agents.recentLines lines as of its queuing; a dm task sends none', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-errands-service-'));
  const hot = { config: { agents: { maxOpen: 5, recentLines: 3, web: { enabled: true, daily: { tasks: 10, usd: 5 } } } } };
  const buffer = [
    { channelId: 'c1', authorName: 'Ελένη', content: 'πρώτη' },
    { channelId: 'c2', authorName: 'Νίκος', content: 'elsewhere' },
    { channelId: 'c1', authorName: 'Νίκος', content: 'δεύτερη\n  με   κενά' },
    { channelId: 'c1', authorName: 'Ελένη', content: '' },
    { channelId: 'c1', authorName: 'A'.repeat(250), content: 'x'.repeat(250) },
    { channelId: 'c1', authorName: 'Ελένη', content: 'τελευταία' },
    { channelId: 'dm1', authorName: 'Ελένη', content: 'ιδιωτικό' },
  ];
  const memory = { getBuffer: (guildId) => (guildId === 'g1' ? buffer : []) };
  const client = fakeClient();
  const deferred = [];
  const stores = createTaskStores({ dataDir: path.join(rootDir, 'data'), config: () => hot.config, log: fakeLog() });
  const errands = createErrandService({ client, stores, hot, memory, getGuildId: () => 'g1', log: fakeLog(), defer: (fn) => deferred.push(fn) });
  errands.submit(ask('web'));
  errands.submit({ ...ask('web'), origin: { channelId: 'dm1', messageId: null }, scope: 'dm' });
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
  hot.config.agents.recentLines = 0;
  errands.submit(ask('web'));
  for (const fn of deferred.splice(0)) fn();
  await errands.idle();
  assert.deepEqual(client.runs[2].context.recent, []);
  fs.rmSync(rootDir, { recursive: true, force: true });
});

/** A fake ledger mirror (src/errands/ledger.js's shape): records each call; `add` answers a ledger id at once. */
function fakeMirror() {
  const calls = [];
  let n = 0;
  return {
    calls,
    enabled: () => true,
    add(task, { guildId, onLedgerId }) {
      calls.push(['add', task.id, task.state, guildId]);
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
    mirrorOpen(tasks, { guildId, onLedgerId }) {
      const missing = tasks.filter((task) => !task.ledgerId);
      calls.push(['mirrorOpen', missing.map((task) => task.id), guildId]);
      for (const task of missing) onLedgerId(task, `R-${task.id}`);
      return missing.length;
    },
  };
}

test('errands service: the ledger mirror is called at the queuing, the start (limits, the role\'s model), each progress, the end, a cancel (who) and a forget; the ledger id is kept on the task', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-errands-service-'));
  const hot = { config: { roles: { 'agent.web': 'openrouter/vendor/web-model' }, agents: { maxOpen: 5, resultMaxChars: 1234, web: { enabled: true, daily: { tasks: 10, usd: 5 }, limits: { steps: 9, usd: 0.3, seconds: 90 } } } } };
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
  const stores = createTaskStores({ dataDir: path.join(rootDir, 'data'), config: () => hot.config, log: fakeLog() });
  const errands = createErrandService({ client, stores, hot, getGuildId: () => 'g1', log: fakeLog(), defer: (fn) => fn(), ledger });
  try {
    assert.equal(errands.ledger, ledger);
    const done = errands.submit(ask('web')).task.id;
    assert.equal(errands.store('g1').get(done).ledgerId, 'L1', 'the ledger id is kept');
    await new Promise((resolve) => setImmediate(resolve));
    for (const fn of listeners) fn({ agent: 'web', id: done, step: 1, tool: 'fetch', note: '' });
    for (const fn of listeners) fn({ agent: 'web', id: 'tunknown', step: 1, tool: null, note: '' });
    gates.get(done)({ status: 'done', result: { text: 'found it' }, usage: { usd: 0.01, steps: 2 } });
    await errands.idle();
    // After its end, a late progress is not mirrored.
    for (const fn of listeners) fn({ agent: 'web', id: done, step: 3, tool: null, note: '' });
    const cancelled = errands.submit(ask('web')).task.id;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(errands.cancel({ guildId: 'g1', id: cancelled, by: 'owner' }).ok, true);
    await errands.idle();
    const forgotten = errands.submit(ask('web')).task.id;
    await new Promise((resolve) => setImmediate(resolve));
    errands.forgetUser('g1', '7');
    await errands.idle();
    const limits = { steps: 9, usd: 0.3, seconds: 90 };
    assert.deepEqual(ledger.calls, [
      ['add', done, 'queued', 'g1'],
      ['start', done, 'running', limits, 'openrouter/vendor/web-model'],
      ['progress', done],
      ['finish', done, 'done', null, 'L1', 1234],
      ['add', cancelled, 'queued', 'g1'],
      ['start', cancelled, 'running', limits, 'openrouter/vendor/web-model'],
      ['cancel', cancelled, 'owner'],
      ['add', forgotten, 'queued', 'g1'],
      ['start', forgotten, 'running', limits, 'openrouter/vendor/web-model'],
      ['cancel', forgotten, 'forget'],
    ], 'a cancelled task\'s late end is not mirrored twice');
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('errands service: at start the open tasks without a ledger id are mirrored, then each one\'s restart failure; a mirror that throws never stops an errand', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-errands-service-'));
  const hot = { config: { agents: { maxOpen: 5, web: { enabled: true, daily: { tasks: 10, usd: 5 } } } } };
  const dataDir = path.join(rootDir, 'data');
  try {
    // Before the restart: two open tasks, one of them already mirrored.
    const before = createTaskStores({ dataDir, config: () => hot.config, log: fakeLog() }).get('g1');
    const first = before.add(ask('web')).task.id;
    const second = before.add(ask('web')).task.id;
    before.start(second);
    before.setLedgerId(second, 'L5');
    const ledger = fakeMirror();
    const stores = createTaskStores({ dataDir, config: () => hot.config, log: fakeLog() });
    const errands = createErrandService({ client: fakeClient(), stores, hot, getGuildId: () => 'g1', log: fakeLog(), defer: (fn) => fn(), ledger });
    assert.equal(errands.start('g1'), 2);
    assert.deepEqual(ledger.calls, [
      ['mirrorOpen', [first], 'g1'],
      ['finish', first, 'failed', 'restarted', `R-${first}`, 3000],
      ['finish', second, 'failed', 'restarted', 'L5', 3000],
    ]);
    assert.equal(stores.get('g1').get(first).ledgerId, `R-${first}`);

    // A mirror that throws at every call: the errand runs and ends as before, the failure is logged.
    const throwing = Object.fromEntries(['add', 'start', 'progress', 'finish', 'cancel', 'mirrorOpen'].map((name) => [name, () => {
      throw new Error('mirror down');
    }]));
    const log = fakeLog();
    const client = fakeClient();
    const other = createErrandService({ client, stores, hot, getGuildId: () => 'g1', log, defer: (fn) => fn(), ledger: throwing });
    const id = other.submit(ask('web')).task.id;
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
      errands.submit(ask('web'));
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
        if (request.op === 'ping') conn.write(encodeLine({ event: 'pong', profile: 'web', busy: false, queued: 0 }));
      }
    });
    conn.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(sock, resolve));
  return {
    close: () => new Promise((resolve) => {
      for (const conn of connections) conn.destroy();
      server.close(() => resolve());
      if (fs.existsSync(sock)) fs.unlinkSync(sock);
    }),
  };
}

test('errands service: with the runner socket absent the flag goes down, submit refuses runner-down at once and writes no task; a ping that succeeds flips it back', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-errands-service-'));
  const sock = path.join(os.tmpdir(), `errand-health-${process.pid}-${Math.random().toString(36).slice(2)}.sock`);
  const hot = { config: { agents: { maxOpen: 3, web: { enabled: true, socket: sock, daily: { tasks: 10, usd: 5 } }, server: { enabled: false } } } };
  let clock = 1_000_000;
  const log = fakeLog();
  const client = createErrandClient({ hot, log, setTimer: (fn, ms) => setTimeout(fn, Math.max(ms, 60_000)) });
  const stores = createTaskStores({ dataDir: path.join(rootDir, 'data'), config: () => hot.config, log });
  const errands = createErrandService({ client, stores, hot, getGuildId: () => 'g1', log, now: () => clock });
  let runner = null;
  try {
    assert.equal(errands.runnerUp('web'), null, 'unknown before anything is known');
    assert.equal(await errands.check('web'), false);
    assert.equal(errands.runnerUp('web'), false);
    const refused = errands.submit(ask('web'));
    assert.deepEqual(refused, { ok: false, code: 'runner-down' }, 'refused synchronously');
    assert.deepEqual(errands.store('g1').recent(10), [], 'no task row');
    const downs = log.calls.filter((c) => c.msg === 'errands: runner down');
    assert.equal(downs.length, 1, 'logged once per change');
    assert.equal(downs[0].fields.agent, 'web');

    // Another refusal within RUNNER_RECHECK_MS sends no recheck and logs nothing new.
    errands.submit(ask('web'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(log.calls.filter((c) => c.msg === 'errands: runner down').length, 1);

    // The runner is back; past RUNNER_RECHECK_MS the next refusal rechecks it and the flag flips up.
    runner = await pongRunner(sock);
    clock += RUNNER_RECHECK_MS;
    assert.equal(errands.submit(ask('web')).code, 'runner-down', 'the asking refusal itself still falls back');
    for (let i = 0; i < 100 && errands.runnerUp('web') !== true; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(errands.runnerUp('web'), true);
    assert.equal(log.calls.filter((c) => c.msg === 'errands: runner up').length, 1);
    const queued = errands.submit(ask('web'));
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

test('errands service: the connect loop\'s outcomes set the flag; start pings the enabled agents; a fake client without ping or onLink never refuses', async () => {
  let linkListener = null;
  const pinged = [];
  const log = fakeLog();
  const client = {
    configured: (agent) => agent === 'web',
    onLink: (fn) => { linkListener = fn; },
    ping: async (agent) => (pinged.push(agent), { ok: false, error: 'disconnected' }),
    run: async () => ({ status: 'done', result: { text: '' }, usage: {} }),
  };
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-errands-service-'));
  const hot = { config: { agents: { maxOpen: 3, web: { enabled: true, daily: { tasks: 10, usd: 5 } } } } };
  const stores = createTaskStores({ dataDir: path.join(rootDir, 'data'), config: () => hot.config, log });
  const errands = createErrandService({ client, stores, hot, getGuildId: () => 'g1', log, defer: (fn) => fn() });
  try {
    errands.start('g1');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(pinged, ['web'], 'only the enabled agent');
    assert.equal(errands.runnerUp('web'), false);
    linkListener({ agent: 'web', up: true });
    linkListener({ agent: 'web', up: true });
    assert.equal(errands.runnerUp('web'), true);
    assert.equal(log.calls.filter((c) => c.msg === 'errands: runner up').length, 1, 'once per change');
    assert.equal(errands.submit(ask('web')).ok, true);
    linkListener({ agent: 'web', up: false, code: 'ENOENT' });
    assert.equal(errands.submit(ask('web')).code, 'runner-down');
    assert.equal(log.calls.find((c) => c.msg === 'errands: runner down').fields.code, 'disconnected', 'the first down came from the ping');
    await errands.idle();

    const plain = makeService(ENV);
    try {
      assert.equal(plain.errands.submit(ask('web')).ok, true);
      await plain.errands.idle();
    } finally {
      plain.cleanup();
    }
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
