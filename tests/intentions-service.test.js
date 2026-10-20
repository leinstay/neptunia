// Tests for the persona's intentions at work: src/intentions/service.js and store.js behind the
// `/nep task intent` operations (src/ops/intent.js), over a real task store and errand service (a
// temp data/ directory) with a FAKE errand client and a fake clock. Reliable waiting: a failed
// launch leaves nothing waiting, an errand of the same turn is linked whichever call came first,
// its end moves the wait back to pending once (a duplicate end is a no-op), a missing end is found
// by the reconciliation, a cancel is final, and a restart (a new store over the same files) keeps
// everything. Candidates from her lines are anchored, de-duplicated, capped and expire.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { runOp } from '../src/ops/index.js';
import { createOpsEnv } from '../src/ops/env.js';
import { createTaskStores } from '../src/errands/store.js';
import { createErrandService } from '../src/errands/service.js';
import { createTaskTurns, taskCompletedEvent } from '../src/errands/turns.js';
import { createEventDoor } from '../src/interface/door.js';
import { createIntentionStores } from '../src/intentions/store.js';
import { createIntentionService } from '../src/intentions/service.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { createDiscordInterface } from '../src/interface/discord.js';
import { tempDir } from './fixtures/tmp.js';

const DISCORD = createDiscordInterface().capabilities;
const OWNER = '42';
const T0 = Date.parse('2026-10-18T10:00:00Z');
const HOUR = 60 * 60 * 1000;

/** A fake errand client: records each run and lets the test end it. */
function fakeClient() {
  const runs = [];
  const gates = new Map();
  return {
    runs,
    configured: () => true,
    run(task) {
      runs.push(task);
      return new Promise((resolve) => gates.set(task.id, resolve));
    },
    cancel(task) {
      gates.get(task.id)?.({ status: 'cancelled', error: 'cancelled' });
      return true;
    },
    end(id, outcome = { status: 'done', result: { text: 'ok' }, usage: { usd: 0.01 } }) {
      gates.get(id)?.(outcome);
    },
  };
}

function makeEnv({ features = { intentions: true }, agents = {}, intentions: settings = {}, rootDir = tempDir('nep-intent-'), clock = { t: T0 }, journal = null } = {}) {
  const hot = {
    config: {
      bot: { owners: [OWNER], access: {} },
      features,
      agents: { maxOpen: 3, web: { enabled: true, daily: { tasks: 10 } }, ...agents },
      intentions: { expiresDays: 14, maxOpen: 20, maxCandidates: 5, candidateExpiresHours: 48, waitHours: 2, ...settings },
    },
    prompts: { labels: {} },
    rootDir,
    reloadConfig: () => true,
  };
  const now = () => clock.t;
  const client = fakeClient();
  const dataDir = path.join(rootDir, 'data');
  const stores = createTaskStores({ dataDir, config: () => hot.config, now });
  let intentions = null;
  // An errand's end goes the way src/index.js sends it: a task.completed event through the event
  // door, whose handler (the task turns) moves the waiting intentions, then runs her result turn,
  // which notes what it found.
  let door = null;
  const turnSaw = [];
  const turns = {
    isBusy: () => false,
    isAnyBusy: () => false,
    runTurn: async ({ taskResult }) => {
      turnSaw.push({ taskId: taskResult.id, intentions: intentions.list('g1', { closed: true, all: true }).map((r) => ({ id: r.id, status: r.status })) });
      return { outcome: 'spoke' };
    },
  };
  const gateway = { user: { id: 'self' }, channels: { fetch: async (id) => ({ id, messages: { fetch: async () => null } }) } };
  const errands = createErrandService({ client, stores, hot, getGuildId: () => 'g1', now, onFinished: (task, guildId) => door.submit(taskCompletedEvent(task, guildId, now)) });
  intentions = createIntentionService({ stores: createIntentionStores({ dataDir, now }), hot, tasks: errands, journal, getGuildId: () => 'g1', now });
  const taskTurns = createTaskTurns({ hot, client: gateway, discord: DISCORD, turns, errands, intentions, getGuildId: () => 'g1', now, setTimer: () => null });
  door = createEventDoor({ handlers: { 'task.completed': (event) => taskTurns.onEvent(event) } });
  const store = { state: { data: {}, markDirty() {} } };
  const env = createOpsEnv({ discord: DISCORD, hot, store, client: { channels: { cache: new Map() } }, spontaneous: {}, calibrator: { ratio: 1 }, getGuildId: () => 'g1', errands, intentions, now });
  return { env, hot, client, errands, intentions, stores, rootDir, dataDir, clock, door, turnSaw };
}

/** Her own call's context in turn `turnId` (an owner asked). */
const hers = (env, turnId, extra = {}) => ({ env, guildId: 'g1', channelId: 'c1', userId: OWNER, roleIds: [], actor: 'persona', turnId, sourceMessageId: 'm1', ...extra });
/** An owner's command. */
const owner = (env) => ({ env, guildId: 'g1', channelId: 'c1', userId: OWNER, roleIds: [] });

function onlyIntention(intentions) {
  const list = intentions.list('g1');
  assert.equal(list.length, 1);
  return list[0];
}

test('intent: with features.intentions off every action answers feature-off', async () => {
  const { env } = makeEnv({ features: {} });
  for (const action of ['add', 'update', 'cancel', 'list']) {
    const result = await runOp(`intent.${{ add: 'set', update: 'update', cancel: 'cancel', list: 'list' }[action]}`, { text: 'x', id: 'i1' }, owner(env));
    assert.equal(result.code, 'feature-off', action);
  }
});

test('intent.set: the answer line says the due time in bot.timezone as the intentions block writes it, never as a bare UTC figure', async () => {
  const { env, hot } = makeEnv();
  hot.config.bot.timezone = 'Europe/Moscow';
  await withCapturedLogs(async () => {
    // T0 is 10:00 UTC, 13:00 in Moscow; one minute on is 13:01 there.
    const result = await runOp('intent.set', { text: 'βρες ένα meme', due: '1m' }, hers(env, 'T1'));
    assert.equal(result.status, 'ok', result.summary);
    assert.match(result.data.text, /due Sun, October 18 13:01,/, result.data.text);
    assert.doesNotMatch(result.data.text, /10:01/, 'no UTC clock in the line');
  });
});

test('intent.set: her own intention is pending with its provenance, written to intentions.json', async () => {
  const { env, intentions, dataDir } = makeEnv();
  await withCapturedLogs(async () => {
    const result = await runOp('intent.set', { text: 'φέρε το άρθρο στην Ελένη', due: '3h' }, hers(env, 'T1'));
    assert.equal(result.status, 'ok', result.summary);
    const record = onlyIntention(intentions);
    assert.equal(record.status, 'pending');
    assert.equal(record.dueAt, T0 + 3 * HOUR);
    assert.deepEqual(record.provenance, { kind: 'self', turnId: 'T1', messageId: 'm1', channelId: 'c1', scope: 'group', participants: [OWNER] });
    const file = JSON.parse(fs.readFileSync(path.join(dataDir, 'guilds', 'g1', 'intentions.json'), 'utf8'));
    assert.deepEqual(file.intentions.map((r) => r.id), [record.id]);
    assert.equal((await runOp('intent.set', { text: 'x', due: 'soon' }, hers(env, 'T1'))).code, 'bad-time');
  });
});

test('reliable waiting: a wait asked before a launch that fails leaves no waiting intention', async () => {
  const { env, intentions, client } = makeEnv({ agents: { maxOpen: 0 } });
  await withCapturedLogs(async () => {
    const set = await runOp('intent.set', { text: 'ψάξε τα νέα', deadline: '1h' }, hers(env, 'T1'));
    assert.equal(set.status, 'ok', set.summary);
    const launched = await runOp('task.run', { agent: 'web', goal: 'find the news' }, hers(env, 'T1'));
    assert.equal(launched.code, 'cap-open', 'the launch failed explicitly');
    const record = onlyIntention(intentions);
    assert.equal(record.status, 'pending');
    assert.equal(record.awaitingTaskId, null);
    assert.equal(client.runs.length, 0);
    assert.deepEqual(intentions.reconcile('g1'), { arrived: 0, missing: 0, deadline: 0, expired: 0 });
    // A wait on an errand the store does not hold is refused, never recorded.
    assert.equal((await runOp('intent.update', { id: record.id, task: 'tnothere' }, hers(env, 'T1'))).code, 'no-task');
  });
});

test('reliable waiting: the errand of the same turn is linked, intention first; its end moves the wait to pending once', async () => {
  const { env, intentions, client, errands, door, turnSaw } = makeEnv();
  await withCapturedLogs(async () => {
    await runOp('intent.set', { text: 'ψάξε τα νέα', deadline: '1h' }, hers(env, 'T1'));
    const launched = await runOp('task.run', { agent: 'web', goal: 'find the news' }, hers(env, 'T1', { idempotencyKey: 'T1.1:1' }));
    const taskId = launched.data.task.id;
    let record = onlyIntention(intentions);
    assert.equal(record.status, 'waiting');
    assert.equal(record.awaitingTaskId, taskId);
    assert.equal(record.waitDeadline, T0 + HOUR);
    await new Promise((r) => setImmediate(r));
    client.end(taskId);
    await errands.idle();
    record = onlyIntention(intentions);
    assert.equal(record.status, 'pending');
    assert.deepEqual(record.outcome, { taskId, state: 'done', at: T0 });
    // The end came through the event door; her result turn already saw the intention pending.
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(turnSaw, [{ taskId, intentions: [{ id: record.id, status: 'pending' }] }]);
    const before = JSON.stringify(record);
    // The same end delivered again changes nothing: the door drops the repeat, the service moves nothing.
    assert.equal((await door.submit(taskCompletedEvent({ id: taskId, state: 'done' }, 'g1'))).status, 'duplicate');
    assert.equal(intentions.onTaskFinished({ id: taskId, state: 'done' }, 'g1'), 0);
    assert.equal(JSON.stringify(onlyIntention(intentions)), before);
    assert.equal(turnSaw.length, 1);
  });
});

test('reliable waiting: the errand queued first in the turn is linked when the intention asks for the wait', async () => {
  const { env, intentions } = makeEnv();
  await withCapturedLogs(async () => {
    const launched = await runOp('task.run', { agent: 'web', goal: 'find the news' }, hers(env, 'T2'));
    const set = await runOp('intent.set', { text: 'πες τι βρήκες', deadline: '2h' }, hers(env, 'T2'));
    assert.equal(set.status, 'ok', set.summary);
    const record = onlyIntention(intentions);
    assert.equal(record.status, 'waiting');
    assert.equal(record.awaitingTaskId, launched.data.task.id);
  });
});

test('reconciliation: an end that never arrived, a gone errand and a passed deadline are each found', async () => {
  const { env, intentions, stores, clock } = makeEnv();
  await withCapturedLogs(async () => {
    const a = (await runOp('task.run', { agent: 'web', goal: 'a' }, owner(env))).data.task.id;
    const b = (await runOp('task.run', { agent: 'web', goal: 'b' }, owner(env))).data.task.id;
    const ia = (await runOp('intent.set', { text: 'περιμένω το a', task: a, deadline: '5h' }, owner(env))).data.intention.id;
    const ib = (await runOp('intent.set', { text: 'περιμένω το b', task: b, deadline: '1h' }, owner(env))).data.intention.id;
    assert.equal(intentions.list('g1').filter((r) => r.status === 'waiting').length, 2);
    // Errand a ends in the store with no completion event reaching the intentions.
    stores.get('g1').finish(a, { status: 'done', result: { text: 'x' } });
    clock.t = T0 + 2 * HOUR;
    const counts = intentions.reconcile('g1');
    assert.deepEqual(counts, { arrived: 1, missing: 0, deadline: 1, expired: 0 });
    const byId = Object.fromEntries(intentions.list('g1').map((r) => [r.id, r]));
    assert.equal(byId[ia].status, 'pending');
    assert.equal(byId[ia].outcome.state, 'done');
    assert.equal(byId[ib].note, 'wait-deadline');
    // A wait whose errand the store no longer holds.
    const c = (await runOp('task.run', { agent: 'web', goal: 'c' }, owner(env))).data.task.id;
    const ic = (await runOp('intent.update', { id: ib, task: c, deadline: '1h' }, owner(env))).data.intention.id;
    stores.get('g1').wipe();
    assert.equal(intentions.reconcile('g1').missing, 1);
    assert.equal(intentions.list('g1').find((r) => r.id === ic).note, 'task-missing');
  });
});

test('intent.cancel: a cancelled intention is final; a restart reads every intention back as it was', async () => {
  const { env, intentions, rootDir, clock } = makeEnv();
  await withCapturedLogs(async () => {
    const first = (await runOp('intent.set', { text: 'ένα', due: '1d', chain: 'k1' }, owner(env))).data.intention.id;
    const second = (await runOp('intent.set', { text: 'δύο' }, owner(env))).data.intention.id;
    assert.equal((await runOp('intent.cancel', { id: second }, owner(env))).status, 'ok');
    assert.equal((await runOp('intent.update', { id: second, state: 'pending' }, owner(env))).code, 'terminal');
    assert.equal((await runOp('intent.cancel', { id: second }, owner(env))).code, 'terminal');
    const before = intentions.list('g1', { closed: true });
    const again = makeEnv({ rootDir, clock });
    assert.deepEqual(again.intentions.list('g1', { closed: true }), before);
    assert.equal(again.intentions.list('g1').map((r) => r.id).join(), first);
    const listed = await runOp('intent.list', {}, owner(again.env));
    assert.match(listed.summary, new RegExp(`^${first} pending, due `));
  });
});

test('intent.update / intent.cancel: the id alone in the body counts as the id; any other body stays the purpose', async () => {
  const { env, intentions } = makeEnv();
  await withCapturedLogs(async () => {
    const id = (await runOp('intent.set', { text: 'ένα' }, hers(env, 'T1'))).data.intention.id;
    // The id in the body (`text`) and no `id=`: the update finds it and the purpose is untouched.
    const done = await runOp('intent.update', { text: `${id}`, state: 'done' }, hers(env, 'T2'));
    assert.equal(done.status, 'ok', done.summary);
    assert.equal(done.data.intention.id, id);
    const record = intentions.list('g1', { closed: true, all: true }).find((r) => r.id === id);
    assert.equal(record.status, 'done');
    assert.equal(record.purpose, 'ένα', 'the body was the id, not a new purpose');
    // A body that is not one bare id is the purpose as before; without an id the call is invalid.
    const other = (await runOp('intent.set', { text: 'δύο' }, hers(env, 'T3'))).data.intention.id;
    assert.equal((await runOp('intent.update', { text: 'τρία' }, hers(env, 'T3'))).code, 'invalid-args');
    assert.equal((await runOp('intent.update', { text: `${other} και κάτι` }, hers(env, 'T3'))).code, 'invalid-args');
    const renamed = await runOp('intent.update', { id: other, text: 'τρία' }, hers(env, 'T3'));
    assert.equal(renamed.status, 'ok');
    assert.equal(intentions.list('g1').find((r) => r.id === other).purpose, 'τρία');
    // An explicit id wins over a body that looks like one.
    const third = (await runOp('intent.set', { text: 'τέσσερα' }, hers(env, 'T4'))).data.intention.id;
    assert.equal((await runOp('intent.update', { id: third, text: other, state: 'done' }, hers(env, 'T4'))).data.intention.id, third);
    // The cancel the same way, with surrounding blanks.
    const cancelled = await runOp('intent.cancel', { text: ` ${other} ` }, hers(env, 'T5'));
    assert.equal(cancelled.status, 'ok', cancelled.summary);
    assert.equal(cancelled.data.intention.status, 'cancelled');
    assert.equal((await runOp('intent.cancel', { text: 'no reason' }, hers(env, 'T5'))).code, 'invalid-args');
  });
});

test('candidates: anchored to her own lines, turn looked up, de-duplicated, capped, accepted or rejected, expired when untouched', async () => {
  const journal = { findTurn: async (guildId, { messageId }) => (messageId === 'm2' ? { turn: { turnId: 'T9' } } : null) };
  const { env, intentions, clock } = makeEnv({ features: { intentions: true, journal: true }, intentions: { maxCandidates: 2, maxOpen: 1 }, journal });
  const lines = [
    { id: 'm1', channelId: 'c1', self: false, content: 'θα έρθεις αύριο;', ts: T0 - 2000 },
    { id: 'm2', channelId: 'c1', self: true, content: 'Ναι, και θα φέρω το παιχνίδι', ts: T0 - 1000, sources: { turnId: null } },
    { id: 'm3', channelId: 'c1', self: true, content: 'θα σου στείλω τον σύνδεσμο αργότερα', ts: T0 - 500, sources: { turnId: null } },
  ];
  await withCapturedLogs(async () => {
    const raw = [
      { span: 'θα φέρω το παιχνίδι', purpose: 'bring the game tomorrow' },
      { span: 'θα έρθεις αύριο', purpose: 'not hers' },
    ];
    const out = await intentions.addCandidates('g1', raw, lines);
    assert.equal(out.added, 1);
    assert.equal(out.dropped.quoted + out.dropped.unanchored, 1);
    const [candidate] = intentions.list('g1');
    assert.equal(candidate.status, 'proposed');
    assert.deepEqual(candidate.provenance, { kind: 'candidate', turnId: 'T9', messageId: 'm2', channelId: 'c1', span: 'θα φέρω το παιχνίδι', scope: 'group', origin: 'own' });
    assert.equal((await intentions.addCandidates('g1', raw.slice(0, 1), lines)).duplicate, 1, 'the same line again is a duplicate');
    await intentions.addCandidates('g1', [{ span: 'θα σου στείλω τον σύνδεσμο', purpose: 'send the link' }], lines);
    assert.equal((await intentions.addCandidates('g1', [{ span: 'αργότερα', purpose: 'later' }], lines)).capped, 1, 'maxCandidates open at once');
    // Accepted: pending. A second acceptance hits maxOpen; rejected: cancelled.
    assert.equal((await runOp('intent.update', { id: candidate.id, state: 'pending' }, hers(env, 'T10'))).data.intention.status, 'pending');
    assert.equal(intentions.store('g1').get(candidate.id).expiresAt, T0 + 14 * 24 * HOUR, 'accepted, it lives as long as her own');
    const other = intentions.list('g1').find((r) => r.status === 'proposed');
    assert.equal((await runOp('intent.update', { id: other.id, state: 'pending' }, hers(env, 'T10'))).code, 'cap-open');
    assert.equal((await runOp('intent.cancel', { id: other.id }, hers(env, 'T10'))).data.intention.status, 'cancelled');
    // An untouched candidate expires after candidateExpiresHours.
    await intentions.addCandidates('g1', [{ span: 'αργότερα', purpose: 'later' }], lines);
    clock.t = T0 + 48 * HOUR;
    assert.equal(intentions.list('g1').some((r) => r.status === 'proposed'), false);
    assert.equal(intentions.list('g1', { closed: true }).filter((r) => r.status === 'expired').length, 1);
  });
});

test('intentions: markExpiredShown marks an expired intention once; an open one, an unknown id and a second call change nothing', async () => {
  const { intentions, clock } = makeEnv();
  const own = intentions.set('g1', { purpose: 'soon gone', expiresAt: T0 + HOUR, channelId: 'c1', scope: 'group' }).intention;
  assert.deepEqual(intentions.markExpiredShown('g1', own.id), { ok: true, intention: own, changed: false }, 'still open: nothing to mark');
  clock.t = T0 + HOUR;
  assert.equal(intentions.list('g1', { closed: true })[0].status, 'expired', 'the sweep expired it');
  clock.t = T0 + 2 * HOUR;
  const marked = intentions.markExpiredShown('g1', own.id);
  assert.equal(marked.changed, true);
  assert.equal(marked.intention.expiredShownAt, T0 + 2 * HOUR);
  assert.equal(intentions.store('g1').get(own.id).expiredShownAt, T0 + 2 * HOUR, 'written');
  assert.equal(intentions.markExpiredShown('g1', own.id).changed, false, 'once');
  assert.deepEqual(intentions.markExpiredShown('g1', 'i00000000'), { ok: false, code: 'not-found' });
  assert.equal(intentions.markExpiredShown(null, own.id).changed, false, 'the default guild is the same store');
});

test('candidates: nothing with features.intentions off', async () => {
  const { intentions } = makeEnv({ features: {} });
  const out = await intentions.addCandidates('g1', [{ span: 'θα το κάνω', purpose: 'do it' }], [{ id: 'm1', self: true, content: 'θα το κάνω', ts: T0 }]);
  assert.equal(out.added, 0);
  assert.deepEqual(intentions.list('g1', { closed: true }), []);
});

test('private chats: her intention in a DM is the DM\'s own -- never in a server turn, not movable from a server channel, gone with a forget of the member', async () => {
  const { env, intentions } = makeEnv();
  const dm = (extra = {}) => hers(env, 'T1', { channelId: 'dm1', privateChat: true, ...extra });
  await withCapturedLogs(async () => {
    const set = await runOp('intent.set', { text: 'ρώτα την για τις εξετάσεις' }, dm());
    assert.equal(set.status, 'ok', set.summary);
    const id = set.data.intention.id;
    const record = intentions.store('g1').get(id);
    assert.equal(record.provenance.scope, 'dm');
    assert.deepEqual(record.provenance.participants, [OWNER], 'the member of the private chat');
    assert.deepEqual(intentions.view('g1').map((r) => r.id), [], 'a server turn never sees it');
    assert.deepEqual(intentions.view('g1', { privateChannelId: 'dm2' }).map((r) => r.id), [], 'nor another private chat');
    assert.deepEqual(intentions.view('g1', { privateChannelId: 'dm1' }).map((r) => r.id), [id]);
    // Her call from a server channel cannot reach it, even by its id.
    assert.equal((await runOp('intent.update', { id, text: 'άλλο' }, hers(env, 'T2'))).code, 'not-found');
    assert.equal((await runOp('intent.cancel', { id }, hers(env, 'T2'))).code, 'not-found');
    assert.equal((await runOp('intent.list', {}, hers(env, 'T2'))).summary, 'no open intentions');
    assert.equal((await runOp('intent.update', { id, due: '2h' }, dm())).status, 'ok', 'in its own chat it moves');
    // A forget of the member takes it out.
    assert.deepEqual(intentions.forgetUser('g1', OWNER), { removed: 1, copies: 0 });
    assert.deepEqual(intentions.list('g1', { closed: true, all: true }), []);
  });
});

test('candidates: the other authors of the line\'s channel are its participants', async () => {
  const { intentions } = makeEnv();
  const lines = [
    { id: 'm1', channelId: 'c1', authorId: 'u3', self: false, content: 'θα έρθεις;', ts: T0 - 2000 },
    { id: 'm2', channelId: 'c1', authorId: 'bot', self: true, content: 'θα έρθω το βράδυ', ts: T0 - 1000 },
  ];
  await withCapturedLogs(async () => {
    assert.equal((await intentions.addCandidates('g1', [{ span: 'θα έρθω το βράδυ', purpose: 'come tonight' }], lines)).added, 1);
  });
  assert.deepEqual(onlyIntention(intentions).provenance.participants, ['u3']);
});

test('candidates: external ones need her accept in a later ordinary turn; an inner turn takes neither those nor one born in its own chain', async () => {
  const { env, intentions } = makeEnv();
  // Her lines as the memory buffer holds them: m2 noted by her turn (via the service's registry), m3 never noted.
  intentions.noteLine('m2', { turnId: 'T5' });
  intentions.noteLine('m4', { turnId: 'T6', read: true });
  intentions.noteLine('m5', { turnId: 'T7', inner: true, chainId: 'chain:k' });
  const lines = [
    { id: 'm2', channelId: 'c1', self: true, content: 'θα φέρω το παιχνίδι', ts: T0 - 4000 },
    { id: 'm3', channelId: 'c1', self: true, content: 'θα στείλω τον σύνδεσμο', ts: T0 - 3000 },
    { id: 'm4', channelId: 'c1', self: true, content: 'θα θυμίζω την κλήρωση κάθε μέρα', ts: T0 - 2000 },
    { id: 'm5', channelId: 'c1', self: true, content: 'θα ξανακοιτάξω το νήμα αύριο', ts: T0 - 1000 },
  ];
  // An inner turn's call context (src/skills/executors.js#executeCall adds ownInitiative and the chain).
  const inner = (turnId, chainId) => hers(env, turnId, { ownInitiative: true, chainId });
  await withCapturedLogs(async () => {
    const out = await intentions.addCandidates('g1', [
      { span: 'θα φέρω το παιχνίδι', purpose: 'bring the game' },
      { span: 'θα στείλω τον σύνδεσμο', purpose: 'send the link' },
      { span: 'θα θυμίζω την κλήρωση κάθε μέρα', purpose: 'remind about the raffle daily' },
      { span: 'θα ξανακοιτάξω το νήμα αύριο', purpose: 'look at the thread again tomorrow' },
    ], lines);
    assert.deepEqual([out.added, out.external], [4, 2]);
    const byMessage = Object.fromEntries(intentions.list('g1').map((r) => [r.provenance.messageId, r]));
    assert.deepEqual(Object.values(byMessage).map((r) => `${r.provenance.messageId}:${r.provenance.origin}:${r.provenance.turnId}`), ['m2:own:T5', 'm3:external:null', 'm4:external:T6', 'm5:own:T7']);
    // An inner turn: her own candidate yes; an external one, or one born in its own chain, no.
    assert.equal((await runOp('intent.update', { id: byMessage.m2.id, state: 'pending' }, inner('T20', 'review:2026-10-18'))).data.intention.status, 'pending');
    assert.equal((await runOp('intent.update', { id: byMessage.m4.id, state: 'pending' }, inner('T20', 'review:2026-10-18'))).code, 'candidate-external');
    assert.equal((await runOp('intent.update', { id: byMessage.m3.id, state: 'pending' }, inner('T20', 'review:2026-10-18'))).code, 'candidate-external', 'a line with no note counts as external');
    assert.equal((await runOp('intent.update', { id: byMessage.m5.id, state: 'pending' }, inner('T21', 'chain:k'))).code, 'candidate-same-chain');
    assert.equal(intentions.store('g1').get(byMessage.m5.id).chainId, null, 'the caller\'s chain never becomes the intention\'s');
    // Her ordinary turn: never the one that wrote the line, a later one may.
    assert.equal((await runOp('intent.update', { id: byMessage.m4.id, state: 'pending' }, hers(env, 'T6'))).code, 'candidate-same-turn');
    assert.equal((await runOp('intent.update', { id: byMessage.m4.id, state: 'pending' }, hers(env, 'T30'))).data.intention.status, 'pending');
    assert.equal((await runOp('intent.update', { id: byMessage.m5.id, state: 'pending' }, inner('T22', 'review:2026-10-18'))).data.intention.status, 'pending', 'another chain may');
  });
});

// ---- recurring intentions (`every`) ------------------------------------------------

const DAY = 24 * HOUR;

test('intent.set / intent.update: every= makes a recurring intention with the wall-clock due pinned in bot.timezone; every=none makes it one-off again; views print it', async () => {
  const { env, hot, intentions } = makeEnv();
  hot.config.bot.timezone = 'Europe/Athens';
  await withCapturedLogs(async () => {
    // T0 is 13:00 in Athens: 21:00 is later today (18:00Z).
    const set = await runOp('intent.set', { text: 'ψάξε για memes', due: '21:00', every: 'day' }, hers(env, 'T1'));
    assert.equal(set.status, 'ok', set.summary);
    const record = onlyIntention(intentions);
    assert.deepEqual(record.every, { period: 'day', at: '21:00' });
    assert.equal(record.dueAt, Date.parse('2026-10-18T18:00:00Z'));
    assert.equal(record.expiresAt, T0 + 30 * DAY, 'intentions.recurringExpiresDays');
    assert.match(set.summary, /every day/);
    assert.match((await runOp('intent.list', {}, owner(env))).summary, /every day/);
    assert.equal((await runOp('intent.set', { text: 'x', due: '1h', every: 'hourly' }, hers(env, 'T1'))).code, 'bad-every');
    assert.equal((await runOp('intent.set', { text: 'x', every: 'day' }, hers(env, 'T1'))).code, 'every-without-due');
    assert.equal((await runOp('intent.set', { text: 'x', due: 'mon 9' }, hers(env, 'T1'))).code, 'bad-time');
    // A weekly one from a weekday form; every=none clears it.
    const weekly = await runOp('intent.set', { text: 'κοίτα το νήμα', due: 'mon 20:00', every: 'week' }, hers(env, 'T1'));
    assert.equal(weekly.status, 'ok', weekly.summary);
    const weeklyRecord = intentions.store('g1').get(weekly.data.intention.id);
    assert.deepEqual(weeklyRecord.every, { period: 'week', at: '20:00' });
    assert.equal(weeklyRecord.dueAt, Date.parse('2026-10-19T17:00:00Z'));
    const cleared = await runOp('intent.update', { id: weeklyRecord.id, every: 'none' }, hers(env, 'T2'));
    assert.equal(cleared.status, 'ok', cleared.summary);
    assert.equal(intentions.store('g1').get(weeklyRecord.id).every, null);
    assert.doesNotMatch(cleared.summary, /every/);
    // An interval on an existing one-off; a new due re-pins a daily one.
    const twelve = await runOp('intent.update', { id: weeklyRecord.id, every: '12h' }, hers(env, 'T2'));
    assert.deepEqual(intentions.store('g1').get(weeklyRecord.id).every, { period: '12h', at: null });
    assert.match(twelve.summary, /every 12h/);
    await runOp('intent.update', { id: record.id, due: '22:30' }, hers(env, 'T2'));
    assert.deepEqual(intentions.store('g1').get(record.id).every, { period: 'day', at: '22:30' });
    const noDue = (await runOp('intent.set', { text: 'y' }, hers(env, 'T3'))).data.intention.id;
    assert.equal((await runOp('intent.update', { id: noDue, every: 'day' }, hers(env, 'T3'))).code, 'every-without-due');
  });
});

test('intentions: state=done on a recurring one closes the occurrence only; advance writes recurred or missed and never lists the same occurrence twice', async () => {
  const { env, intentions, clock } = makeEnv();
  await withCapturedLogs(async () => {
    const id = (await runOp('intent.set', { text: 'ψάξε για memes', due: '1h', every: 'day' }, hers(env, 'T1'))).data.intention.id;
    clock.t = T0 + HOUR + 5 * 60_000;
    assert.deepEqual(intentions.due('g1').map((d) => d.intention.id), [id]);
    const done = await runOp('intent.update', { id, state: 'done' }, hers(env, 'T2'));
    assert.equal(done.status, 'ok', done.summary);
    let record = intentions.store('g1').get(id);
    assert.equal(record.status, 'pending', 'never done');
    assert.equal(record.dueAt, T0 + HOUR + DAY);
    assert.equal(record.history.at(-1).code, 'done-occurrence');
    assert.deepEqual(intentions.due('g1'), [], 'the next occurrence is not due yet');
    // The disposition's advance on an already advanced record changes nothing.
    assert.equal(intentions.advance('g1', id, { named: true }).changed, false);
    // The next occurrence, left alone: missed; touched by a call of hers: recurred.
    clock.t = T0 + HOUR + DAY + 60_000;
    assert.equal(intentions.due('g1').length, 1);
    assert.equal(intentions.advance('g1', id, { named: false }).changed, true);
    record = intentions.store('g1').get(id);
    assert.equal(record.history.at(-1).code, 'missed');
    assert.equal(record.history.at(-1).by, 'engine');
    assert.equal(record.dueAt, T0 + HOUR + 2 * DAY);
    assert.deepEqual(intentions.due('g1'), []);
    clock.t = T0 + HOUR + 2 * DAY + 60_000;
    assert.equal(intentions.advance('g1', id, { named: true }).intention.history.at(-1).code, 'recurred');
    // A one-off is not advanced; a cancel ends a recurring one for good.
    const once = (await runOp('intent.set', { text: 'μία φορά', due: '1m' }, hers(env, 'T3'))).data.intention.id;
    clock.t += 2 * 60_000;
    assert.equal(intentions.advance('g1', once, { named: false }).changed, false);
    assert.equal((await runOp('intent.cancel', { id }, hers(env, 'T4'))).data.intention.status, 'cancelled');
    assert.equal(intentions.advance('g1', id, { named: false }).changed, false);
  });
});

test('intentions: a recurring wait ends per occurrence -- the errand\'s end returns it to pending and advances it with the outcome kept', async () => {
  const { env, intentions, client, errands, clock } = makeEnv();
  await withCapturedLogs(async () => {
    const id = (await runOp('intent.set', { text: 'ψάξε τα νέα', due: '1m', every: 'day' }, hers(env, 'T1'))).data.intention.id;
    const launched = await runOp('task.run', { agent: 'web', goal: 'find the news' }, hers(env, 'T1'));
    const taskId = launched.data.task.id;
    const waited = await runOp('intent.update', { id, task: taskId, deadline: '2h' }, hers(env, 'T1'));
    assert.equal(waited.status, 'ok', waited.summary);
    assert.equal(intentions.store('g1').get(id).status, 'waiting');
    // The occurrence stays open while the wait runs: the disposition's advance leaves a waiting one alone.
    assert.equal(intentions.advance('g1', id, { named: true }).changed, false);
    await new Promise((r) => setImmediate(r));
    // The errand ends once the occurrence is due: the wait's end closes it and the outcome stays on the record.
    clock.t = T0 + 5 * 60_000;
    client.end(taskId);
    await errands.idle();
    const record = intentions.store('g1').get(id);
    assert.equal(record.status, 'pending');
    assert.equal(record.dueAt, T0 + 60_000 + DAY, 'the next occurrence');
    assert.deepEqual(record.outcome, { taskId, state: 'done', at: clock.t });
    assert.equal(record.history.at(-1).code, 'recurred');
    assert.equal(record.history.at(-2).code, 'task-done');
  });
});

// ---- attention: intent.set attend= ------------------------------------------------------

test('intent.set attend=: an attention of hers with the defaults from innerLife.attention, her own numbers and people; due and every on it are refused', async () => {
  const { env, hot, intentions } = makeEnv();
  hot.config.innerLife = { attention: { settleSeconds: 45, perDayDefault: 6 } };
  const set = await runOp('intent.set', { attend: 'c-garden' }, hers(env, 'T1'));
  assert.equal(set.status, 'ok', set.code);
  const record = onlyIntention(intentions);
  assert.equal(record.purpose, 'c-garden', 'the purpose is the place when she gives none');
  assert.deepEqual(record.attend, { place: 'c-garden', people: [], settle: 45, perDay: 6, today: null });
  assert.equal(record.dueAt, null);
  assert.match(set.data.text, /attend c-garden/);
  assert.match(set.data.text, /settle 45s, today 0\/6/);
  // Her own numbers and people (ids, comma or space separated; a mention unwrapped).
  const own = await runOp('intent.set', { text: 'follow the garden talk', attend: 'c-garden', people: '7, <@8> 9', settle: '0', perday: 2 }, hers(env, 'T2'));
  assert.equal(own.status, 'ok', own.code);
  const mine = intentions.list('g1').find((r) => r.purpose === 'follow the garden talk');
  assert.deepEqual(mine.attend, { place: 'c-garden', people: ['7', '8', '9'], settle: 0, perDay: 2, today: null });
  assert.match(own.data.text, /people 7,8,9/);
  // Refusals.
  assert.equal((await runOp('intent.set', { attend: 'c-garden', due: '2h' }, hers(env, 'T3'))).code, 'attend-with-due');
  assert.equal((await runOp('intent.set', { attend: 'c-garden', every: 'day', due: '2h' }, hers(env, 'T3'))).code, 'attend-with-due');
  assert.equal((await runOp('intent.set', { attend: 'c-garden', every: 'day' }, hers(env, 'T3'))).code, 'attend-with-every');
  assert.equal((await runOp('intent.set', { attend: 'c-garden', settle: '-1' }, hers(env, 'T3'))).code, 'bad-attend');
  assert.equal((await runOp('intent.set', { attend: 'c-garden', perday: 0 }, hers(env, 'T3'))).code, 'bad-attend');
  assert.equal((await runOp('intent.set', { attend: 'c-garden', perday: 'many' }, hers(env, 'T3'))).code, 'bad-attend');
  assert.equal(intentions.list('g1').length, 2);
});

test('intent.update on an attention changes settle, perDay, people and expires; a due time or a recurrence is refused; cancel ends it; the day counter lives on the record', async () => {
  const { env, intentions, clock } = makeEnv();
  await runOp('intent.set', { attend: 'c-garden', text: 'listen' }, hers(env, 'T1'));
  const record = onlyIntention(intentions);
  const updated = await runOp('intent.update', { id: record.id, settle: 10, perday: 3, people: '7 8', expires: '2d' }, hers(env, 'T2'));
  assert.equal(updated.status, 'ok', updated.code);
  const after = intentions.store('g1').get(record.id);
  assert.deepEqual(after.attend, { place: 'c-garden', people: ['7', '8'], settle: 10, perDay: 3, today: null });
  assert.equal(after.expiresAt, T0 + 48 * HOUR);
  assert.equal((await runOp('intent.update', { id: record.id, due: '1h' }, hers(env, 'T2'))).code, 'attend-with-due');
  assert.equal((await runOp('intent.update', { id: record.id, every: 'day', due: '1h' }, hers(env, 'T2'))).code, 'attend-with-due');
  assert.equal((await runOp('intent.update', { id: record.id, every: 'day' }, hers(env, 'T2'))).code, 'attend-with-every');
  assert.equal((await runOp('intent.update', { id: record.id, perday: 0 }, hers(env, 'T2'))).code, 'bad-attend');
  // A plain intention takes no attention arguments.
  await runOp('intent.set', { text: 'plain one' }, hers(env, 'T3'));
  const plain = intentions.list('g1').find((r) => r.purpose === 'plain one');
  assert.equal((await runOp('intent.update', { id: plain.id, settle: 5 }, hers(env, 'T3'))).code, 'not-attend');
  // The counter: the scheduler counts a wake; a new local day starts at zero; the service reads it.
  assert.deepEqual(intentions.attendToday('g1', record.id), { day: '2026-10-18', wakes: 0 });
  assert.equal(intentions.countAttendWake('g1', record.id).intention.attend.today.wakes, 1);
  assert.equal(intentions.countAttendWake('g1', record.id).intention.attend.today.wakes, 2);
  assert.deepEqual(intentions.attendToday('g1', record.id), { day: '2026-10-18', wakes: 2 });
  assert.deepEqual(intentions.attending('g1').map((r) => r.id), [record.id], 'the open attentions, the plain one not among them');
  clock.t = T0 + 24 * HOUR;
  assert.deepEqual(intentions.attendToday('g1', record.id), { day: '2026-10-19', wakes: 0 }, 'the day changed');
  assert.equal(intentions.countAttendWake('g1', record.id).intention.attend.today.wakes, 1);
  assert.equal(intentions.countAttendWake('g1', plain.id).code, 'not-attend');
  assert.equal(intentions.attendToday('g1', plain.id), null);
  // Cancel ends it; nothing reseeds it.
  assert.equal((await runOp('intent.cancel', { id: record.id }, hers(env, 'T4'))).status, 'ok');
  assert.equal(intentions.store('g1').get(record.id).status, 'cancelled');
  assert.deepEqual(intentions.attending('g1'), []);
  assert.equal((await runOp('intent.update', { id: record.id, settle: 1 }, hers(env, 'T4'))).code, 'terminal');
});

test('intent dropped: set born dropped and update on an open one need a reason; a dropped one never wakes, is not open or counted, is final, and is pruned after droppedDays', async () => {
  const { env, intentions, clock, hot } = makeEnv({ intentions: { maxOpen: 1, droppedDays: 7 } });
  await withCapturedLogs(async () => {
    const none = await runOp('intent.set', { text: 'πήγαινε στη θάλασσα', state: 'dropped' }, hers(env, 'T1'));
    assert.deepEqual([none.status, none.code], ['invalid', 'reason-required']);
    const born = await runOp('intent.set', { text: 'πήγαινε στη θάλασσα', state: 'dropped', reason: 'too cold today' }, hers(env, 'T1'));
    assert.equal(born.status, 'ok', born.summary);
    assert.match(born.data.text, /dropped, reason too cold today/, born.data.text);
    const open = await runOp('intent.set', { text: 'φέρε το άρθρο', due: '1h' }, hers(env, 'T1'));
    assert.equal(open.status, 'ok', 'a dropped one does not count against maxOpen');
    const id = open.data.intention.id;
    clock.t = T0 + HOUR / 2;
    assert.equal((await runOp('intent.update', { id, state: 'dropped' }, hers(env, 'T2'))).code, 'reason-required');
    const dropped = await runOp('intent.update', { id, state: 'dropped', reason: 'no longer needed' }, hers(env, 'T2'));
    assert.equal(dropped.status, 'ok', dropped.summary);
    assert.match(dropped.data.text, /dropped, reason no longer needed/);
    assert.equal((await runOp('intent.update', { id, state: 'pending' }, hers(env, 'T2'))).code, 'terminal');
    assert.equal((await runOp('intent.cancel', { id }, hers(env, 'T2'))).code, 'terminal');
    assert.deepEqual(intentions.list('g1'), []);
    clock.t = T0 + 2 * HOUR;
    assert.deepEqual(intentions.due('g1'), [], 'never wakes');
    assert.equal(intentions.view('g1').length, 0);
    assert.deepEqual(intentions.dropped('g1').map((r) => [r.id, r.reason, r.at]), [[id, 'no longer needed', T0 + HOUR / 2], [born.data.intention.id, 'too cold today', T0]]);
    assert.deepEqual(intentions.dropped('g1', { sinceMs: T0 + 1 }).map((r) => r.id), [id]);
    assert.deepEqual(Object.keys(intentions.dropped('g1')[0]).sort(), ['at', 'id', 'purpose', 'reason']);
    clock.t = T0 + 8 * 24 * HOUR;
    assert.deepEqual(intentions.dropped('g1', { sinceMs: 0 }), [], 'pruned after droppedDays');
    assert.deepEqual(intentions.list('g1', { closed: true, all: true }), []);
    hot.config.features = {};
    assert.deepEqual(intentions.dropped('g1'), [], 'off with the feature');
  });
});

test('intent dropped: a drop from a recurring or waiting one ends it; a private chat\'s drop is visible only in that chat', async () => {
  const { env, intentions } = makeEnv();
  await withCapturedLogs(async () => {
    const rec = await runOp('intent.set', { text: 'πες καλημέρα', due: '1h', every: 'day' }, hers(env, 'T1'));
    const id = rec.data.intention.id;
    assert.equal((await runOp('intent.update', { id, state: 'dropped', reason: 'boring' }, hers(env, 'T2'))).status, 'ok');
    assert.equal(intentions.store('g1').get(id).status, 'dropped');
    const dm = (extra = {}) => hers(env, 'T3', { channelId: 'dm1', privateChat: true, ...extra });
    const priv = await runOp('intent.set', { text: 'ρώτα την', state: 'dropped', reason: 'private matter' }, dm());
    assert.equal(priv.status, 'ok');
    assert.deepEqual(intentions.dropped('g1').map((r) => r.reason), ['boring']);
    assert.deepEqual(intentions.dropped('g1', { privateChannelId: 'dm1' }).map((r) => r.reason).sort(), ['boring', 'private matter']);
    assert.equal(intentions.dropped('g1', { all: true }).length, 2);
  });
});
