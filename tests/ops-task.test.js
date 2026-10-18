// Tests for src/ops/task.js: the `/nep task` operations over a real task store (a temp data/
// directory) and a FAKE errand client. The rights: a member may run the web agent but not the
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
import { createDiscordInterface } from '../src/interface/discord.js';
import { tempDir } from './fixtures/tmp.js';
import { COMMAND_TABLE } from '../src/ops/catalog.js';
import { addArgs } from '../src/errands/ledger.js';

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
  const out = tempDir('nep-ops-task-out-');
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

/** `agents.web` with the adult errand block `adult` (the shipped limits under it). */
const webWith = (adult) => ({ web: { enabled: true, limits: { steps: 25, usd: 0.5, seconds: 300 }, daily: { tasks: 10, usd: 5 }, adult } });

test('task.run adult: on web with agents.web.adult set, the errand carries its model and its limits merged over agents.web.limits', async () => {
  const { env, client, errands, stores } = makeEnv({ agents: webWith({ model: 'vendor/adult-model', limits: { seconds: 900, steps: 40 } }) });
  await withCapturedLogs(async () => {
    const result = await runOp('task.run', { agent: 'web', goal: 'find the scene', adult: true }, ctx(env, MEMBER));
    assert.equal(result.status, 'ok');
    assert.equal(result.code, 'ok');
    const { id } = result.data.task;
    assert.equal(result.data.task.adult, true);
    assert.match(result.summary, new RegExp(`^task ${id}: queued \\(web, adult\\)$`));
    assert.equal(stores.get('g1').get(id).adult, true, 'the record keeps adult: true');
    while (client.runs.length === 0) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(client.runs[0].model, 'vendor/adult-model');
    assert.deepEqual(client.runs[0].limits, { steps: 40, usd: 0.5, seconds: 900 });
    assert.equal(Object.hasOwn(client.runs[0], 'cost'), false, 'no adult cost: none sent, the runner keeps agents.web.cost');
    const status = await runOp('task.status', { id }, ctx(env, MEMBER));
    assert.ok(status.summary.startsWith(`${id} web adult running `), status.summary);
    assert.equal(addArgs(stores.get('g1').get(id), 'g1').metadata.adult, true, 'the ledger mirror\'s metadata');
    // The string form a slash option (or a persona's call) gives.
    const asString = await runOp('task.run', { agent: 'web', goal: 'another', adult: 'true' }, ctx(env, MEMBER));
    assert.equal(stores.get('g1').get(asString.data.task.id).adult, true);
    const no = await runOp('task.run', { agent: 'web', goal: 'plain', adult: 'false' }, ctx(env, MEMBER));
    assert.equal(no.code, 'ok');
    assert.equal(Object.hasOwn(stores.get('g1').get(no.data.task.id), 'adult'), false);
    while (client.runs.length < 3) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(Object.hasOwn(client.runs[2], 'model'), false, 'a plain errand takes the role\'s model');
    assert.deepEqual(client.runs[2].limits, { steps: 25, usd: 0.5, seconds: 300 });
    assert.equal(Object.hasOwn(addArgs(stores.get('g1').get(no.data.task.id), 'g1').metadata, 'adult'), false);
    // Counted against the day's caps as any other errand.
    assert.equal(stores.get('g1').today('web').tasks, 3);
    for (const run of client.runs) client.end(run.id);
    await errands.idle();
  });
});

test('task.run adult: agents.web.adult.cost goes out with the adult errand only, never with a plain one', async () => {
  const hotAgents = webWith({ model: 'vendor/adult-model', cost: { input: 1, output: 3.2 } });
  hotAgents.web.cost = { input: 2, output: 10 };
  const { env, client, errands } = makeEnv({ agents: hotAgents });
  await withCapturedLogs(async () => {
    const adult = await runOp('task.run', { agent: 'web', goal: 'find the scene', adult: true }, ctx(env, MEMBER));
    assert.equal(adult.code, 'ok');
    while (client.runs.length === 0) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(client.runs[0].model, 'vendor/adult-model');
    assert.deepEqual(client.runs[0].cost, { input: 1, output: 3.2 });
    const plain = await runOp('task.run', { agent: 'web', goal: 'plain' }, ctx(env, MEMBER));
    assert.equal(plain.code, 'ok');
    while (client.runs.length < 2) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(Object.hasOwn(client.runs[1], 'cost'), false, 'a plain errand sends no cost: the runner keeps agents.web.cost');
    for (const run of client.runs) client.end(run.id);
    await errands.idle();
  });
});

test('task.run adult: refused for the server agent; a value that is not a flag is invalid', async () => {
  const { env, client } = makeEnv({ agents: webWith({ model: 'vendor/adult-model' }) });
  await withCapturedLogs(async () => {
    const refused = await runOp('task.run', { agent: 'server', goal: 'list the units', adult: true }, ctx(env, OWNER));
    assert.equal(refused.status, 'invalid');
    assert.equal(refused.code, 'adult-web-only');
    const bad = await runOp('task.run', { agent: 'web', goal: 'x', adult: 'maybe' }, ctx(env, MEMBER));
    assert.equal(bad.status, 'invalid');
    await new Promise((r) => setImmediate(r));
    assert.equal(client.runs.length, 0, 'nothing queued');
    const plainServer = await runOp('task.run', { agent: 'server', goal: 'list the units', adult: 'false' }, ctx(env, OWNER));
    assert.equal(plainServer.status, 'ok', 'adult false is no adult errand');
  });
});

test('task.run adult: with the feature off the flag is ignored, the errand runs as usual and the code says so', async () => {
  for (const [adult, code] of [[undefined, 'adult-off'], [null, 'adult-off'], [{ model: 'not a model' }, 'adult-misconfigured']]) {
    const { env, client, stores, errands } = makeEnv({ agents: webWith(adult) });
    await withCapturedLogs(async () => {
      const result = await runOp('task.run', { agent: 'web', goal: 'find the scene', adult: true }, ctx(env, MEMBER));
      assert.equal(result.status, 'ok');
      assert.equal(result.code, code);
      const { id } = result.data.task;
      assert.equal(result.summary, `task ${id}: queued (web; adult ignored: ${code})`);
      assert.equal(Object.hasOwn(stores.get('g1').get(id), 'adult'), false);
      while (client.runs.length === 0) await new Promise((resolve) => setImmediate(resolve));
      assert.equal(Object.hasOwn(client.runs[0], 'model'), false);
      assert.deepEqual(client.runs[0].limits, { steps: 25, usd: 0.5, seconds: 300 });
      client.end(id);
      await errands.idle();
    });
  }
});

test('/nep task run: the adult option is a lowercase string flag, mapped to a boolean only when given', () => {
  const run = COMMAND_TABLE.find((node) => node.name === 'task').subcommands.find((leaf) => leaf.name === 'run');
  const option = run.options.find((o) => o.name === 'adult');
  assert.equal(option.type, 3, 'a STRING option, never a Discord BOOLEAN');
  assert.deepEqual(option.choices.map((c) => c.value), ['true', 'false']);
  assert.equal(option.required, false);
  const reader = (given) => ({ getString: (name) => (Object.hasOwn(given, name) ? given[name] : null) });
  assert.deepEqual(run.args(reader({ agent: 'web', goal: 'g', adult: 'true' })), { agent: 'web', goal: 'g', adult: true });
  assert.deepEqual(run.args(reader({ agent: 'web', goal: 'g', adult: true })), { agent: 'web', goal: 'g', adult: true }, 'a persona\'s call carries the boolean');
  assert.deepEqual(run.args(reader({ agent: 'web', goal: 'g', adult: 'false' })), { agent: 'web', goal: 'g', adult: false });
  assert.deepEqual(run.args(reader({ agent: 'web', goal: 'g' })), { agent: 'web', goal: 'g' });
});
