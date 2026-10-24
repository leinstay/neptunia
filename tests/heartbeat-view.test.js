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
    turn(NOW - HOUR_MS, [{ skill: 'message.create', status: 'executed', result: 'ok', target: { channel: 'c1' } }, { skill: 'web.search', status: 'proposed', result: 'ok' }, { skill: 'draw.create', status: 'executed', result: 'failed' }, { skill: 'places.list', status: 'executed', result: 'ok' }]),
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
  // A message she sent is listed from the record and a diary post from the diary, never as a call.
  assert.deepEqual(facts.life.actions.items, [{ at: NOW - HOUR_MS, skill: 'places.list', place: null }]);
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
  assert.deepEqual(journalled.since.filtered.items[0], { at: NOW - MINUTE_MS, place: 'n-c2', by: 'address', who: 'u1' });
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
  for (const needle of [labels.wake.kinds.heartbeat, l.people, 'name-b: ', 'cares about tea', 'writes lately in general', 'last talked', '#n-c1: 1 lines from name-b', l.closed, 'learn a song', 'no time', 'web: search', 'Errand agents: web', 'intention x1 expired: old plan', l.notDone]) {
    assert.ok(text.includes(needle), needle);
  }
  assert.ok(!text.includes(l.filtered), 'no filtered list without filtered lines');
  assert.ok(text.includes(l.activity), 'the places block is the lines people wrote lately');
  assert.ok(!text.includes(l.life), 'no life lead without a life');
  // The review's places page is not repeated by the heartbeat block.
  assert.ok(!text.includes('#general 2/1'));
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

// The record's lines as the view reads them: a full `seen` line with its message id, text and media kinds.
const line = (messageId, by, at, channel, text, extra = {}) => ({ kind: 'seen', messageId, revision: 1, by, occurredAt: iso(at), scope: { channel }, text, media: [], participants: [by], ...extra });
const ownLine = (messageId, at, channel, text, extra = {}) => ({ kind: 'said', messageId, revision: 1, occurredAt: iso(at), scope: { channel }, text, media: [], participants: [], ...extra });
const wakeOf = (facts, options) => wakeBlockText({ items: [{ kind: 'heartbeat', intentionIds: [] }], intentions: [], now: NOW, timezone: 'UTC', heartbeat: facts, here: null }, labels, options);

test('places: a link another member posted 2.5 hours ago shows in the place and in that person\'s own line, with one handle that resolves', async () => {
  const link = line('m-yt', 'vertex', NOW - 2.5 * HOUR_MS, 'muzika', 'they still make clips for this song https://youtu.be/abc', { media: ['link'], links: [{ url: 'https://youtu.be/abc', title: 'The song', description: '', site: 'YouTube' }] });
  const facts = await buildHeartbeatFacts(base({
    profiles: [profile('vertex', 40, { names: ['Vertex'] })],
    record: record([line('m-1', 'other', NOW - 5 * HOUR_MS, 'muzika', 'old chatter'), link, line('m-2', 'other', NOW - HOUR_MS, 'muzika', 'nice one')]),
  }));
  const [muzika] = facts.activity.items;
  assert.equal(muzika.name, 'n-muzika');
  assert.equal(muzika.lines, 3);
  assert.deepEqual(muzika.previews.map((p) => p.text.slice(0, 12)), ['they still m', 'nice one']);
  assert.equal(muzika.previews[0].by, 'Vertex');
  assert.deepEqual(muzika.previews[0].media, { kinds: ['link'], title: 'The song' });
  const person = facts.people[0];
  assert.equal(person.lastWrote.place, 'n-muzika');
  assert.equal(person.lastWrote.ref, muzika.previews[0].ref, 'one line, one handle');
  const ref = facts.refs[person.lastWrote.ref];
  assert.equal(ref.id, 'm-yt');
  assert.equal(ref.channelId, 'muzika');
  assert.equal(ref.authorId, 'vertex');
  assert.equal(ref.self, false);
  assert.equal(ref.message.links[0].url, 'https://youtu.be/abc');
  const shown = [];
  const text = wakeOf(facts, { handleBase: 50, onRefs: (refs) => shown.push(...refs) });
  const handle = `#${50 + person.lastWrote.ref}`;
  assert.ok(text.includes(`${handle} Vertex,`) && text.includes('they still make clips'), 'the place quotes the line under its handle');
  assert.ok(text.includes(`last wrote`) && text.split(handle).length === 3, 'the person line carries the same handle');
  assert.ok(text.includes('[link: The song]'));
  assert.ok(shown.includes(person.lastWrote.ref));
  assert.ok(!wakeOf(facts).includes('#5'), 'without a base there are no handles');
});

test('places: ranked by lines in the last placesHours, places without any dropped, her own lines and deleted ones left out, an edit replaces its earlier text, capped with the rest counted', async () => {
  const lines = [
    ...Array.from({ length: 3 }, (_, i) => line(`a${i}`, 'u1', NOW - (i + 1) * MINUTE_MS, 'busy', `line ${i}`)),
    line('b0', 'u1', NOW - MINUTE_MS, 'quiet', 'one'),
    line('c0', 'u1', NOW - 7 * HOUR_MS, 'stale', 'too old'),
    line('d0', 'self', NOW - MINUTE_MS, 'mine', 'my own'),
    ownLine('s0', NOW - MINUTE_MS, 'mine', 'said'),
    line('e0', 'u1', NOW - MINUTE_MS, 'gone', 'deleted line'),
    { kind: 'deleted', messageId: 'e0', occurredAt: iso(NOW - 30_000), scope: { channel: 'gone' }, participants: ['u1'] },
    line('f0', 'u2', NOW - 30_000, 'edited', 'first words'),
    line('f0', 'u2', NOW - 30_000, 'edited', 'edited words', { revision: 2 }),
  ];
  const facts = await buildHeartbeatFacts(base({ selfId: 'self', record: record(lines), settings: { placesShown: 2 } }));
  assert.deepEqual(facts.activity.items.map((p) => [p.name, p.lines]), [['n-busy', 3], ['n-edited', 1]]);
  assert.equal(facts.activity.total, 3);
  assert.equal(facts.activity.more, 1);
  assert.equal(facts.activity.items[0].previews.length, 2, 'placeLines: the last two');
  assert.deepEqual(facts.activity.items[0].previews.map((p) => p.text), ['line 1', 'line 0']);
  assert.equal(facts.activity.items[1].previews[0].text, 'edited words');
  const wide = await buildHeartbeatFacts(base({ record: record(lines), settings: { placesHours: 8, placeLines: 1 } }));
  assert.ok(wide.activity.items.some((p) => p.name === 'n-stale'));
  assert.ok(wide.activity.items.every((p) => p.previews.length === 1));
  assert.ok(!(await buildHeartbeatFacts(base({ selfId: 'self', record: record(lines) }))).activity.items.some((p) => p.name === 'n-gone'));
  const text = wakeOf(facts, { handleBase: 1 });
  assert.ok(text.includes(labels.wake.heartbeat.more.replace('{more}', '1')));
});

test('places: a preview is cut to about 140 characters and a line with only a picture still shows its marker', async () => {
  const long = 'x'.repeat(300);
  const facts = await buildHeartbeatFacts(base({ record: record([line('l1', 'u1', NOW - 2 * MINUTE_MS, 'c1', long), line('l2', 'u1', NOW - MINUTE_MS, 'c1', '', { media: ['image', 'image', 'video'] })]) }));
  const [first, second] = facts.activity.items[0].previews;
  assert.ok(first.text.length <= 140 && first.text.endsWith('…'));
  assert.equal(second.text, '');
  assert.deepEqual(second.media.kinds, ['image', 'video']);
  assert.ok(wakeOf(facts, { handleBase: 1 }).includes('[image/video]'));
});

test('people: each person\'s own last line within historyDays (when, where, preview, handle); an older one is not shown', async () => {
  const profiles = [profile('a', 9), profile('b', 8)];
  const lines = [line('a1', 'a', NOW - 3 * DAY_MS, 'c1', 'first'), line('a2', 'a', NOW - 2 * DAY_MS, 'c2', 'y'.repeat(200)), line('b1', 'b', NOW - 20 * DAY_MS, 'c1', 'ancient'), said(NOW - HOUR_MS, 'c3', ['b'])];
  const facts = await buildHeartbeatFacts(base({ profiles, record: record(lines) }));
  const [a, b] = facts.people;
  assert.equal(a.lastWrote.at, NOW - 2 * DAY_MS);
  assert.equal(a.lastWrote.place, 'n-c2');
  assert.ok(a.lastWrote.text.length <= 120);
  assert.equal(facts.refs[a.lastWrote.ref].id, 'a2');
  assert.equal(b.lastWrote, null);
  assert.equal(b.lastAt, NOW - HOUR_MS, 'the last contact with her stays');
  const text = wakeOf(facts, { handleBase: 10 });
  assert.ok(text.includes('name-a: ') && text.includes('last wrote'));
});

test('not done: only her own sends count, an engine action never does, and a send whose message arrived later is dropped', async () => {
  const unknown = (extra) => ({ kind: 'action', phase: 'unknown', occurredAt: iso(NOW - 30 * MINUTE_MS), scope: { channel: 'c5' }, ...extra });
  const journal = fakeJournal([
    unknown({ name: 'skill', by: 'persona', opId: 'op-1', input: { skill: 'message.create' } }),
    unknown({ name: 'skill', by: 'persona', opId: 'op-2', input: { skill: 'message.create' } }),
    { kind: 'action', phase: 'succeeded', name: 'skill', by: 'persona', opId: 'op-2', occurredAt: iso(NOW - 20 * MINUTE_MS), scope: { channel: 'c5' } },
    unknown({ name: 'post', by: 'persona', opId: 'op-3' }),
    unknown({ name: 'describe', by: 'engine', opId: 'op-4' }),
    unknown({ name: 'skill', by: 'persona', opId: 'op-5', input: { skill: 'web.search' } }),
    unknown({ name: 'skill', by: 'persona', opId: 'op-6', input: { skill: 'draw.create' } }),
  ]);
  const { since } = await buildHeartbeatFacts(base({ journal }));
  assert.deepEqual(since.notDone.unknownSends.items.map((x) => x.skill).sort(), ['draw.create', 'message.create', 'post']);
  assert.equal(since.notDone.unknownSends.items.length, 3);
});

test('filtered: each line with its author, a preview cut to about 100 characters and a handle that resolves; a line the record lacks keeps the plain row', async () => {
  const rows = [
    { kind: 'answer', event: 'verdict', verdict: 'stale', messageId: 'f1', authorId: 'u7', occurredAt: iso(NOW - 10 * MINUTE_MS), scope: { channel: 'c1' } },
    { kind: 'answer', event: 'address', verdict: 'not-addressed', messageId: 'f2', authorId: 'u8', channelId: 'c2', at: iso(NOW - 5 * MINUTE_MS), occurredAt: iso(NOW - 5 * MINUTE_MS), scope: { channel: 'c2' } },
    { kind: 'answer', event: 'verdict', verdict: 'stale', messageId: 'missing', authorId: 'u9', occurredAt: iso(NOW - 20 * MINUTE_MS), scope: { channel: 'c1' } },
  ];
  const facts = await buildHeartbeatFacts(base({
    journal: fakeJournal(rows),
    nameOf: (id) => ({ u7: 'Seven', u8: 'Eight' })[id] ?? null,
    record: record([line('f1', 'u7', NOW - 11 * MINUTE_MS, 'c1', 'z'.repeat(250)), line('f2', 'u8', NOW - 6 * MINUTE_MS, 'c2', 'hello there', { media: ['gif'] })]),
  }));
  const [address, missed, plain] = facts.since.filtered.items;
  assert.deepEqual([address.who, address.text, address.media.kinds], ['Eight', 'hello there', ['gif']]);
  assert.ok(missed.text.length <= 100 && missed.who === 'Seven');
  assert.equal(facts.refs[address.ref].id, 'f2');
  assert.equal(plain.ref, undefined);
  assert.equal(plain.who, 'u9');
  const text = wakeOf(facts, { handleBase: 30 });
  assert.ok(text.includes(`Eight #${30 + address.ref} hello there [gif]: a line judged not for you`));
  assert.ok(text.includes('a line judged not owed an answer (stale)'));
});

test('life: her own posts with place and preview, errands with their goal, a diary post once', async () => {
  const diary = [{ at: NOW - 2 * HOUR_MS, kind: 'note', gist: 'g'.repeat(200), messageIds: ['d-msg'] }];
  const lines = [ownLine('p1', NOW - HOUR_MS, 'c1', 'p'.repeat(200)), ownLine('d-msg', NOW - 2 * HOUR_MS, 'diary', 'the diary text'), ownLine('p-old', NOW - 2 * DAY_MS, 'c1', 'yesterday')];
  const tasks = [{ id: 't1', agent: 'web', state: 'done', createdAt: NOW - HOUR_MS, goal: 'find the song '.repeat(20), requester: { kind: 'persona' } }];
  const journal = fakeJournal([{ kind: 'inner', event: 'turn', occurredAt: iso(NOW - HOUR_MS), actions: [{ skill: 'diary.post', status: 'executed', result: 'ok' }, { skill: 'message.create', status: 'executed', result: 'ok' }] }]);
  const facts = await buildHeartbeatFacts(base({ record: record(lines), tasks, diary, journal }));
  assert.equal(facts.life.posts.items.length, 1);
  assert.equal(facts.life.posts.items[0].place, 'n-c1');
  assert.ok(facts.life.posts.items[0].text.length <= 80);
  assert.ok(facts.life.errands.items[0].goal.length <= 80 && facts.life.errands.items[0].goal.startsWith('find the song'));
  assert.equal(facts.life.diary.items.length, 1);
  assert.ok(facts.life.diary.items[0].gist.length <= 80);
  assert.equal(facts.life.actions.items.length, 0, 'neither a message nor a diary post is listed a second time as a call');
  const text = wakeOf(facts, { handleBase: 1 });
  assert.equal(text.split('a diary post').length, 2);
  assert.ok(text.includes('you wrote in #n-c1: ppp'));
  assert.ok(text.includes('errand to web (done): find the song'));
});

test('budget: over heartbeat.maxTokens the lists shed their last items in order -- filtered, her life, places beyond 3, people beyond 5 -- and the shed ones are counted', async () => {
  const profiles = Array.from({ length: 8 }, (_, i) => profile(`p${i}`, 100 - i));
  const lines = Array.from({ length: 6 }, (_, i) => line(`m${i}`, `p${i}`, NOW - (i + 1) * MINUTE_MS, `ch${i}`, `says ${i} `.repeat(10)));
  const rows = Array.from({ length: 6 }, (_, i) => ({ kind: 'answer', event: 'verdict', verdict: 'stale', messageId: `x${i}`, authorId: 'u1', occurredAt: iso(NOW - (i + 1) * MINUTE_MS), scope: { channel: 'c1' } }));
  const tasks = Array.from({ length: 4 }, (_, i) => ({ id: `t${i}`, agent: 'web', state: 'done', createdAt: NOW - (i + 1) * MINUTE_MS, goal: 'goal', requester: { kind: 'persona' } }));
  const input = { profiles, record: record(lines), journal: fakeJournal(rows), tasks };
  const full = await buildHeartbeatFacts(base({ ...input, settings: { maxTokens: 0 } }));
  const fullText = wakeOf(full, { handleBase: 1 });
  assert.ok(fullText.includes('ch5') && fullText.includes('name-p7') && fullText.includes('errand to web'));
  const tokens = (value) => Math.ceil(value.length / 3.5);
  // A cap just under the full block: the filtered lines go first.
  const first = await buildHeartbeatFacts(base({ ...input, settings: { maxTokens: tokens(fullText) - 30 } }));
  const firstText = wakeOf(first, { handleBase: 1 });
  assert.ok(firstText.includes('errand to web') && firstText.includes('name-p7') && firstText.includes('ch5'));
  assert.ok((firstText.match(/judged not owed/g) ?? []).length < 6);
  assert.ok(tokens(firstText.split('\n').slice(1).join('\n')) < tokens(fullText));
  // A tight cap: filtered and her life gone, places cut to 3, people to 5, and the counts say so.
  const tight = await buildHeartbeatFacts(base({ ...input, settings: { maxTokens: 1 } }));
  const tightText = wakeOf(tight, { handleBase: 1 });
  assert.ok(!tightText.includes('judged not owed') && !tightText.includes('errand to web'));
  const rowsOf = (value, pattern) => value.split('\n').filter((row) => pattern.test(row)).length;
  assert.equal(rowsOf(fullText, / lines from /), 6);
  assert.equal(rowsOf(tightText, / lines from /), 3, 'places beyond 3 are shed');
  assert.equal(rowsOf(fullText, /^name-p\d: /), 8);
  assert.equal(rowsOf(tightText, /^name-p\d: /), 5, 'people beyond 5 are shed');
  assert.ok(tightText.includes(labels.wake.heartbeat.more.replace('{more}', '3')), 'three places and three people are counted');
});

// ---------- the focus set (innerLife.heartbeat.focusSource, src/memory/db/focus.js) ----------

test('focus: a reader that gives nothing leaves the view exactly as the affinity ranking makes it', async () => {
  const profiles = [profile('a', 10), profile('b', 50), profile('c', 30), profile('self', 99)];
  const lines = [seen('b', NOW - 2 * HOUR_MS, 'c2'), said(NOW - HOUR_MS, 'c3', ['c'])];
  const input = () => base({ profiles, selfId: 'self', settings: { people: 2 }, record: record(lines) });
  const plain = await buildHeartbeatFacts(input());
  for (const focusPeople of [null, () => null, () => ({}), () => { throw new Error('closed'); }]) {
    const facts = await buildHeartbeatFacts({ ...input(), focusPeople });
    assert.equal(JSON.stringify(facts), JSON.stringify(plain));
  }
  const words = (heartbeat) => wakeBlockText({ items: [{ kind: 'heartbeat', intentionIds: [] }], intentions: [], now: NOW, timezone: 'UTC', heartbeat, here: null }, labels);
  assert.equal(words(await buildHeartbeatFacts({ ...input(), focusPeople: () => null })), words(plain));
});

test('focus: with the sets the close members come first, then the exploring ones with their share; a member with no profile still shows', async () => {
  const profiles = [profile('a', 90), profile('b', 80), profile('c', 70), profile('d', 60), profile('e', 50), profile('x', 1)];
  const focusPeople = () => ({ close: ['c', 'a', 'z', 'b', 'd', 'self'], exploring: ['x', 'e', 'a'], exploringShare: 0.25 });
  // 8 people: 0.25 * 8 = 2 exploring slots; the close set has 5 (self left out), so the room left goes to exploring too.
  const wide = await buildHeartbeatFacts(base({ profiles, selfId: 'self', settings: { people: 8 }, focusPeople }));
  assert.deepEqual(wide.people.map((p) => p.id), ['c', 'a', 'z', 'b', 'd', 'x', 'e']);
  // 4 people: one exploring slot (0.25 * 4), the close ones first.
  const narrow = await buildHeartbeatFacts(base({ profiles, selfId: 'self', settings: { people: 4 }, focusPeople }));
  assert.deepEqual(narrow.people.map((p) => p.id), ['c', 'a', 'z', 'x']);
  // A small share still gives one slot when there are exploring members.
  const small = await buildHeartbeatFacts(base({ profiles, selfId: 'self', settings: { people: 4 }, focusPeople: () => ({ close: ['a', 'b', 'c', 'd'], exploring: ['e'], exploringShare: 0.01 }) }));
  assert.deepEqual(small.people.map((p) => p.id), ['a', 'b', 'c', 'e']);
  // A member with no profile here is listed by id with no profile facts.
  const z = narrow.people.find((p) => p.id === 'z');
  assert.deepEqual({ interests: z.interests, lastAt: z.lastAt, lastPlace: z.lastPlace }, { interests: [], lastAt: null, lastPlace: null });
  // Empty sets: an empty block (the profiles are not consulted while the sets are given).
  assert.deepEqual((await buildHeartbeatFacts(base({ profiles, focusPeople: () => ({ close: [], exploring: [] }) }))).people, []);
});
