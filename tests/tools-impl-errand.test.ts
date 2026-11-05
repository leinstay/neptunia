// Tests for src/tools/impl/task.ts: the `/nep task` operations over a real task store (a temp data/
// directory) and a FAKE errand client. The rights: a member may run the scout agent but not the
// server one, an owner may run both; a cap refuses with its code; the answer is at once (id and
// `queued`) while the errand runs in the background; a cancel is for the requester or an owner;
// a private chat's task is shown only to its requester or an owner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { runOp } from '../src/tools/impl/index.ts';
import { createOpsEnv } from '../src/tools/impl/env.ts';
import { createErrandStores } from '../src/errands/store.ts';
import { createErrandService } from '../src/errands/service.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { createDiscordInterface } from '../interfaces/discord/index.ts';
import { tempDir } from './fixtures/tmp.ts';
import type { Untyped } from '../src/tools/types.ts';
import { asRecord } from './fixtures/records.ts';

// The casts through `Parameters<typeof f>` hand a function a fake that carries only the fields the test reads.

// The Discord interface's capabilities object, as src/index.ts injects it.
const DISCORD = createDiscordInterface().capabilities;

const OWNER = '42';
const MEMBER = '7';
const OTHER = '8';

/** A fake errand client: records each run and lets the test end it. */
function fakeClient({ configured = true } = {}) {
  const runs: Array<Untyped> = [];
  const cancels: Array<Untyped> = [];
  const gates = new Map();
  return {
    runs,
    cancels,
    configured: () => configured,
    run(task: Untyped) {
      runs.push(task);
      return new Promise((resolve) => gates.set(task.id, resolve));
    },
    cancel(task: Untyped) {
      cancels.push(task);
      gates.get(task.id)?.({ status: 'cancelled', error: 'cancelled' });
      return true;
    },
    end(id: string, outcome = { status: 'done', result: { text: 'ok' }, usage: { usd: 0.01 } }) {
      gates.get(id)?.(outcome);
    },
  };
}

function makeEnv({ errandSettings = {}, agents = {}, configured = true } = {}) {
  const rootDir = tempDir('nep-ops-task-');
  const hot = {
    config: {
      bot: { owners: [OWNER], access: {} },
      features: {},
      errands: { maxOpen: 3, ...errandSettings },
      agents: {
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
  const finished: Array<Untyped> = [];
  const stores = createErrandStores({
    dataDir: path.join(rootDir, 'data'),
    config: () => hot.config,
  } as unknown as Parameters<typeof createErrandStores>[0]);
  const errands = createErrandService({
    client,
    stores,
    hot,
    isServedCommunity: (id: unknown) => id === 'g1',
    onFinished: (task: Untyped) => finished.push(task),
  } as unknown as Parameters<typeof createErrandService>[0]);
  const store = { state: { data: {}, markDirty() {} } };
  const env = createOpsEnv({
    discord: DISCORD,
    hot,
    store,
    client: { channels: { cache: new Map() } },
    spontaneous: {},
    calibrator: { ratio: 1 },
    isServedCommunity: (id: unknown) => id === 'g1',
    errands,
  });
  return { env, client, errands, finished, stores };
}

const ctx = (env: unknown, accountId: string | null, extra = {}) => ({
  env,
  placeId: 'g1',
  conversationId: 'c1',
  accountId,
  roleIds: [],
  ...extra,
});

test('errand.run: a member may run the scout agent; the answer is at once, the errand runs in the background', async () => {
  const { env, client, errands, finished, stores } = makeEnv();
  await withCapturedLogs(async () => {
    const result = await runOp(
      'errand.run',
      { agent: 'scout', goal: 'find the changelog' },
      ctx(env, MEMBER, { sourceMessageId: 'm5' }) as unknown as Parameters<typeof runOp>[2]
    );
    assert.equal(result.status, 'ok');
    const { id, state } = asRecord(result.data).task;
    assert.equal(state, 'queued');
    assert.match(result.summary, new RegExp(`^task ${id}: queued`));
    assert.equal(client.runs.length, 0, 'nothing was sent before the answer');
    const task = stores.get()?.get(id);
    assert.deepEqual(task?.requester, { accountId: MEMBER, kind: 'member' });
    assert.deepEqual(task?.origin, { placeId: 'c1', messageId: 'm5' });
    assert.equal(task?.scope, 'group');
    await new Promise((r) => setImmediate(r));
    assert.equal(client.runs.length, 1);
    assert.equal(client.runs[0].context.scope, 'group');
    assert.deepEqual(
      client.runs[0].limits,
      { steps: 25, seconds: 300 },
      'the profile defaults under agents.scout.limits'
    );
    assert.equal(Object.hasOwn(client.runs[0], 'model'), false, 'no model: the runner takes models.errands.scout');
    assert.equal(stores.get()?.get(id)?.state, 'running');
    client.end(id);
    await errands.idle();
    assert.equal(stores.get()?.get(id)?.state, 'done');
    assert.deepEqual(
      finished.map((t) => t.id),
      [id]
    );
  });
});

test('errand.run: a member may not run the server agent; an owner may', async () => {
  const { env, client } = makeEnv();
  await withCapturedLogs(async () => {
    const refused = await runOp(
      'errand.run',
      { agent: 'server', goal: 'list the units' },
      ctx(env, MEMBER) as unknown as Parameters<typeof runOp>[2]
    );
    assert.equal(refused.status, 'denied');
    assert.equal(refused.code, 'owner-only');
    // Through the persona's call too: the requester of her turn is the caller.
    const viaPersona = await runOp(
      'errand.run',
      { agent: 'server', goal: 'list the units' },
      ctx(env, MEMBER, { actor: 'persona' }) as unknown as Parameters<typeof runOp>[2]
    );
    assert.equal(viaPersona.code, 'owner-only');
    const nobody = await runOp(
      'errand.run',
      { agent: 'server', goal: 'list the units' },
      ctx(env, null, { actor: 'persona' }) as unknown as Parameters<typeof runOp>[2]
    );
    assert.equal(nobody.code, 'owner-only');
    const allowed = await runOp(
      'errand.run',
      { agent: 'server', goal: 'list the units' },
      ctx(env, OWNER, { actor: 'persona', privateChat: true, placeId: 'dm1' }) as unknown as Parameters<typeof runOp>[2]
    );
    assert.equal(allowed.status, 'ok');
    await new Promise((r) => setImmediate(r));
    assert.equal(client.runs.at(-1).agent, 'server');
    assert.equal(client.runs.at(-1).context.scope, 'dm', 'asked in a private chat');
  });
});

test('errand.run: a cap refuses with its code; a runner that is not set up is not-configured', async () => {
  const { env } = makeEnv({ errandSettings: { maxOpen: 1 } });
  await withCapturedLogs(async () => {
    assert.equal(
      (
        await runOp(
          'errand.run',
          { agent: 'scout', goal: 'one' },
          ctx(env, MEMBER) as unknown as Parameters<typeof runOp>[2]
        )
      ).status,
      'ok'
    );
    const second = await runOp(
      'errand.run',
      { agent: 'scout', goal: 'two' },
      ctx(env, MEMBER) as unknown as Parameters<typeof runOp>[2]
    );
    assert.equal(second.status, 'failed');
    assert.equal(second.code, 'cap-open');
    const bad = await runOp(
      'errand.run',
      { agent: 'mail', goal: 'x' },
      ctx(env, MEMBER) as unknown as Parameters<typeof runOp>[2]
    );
    assert.equal(bad.status, 'invalid');
  });
  const off = makeEnv({ configured: false });
  await withCapturedLogs(async () => {
    const result = await runOp(
      'errand.run',
      { agent: 'scout', goal: 'x' },
      ctx(off.env, MEMBER) as unknown as Parameters<typeof runOp>[2]
    );
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'not-configured');
  });
});

test('errand.cancel: only the requester of the task or an owner', async () => {
  const { env, client, stores } = makeEnv();
  await withCapturedLogs(async () => {
    const first = asRecord(
      (
        await runOp(
          'errand.run',
          { agent: 'scout', goal: 'one' },
          ctx(env, MEMBER) as unknown as Parameters<typeof runOp>[2]
        )
      ).data
    ).task.id;
    const second = asRecord(
      (
        await runOp(
          'errand.run',
          { agent: 'scout', goal: 'two' },
          ctx(env, MEMBER) as unknown as Parameters<typeof runOp>[2]
        )
      ).data
    ).task.id;
    await new Promise((r) => setImmediate(r));
    const refused = await runOp(
      'errand.cancel',
      { id: first },
      ctx(env, OTHER) as unknown as Parameters<typeof runOp>[2]
    );
    assert.equal(refused.status, 'denied');
    assert.equal(refused.code, 'not-requester');
    const own = await runOp('errand.cancel', { id: first }, ctx(env, MEMBER) as unknown as Parameters<typeof runOp>[2]);
    assert.equal(own.status, 'ok');
    assert.equal(stores.get()?.get(first)?.state, 'cancelled');
    assert.deepEqual(
      client.cancels.map((t) => t.id),
      [first],
      'the runner is told'
    );
    const byOwner = await runOp(
      'errand.cancel',
      { id: second },
      ctx(env, OWNER) as unknown as Parameters<typeof runOp>[2]
    );
    assert.equal(byOwner.status, 'ok');
    const again = await runOp(
      'errand.cancel',
      { id: second },
      ctx(env, OWNER) as unknown as Parameters<typeof runOp>[2]
    );
    assert.equal(again.status, 'failed');
    assert.equal(again.code, 'not-open');
    const unknown = await runOp(
      'errand.cancel',
      { id: 'tnope' },
      ctx(env, OWNER) as unknown as Parameters<typeof runOp>[2]
    );
    assert.equal(unknown.status, 'invalid');
  });
});

test("errand.status and errand.list: the open ones, one by id, a private chat's only for its requester or an owner", async () => {
  const { env } = makeEnv();
  await withCapturedLogs(async () => {
    const group = String(
      asRecord(
        (
          await runOp(
            'errand.run',
            { agent: 'scout', goal: 'public errand' },
            ctx(env, MEMBER) as unknown as Parameters<typeof runOp>[2]
          )
        ).data
      ).task.id
    );
    const dm = String(
      asRecord(
        (
          await runOp(
            'errand.run',
            { agent: 'scout', goal: 'private errand' },
            ctx(env, MEMBER, { privateChat: true, placeId: 'dm1' }) as unknown as Parameters<typeof runOp>[2]
          )
        ).data
      ).task.id
    );
    const open = await runOp('errand.status', {}, ctx(env, OTHER) as unknown as Parameters<typeof runOp>[2]);
    assert.equal(open.status, 'ok');
    assert.ok(open.summary.includes(group));
    assert.ok(!open.summary.includes(dm), "another member does not see a private chat's task");
    const one = await runOp('errand.status', { id: dm }, ctx(env, MEMBER) as unknown as Parameters<typeof runOp>[2]);
    assert.ok(one.summary.startsWith(`${dm} scout`));
    assert.equal(
      (await runOp('errand.status', { id: dm }, ctx(env, OTHER) as unknown as Parameters<typeof runOp>[2])).code,
      'not-found'
    );
    const listed = await runOp('errand.list', {}, ctx(env, OWNER) as unknown as Parameters<typeof runOp>[2]);
    assert.ok(listed.summary.includes(group) && listed.summary.includes(dm));
    assert.ok(listed.summary.split('\n')[0].startsWith(dm), 'newest first');
  });
});

test('errand.status: a finished task whose files the runner deleted says files-expired', async () => {
  const out = tempDir('nep-ops-task-out-');
  const { env, client, errands } = makeEnv({ agents: { scout: { enabled: true, out, daily: { tasks: 10 } } } });
  await withCapturedLogs(async () => {
    const id = asRecord(
      (
        await runOp(
          'errand.run',
          { agent: 'scout', goal: 'a meme' },
          ctx(env, MEMBER) as unknown as Parameters<typeof runOp>[2]
        )
      ).data
    ).task.id;
    while (client.runs.length === 0) await new Promise((resolve) => setImmediate(resolve));
    client.end(id, {
      status: 'done',
      result: { text: 'ok', files: [{ path: '/x/a.png', name: 'a.png' }] },
      usage: { usd: 0.01 },
    } as unknown as Parameters<typeof client.end>[1]);
    await errands.idle();
    const one = await runOp('errand.status', { id }, ctx(env, MEMBER) as unknown as Parameters<typeof runOp>[2]);
    assert.ok(one.summary.startsWith(`${id} scout done (files-expired) `), one.summary);
  });
});

// The ledger half of this test (errand.status showing a mirrored errand's `ledger: <id>`) went with the ledger mirror
// in PR 6e; what stays is who errand.cancel names to the service.
test('errand.cancel tells the service who cancelled', async () => {
  const { env, errands } = makeEnv();
  await withCapturedLogs(async () => {
    const id = asRecord(
      (
        await runOp(
          'errand.run',
          { agent: 'scout', goal: 'one' },
          ctx(env, MEMBER) as unknown as Parameters<typeof runOp>[2]
        )
      ).data
    ).task.id;
    const seen: Array<string | undefined> = [];
    const cancel = errands.cancel;
    errands.cancel = (args) => {
      seen.push(args.by);
      return cancel(args);
    };
    const other = asRecord(
      (
        await runOp(
          'errand.run',
          { agent: 'scout', goal: 'two' },
          ctx(env, MEMBER) as unknown as Parameters<typeof runOp>[2]
        )
      ).data
    ).task.id;
    const hers = asRecord(
      (
        await runOp(
          'errand.run',
          { agent: 'scout', goal: 'three' },
          ctx(env, null, { actor: 'persona' }) as unknown as Parameters<typeof runOp>[2]
        )
      ).data
    ).task.id;
    await runOp('errand.cancel', { id }, ctx(env, MEMBER) as unknown as Parameters<typeof runOp>[2]);
    await runOp('errand.cancel', { id: other }, ctx(env, OWNER) as unknown as Parameters<typeof runOp>[2]);
    await runOp(
      'errand.cancel',
      { id: hers },
      ctx(env, null, { actor: 'persona' }) as unknown as Parameters<typeof runOp>[2]
    );
    assert.deepEqual(seen, ['requester', 'owner', 'persona']);
    await errands.idle();
  });
});

/** Ends a fresh scout task of MEMBER with `result` and returns its id. */
async function finishedTask(fixture: Untyped, goal: string, result: unknown, extra = {}) {
  const { env, client, errands } = fixture;
  const before = client.runs.length;
  const id = asRecord(
    (
      await runOp(
        'errand.run',
        { agent: 'scout', goal },
        ctx(env, MEMBER, extra) as unknown as Parameters<typeof runOp>[2]
      )
    ).data
  ).task.id;
  while (client.runs.length === before) await new Promise((resolve) => setImmediate(resolve));
  client.end(id, { status: 'done', result, usage: { usd: 0.01 } });
  await errands.idle();
  return id;
}

test('errand.status without an id lists the open tasks and the finished ones not read yet; errand.read marks one read', async () => {
  const fixture = makeEnv();
  const { env, stores } = fixture;
  await withCapturedLogs(async () => {
    const done = await finishedTask(fixture, 'first', { text: 'the answer' });
    const listed = await runOp('errand.status', {}, ctx(env, MEMBER) as unknown as Parameters<typeof runOp>[2]);
    assert.ok(listed.summary.includes(`${done} scout done`) && listed.summary.includes('(unread)'), listed.summary);
    const read = await runOp('errand.read', { id: done }, ctx(env, MEMBER) as unknown as Parameters<typeof runOp>[2]);
    assert.equal(read.status, 'ok');
    assert.ok(read.summary.includes('the answer'));
    assert.equal((stores.get()?.get(done)?.readAt ?? 0) > 0, true);
    assert.equal(
      (await runOp('errand.status', {}, ctx(env, MEMBER) as unknown as Parameters<typeof runOp>[2])).summary,
      'no open tasks',
      'read, so no longer listed'
    );
  });
});

test('errand.read: pages of errands.resultMaxChars, the last page marks it read; sources, the error and the file manifest come with the first page', async () => {
  const out = tempDir('nep-ops-task-out-');
  const fixture = makeEnv({
    errandSettings: { resultMaxChars: 10 },
    agents: { scout: { enabled: true, out, daily: { tasks: 10 } } },
  });
  const { env, stores } = fixture;
  await withCapturedLogs(async () => {
    const id = await finishedTask(fixture, 'long one', {
      text: 'abcdefghijklmnopqrstuvwxy',
      sources: ['https://example.org/a'],
      files: [{ path: '/x/a.png', name: 'a.png', contentType: 'image/png', bytes: 12 }],
    });
    fs.mkdirSync(path.join(out, id), { recursive: true });
    const first = (
      await runOp('errand.read', { id }, ctx(env, MEMBER) as unknown as Parameters<typeof runOp>[2])
    ).summary.split('\n');
    assert.ok(first.includes('source 1: https://example.org/a'));
    assert.ok(first.includes(`file: file:${id}/a.png (image/png, 12 bytes)`));
    assert.ok(first.includes('result: characters 0-10 of 25'));
    assert.ok(first.includes('abcdefghij') && first.includes('next: from=10'));
    assert.equal(stores.get()?.get(id)?.readAt, null, 'not read until the last page');
    const second = (
      await runOp('errand.read', { id, from: 10 }, ctx(env, MEMBER) as unknown as Parameters<typeof runOp>[2])
    ).summary.split('\n');
    assert.ok(second.includes('klmnopqrst') && second.includes('next: from=20'));
    assert.ok(
      !second.some((line) => line.startsWith('source') || line.startsWith('file:')),
      'only the first page carries them'
    );
    const last = (
      await runOp('errand.read', { id, from: 20 }, ctx(env, MEMBER) as unknown as Parameters<typeof runOp>[2])
    ).summary.split('\n');
    assert.ok(last.includes('uvwxy') && !last.some((line) => line.startsWith('next:')));
    assert.equal((stores.get()?.get(id)?.readAt ?? 0) > 0, true);
    assert.equal(
      (await runOp('errand.read', { id, from: 99 }, ctx(env, MEMBER) as unknown as Parameters<typeof runOp>[2])).status,
      'invalid'
    );
  });
});

test("errand.read: an expired file is marked and has no handle; a failed task shows its error; an open or unknown task, and a private chat's task for another member, are refused", async () => {
  const out = tempDir('nep-ops-task-out-');
  const fixture = makeEnv({ agents: { scout: { enabled: true, out, daily: { tasks: 10 } } } });
  const { env, client, errands } = fixture;
  await withCapturedLogs(async () => {
    const id = await finishedTask(fixture, 'a meme', {
      text: 'ok',
      files: [{ path: '/x/a.png', name: 'a.png', contentType: 'image/png', bytes: 5 }],
    });
    const lines = (
      await runOp('errand.read', { id }, ctx(env, MEMBER) as unknown as Parameters<typeof runOp>[2])
    ).summary.split('\n');
    assert.ok(lines.includes('file: a.png (image/png, 5 bytes) expired, no handle'), lines.join('\n'));
    assert.ok(!lines.some((line) => line.includes(`file:${id}`)));
    const failed = asRecord(
      (
        await runOp(
          'errand.run',
          { agent: 'scout', goal: 'will fail' },
          ctx(env, MEMBER) as unknown as Parameters<typeof runOp>[2]
        )
      ).data
    ).task.id;
    const open = await runOp('errand.read', { id: failed }, ctx(env, MEMBER) as unknown as Parameters<typeof runOp>[2]);
    assert.equal(open.status, 'invalid');
    while (client.runs.length < 2) await new Promise((resolve) => setImmediate(resolve));
    client.end(failed, { status: 'failed', error: 'timeout' } as unknown as Parameters<typeof client.end>[1]);
    await errands.idle();
    const reason = (
      await runOp('errand.read', { id: failed }, ctx(env, MEMBER) as unknown as Parameters<typeof runOp>[2])
    ).summary.split('\n');
    assert.ok(reason.includes('error: timeout') && reason.includes('result: empty'));
    assert.equal(
      (await runOp('errand.read', { id: 'tnope' }, ctx(env, MEMBER) as unknown as Parameters<typeof runOp>[2])).code,
      'not-found'
    );
    const dm = await finishedTask(fixture, 'private', { text: 'secret' }, { privateChat: true, placeId: 'dm1' });
    assert.equal(
      (await runOp('errand.read', { id: dm }, ctx(env, OTHER) as unknown as Parameters<typeof runOp>[2])).code,
      'not-found'
    );
    assert.equal(
      (
        await runOp(
          'errand.read',
          { id: dm },
          ctx(env, MEMBER, { placeId: 'dm1', privateChat: true }) as unknown as Parameters<typeof runOp>[2]
        )
      ).status,
      'ok'
    );
  });
});

test('errand.resolve: closes a finished task of her view so the list drops it; an open one is refused; resolving twice is fine', async () => {
  const fixture = makeEnv();
  const { env, stores } = fixture;
  await withCapturedLogs(async () => {
    const id = await finishedTask(fixture, 'done one', { text: 'x' });
    const answer = await runOp('errand.resolve', { id }, ctx(env, MEMBER) as unknown as Parameters<typeof runOp>[2]);
    assert.equal(answer.status, 'ok');
    assert.equal(answer.summary, `task ${id}: resolved`);
    assert.equal((stores.get()?.get(id)?.resolvedAt ?? 0) > 0, true);
    assert.equal(
      (await runOp('errand.status', {}, ctx(env, MEMBER) as unknown as Parameters<typeof runOp>[2])).summary,
      'no open tasks'
    );
    assert.equal(
      (await runOp('errand.resolve', { id }, ctx(env, MEMBER) as unknown as Parameters<typeof runOp>[2])).status,
      'ok'
    );
    const open = asRecord(
      (
        await runOp(
          'errand.run',
          { agent: 'scout', goal: 'still going' },
          ctx(env, MEMBER) as unknown as Parameters<typeof runOp>[2]
        )
      ).data
    ).task.id;
    assert.equal(
      (await runOp('errand.resolve', { id: open }, ctx(env, MEMBER) as unknown as Parameters<typeof runOp>[2])).status,
      'invalid'
    );
    assert.equal(
      (await runOp('errand.resolve', { id: 'tnope' }, ctx(env, OTHER) as unknown as Parameters<typeof runOp>[2])).code,
      'not-found'
    );
  });
});
