// Tests for src/intentions/service.ts: the persona's intentions at work, set through the `intention.*` operations over
// a real task store and errand service (a temp data/ directory) with a fake errand client and a fake clock. Reliable
// waiting: a failed launch leaves nothing waiting, an errand of the same turn is linked whichever call came first, its
// end moves the wait back to pending once, a missing end is found by the reconciliation, a cancel is final, and a
// restart keeps everything. Private chats keep their intentions, recurring and dropped ones close as their status
// says, and the service answers with no root named.
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, test, describe, beforeEach } from 'node:test';
import { wakeOfDue } from '../../../src/behavior/inner/queue.ts';
import { runOp as runOperation } from '../../../src/tools/operations/index.ts';
import type { OpResult } from '../../../src/tools/operations/index.ts';
import { createOpsEnv } from '../../../src/tools/operations/env.ts';
import { createErrandStores } from '../../../src/errands/store.ts';
import { createErrandService } from '../../../src/errands/service.ts';
import { createErrandTurns, errandDoneEvent } from '../../../src/errands/turns.ts';
import { createEventDoor } from '../../../src/interface/door.ts';
import { createIntentionStores } from '../../../src/intentions/store.ts';
import { createIntentionService } from '../../../src/intentions/service.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { createDiscordInterface } from '../../../interfaces/discord/index.ts';
import { useIface, world, onWorld } from '../../fixtures/turn-world.ts';
import { tempDir } from '../../fixtures/tmp.ts';
import { openTestMemorySync, unitFile, openTestMemory } from '../../fixtures/memory-db/service.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { wrongly, present } from '../../fixtures/loose-types.ts';
import type { RunOutcome, RunRequest } from '../../../src/errands/types.ts';
import type { IntentionService, Intention } from '../../../src/intentions/types.ts';
import { OWNER_PERSON, ownedBy } from '../../fixtures/owner-accounts.ts';
import { createIntention, wakeTimeOf, HEARTBEAT_ORIGIN } from '../../../src/intentions/model.ts';

import {
  hotWith,
  NOW as INNER_NOW,
  SILENT as INNER_SILENT,
  clock,
  fakeTurns,
  setup,
} from '../../fixtures/inner-rig.ts';

import { HOUR_MS, MINUTE_MS, DAY_MS } from '../../../src/time.ts';
import { createTurnRunner as createRealTurnRunner } from '../../../src/behavior/turn.ts';
import { createFakeAdapter } from '../../../scripts/lib/fake.ts';
import { skillRegistry } from '../../../src/tools/registry.ts';
import { createAdmin } from '../../../src/admin.ts';
import { labels } from '../../fixtures/labels.ts';
import { call, completionOf, toolAnswer } from '../../fixtures/tool-answers.ts';
import { chainsOf } from '../../fixtures/chains.ts';
import { objectMediaCache } from '../../../src/memory/store-media.ts';
import { createInnerLife } from '../../../src/behavior/inner.ts';
import type { InnerJournal, InnerTurnParams } from '../../../src/behavior/inner/types.ts';

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
// The chat an errand answers in is held by the fake interface of the test's world.
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
      bot: { ownerPerson: OWNER_PERSON, access: {}, ...wrongly<{ timezone?: string }>({}) },
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
  // door, whose handler (the task turns) moves the waiting intentions, then runs the persona's result turn,
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
    isServedRoot: (id: unknown) => id === 'g1',
    errands,
    intentions,
    now,
  });
  return { env, hot, client, errands, intentions, stores, intentionStores, rootDir, dataDir, clock, door, turnSaw };
}

/** The persona's own call's context in turn `turnId`, asked by the owner account. */
const personaCall = (env: Env, turnId: string, extra = {}) => ({
  env,
  // The place of the call alone.
  placeId: 'c1',
  accountId: OWNER,
  roleIds: [],
  actor: 'persona',
  turnId,
  sourceMessageId: 'm1',
  ...extra,
});
/** A command of the owner account. */
const owner = (env: Env) => ({ env, placeId: 'c1', accountId: OWNER, roleIds: [] });

function onlyIntention(intentions: IntentionService) {
  const list = intentions.list();
  assert.equal(list.length, 1);
  return list[0];
}

test("intention.set: the persona's own intention is pending with its provenance, written to intentions.json", async () => {
  const { env, intentions, intentionStores, dataDir } = makeEnv();
  await withCapturedLogs(async () => {
    const result = await runOp(
      'intention.set',
      { text: 'φέρε το άρθρο στην Ελένη', due: '3h' },
      personaCall(env, 'T1')
    );
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
    assert.equal((await runOp('intention.set', { text: 'x', due: 'soon' }, personaCall(env, 'T1'))).code, 'bad-time');
  });
});

test('reliable waiting: a wait asked before a launch that fails leaves no waiting intention', async () => {
  const { env, intentions, client } = makeEnv({ errandSettings: { maxOpen: 0 } });
  await withCapturedLogs(async () => {
    const set = await runOp('intention.set', { text: 'ψάξε τα νέα', deadline: '1h' }, personaCall(env, 'T1'));
    assert.equal(set.status, 'ok', set.summary);
    const launched = await runOp('errand.scout', { goal: 'find the news' }, personaCall(env, 'T1'));
    assert.equal(launched.code, 'cap-open', 'the launch failed explicitly');
    const record = onlyIntention(intentions);
    assert.equal(record.status, 'pending');
    assert.equal(record.awaitingErrandId, null);
    assert.equal(client.runs.length, 0);
    assert.deepEqual(intentions.reconcile(), { arrived: 0, missing: 0, deadline: 0, expired: 0 });
    // A wait on an errand the store does not hold is refused, never recorded.
    assert.equal(
      (await runOp('intention.update', { id: record.id, errand: 'tnothere' }, personaCall(env, 'T1'))).code,
      'no-errand'
    );
  });
});

test('reliable waiting: the errand of the same turn is linked, intention first; its end moves the wait to pending once', async () => {
  const { env, intentions, client, errands, door, turnSaw } = makeEnv();
  await withCapturedLogs(async () => {
    await runOp('intention.set', { text: 'ψάξε τα νέα', deadline: '1h' }, personaCall(env, 'T1'));
    const launched = await runOp(
      'errand.scout',
      { agent: 'scout', goal: 'find the news' },
      personaCall(env, 'T1', { idempotencyKey: 'T1.1:1' })
    );
    const { task } = launched.data;
    const taskId = task.id;
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
    // The end came through the event door; the result turn already saw the intention pending.
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
    const launched = await runOp('errand.scout', { goal: 'find the news' }, personaCall(env, 'T2'));
    const set = await runOp('intention.set', { text: 'πες τι βρήκες', deadline: '2h' }, personaCall(env, 'T2'));
    assert.equal(set.status, 'ok', set.summary);
    const record = onlyIntention(intentions);
    assert.equal(record.status, 'waiting');
    const { task } = launched.data;
    assert.equal(record.awaitingErrandId, task.id);
  });
});

test('reconciliation: an end that never arrived, a gone errand and a passed deadline are each found', async () => {
  const { env, intentions, stores, clock } = makeEnv();
  await withCapturedLogs(async () => {
    const a = (await runOp('errand.scout', { goal: 'a' }, owner(env))).data.task.id;
    const b = (await runOp('errand.scout', { goal: 'b' }, owner(env))).data.task.id;
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
    const { outcome } = byId[ia];
    assert.equal(outcome.state, 'done');
    assert.equal(byId[ib].note, 'wait-deadline');
    // A wait whose errand the store does not hold.
    const c = (await runOp('errand.scout', { goal: 'c' }, owner(env))).data.task.id;
    const ic = (await runOp('intention.update', { id: ib, errand: c, deadline: '1h' }, owner(env))).data.intention.id;
    // The store does not hold the errand.
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

test("private chats: the persona's intention in a DM is the DM's own -- never in a server turn, not movable from a server channel, gone with a forget of the member", async () => {
  const { env, intentions } = makeEnv();
  const dm = (extra = {}) => personaCall(env, 'T1', { placeId: 'dm1', dmChat: true, ...extra });
  await withCapturedLogs(async () => {
    const set = await runOp('intention.set', { text: 'ρώτα την για τις εξετάσεις' }, dm());
    assert.equal(set.status, 'ok', set.summary);
    const { intention } = set.data;
    const id = intention.id;
    const record = present(intentions.store()).get(id);
    assert.equal(present(record).provenance.scope, 'dm');
    assert.deepEqual(present(record).provenance.participants, [OWNER], 'the member of the private chat');
    assert.deepEqual(
      intentions.view().map((r) => r.id),
      [],
      'a server turn never sees it'
    );
    assert.deepEqual(
      intentions.view({ dmChatId: 'dm2' }).map((r) => r.id),
      [],
      'nor another private chat'
    );
    assert.deepEqual(
      intentions.view({ dmChatId: 'dm1' }).map((r) => r.id),
      [id]
    );
    // The persona's call from a server channel cannot reach it, even by its id.
    assert.equal((await runOp('intention.update', { id, text: 'άλλο' }, personaCall(env, 'T2'))).code, 'not-found');
    assert.equal((await runOp('intention.cancel', { id }, personaCall(env, 'T2'))).code, 'not-found');
    assert.equal((await runOp('intention.list', {}, personaCall(env, 'T2'))).summary, 'no open intentions');
    assert.equal((await runOp('intention.update', { id, due: '2h' }, dm())).status, 'ok', 'in its own chat it moves');
  });
});

test("with context.memory.openPrivate on, the persona's intention in a DM is seen and moved from a server channel and keeps its DM", async () => {
  // Bug: the switch opens the persona's memory but a private chat's intention stays hidden, or opening it moves where it lands.
  const { env, hot, intentions } = makeEnv();
  Object.assign(hot.config, { context: { memory: { openPrivate: true } } });
  await withCapturedLogs(async () => {
    const set = await runOp(
      'intention.set',
      { text: 'ρώτα την για τις εξετάσεις' },
      personaCall(env, 'T1', { placeId: 'dm1', dmChat: true })
    );
    const { id } = set.data.intention;
    assert.deepEqual(
      intentions.view().map((r) => r.id),
      [id]
    );
    assert.equal((await runOp('intention.update', { id, due: '2h' }, personaCall(env, 'T2'))).status, 'ok');
    const record = present(present(intentions.store()).get(id));
    assert.equal(record.provenance.scope, 'dm');
    assert.equal(record.provenance.placeId, 'dm1');
    // Its due turn still runs in the direct chat it was made in.
    const wake = wakeOfDue({ intention: record, reason: 'due', at: 1 });
    assert.deepEqual([wake.placeId, wake.dmChat], ['dm1', true]);
    Object.assign(hot.config, { context: { memory: { openPrivate: false } } });
    assert.deepEqual(intentions.view(), []);
  });
});

// ---- recurring intentions (`every`) ------------------------------------------------

const DAY = 24 * HOUR;

test('intentions: state=done on a recurring one closes the occurrence only; advance writes recurred or missed and never lists the same occurrence twice', async () => {
  const { env, intentions, clock } = makeEnv();
  await withCapturedLogs(async () => {
    const id = (
      await runOp('intention.set', { text: 'ψάξε για memes', due: '1h', every: 'day' }, personaCall(env, 'T1'))
    ).data.intention.id;
    clock.t = T0 + HOUR + 5 * 60_000;
    assert.deepEqual(
      intentions.due().map((d) => d.intention.id),
      [id]
    );
    const done = await runOp('intention.update', { id, state: 'done' }, personaCall(env, 'T2'));
    assert.equal(done.status, 'ok', done.summary);
    let record = present(intentions.store()).get(id);
    assert.equal(present(record).status, 'pending', 'never done');
    assert.equal(present(record).dueAt, T0 + HOUR + DAY);
    assert.equal(present(present(record).history.at(-1)).code, 'done-occurrence');
    assert.deepEqual(intentions.due(), [], 'the next occurrence is not due yet');
    // The disposition's advance on an already advanced record changes nothing.
    assert.equal(intentions.advance(id, { named: true }).changed, false);
    // The next occurrence, left alone: missed; touched by a call of the persona: recurred.
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
    const once = (await runOp('intention.set', { text: 'μία φορά', due: '1m' }, personaCall(env, 'T3'))).data.intention
      .id;
    clock.t += 2 * 60_000;
    assert.equal(intentions.advance(once, { named: false }).changed, false);
    assert.equal((await runOp('intention.cancel', { id }, personaCall(env, 'T4'))).data.intention.status, 'cancelled');
    assert.equal(intentions.advance(id, { named: false }).changed, false);
  });
});

test("intentions: a recurring wait ends per occurrence -- the errand's end returns it to pending and advances it with the outcome kept", async () => {
  const { env, intentions, client, errands, clock } = makeEnv();
  await withCapturedLogs(async () => {
    const id = (await runOp('intention.set', { text: 'ψάξε τα νέα', due: '1m', every: 'day' }, personaCall(env, 'T1')))
      .data.intention.id;
    const launched = await runOp('errand.scout', { goal: 'find the news' }, personaCall(env, 'T1'));
    const { task } = launched.data;
    const taskId = task.id;
    const waited = await runOp('intention.update', { id, errand: taskId, deadline: '2h' }, personaCall(env, 'T1'));
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

test('intent dropped: set born dropped and update on an open one need a reason; a dropped one never wakes, is not open or counted, is final, and stays among the closed ones', async () => {
  const { env, intentions, clock, hot } = makeEnv({ intentions: { maxOpen: 1 } });
  await withCapturedLogs(async () => {
    const none = await runOp(
      'intention.set',
      { text: 'πήγαινε στη θάλασσα', state: 'dropped' },
      personaCall(env, 'T1')
    );
    assert.deepEqual([none.status, none.code], ['invalid', 'reason-required']);
    const born = await runOp(
      'intention.set',
      { text: 'πήγαινε στη θάλασσα', state: 'dropped', reason: 'too cold today' },
      personaCall(env, 'T1')
    );
    assert.equal(born.status, 'ok', born.summary);
    assert.match(born.data.text, /dropped, reason too cold today/, born.data.text);
    const bornIntention = born.data.intention;
    const open = await runOp('intention.set', { text: 'φέρε το άρθρο', due: '1h' }, personaCall(env, 'T1'));
    assert.equal(open.status, 'ok', 'a dropped one does not count against maxOpen');
    const { intention } = open.data;
    const id = intention.id;
    clock.t = T0 + HOUR / 2;
    assert.equal(
      (await runOp('intention.update', { id, state: 'dropped' }, personaCall(env, 'T2'))).code,
      'reason-required'
    );
    const dropped = await runOp(
      'intention.update',
      { id, state: 'dropped', reason: 'no longer needed' },
      personaCall(env, 'T2')
    );
    assert.equal(dropped.status, 'ok', dropped.summary);
    assert.match(dropped.data.text, /dropped, reason no longer needed/);
    assert.equal((await runOp('intention.update', { id, state: 'pending' }, personaCall(env, 'T2'))).code, 'terminal');
    assert.equal((await runOp('intention.cancel', { id }, personaCall(env, 'T2'))).code, 'terminal');
    assert.deepEqual(intentions.list(), []);
    clock.t = T0 + 2 * HOUR;
    assert.deepEqual(intentions.due(), [], 'never wakes');
    assert.equal(intentions.view().length, 0);
    const closed = intentions.list({ closed: true, all: true }).map((r) => [r.id, r.status, r.reason]);
    assert.deepEqual(
      closed.sort(),
      [
        [id, 'dropped', 'no longer needed'],
        [bornIntention.id, 'dropped', 'too cold today'],
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
    const rec = await runOp('intention.set', { text: 'πες καλημέρα', due: '1h', every: 'day' }, personaCall(env, 'T1'));
    const { intention } = rec.data;
    const id = intention.id;
    assert.equal(
      (await runOp('intention.update', { id, state: 'dropped', reason: 'boring' }, personaCall(env, 'T2'))).status,
      'ok'
    );
    assert.equal(present(present(intentions.store()).get(id)).status, 'dropped');
    const dm = (extra = {}) => personaCall(env, 'T3', { placeId: 'dm1', dmChat: true, ...extra });
    const priv = await runOp('intention.set', { text: 'ρώτα την', state: 'dropped', reason: 'private matter' }, dm());
    assert.equal(priv.status, 'ok');
    assert.deepEqual(
      intentions.list({ closed: true }).map((r) => r.reason),
      ['boring']
    );
    assert.deepEqual(
      intentions
        .list({ closed: true, dmChatId: 'dm1' })
        .map((r) => r.reason)
        .sort(),
      ['boring', 'private matter']
    );
    assert.equal(intentions.list({ closed: true, all: true }).length, 2);
  });
});

// The owner account of these configs: `bot.ownerPerson` and the accounts bound to it, in the fixture of owner accounts.
ownedBy([OWNER]);

// The intentions belong to one persona, each with its own optional destination: an intention born in a DM keeps that
// DM through a restart, and no list depends on a home root.
// Contract: `createIntentionStore({ memoryDb, log })` takes no `rootId` and its
// collection is `personaKey('intentions')`; `createIntentionService` takes no `getRootId` and `service.list(options?)`,
// `service.due()` and `service.reconcile()` take no root.
// Appendix entries: src/intentions/{service,store,types}.ts, src/memory/db/readers/intentions.ts, src/tools/operations/intention.ts.

const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const silent = { info() {}, warn() {}, error() {} };

function made(id: string): Intention {
  const created = createIntention({
    id,
    purpose: 'answer about the synthetic plan',
    provenance: { kind: 'self', placeId: 'native-dm', scope: 'dm' },
    destination: 'native-dm',
    dueAt: NOW - 1000,
    expiresAt: NOW + 86400000,
    now: NOW,
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  return wrongly<{ intention: Intention }>(created).intention;
}

test('the service lists and answers what is due with no root named', () => {
  // Bug: `storeOf` answers null without a root, so a core with only DMs forgets every promise.
  const stores = createIntentionStores({ now: () => NOW, log: silent });
  const service = createIntentionService({ stores, hot: hotWith(), now: () => NOW, log: silent });
  present(stores.get()).add(made('i2'));
  assert.deepEqual(
    service.list({ all: true }).map((one) => one.id),
    ['i2']
  );
  assert.deepEqual(
    service.due().map((one) => one.intention.id),
    ['i2']
  );
});

// A heartbeat intention woken early by its due jitter still advances to the next occurrence.
const JITTER_T0 = Date.parse('2026-10-24T10:00:00Z');
const J = 20;
const JITTER_SILENT = { info() {}, warn() {}, error() {} };

test('a recurring heartbeat intention woken early still advances to the next occurrence', () => {
  const clock = { t: JITTER_T0 };
  const hot = {
    config: {
      features: { intentions: true },
      bot: { timezone: 'UTC' },
      intentions: {
        expiresDays: 14,
        recurringExpiresDays: 30,
        maxOpen: 20,

        waitHours: 2,
      },
      wakes: { heartbeat: { dueJitterMinutes: J } },
    },
  };
  const service = createIntentionService({
    stores: createIntentionStores({ dataDir: tempDir('nep-due-jitter-'), now: () => clock.t, log: JITTER_SILENT }),
    hot,
    now: () => clock.t,
    log: JITTER_SILENT,
    uuid: () => 'early-id',
  });
  const due = JITTER_T0 + 6 * HOUR_MS;
  const set = service.set({
    purpose: 'look at the thread',
    dueAt: due,
    every: { period: 'day', at: null },
    destination: 'c1',
    origin: HEARTBEAT_ORIGIN,
  });
  assert.equal(set.ok, true, wrongly(set.code));
  const record = service.list()[0];
  const at = wakeTimeOf(record, J);
  clock.t = at - 1;
  assert.equal(service.due().length, 0);
  assert.equal(service.advance(record.id).changed, false);
  clock.t = at;
  assert.equal(service.due().length, 1);
  const advanced = service.advance(record.id);
  assert.equal(advanced.changed, true);
  assert.equal(present(advanced.intention).dueAt, due + 24 * HOUR_MS);
});

const createTurnRunner = onWorld(wrongly(createRealTurnRunner));

const HEARTBEAT_DISCORD = createDiscordInterface().capabilities;
const HEARTBEAT_NOW = Date.parse('2026-10-19T12:00:00Z');
const INNER_TASK = 'Nobody wrote to you; read the wake block.';

function rawMessage({
  id,
  authorId = 'u1',
  authorName = 'Alice',
  ts = HEARTBEAT_NOW - 60_000,
  content = 'καλημέρα',
}: {
  id: string;
  authorId?: string;
  authorName?: string;
  ts?: number;
  content?: string;
}) {
  return {
    id,
    placeId: 'c1',
    author: { id: authorId, bot: false, globalName: authorName, username: authorName },
    member: { displayName: authorName },
    cleanContent: content,
    createdTimestamp: ts,
    reference: null,
    attachments: new Map(),
    stickers: new Map(),
  };
}

function fakeStore() {
  return {
    getPlace: () => ({}),
    getUser: () => null,
    getPrivate: () => null,
    listChannels: () => [],
    listUserProfiles: () => [],
    countUsers: () => 0,
    getLore: () => [],
    liveRules: () => [],
    ...objectMediaCache({}),
    state: { data: {}, markDirty() {} },
  };
}

// PR 7d: the switches are code, the heartbeat holds to intention changes and its caps (3 open, 1 recurring) are
// constants, so the config holds only the keys that are still settings.
function heartbeatHotWith({ access = {}, wakes = {} } = {}) {
  return {
    config: {
      bot: { timezone: 'UTC', owners: ['u1'], access },
      context: {
        channelMessages: 100,
        caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
        vision: { fetchTimeoutMs: 10_000 },
        pull: { sameAudience: true },
      },
      llm: { maxRequestTokens: 50000 },
      typing: { reactionDelayMs: [0, 0], msPerChar: [1, 1], minMs: 0, maxMs: 100, betweenMessagesMs: [0, 0] },
      models: { routes: chainsOf({ analyzer: 'x/text' }) },
      tools: {
        safeMode: false,
        resultMaxChars: 2000,
        callTimeoutMs: 120000,
        loop: { maxSteps: 3, timeBudgetMs: 20000, maxCallsPerStep: 4 },
      },
      wakes: { mode: 'shadow', ...wakes },
    },
    prompts: {
      main: 'You are a regular member of this chat, not an assistant.',
      persona: 'You are friendly and terse.',
      format: 'Use <msg> and <react> tags.',
      'turn/reply': 'Someone called you: {{author}}.',
      interject: 'Jump into the chat.',
      initiate: 'Start a topic.',
      'turn/inner': INNER_TASK,
      labels,
    },
  };
}

function personaGrants(names: Array<string>) {
  return Object.fromEntries(names.map((name) => [name, { everyone: false, roles: [], users: ['self-id'] }]));
}

function sequenceLlm(answers: Array<unknown>, { onCall = null }: { onCall?: ((calls: number) => void) | null } = {}) {
  const calls: Array<Untyped> = [];
  return {
    calls,
    complete: async (messages: Record<string, Untyped>) => {
      calls.push(messages);
      const answer: unknown = answers[Math.min(calls.length - 1, answers.length - 1)];
      if (onCall) onCall(calls.length);
      return completionOf(answer);
    },
  };
}

const BEAT_WAKE = {
  kind: 'heartbeat',
  items: [{ kind: 'heartbeat', reason: 'heartbeat', intentionIds: [], errandId: null }],
  intentions: [],
  now: HEARTBEAT_NOW,
  timezone: 'UTC',
  channels: [],
  chainId: 'heartbeat:1',
};
const DUE_WAKE = {
  ...BEAT_WAKE,
  kind: 'intention_due',
  items: [{ kind: 'intention_due', reason: 'due', intentionIds: ['i1'], errandId: null }],
  chainId: 'i1',
};
const GRANTS = [
  'conversation.read',
  'lore.show',
  'lore.list',
  'message.create',
  'intention.set',
  'intention.update',
  'intention.cancel',
  'web.search',
  'web.read',
  'media.look',
];

/** A real intention service over a temp data dir (guild g1) and a clock fixed at NOW. */
function intentionService(hot: Record<string, Untyped>) {
  const stores = createIntentionStores({ dataDir: tempDir('nep-hb-intents-'), now: () => HEARTBEAT_NOW });
  return createIntentionService({ stores, hot, now: () => HEARTBEAT_NOW, log: { info() {}, warn() {} } });
}

/**
 * One live inner turn in #general answered with `answers`, over the real intention service. `wake` is the turn's
 * wake (a heartbeat by default), `seed(service)`
 * what exists before the turn.
 */
async function liveTurn({
  answers,
  wake = BEAT_WAKE,
  seed = null,
  intentionsCfg = {},
  lore = [],
  lookup = null,
}: Record<string, Untyped>) {
  const history = [rawMessage({ id: 'm0', ts: HEARTBEAT_NOW - 120_000, content: 'πρώτο' })];
  const hot: Record<string, Untyped> = heartbeatHotWith({
    access: personaGrants(GRANTS),
    wakes: { mode: 'live' },
  });
  hot.config.intentions = { expiresDays: 14, maxOpen: 20, ...intentionsCfg };
  const intentions = intentionService(hot);
  seed?.(intentions);
  const channel = world().channel({ id: 'c1', name: 'general', placeId: 'g1', historyMessages: history });
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => HEARTBEAT_NOW });
  const reads = world().adopt(port);
  const client = { user: { id: 'self-id', username: 'Bot' } };
  const store = fakeStore();
  store.getLore = () => lore;
  const admin = createAdmin({
    discord: HEARTBEAT_DISCORD,
    hot,
    store,
    client,
    isServedRoot: (id: unknown) => id === 'g1',
    port,
    reads,
    intentions,
    now: () => HEARTBEAT_NOW,
  });
  const llm = sequenceLlm(typeof answers === 'function' ? answers(intentions) : answers);
  const calibrator = { ratio: 1, apply: (value: Record<string, Untyped>) => value, observe: () => {} };
  const turns = createTurnRunner({
    hot,
    store,
    llm,
    calibrator,
    now: () => HEARTBEAT_NOW,
    port,
    skills: skillRegistry(),
    journal: null,
    runOp: admin.runSkillOp,
    runOwnOp: admin.runOwnSkillOp,
    runInitiativeOp: admin.runInitiativeSkillOp,
    intentions,
    lookup,
  });
  const inner = { wake, shadow: false, mayAct: () => true, currentChannel: null };
  const { result, logs } = await withCapturedLogs(() =>
    turns.runTurn({ channel, placeId: 'g1', mode: 'inner', triggerKind: 'inner', inner })
  );
  const sends = port.calls.filter((call) => call.op === 'send');
  return { result, logs, llm, sends, intentions, hot, list: () => intentions.list({ all: true, closed: true }) };
}

const THINK = '<think>STEP 4. So: write it.</think>';
const SET = (text: string, extra = {}) => toolAnswer(THINK, [call('intention.set', { due: '0m', text, ...extra })]);
/** What the persona read of the calls of request `i`: the content of its tool messages, in order. */
const readOf = (run: Record<string, Untyped>, i: Untyped): string => {
  const { calls } = run.llm;
  return calls[i]
    .filter((message: Record<string, Untyped>) => message.role === 'tool')
    .map((message: Record<string, Untyped>) =>
      typeof message.content === 'string'
        ? message.content
        : message.content.map((part: Record<string, Untyped>) => part.text).join('')
    )
    .join('\n');
};
const actionsOf = (run: Record<string, Untyped>): Array<string> => {
  const { actions } = run.result.inner;
  return actions.map((a: Record<string, Untyped>) => `${a.skill}:${a.status}:${a.code ?? a.result}`);
};

test('heartbeat turn: the engine stamps origin heartbeat on what it creates; an update keeps it, a heartbeat updating another one does not relabel it', async () => {
  const run = await liveTurn({
    answers: (service: ReturnType<typeof intentionService>) => [
      toolAnswer(`${THINK}`, [
        call('intention.update', { id: `${service.list({ all: true })[0].id}`, text: `new words` }),
      ]),
      '<skip/>',
    ],
    seed: (service: ReturnType<typeof intentionService>) =>
      service.set({ purpose: 'her own earlier one', dueAt: HEARTBEAT_NOW + 3_600_000 }),
  });
  assert.deepEqual(actionsOf(run), ['intention.update:executed:ok']);
  assert.equal(run.list()[0].purpose, 'new words');
  assert.equal(run.list()[0].origin, undefined, 'not relabelled');
  const made = await liveTurn({ answers: [SET('made by a heartbeat'), '<skip/>'] });
  assert.equal(made.list()[0].origin, 'heartbeat', 'stamped by the engine');
  const id = made.list()[0].id;
  assert.equal(
    present(made.intentions.update(id, { purpose: 'reworded', by: 'persona' }).intention).origin,
    'heartbeat'
  );
  assert.equal(present(made.intentions.update(id, { dueAt: HEARTBEAT_NOW + 7_200_000 }).intention).origin, 'heartbeat');
});

test('intention.set outside a heartbeat carries no origin and no heartbeat cap', async () => {
  const run = await liveTurn({
    wake: DUE_WAKE,
    answers: [SET('one'), '<skip/>'],
    seed: (service: ReturnType<typeof intentionService>) => {
      for (const n of [1, 2, 3])
        service.set({ purpose: `from a heartbeat ${n}`, dueAt: HEARTBEAT_NOW + n * 3_600_000, origin: 'heartbeat' });
    },
  });
  assert.equal(run.list().length, 4);
  assert.equal(present(run.list().find((r) => r.purpose === 'one')).origin, undefined);
});

test('heartbeat caps: at maxOpen intention.set is refused heartbeat-cap and the result names the open ones; closing one frees the room', async () => {
  const seed = (service: ReturnType<typeof intentionService>) => {
    for (const n of [1, 2, 3])
      service.set({ purpose: `heartbeat thing ${n}`, dueAt: HEARTBEAT_NOW + n * 3_600_000, origin: 'heartbeat' });
  };
  const run = await liveTurn({ answers: [SET('a fourth'), '<skip/>'], seed });
  assert.deepEqual(actionsOf(run), ['intention.set:executed:heartbeat-cap']);
  assert.equal(run.list().length, 3);
  const ids = run.list().map((r) => r.id);
  const shown = readOf(run, 1);
  for (const id of ids) assert.ok(shown.includes(id), `the result names ${id}`);
  assert.ok(shown.includes('heartbeat thing 2'));
  const freed = await liveTurn({
    answers: [SET('a fourth'), '<skip/>'],
    seed: (service: ReturnType<typeof intentionService>) => {
      seed(service);
      const first = service.list({ all: true })[0];
      service.cancel(first.id, { all: true });
    },
  });
  assert.deepEqual(actionsOf(freed), ['intention.set:executed:ok']);
});

test('heartbeat caps: one recurring at most, for a new one and for a one-off made recurring', async () => {
  const seed = (service: ReturnType<typeof intentionService>) => {
    service.set({
      purpose: 'regular thing',
      dueAt: HEARTBEAT_NOW + 3_600_000,
      every: { period: 'day', at: null },
      origin: 'heartbeat',
    });
    service.set({ purpose: 'one-off', dueAt: HEARTBEAT_NOW + 7_200_000, origin: 'heartbeat' });
  };
  const fresh = await liveTurn({ answers: [SET('another regular', { every: 'day' }), '<skip/>'], seed });
  assert.deepEqual(actionsOf(fresh), ['intention.set:executed:heartbeat-recurring-cap']);
  const plain = await liveTurn({ answers: [SET('plain one'), '<skip/>'], seed });
  assert.deepEqual(actionsOf(plain), ['intention.set:executed:ok']);
  const made = await liveTurn({
    answers: (service: ReturnType<typeof intentionService>) => [
      toolAnswer(`${THINK}`, [
        call('intention.update', {
          id: `${present(service.list({ all: true }).find((r: Record<string, Untyped>) => r.purpose === 'one-off')).id}`,
          every: `day`,
        }),
      ]),
      '<skip/>',
    ],
    seed,
  });
  assert.deepEqual(actionsOf(made), ['intention.update:executed:heartbeat-recurring-cap']);
  assert.equal(made.list().filter((r) => r.every).length, 1);
});

const ROOT = 'g1';
const MINUTE = 60_000;
const T = Date.parse('2026-10-31T12:00:00Z');
const LEASE_MS = MINUTE;
const SILENT = { info() {}, warn() {}, error() {}, debug() {} };

type Memory = Awaited<ReturnType<typeof openTestMemory>>;
type Answer = (params: InnerTurnParams) => Promise<unknown>;
/** The pause flags of the store (`/nep pause` sets them in state.json). */
type PauseFlags = { paused?: boolean; pausedAt?: string };

/** The answer of a turn that ran and said nothing. */
const skipped = (): Promise<unknown> =>
  Promise.resolve({ outcome: 'skip', reason: 'nothing-to-do', inner: { actions: [], turnId: 't-inner' } });

function hotOf() {
  return {
    config: {
      bot: { timezone: 'UTC' },
      context: { turnLeaseMs: LEASE_MS },
      features: { wakes: true, intentions: true, journal: false },
      mention: { oneAtATime: true },
      wakes: {
        mode: 'shadow',
        tickSeconds: 60,
        queueMax: 20,
        chatMessages: 30,
        review: { enabled: false, historyDays: 14 },
        caps: { perChain: 3 },
      },
      heartbeat: { enabled: false, dueJitterMinutes: 0 },
    },
  };
}

/**
 * One core over a data directory: a memory database opened there, an inner life with its door, and what the core
 * keeps across a restart (the clock, the intentions, the store's pause flags). `restart()` closes the database and
 * opens a new one and a new inner life over the same directory, as a new process would.
 */
async function core(dataDir = tempDir('nep-inner-wakes-'), journal: InnerJournal | null = null) {
  world().channel({ id: 'c1', name: 'chan-c1', placeId: ROOT, permissions: { send: true } });
  const clock = { t: T };
  const hot = hotOf();
  const flags: PauseFlags = {};
  const store = { state: { data: flags } };
  const service = createIntentionService({
    stores: createIntentionStores({ now: () => clock.t, log: SILENT }),
    hot,
    now: () => clock.t,
    log: SILENT,
  });
  const turns = { busy: false, calls: [] as Array<InnerTurnParams>, answer: skipped as Answer };
  // One stream of ids across restarts, as each process draws its own.
  let ids = 0;
  const open = async () => {
    const memory = await openTestMemory({
      dataDir,
      iface: () => 'fake',
      config: { context: { turnLeaseMs: LEASE_MS } },
      now: () => clock.t,
    });
    let life: ReturnType<typeof createInnerLife> | null = null;
    const door = createEventDoor({ handlers: { 'inner.wake': (event: object) => life?.onWake(event) }, log: SILENT });
    life = createInnerLife({
      hot,
      dataDir,
      turns: {
        isAnyBusy: () => turns.busy,
        runTurn: (params: InnerTurnParams) => {
          turns.calls.push(params);
          return turns.answer(params);
        },
      },
      intentions: service,
      reads: world().reads,
      iface: () => 'fake',
      chatName: (id: string) => `chan-${id}`,
      submit: (event: object) => door.submit(event),
      store,
      meter: { run: async (fn: () => unknown) => ({ result: await fn(), usd: 0, requests: 1, voice: 0 }) },
      memoryDb: memory.memoryDb,
      journal,
      rng: () => 0.5,
      uuid: () => `u${(ids += 1)}`,
      now: () => clock.t,
      log: SILENT,
    });
    return { memory, life };
  };
  let current = await open();
  return {
    dataDir,
    clock,
    flags,
    service,
    turns,
    get life() {
      return current.life;
    },
    get memory(): Memory {
      return current.memory;
    },
    async restart() {
      await current.memory.close();
      current = await open();
    },
    close: () => current.memory.close(),
  };
}

type Core = Awaited<ReturnType<typeof core>>;

/** A one-off intention of the persona's in c1 due at `dueAt`, and the id of the wake it gives. */
function dueIntention(run: Core, dueAt: number): { id: string; wakeId: string } {
  const made = run.service.set({ purpose: 'ask how the trip went', dueAt, placeId: 'c1', scope: 'group' });
  if (!made.ok) throw new Error(`intention not set: ${made.code}`);
  return { id: made.intention.id, wakeId: `inner.wake:intention_due:${made.intention.id}:${dueAt}` };
}

test("the persona's calls on an intention whose wake slept answer slept, and the record keeps when it slept", async () => {
  const run = await core();
  try {
    const { id } = dueIntention(run, T + 20 * MINUTE);
    await run.life.tick();
    run.flags.paused = true;
    run.flags.pausedAt = new Date(T + MINUTE).toISOString();
    run.clock.t = T + 10 * MINUTE;
    await run.life.tick();
    run.clock.t = T + 40 * MINUTE;
    delete run.flags.paused;
    delete run.flags.pausedAt;
    await run.life.tick();
    const record = run.service.store()?.get(id);
    assert.equal(record?.status, 'cancelled', 'a cancel, never a deletion');
    assert.equal(record?.sleptAt, T + 40 * MINUTE);
    assert.equal(run.service.update(id, { state: 'done' }).code, 'slept');
    assert.equal(run.service.cancel(id).code, 'slept');
  } finally {
    await run.close();
  }
});

const recordOf = (set: unknown): Record<string, Untyped> =>
  wrongly<{ intention: Record<string, Untyped> }>(set).intention;

const settle = () => new Promise((resolve) => setImmediate(resolve));

// ---- recurring intentions ------------------------------------------------------------

/** The production intention service over the inner life's temp data directory. */
function realIntentions(hot: Record<string, Untyped>, dataDir: string) {
  hot.config.intentions = {
    expiresDays: 14,
    recurringExpiresDays: 30,
    maxOpen: 20,
  };
  return createIntentionService({
    stores: createIntentionStores({ dataDir, now: () => clock.t, log: INNER_SILENT }),
    hot,
    now: () => clock.t,
    log: INNER_SILENT,
  });
}

describe('recurring intentions over the inner rig', () => {
  beforeEach(() => void (clock.t = INNER_NOW));

  test("inner: a recurring intention advances when its wake is disposed of -- recurred when the persona's turn named it, missed when not; one wake per occurrence; each occurrence is its own chain", async () => {
    const dataDir = tempDir('nep-inner-');
    const hot = hotWith();
    const service = realIntentions(hot, dataDir);
    let named = ['x'];
    const turns = fakeTurns({
      answer: () => ({ outcome: 'spoke', inner: { actions: [], intentIds: named, turnId: 't-r' } }),
    });
    const run = setup({ service, hot, turns, dataDir });
    const first = INNER_NOW - MINUTE_MS;
    const set = service.set({
      purpose: 'look for memes',
      dueAt: first,
      every: { period: 'day', at: null },
      placeId: 'c1',
      scope: 'group',
    });
    assert.equal(set.ok, true, wrongly(set.code));
    const id = set.intention.id;
    named = [id];
    await run.inner.tick();
    await settle();
    const calls = run.turns.calls;
    assert.equal(calls.length, 1);
    const inner = calls[0].inner;
    assert.equal(inner.wake.chainId, `intention:${id}:${first}`, "this occurrence's own chain");
    assert.equal(inner.wake.notes, undefined, 'not the last occurrence');
    let record = present(service.store()).get(id);
    assert.equal(present(record).status, 'pending');
    assert.equal(present(record).dueAt, first + DAY_MS, 'the next occurrence, after the turn');
    assert.equal(present(present(record).history.at(-1)).code, 'recurred');
    assert.deepEqual(
      run.journal.filter((r) => r.event === 'recurred').map((r) => [r.intentionId, r.code, r.outcome]),
      [[id, 'recurred', 'spoke']]
    );
    // The same occurrence never wakes the persona twice: the next tick lists nothing new.
    const again = await run.inner.tick();
    assert.equal(again.submitted, 0);
    const runCalls = run.turns.calls;
    assert.equal(runCalls.length, 1);
    assert.deepEqual(run.inner.status().next, { at: first + DAY_MS, kind: 'intention' });
    // The next day, a turn that names nothing: the occurrence is missed, the intention goes on.
    named = [];
    clock.t = first + DAY_MS + MINUTE_MS;
    await run.inner.tick();
    await settle();
    const runCalls2 = run.turns.calls;
    assert.equal(runCalls2.length, 2);
    const runCalls2Inner = runCalls2[1].inner;
    assert.equal(runCalls2Inner.wake.chainId, `intention:${id}:${first + DAY_MS}`);
    record = present(service.store()).get(id);
    assert.equal(present(present(record).history.at(-1)).code, 'missed');
    assert.equal(present(record).dueAt, first + 2 * DAY_MS);
    // Two occurrences, two chains: the per-chain cap bounds one occurrence, not the intention's life.
    assert.equal(run.inner.status().chains, 1, 'one chain today');
    const state = run.inner.state();
    assert.equal(new Set(state.turns.map((turn) => turn.chainId)).size, 2);
  });

  // PR 7d: `wakes.queueMax` is the constant 20, so nineteen wakes of their own fill the queue beside the held one.
  // Slice 5: a due intention whose place is gone is no longer dropped no-channel: its turn runs nowhere with the place's
  // code (plan 5 (a)), and the recurring intention still advances. The turn counts below count that turn.
  test('inner: a recurring intention whose place is gone runs nowhere, a dropped wake (overflow, stale) still advances it; the last occurrence before expiry carries its note', async () => {
    const dataDir = tempDir('nep-inner-');
    const hot: Record<string, Untyped> = hotWith();
    const service: Record<string, Untyped> = realIntentions(hot, dataDir);
    hot.config.intentions.maxOpen = 40;
    const turns = fakeTurns();
    const run = setup({ service, hot: wrongly(hot), turns, dataDir });
    const first = INNER_NOW - MINUTE_MS;
    // No usable chat: a turn nowhere with the place's code, missed, advanced.
    const nowhere = service.set({
      purpose: 'nowhere',
      dueAt: first,
      every: { period: '12h', at: null },
      placeId: 'c-gone',
      scope: 'group',
    }).intention;
    await run.inner.tick();
    await settle();
    const calls = run.turns.calls;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].chat, null);
    const inner = calls[0].inner;
    assert.equal(inner.wake.placeFailure, 'unavailable');
    assert.ok(!run.journal.some((r) => r.event === 'no-channel'));
    let record = present(service.store()).get(nowhere.id);
    assert.equal(present(record.history.at(-1)).code, 'missed');
    assert.equal(present(record).dueAt, first + 12 * HOUR_MS);
    // The queue full: the overflowing wake is handled, its intention advanced.
    run.turns.busy = true;
    const held = recordOf(service.set({ purpose: 'held', dueAt: first, placeId: 'c1', scope: 'group' }));
    const fillers = [...Array(19).keys()].map((n) =>
      recordOf(service.set({ purpose: `filler ${n}`, dueAt: first, placeId: `c-q${n}`, scope: 'group' }))
    );
    await run.inner.tick();
    assert.deepEqual(
      run.inner.state().queue.map((w) => w.intentionIds[0]),
      [held, ...fillers].map((r) => r.id)
    );
    const over = service.set({
      purpose: 'over',
      dueAt: first,
      every: { period: 'day', at: null },
      placeId: 'c1',
      scope: 'group',
    }).intention;
    await run.inner.tick();
    await settle();
    assert.ok(run.journal.some((r) => r.event === 'overflow'));
    assert.equal(present(service.store().get(over.id).history.at(-1)).code, 'missed');
    assert.ok(present(service.store().get(over.id).dueAt) > clock.t);
    // Stale: the intention closed meanwhile is cancelled, nothing to advance; the others are untouched.
    for (const r of [held, ...fillers]) service.cancel(r.id);
    run.turns.busy = false;
    await run.inner.tick();
    await settle();
    assert.ok(run.journal.some((r) => r.event === 'stale'));
    const runCalls = run.turns.calls;
    assert.equal(runCalls.length, 1);
    // The last occurrence before the expiry: the wake carries the note; after it the expiry wins.
    const last = service.set({
      purpose: 'last one',
      dueAt: first,
      every: { period: 'day', at: null },
      expiresAt: INNER_NOW + 12 * HOUR_MS,
      placeId: 'c2',
      scope: 'group',
    }).intention;
    await run.inner.tick();
    await settle();
    const runCalls2 = run.turns.calls;
    assert.equal(runCalls2.length, 2);
    const runCalls2Inner = runCalls2[1].inner;
    assert.deepEqual(runCalls2Inner.wake.notes, { [last.id]: 'last-occurrence' });
    record = present(service.store()).get(last.id);
    assert.ok(present(record.dueAt) > present(record).expiresAt, 'the next occurrence lies past the expiry');
    clock.t = INNER_NOW + 12 * HOUR_MS;
    await run.inner.tick();
    await settle();
    assert.equal(present(service.store().get(last.id)).status, 'expired');
    // The twelve-hourly intention of the gone place recurs nowhere; the expired one wakes nobody.
    const runCalls3 = run.turns.calls;
    assert.deepEqual(
      runCalls3.slice(2).map(({ inner: { wake } }) => wake.intentions.map((r) => r.id)),
      [[nowhere.id]],
      'no wake past the expiry'
    );
    // The drops reached the persona in the wake of the next turn that ran.
    const runCalls4 = run.turns.calls;
    const runCalls4Inner = runCalls4[1].inner;
    assert.deepEqual(
      present(runCalls4Inner.wake.facts).map((fact) => `${fact.code}:${fact.why ?? ''}`),
      // The wake shows the first twelve facts (FACTS_SHOWN_MAX), the rest of the twenty stale ones wait.
      ['overflow:', ...Array(11).fill('stale:cancelled')]
    );
  });
});
