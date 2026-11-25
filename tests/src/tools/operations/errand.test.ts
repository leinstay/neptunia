// Tests for src/tools/operations/errand.ts: the errand operations over a real task store (a temp data/
// directory) and a FAKE errand client. Each of errand.server, errand.scout and errand.code files an errand for the
// agent of its name; a cap refuses with its code; the answer is at once (id and
// `queued`) while the errand runs in the background; a cancel is for the requester or an owner;
// a private chat's task is shown only to its requester or an owner.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runOp } from '../../../../src/tools/operations/index.ts';
import { createOpsEnv } from '../../../../src/tools/operations/env.ts';
import { createErrandStores } from '../../../../src/errands/store.ts';
import { createErrandService } from '../../../../src/errands/service.ts';
import { withCapturedLogs } from '../../../fixtures/capture-logs.ts';
import { createDiscordInterface } from '../../../../interfaces/discord/index.ts';
import { tempDir } from '../../../fixtures/tmp.ts';
import type { Untyped, Obj } from '../../../../src/tools/types.ts';
import { asRecord } from '../../../fixtures/records.ts';
import { OWNER_PERSON, ownedBy } from '../../../fixtures/owner-accounts.ts';
import { labels as LABELS } from '../../../fixtures/labels.ts';
import { boardTaskOf } from '../../../fixtures/board-task.ts';
import type { BoardTask } from '../../../fixtures/board-task.ts';
import type { ErrandClient, ErrandService, ErrandStores, RunOutcome } from '../../../../src/errands/types.ts';
import { openTestMemorySync } from '../../../fixtures/memory-db/service.ts';
import { call, toolAnswer } from '../../../fixtures/tool-answers.ts';
import {
  AGENTS,
  WEB_CONFIG,
  coreTurn,
  errandService,
  hotWith,
  journalOverMemory,
} from '../../../fixtures/turn-harness.ts';

// The casts through `Parameters<typeof f>` hand a function a fake that carries only the fields the test reads.

// The Discord interface's capabilities object, as src/index.ts injects it.
const DISCORD = createDiscordInterface().capabilities;

const OWNER = '42';

const MEMBER = '7';

/** A second account bound to the owner person, on any interface. */
const OWNER_SECOND = '43';

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

/** The scout unit's out folder under a fresh state folder of a user unit, and the agent paths that point there. */
function scoutOut(): { out: string; agentPaths: { env: Record<string, string> } } {
  const stateDir = tempDir('nep-ops-task-state-');
  const out = path.join(stateDir, 'neptunia-agent-scout', 'out');
  fs.mkdirSync(out, { recursive: true });
  return { out, agentPaths: { env: { NEPTUNIA_UNIT_SCOPE: 'user', XDG_STATE_HOME: stateDir } } };
}

function makeEnv({
  errandSettings = {},
  agents = {},
  configured = true,
  labels = {},
  agentPaths = undefined as { env: Record<string, string> } | undefined,
} = {}) {
  const rootDir = tempDir('nep-ops-task-');
  const hot = {
    config: {
      bot: { ownerPerson: OWNER_PERSON, access: {} },
      features: {},
      errands: { maxOpen: 3, ...errandSettings },
      models: { agents: { via: { scout: 'claude', server: 'claude', code: 'claude' } } },
      agents: {
        scout: { enabled: true, daily: { tasks: 10 } },
        server: { enabled: true, daily: { tasks: 10 } },
        code: { enabled: true, daily: { tasks: 10 } },
        ...agents,
      },
    },
    prompts: { labels },
    rootDir,
    reloadConfig: () => true,
  };
  const client = fakeClient({ configured });
  const finished: Array<Untyped> = [];
  const stores = createErrandStores({
    dataDir: path.join(rootDir, 'data'),
    config: () => hot.config,
    agentPaths,
  } as unknown as Parameters<typeof createErrandStores>[0]);
  const errands = createErrandService({
    client,
    stores,
    hot,
    agentPaths,
    isServedRoot: (id: unknown) => id === 'g1',
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
    isServedRoot: (id: unknown) => id === 'g1',
    errands,
  });
  return { env, client, errands, finished, stores };
}

const ctx = (env: unknown, accountId: string | null, extra = {}) => ({
  env,
  // The place of the call alone.
  placeId: 'c1',
  accountId,
  roleIds: [],
  ...extra,
});

test('errand.scout: queues a scout errand; the answer is at once, the errand runs in the background', async () => {
  const { env, client, errands, finished, stores } = makeEnv();
  await withCapturedLogs(async () => {
    const result = await runOp(
      'errand.scout',
      { goal: 'find the changelog' },
      ctx(env, MEMBER, { sourceMessageId: 'm5' }) as unknown as Parameters<typeof runOp>[2]
    );
    assert.equal(result.status, 'ok');
    const { id, state } = asRecord(result.data).task;
    assert.equal(state, 'queued');
    // The persona's errand tools say errand (config/tools.json), and so do their answers.
    assert.match(result.summary, new RegExp(`^errand ${id}: queued`));
    assert.equal(client.runs.length, 0, 'nothing was sent before the answer');
    const task = stores.get()?.get(id);
    assert.deepEqual(task?.requester, { accountId: MEMBER, kind: 'member' });
    assert.deepEqual(task?.origin, { placeId: 'c1', messageId: 'm5' });
    assert.equal(task?.scope, 'group');
    await new Promise((r) => setImmediate(r));
    assert.equal(client.runs.length, 1);
    assert.equal(asRecord(client.runs[0]).agent, 'scout');
    const sentRun = asRecord(client.runs[0]);
    assert.equal(sentRun.context.scope, 'group');
    assert.deepEqual(sentRun.limits, { steps: 25, seconds: 300 }, 'the profile defaults under agents.scout.limits');
    assert.equal(Object.hasOwn(client.runs[0], 'model'), false, 'no model: the runner takes the model of the route');
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

test('errand.server, errand.scout and errand.code each file an errand for the agent of its name', async () => {
  const { env, client, stores } = makeEnv();
  await withCapturedLogs(async () => {
    for (const tool of ['errand.server', 'errand.scout', 'errand.code']) {
      const result = await runOp(
        tool,
        { goal: 'list the units' },
        ctx(env, MEMBER, { actor: 'persona' }) as unknown as Parameters<typeof runOp>[2]
      );
      assert.equal(result.status, 'ok', result.summary);
      const task = (result.data as { task: { id: string; agent: string } }).task;
      assert.equal(task.agent, tool.slice('errand.'.length));
      assert.equal(stores.get()?.get(task.id)?.agent, task.agent);
    }
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(
      client.runs.map((run: { agent: string }) => run.agent),
      ['server', 'scout', 'code']
    );
  });
});

test("errand.server: the server agent runs for the owner on any of the owner's accounts and for the owner's typed command", async () => {
  const { env, client } = makeEnv();
  await withCapturedLogs(async () => {
    const second = await runOp(
      'errand.server',
      { goal: 'list the units' },
      ctx(env, OWNER_SECOND, { actor: 'persona' }) as unknown as Parameters<typeof runOp>[2]
    );
    assert.equal(second.status, 'ok', second.summary);
    const typed = await runOp(
      'errand.server',
      { goal: 'list the units' },
      ctx(env, 'cli-owner', { actor: 'owner', asOwner: true }) as unknown as Parameters<typeof runOp>[2]
    );
    assert.equal(typed.status, 'ok', typed.summary);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(
      client.runs.map((run: { agent: string }) => run.agent),
      ['server', 'server']
    );
  });
});

test('errand.scout: a cap refuses with its code; a runner that is not set up is not-configured', async () => {
  const { env } = makeEnv({ errandSettings: { maxOpen: 1 } });
  await withCapturedLogs(async () => {
    assert.equal(
      (await runOp('errand.scout', { goal: 'one' }, ctx(env, MEMBER) as unknown as Parameters<typeof runOp>[2])).status,
      'ok'
    );
    const second = await runOp(
      'errand.scout',
      { goal: 'two' },
      ctx(env, MEMBER) as unknown as Parameters<typeof runOp>[2]
    );
    assert.equal(second.status, 'failed');
    assert.equal(second.code, 'cap-open');
  });
  const off = makeEnv({ configured: false });
  await withCapturedLogs(async () => {
    // The tool names its agent, so an agent that is off refuses the persona's call at once.
    const result = await runOp(
      'errand.scout',
      { goal: 'x' },
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
      (await runOp('errand.scout', { goal: 'one' }, ctx(env, MEMBER) as unknown as Parameters<typeof runOp>[2])).data
    ).task.id;
    const second = asRecord(
      (await runOp('errand.scout', { goal: 'two' }, ctx(env, MEMBER) as unknown as Parameters<typeof runOp>[2])).data
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

test("errand.list: the open ones, one by id, every one with a limit, a private chat's only for its requester or an owner", async () => {
  const { env } = makeEnv();
  await withCapturedLogs(async () => {
    const group = String(
      asRecord(
        (
          await runOp(
            'errand.scout',
            { goal: 'public errand' },
            ctx(env, MEMBER) as unknown as Parameters<typeof runOp>[2]
          )
        ).data
      ).task.id
    );
    const dm = String(
      asRecord(
        (
          await runOp(
            'errand.scout',
            { goal: 'private errand' },
            ctx(env, MEMBER, { dmChat: true, placeId: 'dm1' }) as unknown as Parameters<typeof runOp>[2]
          )
        ).data
      ).task.id
    );
    const open = await runOp('errand.list', {}, ctx(env, OTHER) as unknown as Parameters<typeof runOp>[2]);
    assert.equal(open.status, 'ok');
    assert.ok(open.summary.includes(group));
    assert.ok(!open.summary.includes(dm), "another member does not see a private chat's task");
    const one = await runOp('errand.list', { id: dm }, ctx(env, MEMBER) as unknown as Parameters<typeof runOp>[2]);
    assert.ok(one.summary.startsWith(`${dm} scout`));
    assert.equal(
      (await runOp('errand.list', { id: dm }, ctx(env, OTHER) as unknown as Parameters<typeof runOp>[2])).code,
      'not-found'
    );
    const listed = await runOp('errand.list', { limit: 10 }, ctx(env, OWNER) as unknown as Parameters<typeof runOp>[2]);
    assert.ok(listed.summary.includes(group) && listed.summary.includes(dm));
    assert.ok(listed.summary.split('\n')[0].startsWith(dm), 'newest first');
  });
});

test('errand.list: a finished task whose files the runner deleted says files-expired', async () => {
  // The out folder is the scout unit's.
  const { agentPaths } = scoutOut();
  const { env, client, errands } = makeEnv({ agentPaths });
  await withCapturedLogs(async () => {
    const id = asRecord(
      (await runOp('errand.scout', { goal: 'a meme' }, ctx(env, MEMBER) as unknown as Parameters<typeof runOp>[2])).data
    ).task.id;
    // Bounded, so a run that never starts fails at once.
    await firstRun(client);
    client.end(id, {
      status: 'done',
      result: { text: 'ok', files: [{ path: '/x/a.png', name: 'a.png' }] },
      usage: { usd: 0.01 },
    } as unknown as Parameters<typeof client.end>[1]);
    await errands.idle();
    const one = await runOp('errand.list', { id }, ctx(env, MEMBER) as unknown as Parameters<typeof runOp>[2]);
    assert.ok(one.summary.startsWith(`${id} scout done (files-expired) `), one.summary);
  });
});

// Who errand.cancel names to the service.
test('errand.cancel tells the service who cancelled', async () => {
  const { env, errands } = makeEnv();
  await withCapturedLogs(async () => {
    const id = asRecord(
      (await runOp('errand.scout', { goal: 'one' }, ctx(env, MEMBER) as unknown as Parameters<typeof runOp>[2])).data
    ).task.id;
    const seen: Array<string | undefined> = [];
    const cancel = errands.cancel;
    errands.cancel = (args) => {
      seen.push(args.by);
      return cancel(args);
    };
    const other = asRecord(
      (await runOp('errand.scout', { goal: 'two' }, ctx(env, MEMBER) as unknown as Parameters<typeof runOp>[2])).data
    ).task.id;
    const personaTask = asRecord(
      (
        await runOp(
          'errand.scout',
          { goal: 'three' },
          ctx(env, null, { actor: 'persona' }) as unknown as Parameters<typeof runOp>[2]
        )
      ).data
    ).task.id;
    await runOp('errand.cancel', { id }, ctx(env, MEMBER) as unknown as Parameters<typeof runOp>[2]);
    await runOp('errand.cancel', { id: other }, ctx(env, OWNER) as unknown as Parameters<typeof runOp>[2]);
    await runOp(
      'errand.cancel',
      { id: personaTask },
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
    (await runOp('errand.scout', { goal }, ctx(env, MEMBER, extra) as unknown as Parameters<typeof runOp>[2])).data
  ).task.id;
  while (client.runs.length === before) await new Promise((resolve) => setImmediate(resolve));
  client.end(id, { status: 'done', result, usage: { usd: 0.01 } });
  await errands.idle();
  return id;
}

test('errand.list without an id lists the open tasks and the finished ones not read yet; errand.read marks one read', async () => {
  const fixture = makeEnv();
  const { env, stores } = fixture;
  await withCapturedLogs(async () => {
    const done = await finishedTask(fixture, 'first', { text: 'the answer' });
    const listed = await runOp('errand.list', {}, ctx(env, MEMBER) as unknown as Parameters<typeof runOp>[2]);
    assert.ok(listed.summary.includes(`${done} scout done`) && listed.summary.includes('(unread)'), listed.summary);
    const read = await runOp('errand.read', { id: done }, ctx(env, MEMBER) as unknown as Parameters<typeof runOp>[2]);
    assert.equal(read.status, 'ok');
    assert.ok(read.summary.includes('the answer'));
    assert.equal((stores.get()?.get(done)?.readAt ?? 0) > 0, true);
    assert.equal(
      (await runOp('errand.list', {}, ctx(env, MEMBER) as unknown as Parameters<typeof runOp>[2])).summary,
      // The persona's errand tools say errand (config/tools.json), and so do their answers.
      'no open errands',
      'read, so not listed'
    );
  });
});

test('errand.read: pages of errands.resultMaxChars, the last page marks it read; sources, the error and the file manifest come with the first page', async () => {
  // The out folder is the scout unit's.
  const { out, agentPaths } = scoutOut();
  const fixture = makeEnv({ errandSettings: { resultMaxChars: 10 }, agentPaths });
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
  // The out folder is the scout unit's.
  const { agentPaths } = scoutOut();
  const fixture = makeEnv({ agentPaths });
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
      (await runOp('errand.scout', { goal: 'will fail' }, ctx(env, MEMBER) as unknown as Parameters<typeof runOp>[2]))
        .data
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
    const dm = await finishedTask(fixture, 'private', { text: 'secret' }, { dmChat: true, placeId: 'dm1' });
    assert.equal(
      (await runOp('errand.read', { id: dm }, ctx(env, OTHER) as unknown as Parameters<typeof runOp>[2])).code,
      'not-found'
    );
    assert.equal(
      (
        await runOp(
          'errand.read',
          { id: dm },
          ctx(env, MEMBER, { placeId: 'dm1', dmChat: true }) as unknown as Parameters<typeof runOp>[2]
        )
      ).status,
      'ok'
    );
  });
});

test("errand.resolve: closes a finished task of the persona's view so the list drops it; an open one is refused; resolving twice is fine", async () => {
  const fixture = makeEnv();
  const { env, stores } = fixture;
  await withCapturedLogs(async () => {
    const id = await finishedTask(fixture, 'done one', { text: 'x' });
    const answer = await runOp('errand.resolve', { id }, ctx(env, MEMBER) as unknown as Parameters<typeof runOp>[2]);
    assert.equal(answer.status, 'ok');
    // The persona's errand tools say errand (config/tools.json), and so do their answers.
    assert.equal(answer.summary, `errand ${id}: resolved`);
    assert.equal((stores.get()?.get(id)?.resolvedAt ?? 0) > 0, true);
    assert.equal(
      (await runOp('errand.list', {}, ctx(env, MEMBER) as unknown as Parameters<typeof runOp>[2])).summary,
      'no open errands'
    );
    assert.equal(
      (await runOp('errand.resolve', { id }, ctx(env, MEMBER) as unknown as Parameters<typeof runOp>[2])).status,
      'ok'
    );
    const open = asRecord(
      (await runOp('errand.scout', { goal: 'still going' }, ctx(env, MEMBER) as unknown as Parameters<typeof runOp>[2]))
        .data
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

// The owner of these configs: `bot.ownerPerson` and the accounts bound to it (tests/fixtures/owner-accounts.ts).
ownedBy([OWNER, OWNER_SECOND]);

/** The id of the errand an `errand.scout` answer carries. */
const taskIdOf = (data: unknown): string => (asRecord(data).task as { id: string }).id;

/** Two group errands: the first ended `done`, the second still queued. Returns their ids. */
async function oneDoneOneQueued(
  env: ReturnType<typeof makeEnv>['env'],
  client: ReturnType<typeof fakeClient>,
  errands: { idle(): Promise<unknown> }
) {
  const run = async (goal: string) => {
    const result = await runOp('errand.scout', { goal }, ctx(env, MEMBER) as unknown as Parameters<typeof runOp>[2]);
    return taskIdOf(result.data);
  };
  const first = await run('first errand');
  await new Promise((r) => setImmediate(r));
  client.end(first);
  await errands.idle();
  const second = await run('second errand');
  return { first, second };
}

const status = (env: unknown, args: Record<string, unknown>, accountId = MEMBER) =>
  runOp('errand.list', args, ctx(env, accountId) as unknown as Parameters<typeof runOp>[2]);

test('errand.list with a state lists every errand in that state, finished ones included', async () => {
  // Catches: a finished and read errand that no listing finds, since errand.list holds the reads of a status.
  const { env, client, errands } = makeEnv({ errandSettings: { maxOpen: 3 } });
  await withCapturedLogs(async () => {
    const { first, second } = await oneDoneOneQueued(env, client, errands);
    const done = (await status(env, { state: 'done' })).summary;
    assert.ok(done.includes(first) && !done.includes(second));
    const queued = (await status(env, { state: 'queued' })).summary;
    assert.ok(queued.includes(second) && !queued.includes(first));
    assert.equal((await status(env, { state: 'failed' })).status, 'ok');
    assert.ok(!(await status(env, { state: 'failed' })).summary.includes(first));
  });
});

test('errand.list with a limit lists the newest errands first and stops at the limit', async () => {
  const { env, client, errands } = makeEnv();
  await withCapturedLogs(async () => {
    const { first, second } = await oneDoneOneQueued(env, client, errands);
    const one = (await status(env, { limit: 1 })).summary;
    assert.ok(one.startsWith(second) && !one.includes(first));
    const both = (await status(env, { limit: 5 })).summary.split('\n');
    assert.deepEqual(
      both.map((line: string) => line.split(' ')[0]),
      [second, first]
    );
  });
});

test('errand.list with a time window lists the errands created inside it', async () => {
  // Catches: since or until is ignored, or compared against the wrong time.
  const { env, client, errands } = makeEnv();
  await withCapturedLogs(async () => {
    const { first } = await oneDoneOneQueued(env, client, errands);
    const hour = 3600_000;
    const past = new Date(Date.now() - hour).toISOString();
    const future = new Date(Date.now() + hour).toISOString();
    assert.ok((await status(env, { since: past, until: future })).summary.includes(first));
    assert.ok(!(await status(env, { since: future })).summary.includes(first), 'created before since');
    assert.ok(!(await status(env, { until: past })).summary.includes(first), 'created after until');
  });
});

test("errand.list with a filter hides another member's private errand and answers empty, not an error", async () => {
  // Catches: the listing path skips the view rule of a private chat.
  const { env } = makeEnv();
  await withCapturedLogs(async () => {
    const started = await runOp(
      'errand.scout',
      { goal: 'private errand' },
      ctx(env, MEMBER, { dmChat: true, placeId: 'dm1' }) as unknown as Parameters<typeof runOp>[2]
    );
    const dm = taskIdOf(started.data);
    const other = await status(env, { state: 'queued' }, OTHER);
    assert.equal(other.status, 'ok');
    assert.ok(!other.summary.includes(dm));
    assert.ok((await status(env, { state: 'queued' }, MEMBER)).summary.includes(dm));
  });
});

test('errand.list refuses a state, a date or a limit it cannot read', async () => {
  const { env } = makeEnv();
  await withCapturedLogs(async () => {
    assert.equal((await status(env, { state: 'sleeping' })).status, 'invalid');
    assert.equal((await status(env, { since: 'soon' })).status, 'invalid');
    assert.equal((await status(env, { limit: 0 })).status, 'invalid');
  });
});

// ---- A call that waits for its errand (a heartbeat or a diary turn) -------------------------------------------------

/**
 * Waits until `client` received a run, at most 1000 turns of the event loop: a run that never starts fails the test
 * instead of spending the file's time budget.
 */
async function firstRun(client: { runs: Array<unknown> }): Promise<void> {
  for (let turn = 0; client.runs.length === 0; turn += 1) {
    if (turn >= 1000) throw new Error('no run started');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** One `errand.scout` of the persona's that waits up to `waitMs`, started now; `ended` resolves with its answer. */
function waitingCall(env: unknown, waitMs: number) {
  return runOp(
    'errand.scout',
    { goal: 'find the changelog' },
    ctx(env, null, { actor: 'persona', waitMs }) as unknown as Parameters<typeof runOp>[2]
  );
}

test('errand.scout: a call that waits answers with the result text once the errand is done', async () => {
  // Catches: the waiting call answers `queued` and the persona never reads the result in the turn that asked for it.
  const { env, client, stores } = makeEnv({ labels: LABELS });
  await withCapturedLogs(async () => {
    const answer = waitingCall(env, 600_000);
    // Bounded, so a run that never starts fails at once.
    await firstRun(client);
    const id = String(asRecord(client.runs[0]).id);
    client.end(id, { status: 'done', result: { text: 'the changelog is at v3.2' }, usage: { usd: 0.01 } });
    const result = await answer;
    assert.deepEqual([result.status, result.code], ['ok', 'ok']);
    assert.match(String(asRecord(result.data).text), /the changelog is at v3\.2/);
    assert.equal(Boolean(stores.get()?.get(id)?.readAt), true, 'shown to the persona whole, so read');
  });
});

test("errand.scout: a waited errand that fails answers failed with the errand's own code", async () => {
  // Catches: a failed errand reads as a success, or as a bare error without the errand's own code.
  const { env, client } = makeEnv({ labels: LABELS });
  await withCapturedLogs(async () => {
    const answer = waitingCall(env, 600_000);
    // Bounded, so a run that never starts fails at once.
    await firstRun(client);
    client.end(String(asRecord(client.runs[0]).id), { status: 'failed', error: 'backend-error' } as never);
    const result = await answer;
    assert.deepEqual([result.status, result.code], ['failed', 'backend-error']);
  });
});

test('errand.scout: a wait that outlasts its time answers errand-wait-ended and the errand runs on unread', async () => {
  // Catches: a wait past the turn's budget hangs the turn, or reads as a failed errand that never comes back.
  const { env, client, stores } = makeEnv({ labels: LABELS });
  await withCapturedLogs(async () => {
    const result = await waitingCall(env, 5);
    assert.deepEqual([result.code, asRecord(result.data).unknown], ['errand-wait-ended', true]);
    const id = String(asRecord(client.runs[0]).id);
    assert.deepEqual([stores.get()?.get(id)?.state, Boolean(stores.get()?.get(id)?.readAt)], ['running', false]);
  });
});

// ---- the errand tools over the board ---------------------------------------------------------------------------
// A real memory service on the calling thread and a fake errand client the test ends by hand. `OPENED` holds the
// services these cases open, closed when the file is done.
const NOW = Date.parse('2026-10-31T09:00:00.000Z');

const SILENT = { info() {}, warn() {}, error() {}, debug() {} };

type MemoryDb = ReturnType<typeof openTestMemorySync>['memoryDb'];

type Answer = { status: string; code: string; summary: string; data: unknown };

type Env = ReturnType<typeof createOpsEnv>;

const OPENED: Array<{ close: () => unknown }> = [];

after(async () => {
  for (const memory of OPENED) await memory.close();
});

/** A fake errand client: each run waits until the test ends it (or a cancel does). */
function boardClient(): Partial<ErrandClient> & { end: (id: string, outcome: Partial<RunOutcome>) => void } {
  const gates = new Map<string, (outcome: RunOutcome) => void>();
  const outcome = (given: Partial<RunOutcome>): RunOutcome => ({
    status: given.status ?? 'failed',
    result: given.result ?? { text: '', sources: [], files: [] },
    usage: given.usage ?? { input: 0, output: 0, usd: 0, steps: 0, seconds: 0 },
    ...(given.error ? { error: given.error } : {}),
  });
  return {
    configured: () => true,
    run: (request) => new Promise<RunOutcome>((resolve) => gates.set(request.id, resolve)),
    cancel: (request) => {
      gates.get(request.id)?.(outcome({ status: 'cancelled', error: 'cancelled' }));
      return true;
    },
    end: (id, given) => gates.get(id)?.(outcome(given)),
  };
}

type Rig = { env: Env; client: ReturnType<typeof boardClient>; errands: ErrandService; stores: ErrandStores };

/** The ops of the errand tools over stores on `memoryDb` (null: the errands kept in memory only). */
function boardEnv(memoryDb: MemoryDb | null, { openPrivate = false } = {}): Rig {
  const hot = {
    config: {
      context: { memory: { openPrivate } },
      bot: { owners: [OWNER], access: {} },
      features: {},
      errands: { maxOpen: 3, resultMaxChars: 40 },
      agents: { scout: { enabled: true, daily: { tasks: 10 } }, server: { enabled: true, daily: { tasks: 10 } } },
    },
    prompts: { labels: {} },
    rootDir: tempDir('nep-errand-tools-board-'),
    reloadConfig: () => true,
  };
  const client = boardClient();
  const stores = createErrandStores({ config: () => hot.config, now: () => NOW, log: SILENT, memoryDb });
  const errands = createErrandService({ client, stores, hot, now: () => NOW, log: SILENT });
  const env = createOpsEnv({
    discord: createDiscordInterface().capabilities,
    hot,
    store: { state: { data: {}, markDirty() {} } },
    client: { channels: { cache: new Map() } },
    spontaneous: {},
    calibrator: { ratio: 1 },
    isServedRoot: (id: unknown) => id === 'g1',
    errands,
    now: () => NOW,
  });
  return { env, client, errands, stores };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** What an answer says: its status, code, summary and data. */
async function ask(env: Env, name: string, args: Obj, accountId: string = MEMBER): Promise<Answer> {
  const { status, code, summary, data } = await runOp(name, args, {
    env,
    placeId: 'g1',
    chatId: 'c1',
    accountId,
    roleIds: [],
  });
  return { status, code, summary, data };
}

/** The id of the errand an `errand.scout` answer names. */
function idOf(answer: Answer): string {
  const data = answer.data;
  const task = data !== null && typeof data === 'object' && 'task' in data ? data.task : null;
  const id = task !== null && typeof task === 'object' && 'id' in task ? task.id : null;
  if (typeof id !== 'string') throw new Error(`no errand id in ${answer.summary}`);
  return id;
}

/** Errand `id`'s task on the board as the read connection of `memoryDb` shows it. */
function taskOf(memoryDb: MemoryDb, id: string): BoardTask['task'] {
  // service.js types its read handle loosely; it is open.js's handle, `{ db }`, or null while the database is closed.
  const handle = memoryDb.readHandle() as { db: object } | null;
  if (!handle) throw new Error('the memory database is not open');
  const view = boardTaskOf(handle.db, id);
  if (view === null) throw new Error(`the board holds no task ${id}`);
  return view.task;
}

/** A memory service over a new data directory, written first by `prepare` when given. */
function openedAt(prefix: string, prepare: ((file: string) => void) | null = null): MemoryDb {
  const dataDir = path.join(tempDir(prefix), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  prepare?.(path.join(dataDir, 'memory.db'));
  const opened = openTestMemorySync({ dataDir, now: () => NOW, log: SILENT });
  OPENED.push(opened);
  return opened.memoryDb;
}

test('errand.scout files the errand on the board as a scout task in progress once it is sent', async () => {
  await withCapturedLogs(async () => {
    const memoryDb = openedAt('nep-errand-tools-run-');
    const { env, stores } = boardEnv(memoryDb);
    const id = idOf(await ask(env, 'errand.scout', { goal: 'find the changelog' }));
    await tick();
    await stores.flush();
    const task = taskOf(memoryDb, id);
    // The board holds errands only, so a task has no lane to check.
    assert.deepEqual([task.role, task.status], ['scout', 'in_progress']);
  });
});

test('errand.cancel moves the board task to cancelled', async () => {
  await withCapturedLogs(async () => {
    const memoryDb = openedAt('nep-errand-tools-cancel-');
    const { env, stores, errands } = boardEnv(memoryDb);
    const id = idOf(await ask(env, 'errand.scout', { goal: 'find the changelog' }));
    await tick();
    assert.equal((await ask(env, 'errand.cancel', { id })).status, 'ok');
    await errands.idle();
    await stores.flush();
    assert.equal(taskOf(memoryDb, id).status, 'cancelled');
  });
});

for (const openPrivate of [true, false])
  test(`errand.list of an errand asked in another person's direct chat ${openPrivate ? 'answers' : 'is not-found'} in a group with openPrivate ${openPrivate}`, async () => {
    // Bug: the switch opens the persona's memory, but their tool still hides an errand of a direct chat from a group turn.
    await withCapturedLogs(async () => {
      const { env, errands } = boardEnv(null, { openPrivate });
      const added = errands.submit({
        agent: 'scout',
        goal: 'find the changelog',
        requester: { accountId: '99', kind: 'member' },
        origin: { placeId: 'dm-99', messageId: null },
        scope: 'dm',
      });
      const id = added.errand?.id ?? '';
      const answer = await ask(env, 'errand.list', { id });
      assert.equal(answer.status === 'ok', openPrivate, answer.summary);
    });
  });

// Tests for the persona's own tools in a turn (src/tools/tools.ts over src/behavior/turn.ts): web.search, web.read,
// memory.search, media.look and draw.create run inside the turn and come back in it as the tool message of
// the call; the step engine itself has its own tests. Over a real admin and the fake interface
// adapter (scripts/lib/fake.ts); no network, no data/.

// The persona's in-turn tools: web.search and memory.search run inside the turn and come back in it,
// labelled by where they came from; a result is data, never a call.

/** A web lookup fake whose raw search answers one result with `text` as its snippet (null: nothing came back); its page reader answers `page`. */
function fakeLookup(
  text = 'Η Ana κέρδισε τον τελικό.',
  page = { ok: true, url: 'https://example.org/x', title: 'Σελίδα', text: 'Το κείμενο της σελίδας.', cut: false }
) {
  const searches: Array<{ placeId: Untyped; query: Untyped }> = [];
  const reads: Array<{ placeId: Untyped; url: Untyped }> = [];
  return {
    searches,
    reads,
    hasSearch: () => true,
    webCapLeft: () => 10,
    readLinks: async () => ({ reads: new Map(), newCount: 0 }),
    cachedReads: () => new Map(),
    search: async () => {
      throw new Error('the condensed search is never a tool of the persona');
    },
    searchResults: async (placeId: string, query: unknown) => {
      searches.push({ placeId, query });
      return text === null
        ? null
        : { query, results: [{ title: 'Un', url: 'https://www.example.com/1', site: 'example.com', snippet: text }] };
    },
    readPage: async (placeId: string, url: string) => {
      reads.push({ placeId, url });
      return page;
    },
  };
}

// Dispatch: an errand only from the persona's own accepted errand.scout call, recorded with the turn and the
// brief the persona wrote, once per call whatever retries.

test('errand.scout in the loop: after a search the persona hands off the errand, it is queued once with the turn and the brief as written; the same call again queues nothing', async () => {
  const hot = hotWith({ config: { ...WEB_CONFIG, ...AGENTS } });
  const { service, runs } = errandService(hot);
  const brief = 'Βρες στο pixiv το πιο δημοφιλές έργο με την ετικέτα serial_experiments_lain και φέρε το αρχείο.';
  const { journal } = journalOverMemory();
  const run = await coreTurn({
    answers: [
      toolAnswer('', [call('web.search', { query: 'pixiv serial_experiments_lain' })]),
      toolAnswer(`<msg>το στέλνω να ψάξει</msg>`, [call('errand.scout', { goal: `${brief}` })]),
      '<skip/>',
    ],
    allowed: ['web.search', 'errand.scout'],
    features: { webLookup: true },
    config: { ...WEB_CONFIG, ...AGENTS },
    runner: { lookup: fakeLookup(), errands: service },
    adminExtra: { errands: service },
    journal,
  } as unknown as Parameters<typeof coreTurn>[0]);
  assert.equal(asRecord(run.result).outcome, 'spoke');
  const tasks = service.store()?.recent(10);
  assert.equal(tasks?.length, 1, 'one errand');
  const [task] = tasks;
  assert.equal(task.goal, brief, 'the brief as the persona wrote it');
  assert.equal(task.requester.kind, 'owner');
  assert.match(asRecord(task.origin).turnId, /^t-u\d+$/, 'the journal turn of the call');
  // The key names the effect, never the attempt: `<turnId>:<effectIndex>:<target>`, the target the turn's channel c1
  // because errand.scout names none (stage 4 design, "After Astra": the delivery identity is the effect's record).
  assert.equal(task.idempotencyKey, `${task.origin.turnId}:1:c1`, 'the second call of the turn');
  assert.equal(runs.length, 1);
  // A quiet call in a turn that answers someone is shown to the persona in one step.
  const { calls } = run.llm;
  assert.equal(
    calls.length,
    3,
    'the accepted errand came back to the persona in one step, where the persona stayed silent'
  );
  assert.deepEqual(
    run.sends.map((send) => send.text),
    ['το στέλνω να ψάξει']
  );
  // The same call made again (a retry): the same errand, nothing new queued or run.
  const again = await run.admin.runSkillOp(
    'errand.scout',
    { agent: 'scout', goal: brief },
    {
      placeId: 'g1',
      chatId: 'c1',
      accountId: 'u1',
      roleIds: [],
      actor: 'persona',
      turnId: task.origin.turnId,
      idempotencyKey: task.idempotencyKey,
    }
  );
  assert.equal(again.status, 'ok');
  assert.equal(asRecord(again.data).task.id, task.id);
  assert.deepEqual([service.store()?.recent(10).length, runs.length], [1, 1]);
});

test('errand.scout not granted: refused before it runs, no errand; nothing but an accepted call of the persona ever queues one', async () => {
  const hot = hotWith({ config: { ...WEB_CONFIG, ...AGENTS } });
  const { service, runs } = errandService(hot);
  const run = await coreTurn({
    answers: [toolAnswer('', [call('errand.scout', { goal: 'βρες κάτι' })]), '<msg>δεν μπορώ</msg>'],
    allowed: [],
    config: { ...WEB_CONFIG, ...AGENTS },
    runner: { errands: service },
    adminExtra: { errands: service },
  });
  assert.deepEqual([service.store()?.recent(10).length, runs.length], [0, 0]);
  assert.ok(
    run.logs.some(
      (entry) => entry.msg === 'skill: refused' && entry.skill === 'errand.scout' && entry.code === 'not-allowed'
    )
  );
  assert.deepEqual(
    run.sends.map((send) => send.text),
    ['δεν μπορώ']
  );
});
