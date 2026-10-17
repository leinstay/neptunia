// Tests for src/agent-runner/protocol.js: validation of the core's `run`,
// `cancel` and `ping` (ids, goal length, context scope, limit keys, model,
// cost, search provider), the decode of a line (bad JSON, oversize), and the
// shapes of the runner's `progress`, `end`, `pong`, `restarted` and `error`
// events, including the frozen RESULT_STATUSES. Pure; no I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RESULT_STATUSES, OPS, validateRequest, parseRequestLine, encodeLine,
  progressEvent, endEvent, restartedEvent, pongEvent, errorEvent, normalizeUsage, normalizeResult,
} from '../src/agent-runner/protocol.js';

test('RESULT_STATUSES: the three final states, frozen', () => {
  assert.deepEqual([...RESULT_STATUSES], ['done', 'failed', 'cancelled']);
  assert.ok(Object.isFrozen(RESULT_STATUSES));
  assert.ok(Object.isFrozen(OPS));
});

test('validateRequest: a full run passes and is normalised', () => {
  const r = validateRequest({
    op: 'run', id: 'task-1', goal: '  find a meme  ',
    context: { scope: 'dm', asker: 'Theodora' },
    limits: { steps: 10, usd: 0.5, seconds: 60 },
    tools: ['search', 'search', 'fetch'], model: 'x-ai/grok-4.7',
    cost: { input: 2, output: 6 }, searchProvider: 'exa',
  });
  assert.equal(r.ok, true);
  assert.equal(r.message.goal, 'find a meme');
  assert.deepEqual(r.message.tools, ['search', 'fetch']);
  assert.deepEqual(r.message.cost, { input: 2, output: 6 });
  assert.equal(r.message.context.scope, 'dm');
});

test('validateRequest: run needs a non-empty goal and an id', () => {
  assert.equal(validateRequest({ op: 'run', id: 'a' }).error, 'bad-goal');
  assert.equal(validateRequest({ op: 'run', id: 'a', goal: '   ' }).error, 'bad-goal');
  assert.equal(validateRequest({ op: 'run', goal: 'x' }).error, 'bad-id');
  assert.equal(validateRequest({ op: 'run', id: 'bad id!', goal: 'x' }).error, 'bad-id');
});

test('validateRequest: a bad scope, limit, cost or search provider is refused', () => {
  assert.equal(validateRequest({ op: 'run', id: 'a', goal: 'x', context: { scope: 'nope' } }).error, 'bad-scope');
  assert.equal(validateRequest({ op: 'run', id: 'a', goal: 'x', limits: { steps: -1 } }).error, 'bad-limits');
  assert.equal(validateRequest({ op: 'run', id: 'a', goal: 'x', limits: { nope: 1 } }).error, 'bad-limits');
  assert.equal(validateRequest({ op: 'run', id: 'a', goal: 'x', cost: { input: -1, output: 2 } }).error, 'bad-cost');
  assert.equal(validateRequest({ op: 'run', id: 'a', goal: 'x', searchProvider: 'Exa!' }).error, 'bad-search-provider');
});

test('validateRequest: goal over the cap is refused', () => {
  const long = 'a'.repeat(4001);
  assert.equal(validateRequest({ op: 'run', id: 'a', goal: long }).error, 'goal-too-long');
});

test('validateRequest: cancel and ping', () => {
  assert.deepEqual(validateRequest({ op: 'cancel', id: 'task-9' }).message, { op: 'cancel', id: 'task-9' });
  assert.deepEqual(validateRequest({ op: 'ping' }).message, { op: 'ping', ids: [] });
  assert.deepEqual(validateRequest({ op: 'ping', ids: ['a', 'a', 'b'] }).message.ids, ['a', 'b']);
  assert.equal(validateRequest({ op: 'ping', ids: ['bad id'] }).error, 'bad-ids');
  assert.equal(validateRequest({ op: 'what' }).error, 'bad-op');
  assert.equal(validateRequest('x').error, 'not-an-object');
});

test('parseRequestLine: bad JSON, oversize, and a valid id surfaced on a bad message', () => {
  assert.equal(parseRequestLine('{not json').error, 'bad-json');
  assert.equal(parseRequestLine('x'.repeat(1_000_001)).error, 'line-too-long');
  const r = parseRequestLine(JSON.stringify({ op: 'run', id: 'task-5', goal: '' }));
  assert.equal(r.ok, false);
  assert.equal(r.id, 'task-5');
});

test('progressEvent: shape, note trimmed and cut', () => {
  const e = progressEvent({ id: 'a', step: 3, tool: 'search', note: `  many   spaces  ${'x'.repeat(300)}` });
  assert.equal(e.event, 'progress');
  assert.equal(e.step, 3);
  assert.equal(e.tool, 'search');
  assert.ok(e.note.length <= 200);
  assert.equal(progressEvent({ id: 'a', step: 1 }).tool, null);
});

test('endEvent: status clamped to a known one, result and usage normalised', () => {
  const e = endEvent({ id: 'a', status: 'weird', result: { text: 'ok', sources: ['u', 'u'], files: [{ path: '/p', bytes: 3 }] }, usage: { usd: 0.1, costUnknown: 2 } });
  assert.equal(e.status, 'failed');
  assert.deepEqual(e.result.sources, ['u']);
  assert.equal(e.result.files[0].name, '');
  assert.equal(e.usage.usd, 0.1);
  assert.equal(e.usage.costUnknown, 2);
  const ok = endEvent({ id: 'a', status: 'done', result: { text: 'hi' } });
  assert.equal(ok.status, 'done');
  assert.equal(ok.error, undefined);
});

test('restarted, pong and error events', () => {
  assert.deepEqual(restartedEvent('a'), { id: 'a', event: 'end', status: 'failed', result: { text: '', sources: [], files: [] }, usage: { input: 0, output: 0, usd: 0, steps: 0, seconds: 0 }, error: 'restarted' });
  assert.deepEqual(pongEvent({ profile: 'web', busy: true, queued: 2 }), { event: 'pong', profile: 'web', busy: true, queued: 2 });
  assert.deepEqual(errorEvent('bad-op'), { event: 'error', error: 'bad-op' });
  assert.deepEqual(errorEvent('bad-goal', 'a'), { id: 'a', event: 'error', error: 'bad-goal' });
});

test('normalizeUsage and normalizeResult: non-numbers and non-objects default', () => {
  assert.deepEqual(normalizeUsage(null), { input: 0, output: 0, usd: 0, steps: 0, seconds: 0 });
  assert.deepEqual(normalizeResult('x'), { text: '', sources: [], files: [] });
});

test('encodeLine: one JSON object and a newline', () => {
  assert.equal(encodeLine({ a: 1 }), '{"a":1}\n');
});
