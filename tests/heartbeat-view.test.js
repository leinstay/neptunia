// Tests for the heartbeat's facts (src/behavior/heartbeat-view.js) and their words in `<wake>`
// (src/behavior/wake.js#heartbeatLines): the people block (affinity order, cap, last contact from the
// record, interests, places), her life, what she can do, and what happened since the last
// heartbeat, every list capped with the rest counted. Fake stores; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHeartbeatFacts } from '../src/behavior/heartbeat-view.js';
import { wakeBlockText } from '../src/behavior/wake.js';
import { labels } from './fixtures/labels.js';
import { DAY_MS, HOUR_MS, MINUTE_MS, utcDay } from '../src/time.js';

const NOW = Date.parse('2026-10-20T12:00:00Z');
const SINCE = NOW - 3 * HOUR_MS;
const iso = (at) => new Date(at).toISOString();

const profile = (id, score, extra = {}) => ({ id, names: [`name-${id}`], lastSeen: iso(NOW - DAY_MS), affinity: { score }, interests: [], ...extra });

/** A journal over `records` (any kind), read by UTC day and kind. */
function fakeJournal(records) {
  return { read: async (guildId, { day, kind }) => records.filter((r) => r.kind === kind && utcDay(Date.parse(r.occurredAt)) === day) };
}

const record = (lines) => ({ iterate: async function* iterate() { for (const line of lines) yield line; } });
const seen = (by, at, channel) => ({ kind: 'seen', by, occurredAt: iso(at), scope: { channel }, participants: [by] });
const said = (at, channel, participants) => ({ kind: 'said', occurredAt: iso(at), scope: { channel }, participants });

const base = (extra = {}) => ({ guildId: 'g1', now: NOW, since: SINCE, placeName: (id) => `n-${id}`, ...extra });

test('people: the closest by affinity, capped, with the last contact and place from the record, top interests, places, no presence', async () => {
  const profiles = [
    profile('a', 10),
    profile('b', 50, { interests: [{ topic: 'one', weight: 1 }, { topic: 'two', weight: 5 }, { topic: 'three', weight: 3 }, { topic: 'four', weight: 2 }, { topic: 'closed', weight: 9, validTo: '2026-01-01' }] }),
    profile('c', 30),
    profile('self', 99),
  ];
  const lines = [seen('b', NOW - 5 * HOUR_MS, 'c1'), seen('b', NOW - 2 * HOUR_MS, 'c2'), said(NOW - HOUR_MS, 'c3', ['c']), seen('b', NOW - 40 * DAY_MS, 'c9')];
  const facts = await buildHeartbeatFacts(base({ profiles, selfId: 'self', settings: { people: 2 }, record: record(lines), activePlaces: (id) => (id === 'b' ? ['x', 'y', 'z', 'w'] : []) }));
  assert.deepEqual(facts.people.map((p) => p.id), ['b', 'c']);
  const b = facts.people[0];
  assert.equal(b.lastAt, NOW - 2 * HOUR_MS);
  assert.equal(b.lastPlace, 'n-c2');
  assert.deepEqual(b.interests, ['two', 'three', 'four']);
  assert.deepEqual(b.places, ['x', 'y', 'z']);
  assert.equal(facts.people[1].lastAt, NOW - HOUR_MS);
});

test('people: no line in the record falls back to the profile\'s lastSeen without a place; no profiles is an empty block; a failing source does not break the view', async () => {
  const quiet = await buildHeartbeatFacts(base({ profiles: [profile('a', 1)], record: record([]) }));
  assert.equal(quiet.people[0].lastAt, NOW - DAY_MS);
  assert.equal(quiet.people[0].lastPlace, null);
  assert.deepEqual((await buildHeartbeatFacts(base())).people, []);
  const warned = [];
  const broken = await buildHeartbeatFacts(base({
    profiles: [profile('a', 1)],
    record: { iterate: () => { throw Object.assign(new Error('x'), { code: 'EIO' }); } },
    journal: { read: async () => { throw new Error('y'); } },
    activePlaces: () => { throw new Error('z'); },
    log: { warn: (msg, fields) => warned.push(fields.source) },
  }));
  assert.equal(broken.people.length, 1);
  assert.ok(warned.includes('record') && warned.includes('journal'));
});

test('life: her executed actions, errands and diary posts of the last day, open intentions, attentions and what she let go; each capped with a count', async () => {
  const turn = (at, actions) => ({ kind: 'inner', event: 'turn', occurredAt: iso(at), actions });
  const journal = fakeJournal([
    turn(NOW - HOUR_MS, [{ skill: 'message.create', status: 'executed', result: 'ok', target: { channel: 'c1' } }, { skill: 'web.search', status: 'proposed', result: 'ok' }, { skill: 'draw.create', status: 'executed', result: 'failed' }]),
    turn(NOW - 2 * DAY_MS, [{ skill: 'message.create', status: 'executed', result: 'ok' }]),
  ]);
  const tasks = [
    { id: 't1', agent: 'web', state: 'done', createdAt: NOW - 2 * HOUR_MS, requester: { kind: 'persona' } },
    { id: 't2', agent: 'web', state: 'done', createdAt: NOW - 2 * DAY_MS, requester: { kind: 'persona' } },
    { id: 't3', agent: 'web', state: 'done', createdAt: NOW - HOUR_MS, requester: { kind: 'member' } },
  ];
  const intentions = [
    { id: 'i1', status: 'pending', purpose: 'later', dueAt: NOW + HOUR_MS },
    { id: 'i2', status: 'pending', purpose: 'listen', attend: { place: 'c2' } },
    { id: 'i3', status: 'waiting', purpose: 'wait', dueAt: null },
  ];
  const facts = await buildHeartbeatFacts(base({ journal, tasks, intentions, diary: [{ at: NOW - HOUR_MS, kind: 'note' }, { at: NOW - 3 * DAY_MS, kind: null }] }));
  assert.deepEqual(facts.life.actions.items, [{ at: NOW - HOUR_MS, skill: 'message.create', place: 'n-c1' }]);
  assert.deepEqual(facts.life.errands.items.map((e) => e.id), ['t1']);
  assert.equal(facts.life.diary.items.length, 1);
  assert.deepEqual(facts.life.open.items.map((i) => i.id), ['i1', 'i3']);
  assert.deepEqual(facts.life.attending.items, [{ id: 'i2', purpose: 'listen', place: 'n-c2' }]);
  const many = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, status: 'pending', purpose: 'p', dueAt: NOW + i }));
  const capped = await buildHeartbeatFacts(base({ intentions: many }));
  assert.equal(capped.life.open.items.length, 8);
  assert.equal(capped.life.open.more, 4);
});

test('closed: the latest closed ones of any state, newest first, each with its outcome or reason, capped at closedShown with the rest counted; open ones and candidates are not in it', async () => {
  const states = ['done', 'cancelled', 'expired', 'dropped'];
  const records = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, status: states[i % 4], purpose: `want ${i}`, reason: i % 4 === 3 ? `why ${i}` : undefined, history: [{ at: NOW - (i + 1) * HOUR_MS }] }));
  const facts = await buildHeartbeatFacts(base({ intentions: records }));
  assert.deepEqual(facts.life.closed.items.map((d) => d.id), ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9']);
  assert.equal(facts.life.closed.more, 2);
  assert.deepEqual(facts.life.closed.items.slice(0, 4).map((d) => d.state), states);
  assert.equal(facts.life.closed.items[3].why, 'why 3');
  const small = await buildHeartbeatFacts(base({ intentions: records, settings: { closedShown: 2 } }));
  assert.equal(small.life.closed.items.length, 2);
  assert.equal(small.life.closed.more, 10);
  const mixed = [
    { id: 'r1', status: 'dropped', purpose: 'a', history: [{ at: NOW - 2 * HOUR_MS, reason: 'from history' }] },
    { id: 'r2', status: 'pending', purpose: 'open' },
    { id: 'r3', status: 'expired', purpose: 'cand', provenance: { kind: 'candidate' }, history: [{ at: NOW - HOUR_MS }] },
    { id: 'r4', status: 'pending', purpose: 'errand', outcome: { state: 'failed', error: 'timeout' } },
    { id: 'r5', status: 'done', purpose: 'b', outcome: { state: 'done' }, history: [{ at: NOW - 3 * HOUR_MS }] },
  ];
  const derived = await buildHeartbeatFacts(base({ intentions: mixed }));
  assert.deepEqual(derived.life.closed.items.map((d) => [d.id, d.state, d.why]), [['r1', 'dropped', 'from history'], ['r5', 'done', 'done']]);
  assert.deepEqual((await buildHeartbeatFacts(base({ intentions: [{ id: 'r6', status: 'pending', purpose: 'x' }] }))).life.closed, { items: [], more: 0 });
});

test('skills are grouped by family and the agents listed', async () => {
  const facts = await buildHeartbeatFacts(base({ skills: ['web.search', 'web.read', 'intent.set', 'solo'], agents: ['web', 'server'] }));
  assert.deepEqual(facts.skills, [{ family: 'web', names: ['search', 'read'] }, { family: 'intent', names: ['set'] }, { family: 'solo', names: ['solo'] }]);
  assert.deepEqual(facts.agents, ['web', 'server']);
});

test('since: done counts, what was not done or counted on, the told facts as one count', async () => {
  const journal = fakeJournal([
    { kind: 'inner', event: 'turn', occurredAt: iso(NOW - HOUR_MS), actions: [{ skill: 'message.create', status: 'executed', result: 'ok' }, { skill: 'draw.create', status: 'executed', result: 'ok' }] },
    { kind: 'action', phase: 'unknown', name: 'message.create', occurredAt: iso(NOW - 30 * MINUTE_MS), scope: { channel: 'c5' } },
    { kind: 'action', phase: 'succeeded', name: 'message.create', occurredAt: iso(NOW - 30 * MINUTE_MS), scope: { channel: 'c5' } },
    { kind: 'action', phase: 'unknown', name: 'message.create', occurredAt: iso(NOW - 6 * HOUR_MS), scope: { channel: 'c5' } },
  ]);
  const tasks = [
    { id: 'e1', agent: 'web', state: 'done', endedAt: NOW - HOUR_MS, createdAt: NOW - 2 * HOUR_MS, requester: { kind: 'persona' } },
    { id: 'e2', agent: 'server', state: 'failed', endedAt: NOW - HOUR_MS, createdAt: NOW - 2 * HOUR_MS, requester: { kind: 'persona' }, error: { code: 'timeout' } },
    { id: 'e3', agent: 'server', state: 'failed', endedAt: NOW - 5 * HOUR_MS, createdAt: NOW - 6 * HOUR_MS, requester: { kind: 'persona' } },
  ];
  const intentions = [
    { id: 'x1', status: 'expired', purpose: 'gone', history: [{ at: NOW - HOUR_MS, to: 'expired' }] },
    { id: 'x2', status: 'expired', purpose: 'candidate', provenance: { kind: 'candidate' }, history: [{ at: NOW - HOUR_MS }] },
    { id: 'x3', status: 'done', purpose: 'kept', history: [{ at: NOW - HOUR_MS, to: 'done' }] },
    { id: 'x4', status: 'pending', purpose: 'rec', history: [{ at: NOW - 2 * HOUR_MS, code: 'missed' }, { at: NOW - 2 * HOUR_MS, code: 'wait-deadline' }] },
  ];
  const innerState = { turns: [{ at: NOW - HOUR_MS, outcome: 'error', code: 'timeout' }, { at: NOW - HOUR_MS, outcome: 'spoke' }, { at: NOW - 9 * HOUR_MS, outcome: 'error' }], facts: [{ told: NOW - HOUR_MS }, { told: NOW - HOUR_MS }, { told: NOW - 8 * HOUR_MS }, { told: false }] };
  const { since } = await buildHeartbeatFacts(base({ journal, tasks, intentions, innerState, diary: [{ at: NOW - 2 * HOUR_MS }] }));
  assert.deepEqual(since.done, { posts: 3, errands: 1, intentions: 1 });
  assert.deepEqual(since.notDone.expired.items.map((i) => i.id), ['x1']);
  assert.deepEqual(since.notDone.missed.items.map((i) => i.id), ['x4']);
  assert.deepEqual(since.notDone.lateErrands.items.map((i) => i.id), ['x4']);
  assert.deepEqual(since.notDone.failedErrands.items.map((e) => [e.id, e.code]), [['e2', 'timeout']]);
  assert.deepEqual(since.notDone.unknownSends.items, [{ at: NOW - 30 * MINUTE_MS, skill: 'message.create', place: 'n-c5' }]);
  assert.deepEqual(since.notDone.failedTurns.items, [{ at: NOW - HOUR_MS, code: 'timeout' }]);
  assert.equal(since.notDone.told, 2);
});

test('since: without a previous heartbeat the window is the last day; an empty window is all empty', async () => {
  const intentions = [{ id: 'x1', status: 'expired', purpose: 'a', history: [{ at: NOW - 10 * HOUR_MS }] }];
  const first = await buildHeartbeatFacts(base({ since: null, intentions }));
  assert.equal(first.since.from, NOW - DAY_MS);
  assert.equal(first.since.notDone.expired.items.length, 1);
  const empty = await buildHeartbeatFacts(base());
  assert.deepEqual(empty.since.done, { posts: 0, errands: 0, intentions: 0 });
  assert.deepEqual(empty.since.filtered, { items: [], more: 0, total: 0 });
  assert.equal(empty.since.notDone.told, 0);
});

test('filtered: the missed helper\'s dismissals (not owed ones, not before the window) with place and time, newest first, capped at filteredShown with the rest counted; the address verdicts join when a source gives them', async () => {
  const verdict = (at, verdictName, channel = 'c1') => ({ kind: 'answer', event: 'verdict', verdict: verdictName, occurredAt: iso(at), scope: { channel } });
  const rows = [
    ...Array.from({ length: 6 }, (_, i) => verdict(NOW - (i + 1) * 10 * MINUTE_MS, ['intentional-skip', 'stale', 'uncertain'][i % 3])),
    verdict(NOW - 5 * MINUTE_MS, 'owed'),
    verdict(NOW - 5 * MINUTE_MS, 'resolved'),
    verdict(NOW - 6 * HOUR_MS, 'stale'),
    { kind: 'answer', event: 'fact', occurredAt: iso(NOW - 5 * MINUTE_MS), scope: { channel: 'c1' } },
  ];
  const facts = await buildHeartbeatFacts(base({ journal: fakeJournal(rows), settings: { filteredShown: 4 } }));
  assert.equal(facts.since.filtered.total, 6);
  assert.equal(facts.since.filtered.items.length, 4);
  assert.equal(facts.since.filtered.more, 2);
  assert.deepEqual(facts.since.filtered.items.map((x) => x.verdict), ['intentional-skip', 'stale', 'uncertain', 'intentional-skip']);
  assert.ok(facts.since.filtered.items.every((x) => x.by === 'missed' && x.place === 'n-c1'));
  const joined = await buildHeartbeatFacts(base({ journal: fakeJournal(rows), addressVerdicts: () => [{ at: NOW - MINUTE_MS, channelId: 'c2' }, { at: NOW - 9 * HOUR_MS, channelId: 'c2' }] }));
  assert.equal(joined.since.filtered.total, 7);
  const journalled = await buildHeartbeatFacts(base({ journal: fakeJournal([...rows, { kind: 'answer', event: 'address', verdict: 'not-addressed', messageId: 'm1', authorId: 'u1', channelId: 'c2', at: iso(NOW - MINUTE_MS), occurredAt: iso(NOW - MINUTE_MS), scope: { channel: 'c2' } }]), settings: { filteredShown: 4 } }));
  assert.equal(journalled.since.filtered.total, 7);
  assert.equal(journalled.since.filtered.more, 3);
  assert.deepEqual(journalled.since.filtered.items[0], { at: NOW - MINUTE_MS, place: 'n-c2', by: 'address' });
  assert.equal(journalled.since.filtered.items.length, 4);
  assert.deepEqual(joined.since.filtered.items[0], { at: NOW - MINUTE_MS, place: 'n-c2', by: 'address' });
});

test('wake: the heartbeat kind line, people, places, her life, skills and what happened since, every word from the labels; empty lists say nothing', async () => {
  const l = labels.wake.heartbeat;
  const facts = await buildHeartbeatFacts(base({
    profiles: [profile('b', 5, { interests: [{ topic: 'tea', weight: 1 }] })],
    record: record([seen('b', NOW - HOUR_MS, 'c1')]),
    activePlaces: () => ['general'],
    places: { total: 1, more: 0, items: [{ id: 'c1', name: 'general', lines: 2, people: 1, writable: true }] },
    skills: ['web.search'],
    agents: ['web'],
    intentions: [{ id: 'x1', status: 'expired', purpose: 'old plan', history: [{ at: NOW - HOUR_MS }] }, { id: 'd1', status: 'dropped', purpose: 'learn a song', reason: 'no time', history: [{ at: NOW - HOUR_MS }] }],
  }));
  const text = wakeBlockText({ items: [{ kind: 'heartbeat', intentionIds: [] }], intentions: [], now: NOW, timezone: 'UTC', places: facts.places, heartbeat: facts, here: null }, labels);
  for (const needle of [labels.wake.kinds.heartbeat, l.people, 'name-b: ', 'cares about tea', 'writes lately in general', 'last talked', '#general 2/1', l.closed, 'learn a song', 'no time', 'web: search', 'Errand agents: web', 'intention x1 expired: old plan', l.notDone]) {
    assert.ok(text.includes(needle), needle);
  }
  assert.ok(!text.includes(l.filtered), 'no filtered list without filtered lines');
  assert.ok(!text.includes(l.life), 'no life lead without a life');
  // The places page is not repeated by the heartbeat block.
  assert.equal(text.split('#general 2/1').length, 2);
  // Without any facts the block is the plain wake.
  const bare = wakeBlockText({ items: [{ kind: 'heartbeat', intentionIds: [] }], intentions: [], now: NOW, timezone: 'UTC', heartbeat: await buildHeartbeatFacts(base()), here: null }, labels);
  assert.ok(!bare.includes(l.people) && !bare.includes(l.since.slice(0, 5)));
});

test('wake: a capped list ends with the count line', async () => {
  const given = Array.from({ length: 7 }, (_, i) => ({ id: `d${i}`, status: 'dropped', purpose: `want ${i}`, reason: 'r', history: [{ at: NOW - (i + 1) * HOUR_MS }] }));
  const facts = await buildHeartbeatFacts(base({ intentions: given, settings: { closedShown: 5 } }));
  const text = wakeBlockText({ items: [{ kind: 'heartbeat', intentionIds: [] }], intentions: [], now: NOW, timezone: 'UTC', heartbeat: facts, here: null }, labels);
  assert.ok(text.includes('want 4') && !text.includes('want 5'));
  assert.ok(text.includes(labels.wake.heartbeat.more.replace('{more}', '2')));
});
