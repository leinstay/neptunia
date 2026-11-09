// Round trips of errands.js through the real schema: the errand units an older release wrote, which the board's
// schema imports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as errands from '../src/memory/db/map/errands.ts';
import { assertRoundTrip, roundTrip } from './fixtures/memory-db/roundtrip.ts';

const task = (id: string, extra = {}) => ({
  id,
  agent: 'scout',
  goal: 'look something up',
  requester: { accountId: '100000000000000001', kind: 'member' },
  origin: { placeId: '200000000000000001', messageId: null },
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

test('errands: errands become work rows with the record whole', () => {
  const file = {
    errands: [task('t1'), task('t2', { state: 'failed', error: 'timeout', seen: false, endedAt: null })],
    extra: { n: 1 },
  };
  const rows = assertRoundTrip(errands, 'errands.json', file);
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

test('errands: a DM errand is scoped to its requester', () => {
  const rows = assertRoundTrip(errands, 'errands.json', { errands: [task('t3', { scope: 'dm' })] });
  assert.deepEqual([rows.work[0].scope_kind, rows.work[0].scope_dm], ['dm', 'person:discord:100000000000000001']);
  assertRoundTrip(errands, 'errands.json', {
    errands: [task('t4', { scope: 'dm', requester: { accountId: null, kind: 'owner' } })],
  });
});

test('errands: each line of errands.jsonl is an event with its own id, even two identical lines', () => {
  const line = { at: 1792000000500, ...task('t1', { state: 'running' }) };
  const a = roundTrip(errands, 'errands.jsonl', line, { position: 0 });
  const b = roundTrip(errands, 'errands.jsonl', line, { position: 1 });
  assert.deepEqual(a.back, line);
  assert.equal(a.rows.work_events[0].work_id, 't1');
  assert.equal(a.rows.work_events[0].at_ms, 1792000000500);
  assert.notEqual(a.rows.work_events[0].id, b.rows.work_events[0].id);
  assertRoundTrip(errands, 'errands.jsonl', { weird: true }, { position: 2 });
});

test('errands: odd files survive', () => {
  assertRoundTrip(errands, 'errands.json', { errands: [] });
  assertRoundTrip(errands, 'errands.json', { errands: [{ id: 'x' }, { id: 'x' }] });
  assertRoundTrip(errands, 'errands.json', { errands: [{ state: 'open' }], more: [] });
});
