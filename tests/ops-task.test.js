// Tests for src/ops/task.js: the `/nep task` operations over a real task store (a temp data/
// directory) and a FAKE errand client. The rights: a member may run the web agent but not the
// server one, an owner may run both; a cap refuses with its code; the answer is at once (id and
// `queued`) while the errand runs in the background; a cancel is for the requester or an owner;
// a private chat's task is shown only to its requester or an owner.
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
  const env = createOpsEnv({ hot, store, client: { channels: { cache: new Map() } }, spontaneous: {}, calibrator: { ratio: 1 }, getGuildId: () => 'g1', errands });
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
