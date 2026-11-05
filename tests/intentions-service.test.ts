// Tests for the persona's intentions at work: src/intentions/service.ts and store.js behind the
// `/nep task intent` operations (src/tools/impl/intent.ts), over a real task store and errand service (a
// temp data/ directory) with a FAKE errand client and a fake clock. Reliable waiting: a failed
// launch leaves nothing waiting, an errand of the same turn is linked whichever call came first,
// its end moves the wait back to pending once (a duplicate end is a no-op), a missing end is found
// by the reconciliation, a cancel is final, and a restart (a new store over the same files) keeps
// everything. Candidates from her lines are anchored, de-duplicated, capped and expire.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { runOp as runOperation } from '../src/tools/impl/index.ts';
import type { OpResult } from '../src/tools/impl/index.ts';
import { createOpsEnv } from '../src/tools/impl/env.ts';
import { createErrandStores } from '../src/errands/store.ts';
import { createErrandService } from '../src/errands/service.ts';
import { createErrandTurns, errandDoneEvent } from '../src/errands/turns.ts';
import { createEventDoor } from '../src/interface/door.ts';
import { createIntentionStores } from '../src/intentions/store.ts';
import { createIntentionService } from '../src/intentions/service.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { createDiscordInterface } from '../interfaces/discord/index.ts';
import { useIface, world } from './fixtures/turn-world.ts';
import { tempDir } from './fixtures/tmp.ts';
import { openTestMemorySync, unitFile } from './fixtures/memory-db/service.ts';
import type { Untyped } from '../src/tools/types.ts';
import { wrongly, present } from './fixtures/loose-types.ts';
import type { RunOutcome, RunRequest } from '../src/errands/types.ts';
import type { Created, IntentionService } from '../src/intentions/types.ts';

/** The answer of an operation with its `data` read by field name, as these tests do. */
type OpAnswer = Omit<OpResult, 'data'> & {
  data: { text: string; task: { id: string }; intention: { id: string; status: string } };
};
const runOp = async (...args: Parameters<typeof runOperation>): Promise<OpAnswer> =>
  wrongly<OpAnswer>(await runOperation(...args));

/** The memory database of each data directory used here, opened once; closed when the file is done. */
const MEMORY = new Map<string, ReturnType<typeof openTestMemorySync>>();
after(async () => {
  for (const { close } of MEMORY.values()) await close();
});
function memoryOf(dataDir: string) {
  if (!MEMORY.has(dataDir)) MEMORY.set(dataDir, openTestMemorySync({ dataDir }));
  return present(MEMORY.get(dataDir)).memoryDb;
}

const DISCORD = createDiscordInterface().capabilities;
// The conversation an errand answers in is held by the fake interface of the test's world.
useIface('fake');
const OWNER = '42';
const T0 = Date.parse('2026-10-18T10:00:00Z');
const HOUR = 60 * 60 * 1000;

type Env = ReturnType<typeof makeEnv>['env'];

/** A fake errand client: records each run and lets the test end it. */
function fakeClient() {
  const runs: Array<RunRequest> = [];
  const gates = new Map<string, (outcome: RunOutcome) => void>();
  return {
    runs,
    configured: () => true,
    run(request: RunRequest): Promise<RunOutcome> {
      runs.push(request);
      return new Promise((resolve) => gates.set(request.id, resolve));
    },
    cancel(request: { agent: string; id: string }) {
      gates.get(request.id)?.(wrongly<RunOutcome>({ status: 'cancelled', error: 'cancelled' }));
      return true;
    },
    end(id: string, outcome = { status: 'done', result: { text: 'ok' }, usage: { usd: 0.01 } }) {
      // The service reads only the fields a runner reports, and a test names just those.
      gates.get(id)?.(wrongly<RunOutcome>(outcome));
    },
  };
}

function makeEnv({
  errandSettings = {},
  agents = {},
  intentions: settings = {},
  rootDir = tempDir('nep-intent-'),
  clock = { t: T0 },
}: {
  errandSettings?: Record<string, Untyped>;
  agents?: Record<string, Untyped>;
  intentions?: Record<string, Untyped>;
  rootDir?: string;
  clock?: { t: number };
} = {}) {
  const hot = {
    config: {
      bot: { owners: [OWNER], access: {}, ...wrongly<{ timezone?: string }>({}) },
      errands: { maxOpen: 3, ...errandSettings },
      agents: { scout: { enabled: true, daily: { tasks: 10 } }, ...agents },
      intentions: {
        expiresDays: 14,
        maxOpen: 20,
        ...settings,
      },
    },
    prompts: { labels: {} },
    rootDir,
    reloadConfig: () => true,
  };
  const now = () => clock.t;
  const client = fakeClient();
  const dataDir = path.join(rootDir, 'data');
  const stores = createErrandStores({ memoryDb: memoryOf(dataDir), config: () => hot.config, now });
  const intentionStores = createIntentionStores({ memoryDb: memoryOf(dataDir), now });
  let intentions = wrongly<ReturnType<typeof createIntentionService>>(null);
  // An errand's end goes the way src/index.ts sends it: an errand.done event through the event
  // door, whose handler (the task turns) moves the waiting intentions, then runs her result turn,
  // which notes what it found.
  let door = wrongly<ReturnType<typeof createEventDoor>>(null);
  const turnSaw: Array<Untyped> = [];
  const turns = {
    isBusy: () => false,
    isAnyBusy: () => false,
    runTurn: async ({ taskResult }: Record<string, Untyped>) => {
      turnSaw.push({
        taskId: taskResult.id,
        intentions: intentions.list({ closed: true, all: true }).map((r) => ({ id: r.id, status: r.status })),
      });
      return { outcome: 'spoke' };
    },
  };
  world().channel({ id: 'c1' });
  const errands = createErrandService({
    client,
    stores,
    hot,
    isServedCommunity: (id: unknown) => id === 'g1',
    now,
    onFinished: (task) => door.submit(errandDoneEvent(task, now)),
  });
  intentions = createIntentionService({
    stores: intentionStores,
    hot,
    errands,
    now,
  });
  const taskTurns = createErrandTurns({
    hot,
    reads: world().reads,
    iface: () => 'fake',
    turns,
    errands,
    intentions,
    now,
    setTimer: wrongly(() => null),
  });
  door = createEventDoor({ handlers: { 'errand.done': (event) => taskTurns.onEvent(event) } });
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
    intentions,
    now,
  });
  return { env, hot, client, errands, intentions, stores, intentionStores, rootDir, dataDir, clock, door, turnSaw };
}

/** Her own call's context in turn `turnId` (an owner asked). */
const hers = (env: Env, turnId: string, extra = {}) => ({
  env,
  placeId: 'g1',
  conversationId: 'c1',
  userId: OWNER,
  roleIds: [],
  actor: 'persona',
  turnId,
  sourceMessageId: 'm1',
  ...extra,
});
/** An owner's command. */
const owner = (env: Env) => ({ env, placeId: 'g1', conversationId: 'c1', userId: OWNER, roleIds: [] });

function onlyIntention(intentions: IntentionService) {
  const list = intentions.list();
  assert.equal(list.length, 1);
  return list[0];
}

test('intention.set: the answer line says the due time in bot.timezone as the intentions block writes it, never as a bare UTC figure', async () => {
  const { env, hot } = makeEnv();
  hot.config.bot.timezone = 'Europe/Moscow';
  await withCapturedLogs(async () => {
    // T0 is 10:00 UTC, 13:00 in Moscow; one minute on is 13:01 there.
    const result = await runOp('intention.set', { text: 'βρες ένα meme', due: '1m' }, hers(env, 'T1'));
    assert.equal(result.status, 'ok', result.summary);
    assert.match(result.data.text, /due Sun, October 18 13:01,/, result.data.text);
    assert.doesNotMatch(result.data.text, /10:01/, 'no UTC clock in the line');
  });
});

test('intention.set: her own intention is pending with its provenance, written to intentions.json', async () => {
  const { env, intentions, intentionStores, dataDir } = makeEnv();
  await withCapturedLogs(async () => {
    const result = await runOp('intention.set', { text: 'φέρε το άρθρο στην Ελένη', due: '3h' }, hers(env, 'T1'));
    assert.equal(result.status, 'ok', result.summary);
    const record = onlyIntention(intentions);
    assert.equal(record.status, 'pending');
    assert.equal(record.dueAt, T0 + 3 * HOUR);
    assert.deepEqual(record.provenance, {
      kind: 'self',
      turnId: 'T1',
      messageId: 'm1',
      placeId: 'c1',
      scope: 'group',
      participants: [OWNER],
    });
    await present(intentionStores.get()).flush();
    const file = JSON.parse(wrongly(unitFile(memoryOf(dataDir), 'guilds/g1/intentions.json')));
    assert.deepEqual(
      file.intentions.map((r: Record<string, Untyped>) => r.id),
      [record.id]
    );
    assert.equal((await runOp('intention.set', { text: 'x', due: 'soon' }, hers(env, 'T1'))).code, 'bad-time');
  });
});

test('reliable waiting: a wait asked before a launch that fails leaves no waiting intention', async () => {
  const { env, intentions, client } = makeEnv({ errandSettings: { maxOpen: 0 } });
  await withCapturedLogs(async () => {
    const set = await runOp('intention.set', { text: 'ψάξε τα νέα', deadline: '1h' }, hers(env, 'T1'));
    assert.equal(set.status, 'ok', set.summary);
    const launched = await runOp('errand.run', { agent: 'scout', goal: 'find the news' }, hers(env, 'T1'));
    assert.equal(launched.code, 'cap-open', 'the launch failed explicitly');
    const record = onlyIntention(intentions);
    assert.equal(record.status, 'pending');
    assert.equal(record.awaitingErrandId, null);
    assert.equal(client.runs.length, 0);
    assert.deepEqual(intentions.reconcile(), { arrived: 0, missing: 0, deadline: 0, expired: 0 });
    // A wait on an errand the store does not hold is refused, never recorded.
    assert.equal(
      (await runOp('intention.update', { id: record.id, errand: 'tnothere' }, hers(env, 'T1'))).code,
      'no-errand'
    );
  });
});

test('reliable waiting: the errand of the same turn is linked, intention first; its end moves the wait to pending once', async () => {
  const { env, intentions, client, errands, door, turnSaw } = makeEnv();
  await withCapturedLogs(async () => {
    await runOp('intention.set', { text: 'ψάξε τα νέα', deadline: '1h' }, hers(env, 'T1'));
    const launched = await runOp(
      'errand.run',
      { agent: 'scout', goal: 'find the news' },
      hers(env, 'T1', { idempotencyKey: 'T1.1:1' })
    );
    const taskId = launched.data.task.id;
    let record = onlyIntention(intentions);
    assert.equal(record.status, 'waiting');
    assert.equal(record.awaitingErrandId, taskId);
    assert.equal(record.waitDeadline, T0 + HOUR);
    await new Promise((r) => setImmediate(r));
    client.end(taskId);
    await errands.idle();
    record = onlyIntention(intentions);
    assert.equal(record.status, 'pending');
    assert.deepEqual(record.outcome, { errandId: taskId, state: 'done', at: T0 });
    // The end came through the event door; her result turn already saw the intention pending.
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(turnSaw, [{ taskId, intentions: [{ id: record.id, status: 'pending' }] }]);
    const before = JSON.stringify(record);
    // The same end delivered again changes nothing: the door drops the repeat, the service moves nothing.
    assert.equal((await door.submit(errandDoneEvent(wrongly({ id: taskId, state: 'done' })))).status, 'duplicate');
    assert.equal(intentions.onErrandFinished(wrongly({ id: taskId, state: 'done' })), 0);
    assert.equal(JSON.stringify(onlyIntention(intentions)), before);
    assert.equal(turnSaw.length, 1);
  });
});

test('reliable waiting: the errand queued first in the turn is linked when the intention asks for the wait', async () => {
  const { env, intentions } = makeEnv();
  await withCapturedLogs(async () => {
    const launched = await runOp('errand.run', { agent: 'scout', goal: 'find the news' }, hers(env, 'T2'));
    const set = await runOp('intention.set', { text: 'πες τι βρήκες', deadline: '2h' }, hers(env, 'T2'));
    assert.equal(set.status, 'ok', set.summary);
    const record = onlyIntention(intentions);
    assert.equal(record.status, 'waiting');
    assert.equal(record.awaitingErrandId, launched.data.task.id);
  });
});

test('reconciliation: an end that never arrived, a gone errand and a passed deadline are each found', async () => {
  const { env, intentions, stores, clock } = makeEnv();
  await withCapturedLogs(async () => {
    const a = (await runOp('errand.run', { agent: 'scout', goal: 'a' }, owner(env))).data.task.id;
    const b = (await runOp('errand.run', { agent: 'scout', goal: 'b' }, owner(env))).data.task.id;
    const ia = (await runOp('intention.set', { text: 'περιμένω το a', errand: a, deadline: '5h' }, owner(env))).data
      .intention.id;
    const ib = (await runOp('intention.set', { text: 'περιμένω το b', errand: b, deadline: '1h' }, owner(env))).data
      .intention.id;
    assert.equal(intentions.list().filter((r) => r.status === 'waiting').length, 2);
    // Errand a ends in the store with no completion event reaching the intentions.
    present(stores.get()).finish(a, { status: 'done', result: { text: 'x' } });
    clock.t = T0 + 2 * HOUR;
    const counts = intentions.reconcile();
    assert.deepEqual(counts, { arrived: 1, missing: 0, deadline: 1, expired: 0 });
    const byId = Object.fromEntries(intentions.list().map((r: Record<string, Untyped>) => [r.id, r]));
    assert.equal(byId[ia].status, 'pending');
    assert.equal(byId[ia].outcome.state, 'done');
    assert.equal(byId[ib].note, 'wait-deadline');
    // A wait whose errand the store no longer holds.
    const c = (await runOp('errand.run', { agent: 'scout', goal: 'c' }, owner(env))).data.task.id;
    const ic = (await runOp('intention.update', { id: ib, errand: c, deadline: '1h' }, owner(env))).data.intention.id;
    // The store no longer holds the errand.
    const held = stores.get();
    const holds = present(held).get;
    present(held).get = (id) => (id === c ? null : holds(id));
    assert.equal(intentions.reconcile().missing, 1);
    assert.equal(present(intentions.list().find((r) => r.id === ic)).note, 'errand-missing');
  });
});

test('intention.cancel: a cancelled intention is final; a restart reads every intention back as it was', async () => {
  const { env, intentions, intentionStores, rootDir, clock } = makeEnv();
  await withCapturedLogs(async () => {
    const first = (await runOp('intention.set', { text: 'ένα', due: '1d', chain: 'k1' }, owner(env))).data.intention.id;
    const second = (await runOp('intention.set', { text: 'δύο' }, owner(env))).data.intention.id;
    assert.equal((await runOp('intention.cancel', { id: second }, owner(env))).status, 'ok');
    assert.equal((await runOp('intention.update', { id: second, state: 'pending' }, owner(env))).code, 'terminal');
    assert.equal((await runOp('intention.cancel', { id: second }, owner(env))).code, 'terminal');
    const before = intentions.list({ closed: true });
    await present(intentionStores.get()).flush();
    const again = makeEnv({ rootDir, clock });
    assert.deepEqual(again.intentions.list({ closed: true }), before);
    assert.equal(
      again.intentions
        .list()
        .map((r) => r.id)
        .join(),
      first
    );
    const listed = await runOp('intention.list', {}, owner(again.env));
    assert.match(listed.summary, new RegExp(`^${first} pending, due `));
  });
});

test('intention.update / intention.cancel: the id alone in the body counts as the id; any other body stays the purpose', async () => {
  const { env, intentions } = makeEnv();
  await withCapturedLogs(async () => {
    const id = (await runOp('intention.set', { text: 'ένα' }, hers(env, 'T1'))).data.intention.id;
    // The id in the body (`text`) and no `id=`: the update finds it and the purpose is untouched.
    const done = await runOp('intention.update', { text: `${id}`, state: 'done' }, hers(env, 'T2'));
    assert.equal(done.status, 'ok', done.summary);
    assert.equal(done.data.intention.id, id);
    const record = intentions.list({ closed: true, all: true }).find((r) => r.id === id);
    assert.equal(present(record).status, 'done');
    assert.equal(present(record).purpose, 'ένα', 'the body was the id, not a new purpose');
    // A body that is not one bare id is the purpose as before; without an id the call is invalid.
    const other = (await runOp('intention.set', { text: 'δύο' }, hers(env, 'T3'))).data.intention.id;
    assert.equal((await runOp('intention.update', { text: 'τρία' }, hers(env, 'T3'))).code, 'invalid-args');
    assert.equal(
      (await runOp('intention.update', { text: `${other} και κάτι` }, hers(env, 'T3'))).code,
      'invalid-args'
    );
    const renamed = await runOp('intention.update', { id: other, text: 'τρία' }, hers(env, 'T3'));
    assert.equal(renamed.status, 'ok');
    assert.equal(present(intentions.list().find((r) => r.id === other)).purpose, 'τρία');
    // An explicit id wins over a body that looks like one.
    const third = (await runOp('intention.set', { text: 'τέσσερα' }, hers(env, 'T4'))).data.intention.id;
    assert.equal(
      (await runOp('intention.update', { id: third, text: other, state: 'done' }, hers(env, 'T4'))).data.intention.id,
      third
    );
    // The cancel the same way, with surrounding blanks.
    const cancelled = await runOp('intention.cancel', { text: ` ${other} ` }, hers(env, 'T5'));
    assert.equal(cancelled.status, 'ok', cancelled.summary);
    assert.equal(cancelled.data.intention.status, 'cancelled');
    assert.equal((await runOp('intention.cancel', { text: 'no reason' }, hers(env, 'T5'))).code, 'invalid-args');
  });
});

test('intentions: markExpiredShown marks an expired intention once; an open one, an unknown id and a second call change nothing', async () => {
  const { intentions, clock } = makeEnv();
  const own = present(
    wrongly<Created>(
      intentions.set({
        purpose: 'soon gone',
        expiresAt: T0 + HOUR,
        placeId: 'c1',
        scope: 'group',
      })
    ).intention
  );
  assert.deepEqual(
    intentions.markExpiredShown(own.id),
    { ok: true, intention: own, changed: false },
    'still open: nothing to mark'
  );
  clock.t = T0 + HOUR;
  assert.equal(intentions.list({ closed: true })[0].status, 'expired', 'the sweep expired it');
  clock.t = T0 + 2 * HOUR;
  const marked = intentions.markExpiredShown(own.id);
  assert.equal(marked.changed, true);
  assert.equal(marked.intention.expiredShownAt, T0 + 2 * HOUR);
  assert.equal(present(present(intentions.store()).get(own.id)).expiredShownAt, T0 + 2 * HOUR, 'written');
  assert.equal(intentions.markExpiredShown(own.id).changed, false, 'once');
  assert.deepEqual(intentions.markExpiredShown('i00000000'), { ok: false, code: 'not-found' });
  assert.equal(intentions.markExpiredShown(own.id).changed, false, 'the default guild is the same store');
});

test("private chats: her intention in a DM is the DM's own -- never in a server turn, not movable from a server channel, gone with a forget of the member", async () => {
  const { env, intentions } = makeEnv();
  const dm = (extra = {}) => hers(env, 'T1', { conversationId: 'dm1', privateChat: true, ...extra });
  await withCapturedLogs(async () => {
    const set = await runOp('intention.set', { text: 'ρώτα την για τις εξετάσεις' }, dm());
    assert.equal(set.status, 'ok', set.summary);
    const id = set.data.intention.id;
    const record = present(intentions.store()).get(id);
    assert.equal(present(record).provenance.scope, 'dm');
    assert.deepEqual(present(record).provenance.participants, [OWNER], 'the member of the private chat');
    assert.deepEqual(
      intentions.view().map((r) => r.id),
      [],
      'a server turn never sees it'
    );
    assert.deepEqual(
      intentions.view({ privateChannelId: 'dm2' }).map((r) => r.id),
      [],
      'nor another private chat'
    );
    assert.deepEqual(
      intentions.view({ privateChannelId: 'dm1' }).map((r) => r.id),
      [id]
    );
    // Her call from a server channel cannot reach it, even by its id.
    assert.equal((await runOp('intention.update', { id, text: 'άλλο' }, hers(env, 'T2'))).code, 'not-found');
    assert.equal((await runOp('intention.cancel', { id }, hers(env, 'T2'))).code, 'not-found');
    assert.equal((await runOp('intention.list', {}, hers(env, 'T2'))).summary, 'no open intentions');
    assert.equal((await runOp('intention.update', { id, due: '2h' }, dm())).status, 'ok', 'in its own chat it moves');
  });
});

// ---- recurring intentions (`every`) ------------------------------------------------

const DAY = 24 * HOUR;

test('intention.set / intention.update: every= makes a recurring intention with the wall-clock due pinned in bot.timezone; every=none makes it one-off again; views print it', async () => {
  const { env, hot, intentions } = makeEnv();
  hot.config.bot.timezone = 'Europe/Athens';
  await withCapturedLogs(async () => {
    // T0 is 13:00 in Athens: 21:00 is later today (18:00Z).
    const set = await runOp('intention.set', { text: 'ψάξε για memes', due: '21:00', every: 'day' }, hers(env, 'T1'));
    assert.equal(set.status, 'ok', set.summary);
    const record = onlyIntention(intentions);
    assert.deepEqual(record.every, { period: 'day', at: '21:00' });
    assert.equal(record.dueAt, Date.parse('2026-10-18T18:00:00Z'));
    assert.equal(record.expiresAt, T0 + 30 * DAY, 'intentions.recurringExpiresDays');
    assert.match(set.summary, /every day/);
    assert.match((await runOp('intention.list', {}, owner(env))).summary, /every day/);
    assert.equal(
      (await runOp('intention.set', { text: 'x', due: '1h', every: 'hourly' }, hers(env, 'T1'))).code,
      'bad-every'
    );
    assert.equal(
      (await runOp('intention.set', { text: 'x', every: 'day' }, hers(env, 'T1'))).code,
      'every-without-due'
    );
    assert.equal((await runOp('intention.set', { text: 'x', due: 'mon 9' }, hers(env, 'T1'))).code, 'bad-time');
    // A weekly one from a weekday form; every=none clears it.
    const weekly = await runOp(
      'intention.set',
      { text: 'κοίτα το νήμα', due: 'mon 20:00', every: 'week' },
      hers(env, 'T1')
    );
    assert.equal(weekly.status, 'ok', weekly.summary);
    const weeklyRecord = present(intentions.store()).get(weekly.data.intention.id);
    assert.deepEqual(present(weeklyRecord).every, { period: 'week', at: '20:00' });
    assert.equal(present(weeklyRecord).dueAt, Date.parse('2026-10-19T17:00:00Z'));
    const cleared = await runOp('intention.update', { id: present(weeklyRecord).id, every: 'none' }, hers(env, 'T2'));
    assert.equal(cleared.status, 'ok', cleared.summary);
    assert.equal(present(present(intentions.store()).get(present(weeklyRecord).id)).every, null);
    assert.doesNotMatch(cleared.summary, /every/);
    // An interval on an existing one-off; a new due re-pins a daily one.
    const twelve = await runOp('intention.update', { id: present(weeklyRecord).id, every: '12h' }, hers(env, 'T2'));
    assert.deepEqual(present(present(intentions.store()).get(present(weeklyRecord).id)).every, {
      period: '12h',
      at: null,
    });
    assert.match(twelve.summary, /every 12h/);
    await runOp('intention.update', { id: record.id, due: '22:30' }, hers(env, 'T2'));
    assert.deepEqual(present(present(intentions.store()).get(record.id)).every, { period: 'day', at: '22:30' });
    const noDue = (await runOp('intention.set', { text: 'y' }, hers(env, 'T3'))).data.intention.id;
    assert.equal(
      (await runOp('intention.update', { id: noDue, every: 'day' }, hers(env, 'T3'))).code,
      'every-without-due'
    );
  });
});

test('intentions: state=done on a recurring one closes the occurrence only; advance writes recurred or missed and never lists the same occurrence twice', async () => {
  const { env, intentions, clock } = makeEnv();
  await withCapturedLogs(async () => {
    const id = (await runOp('intention.set', { text: 'ψάξε για memes', due: '1h', every: 'day' }, hers(env, 'T1'))).data
      .intention.id;
    clock.t = T0 + HOUR + 5 * 60_000;
    assert.deepEqual(
      intentions.due().map((d) => d.intention.id),
      [id]
    );
    const done = await runOp('intention.update', { id, state: 'done' }, hers(env, 'T2'));
    assert.equal(done.status, 'ok', done.summary);
    let record = present(intentions.store()).get(id);
    assert.equal(present(record).status, 'pending', 'never done');
    assert.equal(present(record).dueAt, T0 + HOUR + DAY);
    assert.equal(present(present(record).history.at(-1)).code, 'done-occurrence');
    assert.deepEqual(intentions.due(), [], 'the next occurrence is not due yet');
    // The disposition's advance on an already advanced record changes nothing.
    assert.equal(intentions.advance(id, { named: true }).changed, false);
    // The next occurrence, left alone: missed; touched by a call of hers: recurred.
    clock.t = T0 + HOUR + DAY + 60_000;
    assert.equal(intentions.due().length, 1);
    assert.equal(intentions.advance(id, { named: false }).changed, true);
    record = present(intentions.store()).get(id);
    assert.equal(present(present(record).history.at(-1)).code, 'missed');
    assert.equal(present(present(record).history.at(-1)).by, 'engine');
    assert.equal(present(record).dueAt, T0 + HOUR + 2 * DAY);
    assert.deepEqual(intentions.due(), []);
    clock.t = T0 + HOUR + 2 * DAY + 60_000;
    assert.equal(present(present(intentions.advance(id, { named: true }).intention).history.at(-1)).code, 'recurred');
    // A one-off is not advanced; a cancel ends a recurring one for good.
    const once = (await runOp('intention.set', { text: 'μία φορά', due: '1m' }, hers(env, 'T3'))).data.intention.id;
    clock.t += 2 * 60_000;
    assert.equal(intentions.advance(once, { named: false }).changed, false);
    assert.equal((await runOp('intention.cancel', { id }, hers(env, 'T4'))).data.intention.status, 'cancelled');
    assert.equal(intentions.advance(id, { named: false }).changed, false);
  });
});

test("intentions: a recurring wait ends per occurrence -- the errand's end returns it to pending and advances it with the outcome kept", async () => {
  const { env, intentions, client, errands, clock } = makeEnv();
  await withCapturedLogs(async () => {
    const id = (await runOp('intention.set', { text: 'ψάξε τα νέα', due: '1m', every: 'day' }, hers(env, 'T1'))).data
      .intention.id;
    const launched = await runOp('errand.run', { agent: 'scout', goal: 'find the news' }, hers(env, 'T1'));
    const taskId = launched.data.task.id;
    const waited = await runOp('intention.update', { id, errand: taskId, deadline: '2h' }, hers(env, 'T1'));
    assert.equal(waited.status, 'ok', waited.summary);
    assert.equal(present(present(intentions.store()).get(id)).status, 'waiting');
    // The occurrence stays open while the wait runs: the disposition's advance leaves a waiting one alone.
    assert.equal(intentions.advance(id, { named: true }).changed, false);
    await new Promise((r) => setImmediate(r));
    // The errand ends once the occurrence is due: the wait's end closes it and the outcome stays on the record.
    clock.t = T0 + 5 * 60_000;
    client.end(taskId);
    await errands.idle();
    const record = present(intentions.store()).get(id);
    assert.equal(present(record).status, 'pending');
    assert.equal(present(record).dueAt, T0 + 60_000 + DAY, 'the next occurrence');
    assert.deepEqual(present(record).outcome, { errandId: taskId, state: 'done', at: clock.t });
    assert.equal(present(present(record).history.at(-1)).code, 'recurred');
    assert.equal(present(present(record).history.at(-2)).code, 'errand-done');
  });
});

// ---- attention: intention.set attend= ------------------------------------------------------

// PR 7d: the attention defaults are the constants ATTEND_DEFAULTS (settle 90 s, 12 a day).
test('intention.set attend=: an attention of hers with the defaults from wakes.attention, her own numbers and people; due and every on it are refused', async () => {
  const { env, intentions } = makeEnv();
  const set = await runOp('intention.set', { attend: 'c-garden' }, hers(env, 'T1'));
  assert.equal(set.status, 'ok', set.code);
  const record = onlyIntention(intentions);
  assert.equal(record.purpose, 'c-garden', 'the purpose is the place when she gives none');
  assert.deepEqual(record.attend, { place: 'c-garden', people: [], settle: 90, perDay: 12, today: null });
  assert.equal(record.dueAt, null);
  assert.match(set.data.text, /attend c-garden/);
  assert.match(set.data.text, /settle 90s, today 0\/12/);
  // Her own numbers and people (ids, comma or space separated; a mention unwrapped).
  const own = await runOp(
    'intention.set',
    { text: 'follow the garden talk', attend: 'c-garden', people: '7, <@8> 9', settle: '0', perday: 2 },
    hers(env, 'T2')
  );
  assert.equal(own.status, 'ok', own.code);
  const mine = intentions.list().find((r) => r.purpose === 'follow the garden talk');
  assert.deepEqual(present(mine).attend, {
    place: 'c-garden',
    people: ['7', '8', '9'],
    settle: 0,
    perDay: 2,
    today: null,
  });
  assert.match(own.data.text, /people 7,8,9/);
  // Refusals.
  assert.equal(
    (await runOp('intention.set', { attend: 'c-garden', due: '2h' }, hers(env, 'T3'))).code,
    'attend-with-due'
  );
  assert.equal(
    (await runOp('intention.set', { attend: 'c-garden', every: 'day', due: '2h' }, hers(env, 'T3'))).code,
    'attend-with-due'
  );
  assert.equal(
    (await runOp('intention.set', { attend: 'c-garden', every: 'day' }, hers(env, 'T3'))).code,
    'attend-with-every'
  );
  assert.equal(
    (await runOp('intention.set', { attend: 'c-garden', settle: '-1' }, hers(env, 'T3'))).code,
    'bad-attend'
  );
  assert.equal((await runOp('intention.set', { attend: 'c-garden', perday: 0 }, hers(env, 'T3'))).code, 'bad-attend');
  assert.equal(
    (await runOp('intention.set', { attend: 'c-garden', perday: 'many' }, hers(env, 'T3'))).code,
    'bad-attend'
  );
  assert.equal(intentions.list().length, 2);
});

test('intention.update on an attention changes settle, perDay, people and expires; a due time or a recurrence is refused; cancel ends it; the day counter lives on the record', async () => {
  const { env, intentions, clock } = makeEnv();
  await runOp('intention.set', { attend: 'c-garden', text: 'listen' }, hers(env, 'T1'));
  const record = onlyIntention(intentions);
  const updated = await runOp(
    'intention.update',
    { id: record.id, settle: 10, perday: 3, people: '7 8', expires: '2d' },
    hers(env, 'T2')
  );
  assert.equal(updated.status, 'ok', updated.code);
  const after = present(intentions.store()).get(record.id);
  assert.deepEqual(present(after).attend, {
    place: 'c-garden',
    people: ['7', '8'],
    settle: 10,
    perDay: 3,
    today: null,
  });
  assert.equal(present(after).expiresAt, T0 + 48 * HOUR);
  assert.equal(
    (await runOp('intention.update', { id: record.id, due: '1h' }, hers(env, 'T2'))).code,
    'attend-with-due'
  );
  assert.equal(
    (await runOp('intention.update', { id: record.id, every: 'day', due: '1h' }, hers(env, 'T2'))).code,
    'attend-with-due'
  );
  assert.equal(
    (await runOp('intention.update', { id: record.id, every: 'day' }, hers(env, 'T2'))).code,
    'attend-with-every'
  );
  assert.equal((await runOp('intention.update', { id: record.id, perday: 0 }, hers(env, 'T2'))).code, 'bad-attend');
  // A plain intention takes no attention arguments.
  await runOp('intention.set', { text: 'plain one' }, hers(env, 'T3'));
  const plain = intentions.list().find((r) => r.purpose === 'plain one');
  assert.equal(
    (await runOp('intention.update', { id: present(plain).id, settle: 5 }, hers(env, 'T3'))).code,
    'not-attend'
  );
  // The counter: the scheduler counts a wake; a new local day starts at zero; the service reads it.
  assert.deepEqual(intentions.attendToday(record.id), { day: '2026-10-18', wakes: 0 });
  assert.equal(present(present(present(intentions.countAttendWake(record.id).intention).attend).today).wakes, 1);
  assert.equal(present(present(present(intentions.countAttendWake(record.id).intention).attend).today).wakes, 2);
  assert.deepEqual(intentions.attendToday(record.id), { day: '2026-10-18', wakes: 2 });
  assert.deepEqual(
    intentions.attending().map((r) => r.id),
    [record.id],
    'the open attentions, the plain one not among them'
  );
  clock.t = T0 + 24 * HOUR;
  assert.deepEqual(intentions.attendToday(record.id), { day: '2026-10-19', wakes: 0 }, 'the day changed');
  assert.equal(present(present(present(intentions.countAttendWake(record.id).intention).attend).today).wakes, 1);
  assert.equal(intentions.countAttendWake(present(plain).id).code, 'not-attend');
  assert.equal(intentions.attendToday(present(plain).id), null);
  // Cancel ends it; nothing reseeds it.
  assert.equal((await runOp('intention.cancel', { id: record.id }, hers(env, 'T4'))).status, 'ok');
  assert.equal(present(present(intentions.store()).get(record.id)).status, 'cancelled');
  assert.deepEqual(intentions.attending(), []);
  assert.equal((await runOp('intention.update', { id: record.id, settle: 1 }, hers(env, 'T4'))).code, 'terminal');
});

test('intent dropped: set born dropped and update on an open one need a reason; a dropped one never wakes, is not open or counted, is final, and stays among the closed ones', async () => {
  const { env, intentions, clock, hot } = makeEnv({ intentions: { maxOpen: 1 } });
  await withCapturedLogs(async () => {
    const none = await runOp('intention.set', { text: 'πήγαινε στη θάλασσα', state: 'dropped' }, hers(env, 'T1'));
    assert.deepEqual([none.status, none.code], ['invalid', 'reason-required']);
    const born = await runOp(
      'intention.set',
      { text: 'πήγαινε στη θάλασσα', state: 'dropped', reason: 'too cold today' },
      hers(env, 'T1')
    );
    assert.equal(born.status, 'ok', born.summary);
    assert.match(born.data.text, /dropped, reason too cold today/, born.data.text);
    const open = await runOp('intention.set', { text: 'φέρε το άρθρο', due: '1h' }, hers(env, 'T1'));
    assert.equal(open.status, 'ok', 'a dropped one does not count against maxOpen');
    const id = open.data.intention.id;
    clock.t = T0 + HOUR / 2;
    assert.equal((await runOp('intention.update', { id, state: 'dropped' }, hers(env, 'T2'))).code, 'reason-required');
    const dropped = await runOp(
      'intention.update',
      { id, state: 'dropped', reason: 'no longer needed' },
      hers(env, 'T2')
    );
    assert.equal(dropped.status, 'ok', dropped.summary);
    assert.match(dropped.data.text, /dropped, reason no longer needed/);
    assert.equal((await runOp('intention.update', { id, state: 'pending' }, hers(env, 'T2'))).code, 'terminal');
    assert.equal((await runOp('intention.cancel', { id }, hers(env, 'T2'))).code, 'terminal');
    assert.deepEqual(intentions.list(), []);
    clock.t = T0 + 2 * HOUR;
    assert.deepEqual(intentions.due(), [], 'never wakes');
    assert.equal(intentions.view().length, 0);
    const closed = intentions.list({ closed: true, all: true }).map((r) => [r.id, r.status, r.reason]);
    assert.deepEqual(
      closed.sort(),
      [
        [id, 'dropped', 'no longer needed'],
        [born.data.intention.id, 'dropped', 'too cold today'],
      ].sort()
    );
    clock.t = T0 + 30 * 24 * HOUR;
    assert.equal(intentions.list({ closed: true, all: true }).length, 2, 'nothing prunes a dropped one');
    assert.equal(wrongly<{ dropped?: unknown }>(intentions).dropped, undefined);
  });
});

test("intent dropped: a drop from a recurring or waiting one ends it; a private chat's drop is visible only in that chat", async () => {
  const { env, intentions } = makeEnv();
  await withCapturedLogs(async () => {
    const rec = await runOp('intention.set', { text: 'πες καλημέρα', due: '1h', every: 'day' }, hers(env, 'T1'));
    const id = rec.data.intention.id;
    assert.equal(
      (await runOp('intention.update', { id, state: 'dropped', reason: 'boring' }, hers(env, 'T2'))).status,
      'ok'
    );
    assert.equal(present(present(intentions.store()).get(id)).status, 'dropped');
    const dm = (extra = {}) => hers(env, 'T3', { conversationId: 'dm1', privateChat: true, ...extra });
    const priv = await runOp('intention.set', { text: 'ρώτα την', state: 'dropped', reason: 'private matter' }, dm());
    assert.equal(priv.status, 'ok');
    assert.deepEqual(
      intentions.list({ closed: true }).map((r) => r.reason),
      ['boring']
    );
    assert.deepEqual(
      intentions
        .list({ closed: true, privateChannelId: 'dm1' })
        .map((r) => r.reason)
        .sort(),
      ['boring', 'private matter']
    );
    assert.equal(intentions.list({ closed: true, all: true }).length, 2);
  });
});

test('store: a closed record beyond KEEP_CLOSED moves to the archive, never lost', async () => {
  const { KEEP_CLOSED } = await import('../src/intentions/store.ts');
  const { createIntention } = await import('../src/intentions/model.ts');
  const MEMBER = '987654321';
  const dataDir = tempDir('intent-archive');
  const stores = createIntentionStores({ memoryDb: memoryOf(dataDir), now: () => T0 });
  const store = stores.get();
  const make = (i: number, participants: Untyped) => {
    const made = createIntention({
      purpose: `want ${i}`,
      provenance: { kind: 'self', turnId: 't', ...(participants ? { participants } : {}) },
      now: T0 + i,
      id: `i${i}`,
      dropped: true,
      reason: `why ${i}`,
    });
    assert.equal(made.ok, true, wrongly(made.code));
    return made.intention;
  };
  for (let i = 0; i < KEEP_CLOSED + 3; i += 1)
    assert.equal(present(store).add(make(i, i === 0 ? [MEMBER] : undefined)).ok, true);
  assert.equal(present(store).list().length, KEEP_CLOSED, 'the list keeps the latest ones');
  await present(store).flush();
  assert.deepEqual(
    present(store)
      .archived()
      .map((r) => r.id),
    ['i0', 'i1', 'i2'],
    'the older three moved, not deleted'
  );
  const lines = present(unitFile(memoryOf(dataDir), 'guilds/g1/intentions-archive.jsonl'))
    .trim()
    .split('\n');
  assert.equal(lines.length, 3);
  assert.deepEqual(
    present(createIntentionStores({ memoryDb: memoryOf(dataDir), now: () => T0 }).get())
      .archived()
      .map((r) => r.id),
    ['i0', 'i1', 'i2'],
    'read back from the database'
  );
});
