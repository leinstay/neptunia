// Round trips of intentions.js and tasks.js through the real schema.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as intentions from '../src/memory/db/map/intentions.js';
import * as tasks from '../src/memory/db/map/tasks.js';
import { assertRoundTrip, roundTrip } from './fixtures/memory-db/roundtrip.js';

const intention = (id, extra = {}) => ({
  id,
  purpose: 'ask about the trip',
  status: 'open',
  createdAt: 1792000000000,
  updatedAt: 1792000001000,
  dueAt: null,
  every: null,
  expiresAt: 1793000000000,
  awaitingTaskId: null,
  waitDeadline: null,
  destination: null,
  completionCondition: null,
  chainId: null,
  attend: null,
  provenance: { kind: 'self', turnId: 't-1', channelId: '200000000000000001', scope: 'group' },
  history: [{ at: 1792000000000, to: 'open', by: 'persona' }],
  ...extra,
});

test('intentions: the record is kept whole and its fields copied to columns', () => {
  const file = {
    intentions: [
      intention('i1', { dueAt: 1792100000000 }),
      intention('i2', { status: 'done', outcome: { taskId: 't', state: 'done', at: 3 } }),
    ],
  };
  const rows = assertRoundTrip(intentions, 'intentions.json', file);
  const [row] = rows.intentions;
  assert.equal(row.id, 'i1');
  assert.equal(row.status, 'open');
  assert.equal(row.due_ms, 1792100000000);
  assert.equal(row.created_ms, 1792000000000);
  assert.equal(row.updated_ms, 1792000001000);
  assert.equal(row.scope_kind, 'group');
  assert.equal(row.archived, 0);
  assert.equal(JSON.parse(row.record).purpose, 'ask about the trip');
});

test('intentions: a DM intention is scoped to its one participant, and to nobody outward with several', () => {
  const dm = intention('i3', { provenance: { kind: 'self', scope: 'dm', participants: ['100000000000000001'] } });
  const many = intention('i4', {
    provenance: { kind: 'self', scope: 'dm', participants: ['100000000000000001', '100000000000000002'] },
  });
  const rows = assertRoundTrip(intentions, 'intentions.json', { intentions: [dm, many] });
  assert.deepEqual(
    [rows.intentions[0].scope_kind, rows.intentions[0].scope_dm],
    ['dm', 'person:discord:100000000000000001']
  );
  assert.equal(rows.intentions[1].scope_kind, 'internal');
});

test('intentions: an archive line is an archived row, and odd files survive', () => {
  const { rows, back } = roundTrip(intentions, 'intentions-archive.jsonl', intention('i9', { status: 'expired' }), {
    position: 4,
  });
  assert.equal(rows.intentions[0].archived, 1);
  assert.equal(rows.intentions[0].position, 4);
  assert.deepEqual(back, intention('i9', { status: 'expired' }));
  assertRoundTrip(intentions, 'intentions-archive.jsonl', 'not a record', { position: 1 });
  assertRoundTrip(intentions, 'intentions.json', { intentions: [] });
  assertRoundTrip(intentions, 'intentions.json', { intentions: [{ id: 'same' }, { id: 'same' }], other: 1 });
  assertRoundTrip(intentions, 'intentions.json', { intentions: [{ status: 'open' }] });
});

const task = (id, extra = {}) => ({
  id,
  agent: 'scout',
  goal: 'look something up',
  requester: { userId: '100000000000000001', kind: 'member' },
  origin: { channelId: '200000000000000001', messageId: null },
  scope: 'group',
  state: 'done',
  createdAt: 1792000000000,
  startedAt: 1792000001000,
  endedAt: 1792000009000,
  usage: { input: 1, output: 2, usd: 0.1, steps: 3, seconds: 4 },
  result: { text: 'found', sources: ['https://example.test'], files: [] },
  error: null,
  seen: true,
  opId: 'op-1',
  readAt: null,
  resolvedAt: null,
  ...extra,
});

test('tasks: tasks become errand work rows with the record whole', () => {
  const file = {
    tasks: [task('t1'), task('t2', { state: 'failed', error: 'timeout', seen: false, endedAt: null })],
    extra: { n: 1 },
  };
  const rows = assertRoundTrip(tasks, 'tasks.json', file);
  const [done, failed] = rows.work;
  assert.equal(done.kind, 'errand');
  assert.equal(done.state, 'done');
  assert.equal(done.created_ms, 1792000000000);
  assert.equal(done.updated_ms, 1792000009000);
  assert.equal(done.seen, 1);
  assert.equal(done.scope_kind, 'group');
  assert.equal(failed.outcome, 'timeout');
  assert.equal(failed.seen, 0);
  assert.equal(failed.updated_ms, 1792000001000);
});

test('tasks: a DM errand is scoped to its requester', () => {
  const rows = assertRoundTrip(tasks, 'tasks.json', { tasks: [task('t3', { scope: 'dm' })] });
  assert.deepEqual([rows.work[0].scope_kind, rows.work[0].scope_dm], ['dm', 'person:discord:100000000000000001']);
  assertRoundTrip(tasks, 'tasks.json', {
    tasks: [task('t4', { scope: 'dm', requester: { userId: null, kind: 'owner' } })],
  });
});

test('tasks: each line of tasks.jsonl is an event with its own id, even two identical lines', () => {
  const line = { at: 1792000000500, ...task('t1', { state: 'running' }) };
  const a = roundTrip(tasks, 'tasks.jsonl', line, { position: 0 });
  const b = roundTrip(tasks, 'tasks.jsonl', line, { position: 1 });
  assert.deepEqual(a.back, line);
  assert.equal(a.rows.work_events[0].work_id, 't1');
  assert.equal(a.rows.work_events[0].at_ms, 1792000000500);
  assert.notEqual(a.rows.work_events[0].id, b.rows.work_events[0].id);
  assertRoundTrip(tasks, 'tasks.jsonl', { weird: true }, { position: 2 });
});

test('tasks: odd files survive', () => {
  assertRoundTrip(tasks, 'tasks.json', { tasks: [] });
  assertRoundTrip(tasks, 'tasks.json', { tasks: [{ id: 'x' }, { id: 'x' }] });
  assertRoundTrip(tasks, 'tasks.json', { tasks: [{ state: 'open' }], more: [] });
});
