// Tests for src/errands/ledger.js: the persona's errands mirrored into the ledger over its Unix
// socket. A FAKE ledger (a net server on a socket in a temp directory) records every request and
// answers like the ledger's wire protocol ({ id, ok, result | error }), returning the same task id
// for the same idempotency key. Covered: the mapping of every transition with its idempotency
// key, the heartbeat at most once a minute, the queue and its replay after a refused connection
// and after a lost answer, a refusal dropped and logged, the queue's cap, the disabled mode, the
// restart mirror of the open tasks without a ledger id, and against a fake of the ledger's state
// machine an errand's whole way (proposed -> triaged -> approved -> in_progress -> done) and one
// warn per task when an early call is refused; and the read `costs()` (the development agents'
// spend) with its fallback to null when the ledger is off, refuses, answers oddly or is silent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { createLedgerMirror, MAX_QUEUE, TITLE_CHARS, agentCostsOf, idempotencyKey } from '../src/errands/ledger.js';
import { tempDir } from './fixtures/tmp.js';

const T0 = Date.parse('2026-10-17T10:00:00Z');

/** A fake log that records every call. */
function fakeLog() {
  const calls = [];
  const record = (level) => (msg, fields) => calls.push({ level, msg, fields });
  return { calls, info: record('info'), warn: record('warn'), error: record('error') };
}

/** A socket path in a fresh temp directory. */
function socketIn() {
  const dir = tempDir('nep-ledger-');
  return { dir, socket: path.join(dir, 'l.sock') };
}

/**
 * A fake ledger on `socketPath`: records each request; `task.add` answers a task id stable per
 * idempotency key, `attempt.start` an attempt id, the rest `{}`. `refuse(op)` answers that op
 * `ok: false`; `dropFirst` closes the connection on the first request without answering.
 */
function fakeLedger(socketPath, { refuse = () => false, dropFirst = false, results = {}, silent = () => false } = {}) {
  const requests = [];
  const addIds = new Map();
  let attempts = 0;
  let dropped = !dropFirst;
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const request = JSON.parse(line);
        requests.push(request);
        if (!dropped) {
          dropped = true;
          socket.destroy();
          return;
        }
        if (silent(request.op)) continue;
        if (refuse(request.op, request)) {
          socket.write(`${JSON.stringify({ id: request.id, ok: false, error: { code: 'bad-transition', message: 'no' } })}\n`);
          continue;
        }
        let result = {};
        if (Object.hasOwn(results, request.op)) {
          result = results[request.op];
        } else if (request.op === 'task.add') {
          if (!addIds.has(request.idempotency)) addIds.set(request.idempotency, `L${addIds.size + 1}`);
          result = { id: addIds.get(request.idempotency) };
        } else if (request.op === 'attempt.start') {
          attempts += 1;
          result = { id: `A${attempts}` };
        }
        socket.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
      }
    });
  });
  const listening = new Promise((resolve) => server.listen(socketPath, resolve));
  const close = () => new Promise((resolve) => {
    for (const socket of sockets) socket.destroy();
    server.close(() => resolve());
  });
  return { requests, listening, close };
}

const queued = (overrides = {}) => ({
  id: 't0000001',
  agent: 'web',
  goal: 'find the release notes of the editor',
  requester: { userId: 'u1', kind: 'member' },
  origin: { channelId: 'c1', messageId: 'm1' },
  scope: 'group',
  state: 'queued',
  result: null,
  usage: null,
  error: null,
  ...overrides,
});

/** The requests without their per-connection `id`. */
const shapes = (requests) => requests.map(({ op, args, idempotency }) => ({ op, args, idempotency }));

test('ledger mirror: every transition of a done errand, with its idempotency key; the heartbeat at most once a minute', async () => {
  const { dir, socket } = socketIn();
  const ledger = fakeLedger(socket);
  await ledger.listening;
  const clock = { t: T0 };
  const log = fakeLog();
  const mirror = createLedgerMirror({ socketPath: socket, log, now: () => clock.t });
  const ledgerIds = [];
  try {
    const task = queued({ goal: `${'α'.repeat(130)}\n tail` });
    assert.equal(mirror.enabled(), true);
    assert.equal(mirror.add(task, { guildId: 'g1', limits: { steps: 25, usd: 0.5, seconds: 300 }, onLedgerId: (id) => ledgerIds.push(id) }), true);
    await mirror.idle();
    assert.deepEqual(ledgerIds, ['L1']);
    const running = { ...task, state: 'running' };
    mirror.start(running, { limits: { steps: 25, seconds: 300 }, model: 'openrouter/vendor/model' });
    clock.t += 10_000;
    assert.equal(mirror.progress(running), false, 'within a minute of the start: no heartbeat');
    clock.t += 60_000;
    assert.equal(mirror.progress(running), true);
    clock.t += 5_000;
    assert.equal(mirror.progress(running), false);
    const done = {
      ...running,
      state: 'done',
      usage: { input: 10, output: 5, usd: 0.042, steps: 7, seconds: 80 },
      result: { text: 'x'.repeat(50), sources: ['https://example.org'], files: [{ path: '/out/t0000001/a.png', name: 'a.png', contentType: 'image/png', bytes: 12 }], withheld: ['/etc/hidden'] },
    };
    mirror.finish(done, { maxChars: 20 });
    await mirror.idle();
    const key = (op) => idempotencyKey('t0000001', op);
    assert.deepEqual(shapes(ledger.requests), [
      {
        op: 'task.add',
        args: {
          lane: 'errand',
          project: null,
          title: 'α'.repeat(TITLE_CHARS),
          description: task.goal,
          requester: 'persona:u1',
          role: 'web',
          subscriber: 'core:g1:c1',
          metadata: { coreId: 't0000001', scope: 'group', agent: 'web' },
        },
        idempotency: 'errand:t0000001:task.add',
      },
      { op: 'task.transition', args: { id: 'L1', to: 'triaged', set: { role: 'web', budget_usd: 0.5, step_cap: 25, estimate_minutes: 5 } }, idempotency: key('task.transition:triaged') },
      { op: 'task.transition', args: { id: 'L1', to: 'approved' }, idempotency: key('task.transition:approved') },
      { op: 'task.claim', args: { id: 'L1', lease_seconds: 360 }, idempotency: key('task.claim') },
      { op: 'attempt.start', args: { task_id: 'L1', principal: 'core', role: 'web', model: 'openrouter/vendor/model', worktree: null }, idempotency: key('attempt.start') },
      { op: 'task.heartbeat', args: { id: 'L1', lease_seconds: 360 }, idempotency: key(`task.heartbeat:${Math.floor((T0 + 70_000) / 60_000)}`) },
      { op: 'attempt.end', args: { id: 'A1', outcome: 'done', steps: 7, cost_usd: 0.042 }, idempotency: key('attempt.end') },
      { op: 'task.result', args: { task_id: 'L1', kind: 'summary', text: 'x'.repeat(20), metadata: { withheld: ['/etc/hidden'] } }, idempotency: key('task.result:summary') },
      { op: 'task.result', args: { task_id: 'L1', kind: 'file', uri: 'file:t0000001/a.png', metadata: { name: 'a.png', contentType: 'image/png', bytes: 12 } }, idempotency: key('task.result:file:a.png') },
      { op: 'task.transition', args: { id: 'L1', to: 'done' }, idempotency: key('task.transition:done') },
    ]);
    assert.deepEqual(ledger.requests.map((request) => request.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'one request id each, in order');
    const recorded = JSON.stringify(log.calls);
    assert.ok(!recorded.includes('α') && !recorded.includes('xxxxx') && !recorded.includes('u1'), 'no goal, result or member id in a log line');
  } finally {
    mirror.close();
    await ledger.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ledger mirror: a failed errand closes with its error code; a cancel ends the attempt and closes cancelled-by-<who>; a queued cancel has no attempt', async () => {
  const { dir, socket } = socketIn();
  const ledger = fakeLedger(socket);
  await ledger.listening;
  const mirror = createLedgerMirror({ socketPath: () => socket, log: fakeLog(), now: () => T0 });
  try {
    const failing = queued({ id: 'tfail', requester: { userId: null, kind: 'persona' }, origin: { channelId: null, messageId: null } });
    mirror.add(failing, { guildId: 'g1' });
    mirror.start({ ...failing, state: 'running' }, { limits: {} });
    mirror.finish({ ...failing, state: 'failed', error: 'timeout', usage: { usd: 0.1, steps: 3 }, result: null });
    const cancelled = queued({ id: 'tcanc' });
    mirror.add(cancelled, { guildId: 'g1' });
    mirror.start({ ...cancelled, state: 'running' }, { limits: { seconds: 120 } });
    mirror.cancel({ ...cancelled, state: 'cancelled', error: 'cancelled' }, { by: 'owner' });
    const early = queued({ id: 'tearly' });
    mirror.add(early, { guildId: 'g1' });
    mirror.cancel({ ...early, state: 'cancelled', error: 'cancelled' }, { by: 'persona' });
    await mirror.idle();
    const by = (id) => shapes(ledger.requests).filter((request) => request.idempotency.startsWith(`errand:${id}:`)).map(({ op, args }) => [op, args]);
    assert.deepEqual(by('tfail'), [
      ['task.add', { lane: 'errand', project: null, title: failing.goal, description: failing.goal, requester: 'persona:self', role: 'web', subscriber: 'core:g1', metadata: { coreId: 'tfail', scope: 'group', agent: 'web' } }],
      ['task.transition', { id: 'L1', to: 'triaged', set: { role: 'web', estimate_minutes: 10 } }],
      ['task.transition', { id: 'L1', to: 'approved' }],
      ['task.claim', { id: 'L1', lease_seconds: 660 }],
      ['attempt.start', { task_id: 'L1', principal: 'core', role: 'web', model: null, worktree: null }],
      ['attempt.end', { id: 'A1', outcome: 'failed', steps: 3, cost_usd: 0.1 }],
      ['task.transition', { id: 'L1', to: 'failed', close_reason: 'timeout' }],
    ]);
    assert.deepEqual(by('tcanc').slice(3), [
      ['task.claim', { id: 'L2', lease_seconds: 180 }],
      ['attempt.start', { task_id: 'L2', principal: 'core', role: 'web', model: null, worktree: null }],
      ['attempt.end', { id: 'A2', outcome: 'cancelled', steps: 0, cost_usd: 0 }],
      ['task.transition', { id: 'L2', to: 'cancelled', close_reason: 'cancelled-by-owner' }],
    ]);
    assert.deepEqual(by('tearly').slice(3), [['task.transition', { id: 'L3', to: 'cancelled', close_reason: 'cancelled-by-persona' }]]);
  } finally {
    mirror.close();
    await ledger.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ledger mirror: a refused connection queues the calls, logs once a minute (codes only), and replays them in order once the ledger answers', async () => {
  const { dir, socket } = socketIn();
  const clock = { t: T0 };
  const log = fakeLog();
  const mirror = createLedgerMirror({ socketPath: socket, log, now: () => clock.t, reconnectMinMs: 10, reconnectMaxMs: 20 });
  let ledger = null;
  try {
    const task = queued();
    const ids = [];
    mirror.add(task, { guildId: 'g1', onLedgerId: (id) => ids.push(id) });
    mirror.start({ ...task, state: 'running' }, { limits: { seconds: 60 } });
    // Several reconnects fail meanwhile.
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(mirror.queued(), 5, 'nothing delivered, nothing lost');
    const unavailable = log.calls.filter((call) => call.msg === 'errands: ledger unavailable');
    assert.equal(unavailable.length, 1, 'once per minute');
    assert.equal(unavailable[0].level, 'warn');
    assert.deepEqual(Object.keys(unavailable[0].fields).sort(), ['code', 'queued']);
    assert.ok(['ENOENT', 'ECONNREFUSED'].includes(unavailable[0].fields.code));
    clock.t += 61_000;
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(log.calls.filter((call) => call.msg === 'errands: ledger unavailable').length, 2, 'again after a minute');
    ledger = fakeLedger(socket);
    await ledger.listening;
    await mirror.idle();
    assert.deepEqual(ledger.requests.map((request) => request.op), ['task.add', 'task.transition', 'task.transition', 'task.claim', 'attempt.start']);
    assert.deepEqual(ids, ['L1']);
    assert.equal(mirror.queued(), 0);
  } finally {
    mirror.close();
    await ledger?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ledger mirror: a call whose answer is lost is replayed with the same idempotency key; a refused call is logged and dropped, the next goes on', async () => {
  const { dir, socket } = socketIn();
  const ledger = fakeLedger(socket, { dropFirst: true, refuse: (op, request) => op === 'task.transition' && request.args.to === 'approved' });
  await ledger.listening;
  const log = fakeLog();
  const mirror = createLedgerMirror({ socketPath: socket, log, now: () => T0, reconnectMinMs: 10, reconnectMaxMs: 20 });
  try {
    const task = queued();
    mirror.add(task, { guildId: 'g1' });
    mirror.start({ ...task, state: 'running' }, { limits: { seconds: 60 } });
    await mirror.idle();
    assert.deepEqual(ledger.requests.map((request) => [request.op, request.idempotency]), [
      ['task.add', 'errand:t0000001:task.add'],
      ['task.add', 'errand:t0000001:task.add'],
      ['task.transition', 'errand:t0000001:task.transition:triaged'],
      ['task.transition', 'errand:t0000001:task.transition:approved'],
      ['task.claim', 'errand:t0000001:task.claim'],
      ['attempt.start', 'errand:t0000001:attempt.start'],
    ]);
    const refused = log.calls.filter((call) => call.msg === 'errands: ledger refused');
    assert.deepEqual(refused.map((call) => call.fields), [{ id: 't0000001', op: 'task.transition:approved', code: 'bad-transition' }]);
  } finally {
    mirror.close();
    await ledger.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The ledger's state machine for one errand lane, as a `refuse` hook of fakeLedger: `task.add`
 * opens `proposed`; `task.transition` moves only along proposed -> triaged (with role, budget and
 * estimate) -> approved, and from in_progress to a closed state; `task.claim` needs approved;
 * `attempt.start`, `task.heartbeat`, `task.result` need in_progress. `triage` false refuses the
 * triage. The statuses by ledger id, the attempts and the results are kept.
 */
function machine({ triage = true } = {}) {
  const status = new Map();
  const ids = new Map();
  const attempts = [];
  const results = [];
  const refuse = (op, request) => {
    const args = request.args;
    if (op === 'task.add') {
      if (state.refuseAdd) return true;
      if (!ids.has(request.idempotency)) ids.set(request.idempotency, `L${ids.size + 1}`);
      status.set(ids.get(request.idempotency), 'proposed');
      return false;
    }
    const id = args.id ?? args.task_id;
    const from = status.get(id);
    let to = from;
    if (op === 'task.transition') {
      const set = args.set ?? {};
      const allowed = (from === 'proposed' && args.to === 'triaged' && triage && set.role && set.budget_usd > 0 && set.estimate_minutes > 0)
        || (from === 'triaged' && args.to === 'approved')
        || (from === 'in_progress' && ['done', 'failed', 'cancelled'].includes(args.to))
        || (['proposed', 'triaged', 'approved'].includes(from) && args.to === 'cancelled');
      if (!allowed) return true;
      to = args.to;
    } else if (op === 'task.claim') {
      if (from !== 'approved') return true;
      to = 'in_progress';
    } else if (op === 'attempt.end') {
      if (!attempts.some((attempt) => attempt.id === args.id)) return true;
      return false;
    } else if (from !== 'in_progress') {
      return true;
    }
    if (op === 'attempt.start') attempts.push({ id: `A${attempts.length + 1}`, task: id });
    if (op === 'task.result') results.push([id, args.kind]);
    status.set(id, to);
    return false;
  };
  const state = { refuse, status, attempts, results, refuseAdd: false };
  return state;
}

test('ledger mirror: against the ledger\'s machine a mirrored errand goes proposed -> triaged -> approved -> in_progress -> done with its attempt and results, and nothing is refused', async () => {
  const { dir, socket } = socketIn();
  const states = machine();
  const ledger = fakeLedger(socket, { refuse: states.refuse });
  await ledger.listening;
  const log = fakeLog();
  const mirror = createLedgerMirror({ socketPath: socket, log, now: () => T0 });
  try {
    const limits = { steps: 9, usd: 0.3, seconds: 90 };
    const task = queued();
    mirror.add(task, { guildId: 'g1', limits });
    await mirror.idle();
    assert.equal(states.status.get('L1'), 'approved');
    mirror.start({ ...task, state: 'running' }, { limits, model: 'openrouter/vendor/model' });
    await mirror.idle();
    assert.equal(states.status.get('L1'), 'in_progress');
    mirror.finish({ ...task, state: 'done', usage: { usd: 0.01, steps: 2 }, result: { text: 'found it', files: [{ name: 'a.png', contentType: 'image/png', bytes: 3 }] } });
    await mirror.idle();
    assert.equal(states.status.get('L1'), 'done');
    assert.deepEqual(states.attempts, [{ id: 'A1', task: 'L1' }]);
    assert.deepEqual(states.results, [['L1', 'summary'], ['L1', 'file']]);
    assert.deepEqual(ledger.requests.filter((request) => request.op === 'task.transition').map((request) => request.args.to), ['triaged', 'approved', 'done']);
    assert.deepEqual(ledger.requests.find((request) => request.args.to === 'triaged').args.set, { role: 'web', budget_usd: 0.3, step_cap: 9, estimate_minutes: 2 });
    assert.deepEqual(log.calls.filter((call) => call.level === 'warn'), [], 'no refused or skipped call');
  } finally {
    mirror.close();
    await ledger.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ledger mirror: when an early call is refused, the later calls of the task are still sent and only one warn is logged per task', async () => {
  const { dir, socket } = socketIn();
  const states = machine({ triage: false });
  const ledger = fakeLedger(socket, { refuse: states.refuse });
  await ledger.listening;
  const log = fakeLog();
  const mirror = createLedgerMirror({ socketPath: socket, log, now: () => T0 });
  try {
    for (const id of ['ta', 'tb']) {
      const task = queued({ id });
      mirror.add(task, { guildId: 'g1', limits: { usd: 0.3 } });
      mirror.start({ ...task, state: 'running' }, { limits: {} });
      mirror.progress({ ...task, state: 'running' });
      mirror.finish({ ...task, state: 'done', usage: { usd: 0.01, steps: 2 }, result: { text: 'found it' } });
    }
    await mirror.idle();
    const ops = ledger.requests.filter((request) => request.idempotency.startsWith('errand:ta:')).map((request) => request.idempotency.slice('errand:ta:'.length));
    assert.deepEqual(ops, ['task.add', 'task.transition:triaged', 'task.transition:approved', 'task.claim', 'attempt.start', 'task.result:summary', 'task.transition:done']);
    const warns = log.calls.filter((call) => call.level === 'warn');
    assert.deepEqual(warns.map((call) => [call.msg, call.fields]), [
      ['errands: ledger refused', { id: 'ta', op: 'task.transition:triaged', code: 'bad-transition' }],
      ['errands: ledger refused', { id: 'tb', op: 'task.transition:triaged', code: 'bad-transition' }],
    ]);
    // A refused task.add: the later calls of the task have no ledger id and are dropped, unlogged.
    const lost = createLedgerMirror({ socketPath: socket, log, now: () => T0 });
    const lostTask = queued({ id: 'tc' });
    states.refuseAdd = true;
    lost.add(lostTask, { guildId: 'g1', limits: { usd: 0.3 } });
    lost.start({ ...lostTask, state: 'running' }, { limits: {} });
    lost.finish({ ...lostTask, state: 'failed', error: 'timeout' });
    await lost.idle();
    lost.close();
    assert.deepEqual(ledger.requests.filter((request) => request.idempotency.startsWith('errand:tc:')).map((request) => request.op), ['task.add']);
    assert.deepEqual(log.calls.filter((call) => call.level === 'warn').slice(2).map((call) => [call.msg, call.fields]), [
      ['errands: ledger refused', { id: 'tc', op: 'task.add', code: 'bad-transition' }],
    ]);
  } finally {
    mirror.close();
    await ledger.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ledger mirror: the queue keeps at most MAX_QUEUE calls; one more is dropped and logged once', async () => {
  const { dir, socket } = socketIn();
  const log = fakeLog();
  const mirror = createLedgerMirror({ socketPath: socket, log, now: () => T0, reconnectMinMs: 10_000, reconnectMaxMs: 10_000 });
  try {
    // Three calls per errand (task.add, two task.transition).
    for (let i = 0; i < Math.ceil(MAX_QUEUE / 3) + 3; i += 1) mirror.add(queued({ id: `t${i}` }), { guildId: 'g1' });
    assert.equal(mirror.queued(), MAX_QUEUE);
    assert.equal(log.calls.filter((call) => call.msg === 'errands: ledger queue full').length, 1);
  } finally {
    mirror.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ledger mirror: with agents.ledger.socket null it is disabled: nothing queued, nothing connects', async () => {
  const connects = [];
  const connect = (where) => {
    connects.push(where);
    throw new Error('never');
  };
  const settings = { socket: null };
  for (const socketPath of [null, () => settings.socket]) {
    const mirror = createLedgerMirror({ socketPath, log: fakeLog(), connect });
    const task = queued();
    assert.equal(mirror.enabled(), false);
    assert.equal(mirror.add(task, { guildId: 'g1' }), false);
    assert.equal(mirror.start({ ...task, state: 'running' }, { limits: {} }), false);
    assert.equal(mirror.progress(task), false);
    assert.equal(mirror.finish({ ...task, state: 'done', result: { text: 'ok' } }), false);
    assert.equal(mirror.cancel(task, { by: 'owner' }), false);
    assert.equal(mirror.mirrorOpen([task], { guildId: 'g1' }), 0);
    assert.equal(mirror.queued(), 0);
    await mirror.idle();
    mirror.close();
  }
  assert.deepEqual(connects, []);
});

test('ledger mirror: at a restart the open tasks without a ledger id are mirrored with the same task.add key, never doubled', async () => {
  const { dir, socket } = socketIn();
  const ledger = fakeLedger(socket);
  await ledger.listening;
  const log = fakeLog();
  try {
    // Before the restart: the task.add of t1 reached the ledger, its answer did not reach tasks.json.
    const before = createLedgerMirror({ socketPath: socket, log, now: () => T0 });
    before.add(queued({ id: 't1' }), { guildId: 'g1' });
    await before.idle();
    before.close();
    const after = createLedgerMirror({ socketPath: socket, log, now: () => T0 });
    const kept = [];
    const tasks = [
      queued({ id: 't1', state: 'running' }),
      queued({ id: 't2' }),
      queued({ id: 't3', ledgerId: 'L9' }),
      queued({ id: 't4', state: 'done' }),
    ];
    assert.equal(after.mirrorOpen(tasks, { guildId: 'g1', onLedgerId: (task, id) => kept.push([task.id, id]) }), 2);
    await after.idle();
    assert.deepEqual(kept, [['t1', 'L1'], ['t2', 'L2']], 'the same ledger task for the same key');
    const adds = ledger.requests.filter((request) => request.op === 'task.add').map((request) => request.idempotency);
    assert.deepEqual(adds, ['errand:t1:task.add', 'errand:t1:task.add', 'errand:t2:task.add']);
    // The one that had its ledger id is closed on its own id.
    after.finish({ ...tasks[2], state: 'failed', error: 'restarted' });
    await after.idle();
    assert.deepEqual(shapes(ledger.requests).at(-1), { op: 'task.transition', args: { id: 'L9', to: 'failed', close_reason: 'restarted' }, idempotency: 'errand:t3:task.transition:failed' });
    after.close();
  } finally {
    await ledger.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A `costs.agents` answer as the ledger gives it. */
const window = (runs, input, output, usd) => ({ runs, input, output, usd });
const LEDGER_COSTS = {
  thinker: {
    today: window(2, 300_000, 9_000, 1.5), last7: window(5, 900_000, 30_000, 4.25), last30: window(5, 900_000, 30_000, 4.25),
    last_wave: { wave: 3, turns: 2, usd: 1.5, context_mean: 120_000, context_peak: 210_000 },
  },
  dev: { today: window(1, 50_000, 4_000, 0.4), last7: window(1, 50_000, 4_000, 0.4), last30: window(1, 50_000, 4_000, 0.4) },
  writer: { today: window(0, 0, 0, 0), last7: window(0, 0, 0, 0), last30: window(0, 0, 0, 0) },
};

test('ledger costs: one costs.agents request with now, no idempotency key, nothing queued; the answer kept as the card reads it', async () => {
  const { dir, socket } = socketIn();
  const ledger = fakeLedger(socket, { results: { 'costs.agents': LEDGER_COSTS } });
  await ledger.listening;
  const log = fakeLog();
  const mirror = createLedgerMirror({ socketPath: socket, log, now: () => T0 });
  try {
    assert.deepEqual(await mirror.costs(), LEDGER_COSTS);
    assert.deepEqual(ledger.requests.map(({ op, args, idempotency }) => ({ op, args, idempotency })), [{ op: 'costs.agents', args: { now: T0 }, idempotency: undefined }]);
    assert.equal(mirror.queued(), 0);
    await mirror.costs({ now: T0 + 5 });
    assert.deepEqual(ledger.requests.at(-1).args, { now: T0 + 5 });
    assert.deepEqual(log.calls, []);
  } finally {
    mirror.close();
    await ledger.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ledger costs: null with no socket, a missing socket, a refusal or a silent ledger, logged at most once a minute, never thrown', async () => {
  assert.equal(await createLedgerMirror({ socketPath: null, connect: () => assert.fail('no connection') }).costs(), null);
  const { dir, socket } = socketIn();
  const log = fakeLog();
  const clock = { t: T0 };
  const where = { path: path.join(dir, 'none.sock') };
  const mirror = createLedgerMirror({ socketPath: () => where.path, log, now: () => clock.t, costsTimeoutMs: 50 });
  const warns = () => log.calls.filter((call) => call.level === 'warn').map((call) => [call.msg, call.fields.code]);
  assert.equal(await mirror.costs(), null, 'nothing listens');
  where.path = socket;
  const refusing = fakeLedger(socket, { refuse: (op) => op === 'costs.agents' });
  await refusing.listening;
  try {
    assert.equal(await mirror.costs(), null, 'refused');
  } finally {
    await refusing.close();
  }
  assert.deepEqual(warns(), [['errands: ledger unavailable', 'ENOENT']], 'the refusal within the minute is not logged again');
  fs.rmSync(socket, { force: true });
  const silent = fakeLedger(socket, { silent: (op) => op === 'costs.agents' });
  await silent.listening;
  try {
    clock.t += 60_000;
    const started = Date.now();
    assert.equal(await mirror.costs(), null, 'no answer in time');
    assert.ok(Date.now() - started < 2000);
  } finally {
    mirror.close();
    await silent.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(warns().at(-1), ['errands: ledger unavailable', 'timeout']);
  assert.equal(warns().length, 2);
  assert.equal(await mirror.costs(), null, 'closed');
});

test('agentCostsOf: the three agents with every window, odd numbers as 0, the last wave or null; not an object gives null', () => {
  assert.equal(agentCostsOf(null), null);
  assert.equal(agentCostsOf([1]), null);
  const totals = agentCostsOf({ thinker: { today: { runs: 'x', usd: 1 }, last_wave: { wave: 'w', context_peak: 9 } }, other: {} });
  assert.deepEqual(Object.keys(totals), ['thinker', 'dev', 'writer']);
  assert.deepEqual(totals.thinker.today, { runs: 0, input: 0, output: 0, usd: 1 });
  assert.deepEqual(totals.dev.last30, { runs: 0, input: 0, output: 0, usd: 0 });
  assert.deepEqual(totals.thinker.last_wave, { wave: 'w', turns: 0, usd: 0, context_mean: null, context_peak: 9 });
  assert.equal(agentCostsOf({}).thinker.last_wave, null);
});
