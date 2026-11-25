// Tests for the destination of an intention at the call (src/tools/operations/intention.ts): a place that is a mirror of
// the persona's diary is no place a due turn can post in, so `intention.set` and `intention.update` refuse it with the code
// `diary-mirror` and store nothing, while any other place the persona may write in is stored as the destination. The
// operations run through `runOp` over a real memory database holding a mirror (tests/fixtures/diary-mirror.ts),
// a real intention store and service, and the fake interface of the test's world for the chats. Synthetic data only.
import { after, test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runOp, runOp as runOperation } from '../../../../src/tools/operations/index.ts';
import type { OpResult } from '../../../../src/tools/operations/index.ts';
import { createOpsEnv } from '../../../../src/tools/operations/env.ts';
import { createIntentionStores } from '../../../../src/intentions/store.ts';
import { createIntentionService } from '../../../../src/intentions/service.ts';
import { createDiscordInterface } from '../../../../interfaces/discord/index.ts';
import { withCapturedLogs } from '../../../fixtures/capture-logs.ts';
import { useIface, world } from '../../../fixtures/turn-world.ts';
import { tempDir } from '../../../fixtures/tmp.ts';
import { openTestMemorySync } from '../../../fixtures/memory-db/service.ts';
import { seedMirror } from '../../../fixtures/diary-mirror.ts';
import { OWNER_PERSON, ownedBy } from '../../../fixtures/owner-accounts.ts';
import { wrongly, present } from '../../../fixtures/loose-types.ts';
import { call, toolAnswer } from '../../../fixtures/tool-answers.ts';
import { serviceTurn, serviceWake } from '../../../fixtures/service-turn.ts';
import { createErrandStores } from '../../../../src/errands/store.ts';
import { createErrandService } from '../../../../src/errands/service.ts';
import { createErrandTurns, errandDoneEvent } from '../../../../src/errands/turns.ts';
import { createEventDoor } from '../../../../src/interface/door.ts';
import type { Untyped } from '../../../../src/tools/types.ts';
import type { RunOutcome, RunRequest } from '../../../../src/errands/types.ts';
import type { IntentionService } from '../../../../src/intentions/types.ts';

useIface('fake');
const OWNER = '42';
const T0 = Date.parse('2026-11-11T10:00:00Z');
/** The chat of the diary's mirror, the chat the persona is in, and another chat they may write in. */
const MIRROR_CHAT = 'diary';
const HERE = 'c1';
const ELSEWHERE = 'c2';

const opened: Array<ReturnType<typeof openTestMemorySync>> = [];
after(async () => {
  for (const { close } of opened) await close();
});

/** The operations' environment over a memory database whose one enabled mirror is the chat `diary` of the fake interface. */
function makeEnv() {
  const rootDir = tempDir('nep-intention-mirror-');
  const memory = openTestMemorySync({ dataDir: path.join(rootDir, 'data') });
  opened.push(memory);
  const { memoryDb } = memory;
  seedMirror(memoryDb, { iface: 'fake', chatId: MIRROR_CHAT, at: T0 });
  for (const id of [HERE, ELSEWHERE, MIRROR_CHAT]) world().channel({ id });
  const hot = {
    config: {
      bot: { ownerPerson: OWNER_PERSON, access: {}, timezone: 'UTC' },
      features: { intentions: true },
      intentions: { expiresDays: 14, maxOpen: 20 },
    },
    prompts: { labels: {} },
    rootDir,
    reloadConfig: () => true,
  };
  const now = () => T0;
  const intentions = createIntentionService({
    stores: createIntentionStores({ memoryDb, now }),
    hot,
    errands: wrongly(null),
    now,
  });
  const env = createOpsEnv({
    discord: createDiscordInterface().capabilities,
    hot,
    store: { state: { data: {}, markDirty() {} } },
    client: { channels: { cache: new Map() } },
    spontaneous: {},
    calibrator: { ratio: 1 },
    isServedRoot: (id: unknown) => id === 'g1',
    reads: world().reads,
    port: world().port,
    memoryDb,
    intentions,
    now,
  });
  return { env, intentions };
}

/** The persona's own call in a reply turn in the chat `c1`. */
const personaCall = (env: unknown) => ({
  env,
  placeId: HERE,
  accountId: OWNER,
  roleIds: [],
  actor: 'persona',
  turnId: 'T1',
  sourceMessageId: 'm1',
});

/** The destinations of every intention the service holds, closed ones included. */
const destinations = (intentions: ReturnType<typeof makeEnv>['intentions']) =>
  intentions.list({ closed: true, all: true }).map((record) => record.destination ?? null);

test('intention.set refuses the place of the diary mirror with diary-mirror and stores nothing', async () => {
  const { env, intentions } = makeEnv();
  await withCapturedLogs(async () => {
    const result = await runOp(
      'intention.set',
      { text: 'post the sketch there', due: '1h', placeId: MIRROR_CHAT },
      wrongly(personaCall(env))
    );
    assert.equal(result.code, 'diary-mirror', result.summary);
    assert.notEqual(result.status, 'ok');
    assert.deepEqual(destinations(intentions), [], 'no intention was stored');
  });
});

test('intention.set with no place, called in the diary mirror, is refused diary-mirror and stores nothing', async () => {
  const { env, intentions } = makeEnv();
  await withCapturedLogs(async () => {
    const result = await runOp(
      'intention.set',
      { text: 'say good morning', due: '1h' },
      wrongly({ ...personaCall(env), placeId: MIRROR_CHAT })
    );
    assert.equal(result.code, 'diary-mirror', result.summary);
    assert.deepEqual(destinations(intentions), [], 'no intention was stored');
  });
});

test('intention.set stores an intention aimed at another place the persona may write in', async () => {
  const { env, intentions } = makeEnv();
  await withCapturedLogs(async () => {
    const result = await runOp(
      'intention.set',
      { text: 'post the sketch there', due: '1h', placeId: ELSEWHERE },
      wrongly(personaCall(env))
    );
    assert.equal(result.status, 'ok', result.summary);
    assert.deepEqual(destinations(intentions), [ELSEWHERE]);
  });
});

test('intention.update refuses moving an intention to the place of the diary mirror and keeps its destination', async () => {
  const { env, intentions } = makeEnv();
  await withCapturedLogs(async () => {
    const set = await runOp(
      'intention.set',
      { text: 'post the sketch there', due: '1h', placeId: ELSEWHERE },
      wrongly(personaCall(env))
    );
    assert.equal(set.status, 'ok', set.summary);
    const id = (set.data as { intention: { id: string } }).intention.id;
    const result = await runOp('intention.update', { id, placeId: MIRROR_CHAT }, wrongly(personaCall(env)));
    assert.equal(result.code, 'diary-mirror', result.summary);
    assert.notEqual(result.status, 'ok');
    assert.deepEqual(destinations(intentions), [ELSEWHERE], 'the destination is the one set before');
  });
});

test('intention.update moves an intention to another place the persona may write in', async () => {
  const { env, intentions } = makeEnv();
  await withCapturedLogs(async () => {
    const set = await runOp('intention.set', { text: 'post the sketch', due: '1h' }, wrongly(personaCall(env)));
    assert.equal(set.status, 'ok', set.summary);
    const id = (set.data as { intention: { id: string } }).intention.id;
    const result = await runOp('intention.update', { id, placeId: ELSEWHERE }, wrongly(personaCall(env)));
    assert.equal(result.status, 'ok', result.summary);
    assert.deepEqual(destinations(intentions), [ELSEWHERE]);
  });
});

// The intention turn on the template of the turn frame (plan 2026-11-06-turn-frame, slice 5 (a) and "The service
// trees"): a place on an intention says where the persona begins. With a place the turn is the ordinary turn there, with the due
// intention first and whole in `<intentions>` inside `<inner>`. Without one the persona wakes nowhere in the service frame and
// reaches any place through `message.create`, the command line's `cli:dm:owner` included. `intention.set` takes the
// place as optional and refuses a root and a place the persona cannot write to. The shapes the specifier chose:
//   the place of `intention.set` is its model-facing argument `place` (src/tools/definitions.ts, slice 7);
//   `message.create` names the destination by its place id in the same argument;
//   a refusal is an action whose status is not `executed` with a code that is not `ok`.

const THINK = '<think>STEP 4. So: do it.</think>';

/** The one action of a heartbeat that called intention.set naming `channel`, and how many intentions it left. */
async function setNaming(channel: string): Promise<{ status: string; code: string; open: number }> {
  const run = await serviceTurn({
    wake: serviceWake('heartbeat'),
    answers: [
      toolAnswer(THINK, [call('intention.set', { due: '1h', text: 'να γράψω εκεί', place: channel })]),
      '<skip/>',
    ],
    chat: null,
  });
  const [, status = '', code = ''] = (run.actions[0] ?? '').split(':');
  const open = run.intentions.list({ all: true });
  return { status, code, open: open.length };
}
describe('intentions in an inner turn', () => {
  before(() => {
    useIface('fake');
  });
  after(() => {
    useIface('fake');
  });

  test('intention.set without a place is accepted and stores no place', async () => {
    // Bug: a heartbeat nowhere is told a destination is required, so the persona names a root to get the intention through.
    const run = await serviceTurn({
      wake: serviceWake('heartbeat'),
      answers: [toolAnswer(THINK, [call('intention.set', { due: '1h', text: 'να ρωτήσω για το βιβλίο' })]), '<skip/>'],
      chat: null,
    });
    assert.deepEqual(run.actions, ['intention.set:executed:ok']);
    const [made] = run.intentions.list({ all: true });
    assert.equal(made?.destination ?? null, null);
  });

  test('intention.set naming a root is refused with a code', async () => {
    // Bug: a root is kept as a place to begin in, and the turn later runs as a reply in a place with no chat.
    const set = await setNaming('g1');
    assert.notEqual(`${set.status}:${set.code}`, 'executed:ok');
    assert.ok(set.code !== '' && set.code !== 'ok', set.code);
    assert.equal(set.open, 0);
  });

  test('intention.set naming a place the persona cannot write to is refused with a code', async () => {
    // Bug: the intention keeps a read-only room, and at its due time the persona wakes where the persona cannot answer.
    const set = await setNaming('c3');
    assert.notEqual(`${set.status}:${set.code}`, 'executed:ok');
    assert.ok(set.code !== '' && set.code !== 'ok', set.code);
    assert.equal(set.open, 0);
  });
});

// Tests for the persona's intentions at work: src/intentions/service.ts and store.js behind the
// `/nep task intent` operations (src/tools/operations/intent.ts), over a real task store and errand service (a
// temp data/ directory) with a FAKE errand client and a fake clock. Reliable waiting: a failed
// launch leaves nothing waiting, an errand of the same turn is linked whichever call came first,
// its end moves the wait back to pending once (a duplicate end is a no-op), a missing end is found
// by the reconciliation, a cancel is final, and a restart (a new store over the same files) keeps
// everything. Candidates from the persona's lines are anchored, de-duplicated, capped and expire.

/** The answer of an operation with its `data` read by field name, as these tests do. */
type OpAnswer = Omit<OpResult, 'data'> & {
  data: { text: string; task: { id: string }; intention: { id: string; status: string } };
};
const intentionsServiceRunOp = async (...args: Parameters<typeof runOperation>): Promise<OpAnswer> =>
  wrongly<OpAnswer>(await runOperation(...args));

/** The memory database of each data directory used here, opened once; closed when the file is done. */
const MEMORY = new Map<string, ReturnType<typeof openTestMemorySync>>();
function memoryOf(dataDir: string) {
  if (!MEMORY.has(dataDir)) MEMORY.set(dataDir, openTestMemorySync({ dataDir }));
  return present(MEMORY.get(dataDir)).memoryDb;
}

const DISCORD = createDiscordInterface().capabilities;
const INTENTIONS_SERVICE_OWNER = '42';
const INTENTIONS_SERVICE_T0 = Date.parse('2026-10-18T10:00:00Z');
const HOUR = 60 * 60 * 1000;

type Env = ReturnType<typeof intentionsServiceMakeEnv>['env'];

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

function intentionsServiceMakeEnv({
  errandSettings = {},
  agents = {},
  intentions: settings = {},
  rootDir = tempDir('nep-intent-'),
  clock = { t: INTENTIONS_SERVICE_T0 },
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
  // door, whose handler (the task turns) moves the waiting intentions, then runs the result turn,
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

/** The persona's own call's context in turn `turnId` (an owner asked). */
const intentionsServicePersona = (env: Env, turnId: string, extra = {}) => ({
  env,
  // The place of the call alone (plan T.4).
  placeId: 'c1',
  accountId: INTENTIONS_SERVICE_OWNER,
  roleIds: [],
  actor: 'persona',
  turnId,
  sourceMessageId: 'm1',
  ...extra,
});
/** An owner's command. */
const owner = (env: Env) => ({ env, placeId: 'c1', accountId: INTENTIONS_SERVICE_OWNER, roleIds: [] });

function onlyIntention(intentions: IntentionService) {
  const list = intentions.list();
  assert.equal(list.length, 1);
  return list[0];
}

// ---- recurring intentions (`every`) ------------------------------------------------

const DAY = 24 * HOUR;
describe('intentions of a service', () => {
  let stopOwners: Array<() => void> = [];
  before(() => {
    useIface('fake');
    stopOwners = [ownedBy([OWNER])];
  });
  after(() => {
    useIface('fake');
    for (const stop of stopOwners) stop();
  });

  test('intention.set: the answer line says the due time in bot.timezone as the intentions block writes it, never as a bare UTC figure', async () => {
    const { env, hot } = intentionsServiceMakeEnv();
    hot.config.bot.timezone = 'Europe/Moscow';
    await withCapturedLogs(async () => {
      // T0 is 10:00 UTC, 13:00 in Moscow; one minute on is 13:01 there.
      const result = await intentionsServiceRunOp(
        'intention.set',
        { text: 'βρες ένα meme', due: '1m' },
        intentionsServicePersona(env, 'T1')
      );
      assert.equal(result.status, 'ok', result.summary);
      assert.match(result.data.text, /due Sun, October 18 13:01,/, result.data.text);
      assert.doesNotMatch(result.data.text, /10:01/, 'no UTC clock in the line');
    });
  });

  test('intention.update / intention.cancel: the id alone in the body counts as the id; any other body stays the purpose', async () => {
    const { env, intentions } = intentionsServiceMakeEnv();
    await withCapturedLogs(async () => {
      const id = (await intentionsServiceRunOp('intention.set', { text: 'ένα' }, intentionsServicePersona(env, 'T1')))
        .data.intention.id;
      // The id in the body (`text`) and no `id=`: the update finds it and the purpose is untouched.
      const done = await intentionsServiceRunOp(
        'intention.update',
        { text: `${id}`, state: 'done' },
        intentionsServicePersona(env, 'T2')
      );
      assert.equal(done.status, 'ok', done.summary);
      const { intention } = done.data;
      assert.equal(intention.id, id);
      const record = intentions.list({ closed: true, all: true }).find((r) => r.id === id);
      assert.equal(present(record).status, 'done');
      assert.equal(present(record).purpose, 'ένα', 'the body was the id, not a new purpose');
      // A body that is not one bare id is the purpose as before; without an id the call is invalid.
      const other = (
        await intentionsServiceRunOp('intention.set', { text: 'δύο' }, intentionsServicePersona(env, 'T3'))
      ).data.intention.id;
      assert.equal(
        (await intentionsServiceRunOp('intention.update', { text: 'τρία' }, intentionsServicePersona(env, 'T3'))).code,
        'invalid-args'
      );
      assert.equal(
        (
          await intentionsServiceRunOp(
            'intention.update',
            { text: `${other} και κάτι` },
            intentionsServicePersona(env, 'T3')
          )
        ).code,
        'invalid-args'
      );
      const renamed = await intentionsServiceRunOp(
        'intention.update',
        { id: other, text: 'τρία' },
        intentionsServicePersona(env, 'T3')
      );
      assert.equal(renamed.status, 'ok');
      assert.equal(present(intentions.list().find((r) => r.id === other)).purpose, 'τρία');
      // An explicit id wins over a body that looks like one.
      const third = (
        await intentionsServiceRunOp('intention.set', { text: 'τέσσερα' }, intentionsServicePersona(env, 'T4'))
      ).data.intention.id;
      assert.equal(
        (
          await intentionsServiceRunOp(
            'intention.update',
            { id: third, text: other, state: 'done' },
            intentionsServicePersona(env, 'T4')
          )
        ).data.intention.id,
        third
      );
      // The cancel the same way, with surrounding blanks.
      const cancelled = await intentionsServiceRunOp(
        'intention.cancel',
        { text: ` ${other} ` },
        intentionsServicePersona(env, 'T5')
      );
      assert.equal(cancelled.status, 'ok', cancelled.summary);
      const { intention: intentionValue } = cancelled.data;
      assert.equal(intentionValue.status, 'cancelled');
      assert.equal(
        (await intentionsServiceRunOp('intention.cancel', { text: 'no reason' }, intentionsServicePersona(env, 'T5')))
          .code,
        'invalid-args'
      );
    });
  });

  test('intention.set / intention.update: every= makes a recurring intention with the wall-clock due pinned in bot.timezone; every=none makes it one-off again; views print it', async () => {
    const { env, hot, intentions } = intentionsServiceMakeEnv();
    hot.config.bot.timezone = 'Europe/Athens';
    await withCapturedLogs(async () => {
      // T0 is 13:00 in Athens: 21:00 is later today (18:00Z).
      const set = await intentionsServiceRunOp(
        'intention.set',
        { text: 'ψάξε για memes', due: '21:00', every: 'day' },
        intentionsServicePersona(env, 'T1')
      );
      assert.equal(set.status, 'ok', set.summary);
      const record = onlyIntention(intentions);
      assert.deepEqual(record.every, { period: 'day', at: '21:00' });
      assert.equal(record.dueAt, Date.parse('2026-10-18T18:00:00Z'));
      assert.equal(record.expiresAt, INTENTIONS_SERVICE_T0 + 30 * DAY, 'intentions.recurringExpiresDays');
      assert.match(set.summary, /every day/);
      assert.match((await intentionsServiceRunOp('intention.list', {}, owner(env))).summary, /every day/);
      assert.equal(
        (
          await intentionsServiceRunOp(
            'intention.set',
            { text: 'x', due: '1h', every: 'hourly' },
            intentionsServicePersona(env, 'T1')
          )
        ).code,
        'bad-every'
      );
      assert.equal(
        (
          await intentionsServiceRunOp(
            'intention.set',
            { text: 'x', every: 'day' },
            intentionsServicePersona(env, 'T1')
          )
        ).code,
        'every-without-due'
      );
      assert.equal(
        (
          await intentionsServiceRunOp(
            'intention.set',
            { text: 'x', due: 'mon 9' },
            intentionsServicePersona(env, 'T1')
          )
        ).code,
        'bad-time'
      );
      // A weekly one from a weekday form; every=none clears it.
      const weekly = await intentionsServiceRunOp(
        'intention.set',
        { text: 'κοίτα το νήμα', due: 'mon 20:00', every: 'week' },
        intentionsServicePersona(env, 'T1')
      );
      assert.equal(weekly.status, 'ok', weekly.summary);
      const { intention } = weekly.data;
      const weeklyRecord = present(intentions.store()).get(intention.id);
      assert.deepEqual(present(weeklyRecord).every, { period: 'week', at: '20:00' });
      assert.equal(present(weeklyRecord).dueAt, Date.parse('2026-10-19T17:00:00Z'));
      const cleared = await intentionsServiceRunOp(
        'intention.update',
        { id: present(weeklyRecord).id, every: 'none' },
        intentionsServicePersona(env, 'T2')
      );
      assert.equal(cleared.status, 'ok', cleared.summary);
      assert.equal(present(present(intentions.store()).get(present(weeklyRecord).id)).every, null);
      assert.doesNotMatch(cleared.summary, /every/);
      // An interval on an existing one-off; a new due re-pins a daily one.
      const twelve = await intentionsServiceRunOp(
        'intention.update',
        { id: present(weeklyRecord).id, every: '12h' },
        intentionsServicePersona(env, 'T2')
      );
      assert.deepEqual(present(present(intentions.store()).get(present(weeklyRecord).id)).every, {
        period: '12h',
        at: null,
      });
      assert.match(twelve.summary, /every 12h/);
      await intentionsServiceRunOp(
        'intention.update',
        { id: record.id, due: '22:30' },
        intentionsServicePersona(env, 'T2')
      );
      assert.deepEqual(present(present(intentions.store()).get(record.id)).every, { period: 'day', at: '22:30' });
      const noDue = (await intentionsServiceRunOp('intention.set', { text: 'y' }, intentionsServicePersona(env, 'T3')))
        .data.intention.id;
      assert.equal(
        (
          await intentionsServiceRunOp(
            'intention.update',
            { id: noDue, every: 'day' },
            intentionsServicePersona(env, 'T3')
          )
        ).code,
        'every-without-due'
      );
    });
  });

  // ---- attention: intention.set attend= ------------------------------------------------------

  // PR 7d: the attention defaults are the constants ATTEND_DEFAULTS (settle 90 s, 12 a day).
  test('intention.set attend=: an attention of the persona with the defaults from wakes.attention or with given numbers and people; due and every on it are refused', async () => {
    const { env, intentions } = intentionsServiceMakeEnv();
    const set = await intentionsServiceRunOp(
      'intention.set',
      { attend: 'c-garden' },
      intentionsServicePersona(env, 'T1')
    );
    assert.equal(set.status, 'ok', set.code);
    const record = onlyIntention(intentions);
    assert.equal(record.purpose, 'c-garden', 'the purpose is the place when the persona gives none');
    assert.deepEqual(record.attend, { place: 'c-garden', people: [], settle: 90, perDay: 12, today: null });
    assert.equal(record.dueAt, null);
    assert.match(set.data.text, /attend c-garden/);
    assert.match(set.data.text, /settle 90s, today 0\/12/);
    // The persona's own numbers and people (ids, comma or space separated; a mention unwrapped).
    const own = await intentionsServiceRunOp(
      'intention.set',
      { text: 'follow the garden talk', attend: 'c-garden', people: '7, <@8> 9', settle: '0', perday: 2 },
      intentionsServicePersona(env, 'T2')
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
      (
        await intentionsServiceRunOp(
          'intention.set',
          { attend: 'c-garden', due: '2h' },
          intentionsServicePersona(env, 'T3')
        )
      ).code,
      'attend-with-due'
    );
    assert.equal(
      (
        await intentionsServiceRunOp(
          'intention.set',
          { attend: 'c-garden', every: 'day', due: '2h' },
          intentionsServicePersona(env, 'T3')
        )
      ).code,
      'attend-with-due'
    );
    assert.equal(
      (
        await intentionsServiceRunOp(
          'intention.set',
          { attend: 'c-garden', every: 'day' },
          intentionsServicePersona(env, 'T3')
        )
      ).code,
      'attend-with-every'
    );
    assert.equal(
      (
        await intentionsServiceRunOp(
          'intention.set',
          { attend: 'c-garden', settle: '-1' },
          intentionsServicePersona(env, 'T3')
        )
      ).code,
      'bad-attend'
    );
    assert.equal(
      (
        await intentionsServiceRunOp(
          'intention.set',
          { attend: 'c-garden', perday: 0 },
          intentionsServicePersona(env, 'T3')
        )
      ).code,
      'bad-attend'
    );
    assert.equal(
      (
        await intentionsServiceRunOp(
          'intention.set',
          { attend: 'c-garden', perday: 'many' },
          intentionsServicePersona(env, 'T3')
        )
      ).code,
      'bad-attend'
    );
    assert.equal(intentions.list().length, 2);
  });
});

describe('intentions of a service', () => {
  let stopOwners: Array<() => void> = [];
  before(() => {
    useIface('fake');
    stopOwners = [ownedBy([OWNER])];
  });
  after(() => {
    useIface('fake');
    for (const stop of stopOwners) stop();
  });

  after(async () => {
    for (const { close } of MEMORY.values()) await close();
  });

  test('intention.update on an attention changes settle, perDay, people and expires; a due time or a recurrence is refused; cancel ends it; the day counter lives on the record', async () => {
    const { env, intentions, clock } = intentionsServiceMakeEnv();
    await intentionsServiceRunOp(
      'intention.set',
      { attend: 'c-garden', text: 'listen' },
      intentionsServicePersona(env, 'T1')
    );
    const record = onlyIntention(intentions);
    const updated = await intentionsServiceRunOp(
      'intention.update',
      { id: record.id, settle: 10, perday: 3, people: '7 8', expires: '2d' },
      intentionsServicePersona(env, 'T2')
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
    assert.equal(present(after).expiresAt, INTENTIONS_SERVICE_T0 + 48 * HOUR);
    assert.equal(
      (
        await intentionsServiceRunOp(
          'intention.update',
          { id: record.id, due: '1h' },
          intentionsServicePersona(env, 'T2')
        )
      ).code,
      'attend-with-due'
    );
    assert.equal(
      (
        await intentionsServiceRunOp(
          'intention.update',
          { id: record.id, every: 'day', due: '1h' },
          intentionsServicePersona(env, 'T2')
        )
      ).code,
      'attend-with-due'
    );
    assert.equal(
      (
        await intentionsServiceRunOp(
          'intention.update',
          { id: record.id, every: 'day' },
          intentionsServicePersona(env, 'T2')
        )
      ).code,
      'attend-with-every'
    );
    assert.equal(
      (
        await intentionsServiceRunOp(
          'intention.update',
          { id: record.id, perday: 0 },
          intentionsServicePersona(env, 'T2')
        )
      ).code,
      'bad-attend'
    );
    // A plain intention takes no attention arguments.
    await intentionsServiceRunOp('intention.set', { text: 'plain one' }, intentionsServicePersona(env, 'T3'));
    const plain = intentions.list().find((r) => r.purpose === 'plain one');
    assert.equal(
      (
        await intentionsServiceRunOp(
          'intention.update',
          { id: present(plain).id, settle: 5 },
          intentionsServicePersona(env, 'T3')
        )
      ).code,
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
    clock.t = INTENTIONS_SERVICE_T0 + 24 * HOUR;
    assert.deepEqual(intentions.attendToday(record.id), { day: '2026-10-19', wakes: 0 }, 'the day changed');
    assert.equal(present(present(present(intentions.countAttendWake(record.id).intention).attend).today).wakes, 1);
    assert.equal(intentions.countAttendWake(present(plain).id).code, 'not-attend');
    assert.equal(intentions.attendToday(present(plain).id), null);
    // Cancel ends it; nothing reseeds it.
    assert.equal(
      (await intentionsServiceRunOp('intention.cancel', { id: record.id }, intentionsServicePersona(env, 'T4'))).status,
      'ok'
    );
    assert.equal(present(present(intentions.store()).get(record.id)).status, 'cancelled');
    assert.deepEqual(intentions.attending(), []);
    assert.equal(
      (
        await intentionsServiceRunOp(
          'intention.update',
          { id: record.id, settle: 1 },
          intentionsServicePersona(env, 'T4')
        )
      ).code,
      'terminal'
    );
  });
});
