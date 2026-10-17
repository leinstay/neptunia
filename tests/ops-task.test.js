// Tests for src/ops/task.js: the `/nep task` operations over a real task store (a temp data/
// directory) and a FAKE errand client. The rights: a member may run the web agent but not the
// server one, an owner may run both; a cap refuses with its code; the answer is at once (id and
// `queued`) while the errand runs in the background; a cancel is for the requester or an owner;
// a private chat's task is shown only to its requester or an owner. `task.show` (owner-only) reads
// one ledger task whole over a FAKE ledger socket: inline, or as a file when long; off without one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runOp } from '../src/ops/index.js';
import { createOpsEnv } from '../src/ops/env.js';
import { createTaskStores } from '../src/errands/store.js';
import { createErrandService } from '../src/errands/service.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { createDiscordInterface } from '../src/interface/discord.js';
import { SHOW_INLINE_CHARS } from '../src/ops/task.js';
import { labels } from './fixtures/labels.js';
import { startFakeLedger, deadSocket } from './fixtures/fake-ledger.js';

// The Discord interface's capabilities object, as src/index.js injects it.
const DISCORD = createDiscordInterface().capabilities;

const OWNER = '42';
const MEMBER = '7';
const OTHER = '8';

/** A fake errand client: records each run and lets the test end it. */
function fakeClient({ configured = true } = {}) {
  const runs = [];
  const cancels = [];
  const gates = new Map();
  return {
    runs,
    cancels,
    configured: () => configured,
    run(task) {
      runs.push(task);
      return new Promise((resolve) => gates.set(task.id, resolve));
    },
    cancel(task) {
      cancels.push(task);
      gates.get(task.id)?.({ status: 'cancelled', error: 'cancelled' });
      return true;
    },
    end(id, outcome = { status: 'done', result: { text: 'ok' }, usage: { usd: 0.01 } }) {
      gates.get(id)?.(outcome);
    },
  };
}

function makeEnv({ agents = {}, configured = true } = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-ops-task-'));
  const hot = {
    config: { bot: { owners: [OWNER], access: {} }, features: {}, agents: { maxOpen: 3, web: { enabled: true, daily: { tasks: 10, usd: 5 } }, server: { enabled: true, daily: { tasks: 10, usd: 5 } }, ...agents } },
    prompts: { labels: {} },
    rootDir,
    reloadConfig: () => true,
  };
  const client = fakeClient({ configured });
  const finished = [];
  const stores = createTaskStores({ dataDir: path.join(rootDir, 'data'), config: () => hot.config });
  const errands = createErrandService({ client, stores, hot, getGuildId: () => 'g1', onFinished: (task) => finished.push(task) });
  const store = { state: { data: {}, markDirty() {} } };
  const env = createOpsEnv({ discord: DISCORD, hot, store, client: { channels: { cache: new Map() } }, spontaneous: {}, calibrator: { ratio: 1 }, getGuildId: () => 'g1', errands });
  return { env, client, errands, finished, stores };
}

const ctx = (env, userId, extra = {}) => ({ env, guildId: 'g1', channelId: 'c1', userId, roleIds: [], ...extra });

test('task.run: a member may run the web agent; the answer is at once, the errand runs in the background', async () => {
  const { env, client, errands, finished, stores } = makeEnv();
  await withCapturedLogs(async () => {
    const result = await runOp('task.run', { agent: 'web', goal: 'find the changelog' }, ctx(env, MEMBER, { sourceMessageId: 'm5' }));
    assert.equal(result.status, 'ok');
    const { id, state } = result.data.task;
    assert.equal(state, 'queued');
    assert.match(result.summary, new RegExp(`^task ${id}: queued`));
    assert.equal(client.runs.length, 0, 'nothing was sent before the answer');
    const task = stores.get('g1').get(id);
    assert.deepEqual(task.requester, { userId: MEMBER, kind: 'member' });
    assert.deepEqual(task.origin, { channelId: 'c1', messageId: 'm5' });
    assert.equal(task.scope, 'group');
    await new Promise((r) => setImmediate(r));
    assert.equal(client.runs.length, 1);
    assert.equal(client.runs[0].context.scope, 'group');
    assert.deepEqual(client.runs[0].limits, { steps: 25, usd: 0.5, seconds: 300 }, 'the profile defaults under agents.web.limits');
    assert.equal(Object.hasOwn(client.runs[0], 'model'), false, 'no model: the runner takes roles.agent.web');
    assert.equal(stores.get('g1').get(id).state, 'running');
    client.end(id);
    await errands.idle();
    assert.equal(stores.get('g1').get(id).state, 'done');
    assert.deepEqual(finished.map((t) => t.id), [id]);
  });
});

test('task.run: a member may not run the server agent; an owner may', async () => {
  const { env, client } = makeEnv();
  await withCapturedLogs(async () => {
    const refused = await runOp('task.run', { agent: 'server', goal: 'list the units' }, ctx(env, MEMBER));
    assert.equal(refused.status, 'denied');
    assert.equal(refused.code, 'owner-only');
    // Through the persona's call too: the requester of her turn is the caller.
    const viaPersona = await runOp('task.run', { agent: 'server', goal: 'list the units' }, ctx(env, MEMBER, { actor: 'persona' }));
    assert.equal(viaPersona.code, 'owner-only');
    const nobody = await runOp('task.run', { agent: 'server', goal: 'list the units' }, ctx(env, null, { actor: 'persona' }));
    assert.equal(nobody.code, 'owner-only');
    const allowed = await runOp('task.run', { agent: 'server', goal: 'list the units' }, ctx(env, OWNER, { actor: 'persona', privateChat: true, channelId: 'dm1' }));
    assert.equal(allowed.status, 'ok');
    await new Promise((r) => setImmediate(r));
    assert.equal(client.runs.at(-1).agent, 'server');
    assert.equal(client.runs.at(-1).context.scope, 'dm', 'asked in a private chat');
  });
});

test('task.run: a cap refuses with its code; a runner that is not set up is not-configured', async () => {
  const { env } = makeEnv({ agents: { maxOpen: 1 } });
  await withCapturedLogs(async () => {
    assert.equal((await runOp('task.run', { agent: 'web', goal: 'one' }, ctx(env, MEMBER))).status, 'ok');
    const second = await runOp('task.run', { agent: 'web', goal: 'two' }, ctx(env, MEMBER));
    assert.equal(second.status, 'failed');
    assert.equal(second.code, 'cap-open');
    const bad = await runOp('task.run', { agent: 'mail', goal: 'x' }, ctx(env, MEMBER));
    assert.equal(bad.status, 'invalid');
  });
  const off = makeEnv({ configured: false });
  await withCapturedLogs(async () => {
    const result = await runOp('task.run', { agent: 'web', goal: 'x' }, ctx(off.env, MEMBER));
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'not-configured');
  });
});

test('task.cancel: only the requester of the task or an owner', async () => {
  const { env, client, stores } = makeEnv();
  await withCapturedLogs(async () => {
    const first = (await runOp('task.run', { agent: 'web', goal: 'one' }, ctx(env, MEMBER))).data.task.id;
    const second = (await runOp('task.run', { agent: 'web', goal: 'two' }, ctx(env, MEMBER))).data.task.id;
    await new Promise((r) => setImmediate(r));
    const refused = await runOp('task.cancel', { id: first }, ctx(env, OTHER));
    assert.equal(refused.status, 'denied');
    assert.equal(refused.code, 'not-requester');
    const own = await runOp('task.cancel', { id: first }, ctx(env, MEMBER));
    assert.equal(own.status, 'ok');
    assert.equal(stores.get('g1').get(first).state, 'cancelled');
    assert.deepEqual(client.cancels.map((t) => t.id), [first], 'the runner is told');
    const byOwner = await runOp('task.cancel', { id: second }, ctx(env, OWNER));
    assert.equal(byOwner.status, 'ok');
    const again = await runOp('task.cancel', { id: second }, ctx(env, OWNER));
    assert.equal(again.status, 'failed');
    assert.equal(again.code, 'not-open');
    const unknown = await runOp('task.cancel', { id: 'tnope' }, ctx(env, OWNER));
    assert.equal(unknown.status, 'invalid');
  });
});

test('task.status and task.list: the open ones, one by id, a private chat\'s only for its requester or an owner', async () => {
  const { env } = makeEnv();
  await withCapturedLogs(async () => {
    const group = (await runOp('task.run', { agent: 'web', goal: 'public errand' }, ctx(env, MEMBER))).data.task.id;
    const dm = (await runOp('task.run', { agent: 'web', goal: 'private errand' }, ctx(env, MEMBER, { privateChat: true, channelId: 'dm1' }))).data.task.id;
    const open = await runOp('task.status', {}, ctx(env, OTHER));
    assert.equal(open.status, 'ok');
    assert.ok(open.summary.includes(group));
    assert.ok(!open.summary.includes(dm), 'another member does not see a private chat\'s task');
    const one = await runOp('task.status', { id: dm }, ctx(env, MEMBER));
    assert.ok(one.summary.startsWith(`${dm} web`));
    assert.equal((await runOp('task.status', { id: dm }, ctx(env, OTHER))).code, 'not-found');
    const listed = await runOp('task.list', {}, ctx(env, OWNER));
    assert.ok(listed.summary.includes(group) && listed.summary.includes(dm));
    assert.ok(listed.summary.split('\n')[0].startsWith(dm), 'newest first');
  });
});

test('task.status: a finished task whose files the runner deleted says files-expired', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-ops-task-out-'));
  const { env, client, errands } = makeEnv({ agents: { web: { enabled: true, out, daily: { tasks: 10, usd: 5 } } } });
  await withCapturedLogs(async () => {
    const id = (await runOp('task.run', { agent: 'web', goal: 'a meme' }, ctx(env, MEMBER))).data.task.id;
    while (client.runs.length === 0) await new Promise((resolve) => setImmediate(resolve));
    client.end(id, { status: 'done', result: { text: 'ok', files: [{ path: '/x/a.png', name: 'a.png' }] }, usage: { usd: 0.01 } });
    await errands.idle();
    const one = await runOp('task.status', { id }, ctx(env, MEMBER));
    assert.ok(one.summary.startsWith(`${id} web done (files-expired) `), one.summary);
  });
});

test('task.status: a task mirrored into the ledger shows its ledger id; task.cancel tells the service who cancelled', async () => {
  const { env, errands, stores } = makeEnv();
  await withCapturedLogs(async () => {
    const id = (await runOp('task.run', { agent: 'web', goal: 'mirrored' }, ctx(env, MEMBER))).data.task.id;
    const plain = await runOp('task.status', { id }, ctx(env, MEMBER));
    assert.ok(!plain.summary.includes('ledger:'), 'no line without a ledger id');
    stores.get('g1').setLedgerId(id, 'L42');
    const one = await runOp('task.status', { id }, ctx(env, MEMBER));
    assert.ok(one.summary.split('\n').includes('ledger: L42'), one.summary);
    const listed = await runOp('task.list', {}, ctx(env, MEMBER));
    assert.ok(!listed.summary.includes('ledger:'), 'task.list unchanged');
    const seen = [];
    const cancel = errands.cancel;
    errands.cancel = (args) => {
      seen.push(args.by);
      return cancel(args);
    };
    const other = (await runOp('task.run', { agent: 'web', goal: 'two' }, ctx(env, MEMBER))).data.task.id;
    const hers = (await runOp('task.run', { agent: 'web', goal: 'three' }, ctx(env, null, { actor: 'persona' }))).data.task.id;
    await runOp('task.cancel', { id }, ctx(env, MEMBER));
    await runOp('task.cancel', { id: other }, ctx(env, OWNER));
    await runOp('task.cancel', { id: hers }, ctx(env, null, { actor: 'persona' }));
    assert.deepEqual(seen, ['requester', 'owner', 'persona']);
    await errands.idle();
  });
});

// ---- task.show: one ledger task whole, over a FAKE ledger socket ------------------------

/** A ledger task as `task.show` answers it, its description `size` characters long. */
function shownTask(id, size = 40) {
  return {
    task: { id, lane: 'dev', status: 'done', title: 'a ledger task', description: 'd'.repeat(size), acceptance_criteria: 'it works' },
    attempts: [{ id: 'A-1', role: 'nep-implementer', model: 'm', outcome: 'done', steps: 3, cost_usd: 0.25 }],
    results: [{ kind: 'prompt', body: 'the prompt' }, { kind: 'spec', body: 'the spec' }],
    questions: [],
    events: [{ seq: 1, actor: 'lead', type: 'created' }],
  };
}

/** An env whose ledger socket is `socket` and whose labels are the fixture's. */
function showEnv(socket) {
  const made = makeEnv();
  made.env.hot.config.agents.ledger = { socket };
  made.env.hot.prompts.labels = labels;
  return made;
}

test('task.show: the owner gets the ledger task whole through task.show; a member is refused owner-only', async () => {
  const ledger = await startFakeLedger((request) => (request.op === 'task.show' ? { ok: true, result: shownTask(request.args.id) } : null));
  try {
    const { env } = showEnv(ledger.socket);
    const result = await runOp('task.show', { id: ' T-q3moxl ' }, ctx(env, OWNER));
    assert.equal(result.status, 'ok', result.summary);
    const lines = result.summary.split('\n');
    assert.equal(lines[0], 'T-q3moxl | dev | done | a ledger task');
    for (const part of ['description:\n' + 'd'.repeat(40), 'acceptance:\nit works', 'A-1 | nep-implementer | m | done | 3 steps | 0.250 USD', '[prompt]', 'the prompt', '[spec]', 'the spec', 'questions:\n(none)', 'events:\n1 | - | lead | created']) {
      assert.ok(result.summary.includes(part), part);
    }
    assert.equal(result.data.files, undefined, 'short: inline');
    assert.deepEqual(ledger.requests.map(({ op, args }) => [op, args]), [['task.show', { id: 'T-q3moxl', full: true }]]);
    const member = await runOp('task.show', { id: 'T-q3moxl' }, ctx(env, MEMBER));
    assert.equal(member.status, 'denied');
    assert.equal(member.code, 'owner-only');
    assert.equal(ledger.requests.length, 1, 'no read for a refused caller');
  } finally {
    await ledger.close();
  }
});

test('task.show: a text over the inline limit comes as a file attachment with one short line', async () => {
  const ledger = await startFakeLedger((request) => ({ ok: true, result: shownTask(request.args.id, SHOW_INLINE_CHARS + 500) }));
  try {
    const { env } = showEnv(ledger.socket);
    const result = await runOp('task.show', { id: 'T-big' }, ctx(env, OWNER));
    assert.equal(result.status, 'ok');
    assert.equal(result.data.files.length, 1);
    const [file] = result.data.files;
    assert.equal(file.name, 'T-big.txt');
    const whole = file.attachment.toString('utf8');
    assert.ok(whole.startsWith('T-big | dev | done | a ledger task'));
    assert.ok(whole.includes('d'.repeat(SHOW_INLINE_CHARS + 500)), 'the description whole in the file');
    assert.equal(result.summary, `task T-big: ${whole.length} chars in T-big.txt`);
    assert.ok(result.summary.length < 2000);
  } finally {
    await ledger.close();
  }
});

test('task.show: without a socket or an answer it says ledger off; an unknown id and a refusal answer through their labels', async () => {
  const { env } = showEnv(null);
  const off = await runOp('task.show', { id: 'T-1' }, ctx(env, OWNER));
  assert.deepEqual([off.status, off.code, off.summary], ['failed', 'ledger-off', 'ledger: off']);
  env.hot.config.agents.ledger.socket = deadSocket();
  const dead = await runOp('task.show', { id: 'T-1' }, ctx(env, OWNER));
  assert.deepEqual([dead.status, dead.code, dead.summary], ['failed', 'ledger-unreachable', 'ledger: off']);
  const missing = await runOp('task.show', { id: '  ' }, ctx(env, OWNER));
  assert.deepEqual([missing.status, missing.summary], ['invalid', 'id required']);
  const ledger = await startFakeLedger((request) => ({ ok: false, error: { code: request.args.id === 'T-none' ? 'not-found' : 'forbidden' } }));
  try {
    env.hot.config.agents.ledger.socket = ledger.socket;
    const unknown = await runOp('task.show', { id: 'T-none' }, ctx(env, OWNER));
    assert.deepEqual([unknown.status, unknown.code, unknown.summary], ['invalid', 'not-found', 'no ledger task T-none']);
    const refused = await runOp('task.show', { id: 'T-other' }, ctx(env, OWNER));
    assert.deepEqual([refused.status, refused.code, refused.summary], ['failed', 'ledger-refused', 'ledger refused: forbidden']);
  } finally {
    await ledger.close();
  }
});
