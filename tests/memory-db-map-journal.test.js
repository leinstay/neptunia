// Round trips of src/memory/db/map/journal.js: one journal line of any kind <-> its rows, through the real schema.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as mapper from '../src/memory/db/map/journal.js';
import { assertRoundTrip, generated, plain, roundTrip } from './fixtures/memory-db/roundtrip.js';

const REL = 'journal/2026-10-20.jsonl';
const PRIVATE_REL = 'private/100000000000000001/journal/2026-10-20.jsonl';
const CHANNEL = '200000000000000001';

const envelope = (kind, extra = {}) => ({
  v: 1,
  id: `j-${kind}`,
  kind,
  occurredAt: '2026-10-20T10:00:00.000Z',
  recordedAt: '2026-10-20T10:00:01.000Z',
  guildId: '300000000000000001',
  scope: { channel: CHANNEL },
  participants: ['100000000000000001'],
  sourceMessageIds: ['400000000000000001'],
  origin: 'live',
  ...extra,
});

const turn = () =>
  envelope('turn', {
    turnId: 'turn-1',
    attemptId: 1,
    startedAt: '2026-10-20T09:59:58.000Z',
    mode: 'reply',
    outcome: 'spoke',
    reason: null,
    posted: [{ messageId: '400000000000000009', replyTo: '400000000000000001', opId: 'op-1' }],
    reactions: [{ opId: 'op-2', to: '400000000000000001', emoji: 'ok' }],
    actions: ['op-1', { skill: 'look', status: 'ok', result: 'seen', target: { channel: CHANNEL } }],
    think: 'Καλημέρα. A café thought.',
    thinkTruncated: true,
    usage: { prompt: 10, cached: 4, completion: 3 },
    budget: { dropped: { emoji: 0 } },
    limits: [{ kind: 'chars', where: 'think', lost: null }],
    format: { thinkMissing: 0, coerced: 0 },
  });

test('a turn becomes an answer source and a day row, and the line comes back whole', () => {
  const line = turn();
  const rows = assertRoundTrip(mapper, REL, line, { position: 5 });
  const [day] = rows.day;
  const [answer] = rows.sources;
  assert.equal(day.id, 'j-turn');
  assert.equal(day.at, line.occurredAt);
  assert.equal(day.what, 'turn');
  assert.equal(day.outcome, 'spoke');
  assert.equal(day.reason, null);
  assert.equal(day.turn_id, 'turn-1');
  assert.equal(day.source_id, 'src:turn:turn-1:1');
  assert.equal(day.place_id, `discord:channel:${CHANNEL}`);
  assert.equal(day.position, 5);
  assert.equal(answer.id, 'src:turn:turn-1:1');
  assert.equal(answer.kind, 'answer');
  assert.equal(answer.think, line.think);
  assert.equal(answer.turn_id, 'turn-1');
  assert.deepEqual(JSON.parse(answer.extra).posted, line.posted);
  assert.ok(!('think' in JSON.parse(day.extra)), 'the think is in its column, not in extra');
  assert.ok(!('posted' in JSON.parse(day.extra)));
});

test('a turn with a null think, or none, keeps which it was', () => {
  const nullThink = { ...turn(), think: null };
  const noThink = turn();
  delete noThink.think;
  delete noThink.posted;
  assert.deepEqual(roundTrip(mapper, REL, nullThink).back, nullThink);
  assert.ok(!Object.hasOwn(roundTrip(mapper, REL, noThink).back, 'think'));
  assert.deepEqual(roundTrip(mapper, REL, noThink).back, noThink);
});

test('turn.start, action, inner, system and the missed-message answer record are day rows', () => {
  const lines = [
    envelope('turn.start', {
      turnId: 'turn-1',
      attemptId: 1,
      mode: 'reply',
      trigger: { kind: 'mention', messageId: '400000000000000001', authorId: '100000000000000001' },
    }),
    envelope('action', {
      turnId: 'turn-1',
      opId: 'op-1',
      name: 'message',
      phase: 'succeeded',
      by: 'persona',
      trigger: null,
      input: { to: null, text: 'x' },
      result: { messageId: '400000000000000009', delivered: true },
      intent: { replyTo: null, text: 'hi' },
    }),
    envelope('inner', {
      event: 'wake',
      wake: { id: 'w1', kind: 'heartbeat', reason: 'due', dueAt: 1, intentionIds: ['i1'], chainId: 'c1' },
      outcome: 'idle',
      reason: 'nothing',
      cost: { usd: 0, requests: 1, voice: 0 },
    }),
    envelope('system', { event: 'start', by: 'owner', note: 'ok' }),
    envelope('answer', {
      event: 'fact',
      reason: 'maybe unanswered',
      messageId: '400000000000000001',
      authorId: '100000000000000001',
      at: 1760954400000,
      question: true,
    }),
    envelope('answer', { event: 'verdict', verdict: 'answered', by: 'code', at: '2026-10-20T10:00:00.000Z' }),
    envelope('something-new', { whatever: [1, 2, 3] }),
  ];
  for (const line of lines) {
    const rows = assertRoundTrip(mapper, REL, line, {}, line.kind);
    assert.equal(rows.day.length, 1, line.kind);
    assert.equal(rows.day[0].what, line.kind);
    assert.equal(rows.sources, undefined, `${line.kind} makes no source`);
  }
});

test('the day row takes outcome, reason and turn id from the line when it has them', () => {
  const line = envelope('inner', { outcome: 'idle', reason: 'nothing', turnId: 't9' });
  const { rows } = roundTrip(mapper, REL, line);
  assert.deepEqual([rows.day[0].outcome, rows.day[0].reason, rows.day[0].turn_id], ['idle', 'nothing', 't9']);
});

const memory = () =>
  envelope('memory', {
    batchId: 'b-1',
    stage: 'applied',
    appliedRevision: 'r1',
    note: 'a batch',
    batch: { messageIds: ['400000000000000001'], consumed: 1 },
    changed: { users: ['100000000000000001'], guild: false, channels: [], lore: 0 },
    episodes: [{ userId: '100000000000000001', itemId: null, key: 'k', what: 'w', weight: 1 }],
    attitude: [
      { userId: '100000000000000001', delta: 3, applied: 2, reason: 'was kind' },
      { userId: '100000000000000002', delta: -1, applied: -1, reason: 'was rude', extraField: 'kept' },
    ],
    self: [],
    learned: [{ id: 1, text: 'taught' }],
    consolidation: [],
    archived: [{ itemId: 'i', revisionId: 'r', confirmed: true }],
    promptsHash: 'p',
    configHash: 'c',
  });

test('a memory line becomes a decision by the analyzer and one affinity event per attitude entry', () => {
  const line = memory();
  const rows = assertRoundTrip(mapper, REL, line, { position: 2 });
  assert.equal(rows.day, undefined);
  const [decision] = rows.decisions;
  assert.deepEqual(
    [decision.id, decision.at, decision.by, decision.target_kind, decision.target_id, decision.action, decision.reason],
    ['j-memory', line.occurredAt, 'analyzer', 'batch', 'b-1', 'applied', 'a batch']
  );
  assert.ok(!('attitude' in JSON.parse(decision.extra)));
  assert.equal(rows.affinity_events.length, 2);
  const [first, second] = rows.affinity_events;
  assert.deepEqual(
    [first.person_id, first.delta, first.applied, first.reason, first.at, first.position, first.scope_kind],
    ['person:discord:100000000000000001', 3, 2, 'was kind', line.occurredAt, 0, 'group']
  );
  assert.equal(second.position, 1);
  assert.equal(JSON.parse(second.extra).extraField, 'kept');
});

test('attitude: empty, absent and not-a-list each come back as they were', () => {
  const empty = { ...memory(), attitude: [] };
  const absent = memory();
  delete absent.attitude;
  const odd = { ...memory(), attitude: 'none' };
  const mixed = { ...memory(), attitude: [{ userId: '1', delta: 1 }, 'text'] };
  for (const line of [empty, absent, odd, mixed]) assert.deepEqual(roundTrip(mapper, REL, line).back, line);
  assert.equal(roundTrip(mapper, REL, empty).rows.affinity_events, undefined);
  assert.ok(!Object.hasOwn(roundTrip(mapper, REL, absent).back, 'attitude'));
});

test('the order of attitude entries comes back by position', () => {
  const line = {
    ...memory(),
    attitude: ['a', 'b', 'c', 'd'].map((name, index) => ({ userId: name, delta: index, applied: index, reason: name })),
  };
  const { stored, back } = roundTrip(mapper, REL, line);
  stored.affinity_events.reverse();
  assert.deepEqual(
    mapper.fromRows(stored).attitude.map((entry) => entry.userId),
    ['a', 'b', 'c', 'd']
  );
  assert.deepEqual(back, line);
});

test('a private journal line is a DM row of that member, and its scope survives', () => {
  for (const line of [turn(), memory(), envelope('inner', { scope: { channel: '200000000000000099' } })]) {
    const { rows, back } = roundTrip(mapper, PRIVATE_REL, line);
    const row = (rows.day ?? rows.affinity_events)[0];
    assert.equal(row.scope_kind, 'dm');
    assert.equal(row.scope_dm, 'person:discord:100000000000000001');
    assert.deepEqual(back, line);
  }
});

test('lines with no scope, an empty scope or a guild scope come back as they were', () => {
  for (const scope of [undefined, {}, { guild: true }]) {
    const line = envelope('system', { event: 'stop' });
    if (scope === undefined) delete line.scope;
    else line.scope = scope;
    assert.deepEqual(roundTrip(mapper, REL, line).back, line, JSON.stringify(scope));
  }
});

test('the generated fixtures with every key path of the live journal round trip', () => {
  for (const [index, line] of generated('journal').entries()) {
    assertRoundTrip(mapper, REL, plain(line), {}, `generated journal ${index} (${line.kind})`);
  }
});
