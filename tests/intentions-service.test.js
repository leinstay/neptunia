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
      agents: { maxOpen: 3, web: { enabled: true, daily: { tasks: 10, usd: 5 } }, ...agents },
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

test('intent.set: her own intention is pending with its provenance, written to intentions.json', async () => {
  const { env, intentions, dataDir } = makeEnv();
  await withCapturedLogs(async () => {
    const result = await runOp('intent.set', { text: 'φέρε το άρθρο στην Ελένη', due: '3h' }, hers(env, 'T1'));
    assert.equal(result.status, 'ok', result.summary);
    const record = onlyIntention(intentions);
    assert.equal(record.status, 'pending');
    assert.equal(record.dueAt, T0 + 3 * HOUR);
    assert.deepEqual(record.provenance, { kind: 'self', turnId: 'T1', messageId: 'm1', channelId: 'c1', scope: 'group' });
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

test('candidates: anchored to her own lines, turn looked up, de-duplicated, capped, accepted or rejected, expired when untouched', async () => {
  const journal = { findTurn: async (guildId, { messageId }) => (messageId === 'm2' ? { turn: { turnId: 'T9' } } : null) };
  const { env, intentions, clock } = makeEnv({ features: { intentions: true, journal: true }, intentions: { maxCandidates: 2, maxOpen: 1 }, journal });
  const lines = [
    { id: 'm1', channelId: 'c1', self: false, content: 'θα έρθεις αύριο;', ts: T0 - 2000 },
    { id: 'm2', channelId: 'c1', self: true, content: 'Ναι, και θα φέρω το παιχνίδι', ts: T0 - 1000 },
    { id: 'm3', channelId: 'c1', self: true, content: 'θα σου στείλω τον σύνδεσμο αργότερα', ts: T0 - 500 },
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
    assert.deepEqual(candidate.provenance, { kind: 'candidate', turnId: 'T9', messageId: 'm2', channelId: 'c1', span: 'θα φέρω το παιχνίδι', scope: 'group' });
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

test('candidates: nothing with features.intentions off', async () => {
  const { intentions } = makeEnv({ features: {} });
  const out = await intentions.addCandidates('g1', [{ span: 'θα το κάνω', purpose: 'do it' }], [{ id: 'm1', self: true, content: 'θα το κάνω', ts: T0 }]);
  assert.equal(out.added, 0);
  assert.deepEqual(intentions.list('g1', { closed: true }), []);
});
