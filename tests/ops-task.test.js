// Tests for src/ops/task.js: the `/nep task` operations over a real task store (a temp data/
// directory) and a FAKE errand client. The rights: a member may run the scout agent but not the
// server one, an owner may run both; a cap refuses with its code; the answer is at once (id and
// `queued`) while the errand runs in the background; a cancel is for the requester or an owner;
// a private chat's task is shown only to its requester or an owner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { runOp } from '../src/ops/index.js';
import { createOpsEnv } from '../src/ops/env.js';
import { createTaskStores } from '../src/errands/store.js';
import { createErrandService } from '../src/errands/service.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { createDiscordInterface } from '../interfaces/discord/index.js';
import { tempDir } from './fixtures/tmp.js';

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
  const rootDir = tempDir('nep-ops-task-');
  const hot = {
    config: {
      bot: { owners: [OWNER], access: {} },
      features: {},
      agents: {
        maxOpen: 3,
        scout: { enabled: true, daily: { tasks: 10 } },
        server: { enabled: true, daily: { tasks: 10 } },
        ...agents,
      },
    },
    prompts: { labels: {} },
    rootDir,
    reloadConfig: () => true,
  };
  const client = fakeClient({ configured });
  const finished = [];
  const stores = createTaskStores({ dataDir: path.join(rootDir, 'data'), config: () => hot.config });
  const errands = createErrandService({
    client,
    stores,
    hot,
    getGuildId: () => 'g1',
    onFinished: (task) => finished.push(task),
  });
  const store = { state: { data: {}, markDirty() {} } };
  const env = createOpsEnv({
    discord: DISCORD,
    hot,
    store,
    client: { channels: { cache: new Map() } },
    spontaneous: {},
    calibrator: { ratio: 1 },
    getGuildId: () => 'g1',
    errands,
  });
  return { env, client, errands, finished, stores };
}

const ctx = (env, userId, extra = {}) => ({ env, guildId: 'g1', channelId: 'c1', userId, roleIds: [], ...extra });

test('task.run: a member may run the scout agent; the answer is at once, the errand runs in the background', async () => {
  const { env, client, errands, finished, stores } = makeEnv();
  await withCapturedLogs(async () => {
    const result = await runOp(
      'task.run',
      { agent: 'scout', goal: 'find the changelog' },
      ctx(env, MEMBER, { sourceMessageId: 'm5' })
    );
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
    assert.deepEqual(
      client.runs[0].limits,
      { steps: 25, seconds: 300 },
      'the profile defaults under agents.scout.limits'
    );
    assert.equal(Object.hasOwn(client.runs[0], 'model'), false, 'no model: the runner takes models.errands.scout');
    assert.equal(stores.get('g1').get(id).state, 'running');
    client.end(id);
    await errands.idle();
    assert.equal(stores.get('g1').get(id).state, 'done');
    assert.deepEqual(
      finished.map((t) => t.id),
      [id]
    );
  });
});

test('task.run: a member may not run the server agent; an owner may', async () => {
  const { env, client } = makeEnv();
  await withCapturedLogs(async () => {
    const refused = await runOp('task.run', { agent: 'server', goal: 'list the units' }, ctx(env, MEMBER));
    assert.equal(refused.status, 'denied');
    assert.equal(refused.code, 'owner-only');
    // Through the persona's call too: the requester of her turn is the caller.
    const viaPersona = await runOp(
      'task.run',
      { agent: 'server', goal: 'list the units' },
      ctx(env, MEMBER, { actor: 'persona' })
    );
    assert.equal(viaPersona.code, 'owner-only');
    const nobody = await runOp(
      'task.run',
      { agent: 'server', goal: 'list the units' },
      ctx(env, null, { actor: 'persona' })
    );
    assert.equal(nobody.code, 'owner-only');
    const allowed = await runOp(
      'task.run',
      { agent: 'server', goal: 'list the units' },
      ctx(env, OWNER, { actor: 'persona', privateChat: true, channelId: 'dm1' })
    );
    assert.equal(allowed.status, 'ok');
    await new Promise((r) => setImmediate(r));
    assert.equal(client.runs.at(-1).agent, 'server');
    assert.equal(client.runs.at(-1).context.scope, 'dm', 'asked in a private chat');
  });
});

test('task.run: a cap refuses with its code; a runner that is not set up is not-configured', async () => {
  const { env } = makeEnv({ agents: { maxOpen: 1 } });
  await withCapturedLogs(async () => {
    assert.equal((await runOp('task.run', { agent: 'scout', goal: 'one' }, ctx(env, MEMBER))).status, 'ok');
    const second = await runOp('task.run', { agent: 'scout', goal: 'two' }, ctx(env, MEMBER));
    assert.equal(second.status, 'failed');
    assert.equal(second.code, 'cap-open');
    const bad = await runOp('task.run', { agent: 'mail', goal: 'x' }, ctx(env, MEMBER));
    assert.equal(bad.status, 'invalid');
  });
  const off = makeEnv({ configured: false });
  await withCapturedLogs(async () => {
    const result = await runOp('task.run', { agent: 'scout', goal: 'x' }, ctx(off.env, MEMBER));
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'not-configured');
  });
});

test('task.cancel: only the requester of the task or an owner', async () => {
  const { env, client, stores } = makeEnv();
  await withCapturedLogs(async () => {
    const first = (await runOp('task.run', { agent: 'scout', goal: 'one' }, ctx(env, MEMBER))).data.task.id;
    const second = (await runOp('task.run', { agent: 'scout', goal: 'two' }, ctx(env, MEMBER))).data.task.id;
    await new Promise((r) => setImmediate(r));
    const refused = await runOp('task.cancel', { id: first }, ctx(env, OTHER));
    assert.equal(refused.status, 'denied');
    assert.equal(refused.code, 'not-requester');
    const own = await runOp('task.cancel', { id: first }, ctx(env, MEMBER));
    assert.equal(own.status, 'ok');
    assert.equal(stores.get('g1').get(first).state, 'cancelled');
    assert.deepEqual(
      client.cancels.map((t) => t.id),
      [first],
      'the runner is told'
    );
    const byOwner = await runOp('task.cancel', { id: second }, ctx(env, OWNER));
    assert.equal(byOwner.status, 'ok');
    const again = await runOp('task.cancel', { id: second }, ctx(env, OWNER));
    assert.equal(again.status, 'failed');
    assert.equal(again.code, 'not-open');
    const unknown = await runOp('task.cancel', { id: 'tnope' }, ctx(env, OWNER));
    assert.equal(unknown.status, 'invalid');
  });
});

test("task.status and task.list: the open ones, one by id, a private chat's only for its requester or an owner", async () => {
  const { env } = makeEnv();
  await withCapturedLogs(async () => {
    const group = (await runOp('task.run', { agent: 'scout', goal: 'public errand' }, ctx(env, MEMBER))).data.task.id;
    const dm = (
      await runOp(
        'task.run',
        { agent: 'scout', goal: 'private errand' },
        ctx(env, MEMBER, { privateChat: true, channelId: 'dm1' })
      )
    ).data.task.id;
    const open = await runOp('task.status', {}, ctx(env, OTHER));
    assert.equal(open.status, 'ok');
    assert.ok(open.summary.includes(group));
    assert.ok(!open.summary.includes(dm), "another member does not see a private chat's task");
    const one = await runOp('task.status', { id: dm }, ctx(env, MEMBER));
    assert.ok(one.summary.startsWith(`${dm} scout`));
    assert.equal((await runOp('task.status', { id: dm }, ctx(env, OTHER))).code, 'not-found');
    const listed = await runOp('task.list', {}, ctx(env, OWNER));
    assert.ok(listed.summary.includes(group) && listed.summary.includes(dm));
    assert.ok(listed.summary.split('\n')[0].startsWith(dm), 'newest first');
  });
});

test('task.status: a finished task whose files the runner deleted says files-expired', async () => {
  const out = tempDir('nep-ops-task-out-');
  const { env, client, errands } = makeEnv({ agents: { scout: { enabled: true, out, daily: { tasks: 10 } } } });
  await withCapturedLogs(async () => {
    const id = (await runOp('task.run', { agent: 'scout', goal: 'a meme' }, ctx(env, MEMBER))).data.task.id;
    while (client.runs.length === 0) await new Promise((resolve) => setImmediate(resolve));
    client.end(id, {
      status: 'done',
      result: { text: 'ok', files: [{ path: '/x/a.png', name: 'a.png' }] },
      usage: { usd: 0.01 },
    });
    await errands.idle();
    const one = await runOp('task.status', { id }, ctx(env, MEMBER));
    assert.ok(one.summary.startsWith(`${id} scout done (files-expired) `), one.summary);
  });
});

test('task.status: a task mirrored into the ledger shows its ledger id; task.cancel tells the service who cancelled', async () => {
  const { env, errands, stores } = makeEnv();
  await withCapturedLogs(async () => {
    const id = (await runOp('task.run', { agent: 'scout', goal: 'mirrored' }, ctx(env, MEMBER))).data.task.id;
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
    const other = (await runOp('task.run', { agent: 'scout', goal: 'two' }, ctx(env, MEMBER))).data.task.id;
    const hers = (await runOp('task.run', { agent: 'scout', goal: 'three' }, ctx(env, null, { actor: 'persona' }))).data
      .task.id;
    await runOp('task.cancel', { id }, ctx(env, MEMBER));
    await runOp('task.cancel', { id: other }, ctx(env, OWNER));
    await runOp('task.cancel', { id: hers }, ctx(env, null, { actor: 'persona' }));
    assert.deepEqual(seen, ['requester', 'owner', 'persona']);
    await errands.idle();
  });
});

/** Ends a fresh scout task of MEMBER with `result` and returns its id. */
async function finishedTask(fixture, goal, result, extra = {}) {
  const { env, client, errands } = fixture;
  const before = client.runs.length;
  const id = (await runOp('task.run', { agent: 'scout', goal }, ctx(env, MEMBER, extra))).data.task.id;
  while (client.runs.length === before) await new Promise((resolve) => setImmediate(resolve));
  client.end(id, { status: 'done', result, usage: { usd: 0.01 } });
  await errands.idle();
  return id;
}

test('task.status without an id lists the open tasks and the finished ones not read yet; task.read marks one read', async () => {
  const fixture = makeEnv();
  const { env, stores } = fixture;
  await withCapturedLogs(async () => {
    const done = await finishedTask(fixture, 'first', { text: 'the answer' });
    const listed = await runOp('task.status', {}, ctx(env, MEMBER));
    assert.ok(listed.summary.includes(`${done} scout done`) && listed.summary.includes('(unread)'), listed.summary);
    const read = await runOp('task.read', { id: done }, ctx(env, MEMBER));
    assert.equal(read.status, 'ok');
    assert.ok(read.summary.includes('the answer'));
    assert.equal(stores.get('g1').get(done).readAt > 0, true);
    assert.equal(
      (await runOp('task.status', {}, ctx(env, MEMBER))).summary,
      'no open tasks',
      'read, so no longer listed'
    );
  });
});

test('task.read: pages of agents.resultMaxChars, the last page marks it read; sources, the error and the file manifest come with the first page', async () => {
  const out = tempDir('nep-ops-task-out-');
  const fixture = makeEnv({ agents: { resultMaxChars: 10, scout: { enabled: true, out, daily: { tasks: 10 } } } });
  const { env, stores } = fixture;
  await withCapturedLogs(async () => {
    const id = await finishedTask(fixture, 'long one', {
      text: 'abcdefghijklmnopqrstuvwxy',
      sources: ['https://example.org/a'],
      files: [{ path: '/x/a.png', name: 'a.png', contentType: 'image/png', bytes: 12 }],
    });
    fs.mkdirSync(path.join(out, id), { recursive: true });
    const first = (await runOp('task.read', { id }, ctx(env, MEMBER))).summary.split('\n');
    assert.ok(first.includes('source 1: https://example.org/a'));
    assert.ok(first.includes(`file: file:${id}/a.png (image/png, 12 bytes)`));
    assert.ok(first.includes('result: characters 0-10 of 25'));
    assert.ok(first.includes('abcdefghij') && first.includes('next: from=10'));
    assert.equal(stores.get('g1').get(id).readAt, null, 'not read until the last page');
    const second = (await runOp('task.read', { id, from: 10 }, ctx(env, MEMBER))).summary.split('\n');
    assert.ok(second.includes('klmnopqrst') && second.includes('next: from=20'));
    assert.ok(
      !second.some((line) => line.startsWith('source') || line.startsWith('file:')),
      'only the first page carries them'
    );
    const last = (await runOp('task.read', { id, from: 20 }, ctx(env, MEMBER))).summary.split('\n');
    assert.ok(last.includes('uvwxy') && !last.some((line) => line.startsWith('next:')));
    assert.equal(stores.get('g1').get(id).readAt > 0, true);
    assert.equal((await runOp('task.read', { id, from: 99 }, ctx(env, MEMBER))).status, 'invalid');
  });
});

test("task.read: an expired file is marked and has no handle; a failed task shows its error; an open or unknown task, and a private chat's task for another member, are refused", async () => {
  const out = tempDir('nep-ops-task-out-');
  const fixture = makeEnv({ agents: { scout: { enabled: true, out, daily: { tasks: 10 } } } });
  const { env, client, errands } = fixture;
  await withCapturedLogs(async () => {
    const id = await finishedTask(fixture, 'a meme', {
      text: 'ok',
      files: [{ path: '/x/a.png', name: 'a.png', contentType: 'image/png', bytes: 5 }],
    });
    const lines = (await runOp('task.read', { id }, ctx(env, MEMBER))).summary.split('\n');
    assert.ok(lines.includes('file: a.png (image/png, 5 bytes) expired, no handle'), lines.join('\n'));
    assert.ok(!lines.some((line) => line.includes(`file:${id}`)));
    const failed = (await runOp('task.run', { agent: 'scout', goal: 'will fail' }, ctx(env, MEMBER))).data.task.id;
    const open = await runOp('task.read', { id: failed }, ctx(env, MEMBER));
    assert.equal(open.status, 'invalid');
    while (client.runs.length < 2) await new Promise((resolve) => setImmediate(resolve));
    client.end(failed, { status: 'failed', error: 'timeout' });
    await errands.idle();
    const reason = (await runOp('task.read', { id: failed }, ctx(env, MEMBER))).summary.split('\n');
    assert.ok(reason.includes('error: timeout') && reason.includes('result: empty'));
    assert.equal((await runOp('task.read', { id: 'tnope' }, ctx(env, MEMBER))).code, 'not-found');
    const dm = await finishedTask(fixture, 'private', { text: 'secret' }, { privateChat: true, channelId: 'dm1' });
    assert.equal((await runOp('task.read', { id: dm }, ctx(env, OTHER))).code, 'not-found');
    assert.equal(
      (await runOp('task.read', { id: dm }, ctx(env, MEMBER, { channelId: 'dm1', privateChat: true }))).status,
      'ok'
    );
  });
});

test('task.resolve: closes a finished task of her view so the list drops it; an open one is refused; resolving twice is fine', async () => {
  const fixture = makeEnv();
  const { env, stores } = fixture;
  await withCapturedLogs(async () => {
    const id = await finishedTask(fixture, 'done one', { text: 'x' });
    const answer = await runOp('task.resolve', { id }, ctx(env, MEMBER));
    assert.equal(answer.status, 'ok');
    assert.equal(answer.summary, `task ${id}: resolved`);
    assert.equal(stores.get('g1').get(id).resolvedAt > 0, true);
    assert.equal((await runOp('task.status', {}, ctx(env, MEMBER))).summary, 'no open tasks');
    assert.equal((await runOp('task.resolve', { id }, ctx(env, MEMBER))).status, 'ok');
    const open = (await runOp('task.run', { agent: 'scout', goal: 'still going' }, ctx(env, MEMBER))).data.task.id;
    assert.equal((await runOp('task.resolve', { id: open }, ctx(env, MEMBER))).status, 'invalid');
    assert.equal((await runOp('task.resolve', { id: 'tnope' }, ctx(env, OTHER))).code, 'not-found');
  });
});
