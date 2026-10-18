// Tests for tools/lib/report.mjs: the pure part of tools/journal-report.mjs and
// tools/request-report.mjs, on fixture journal records of every kind and fixture log lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { percentile, tally, limitsTable, renderDay, tallyLog, NA, LOG_OUTCOME } from '../tools/lib/report.mjs';

const envelope = (kind, fields) => ({
  v: 1,
  id: `id-${Math.random()}`,
  kind,
  occurredAt: '2026-10-13T10:00:00.000Z',
  recordedAt: '2026-10-13T10:00:00.000Z',
  guildId: 'g1',
  scope: { channel: 'c1' },
  participants: [],
  sourceMessageIds: [],
  origin: 'live',
  ...fields,
});

/** One day of every kind: three turns (two attempts of one turn), actions, memory, system. */
function fixtureDay() {
  return [
    envelope('turn.start', { turnId: 't-1', attemptId: 1, mode: 'reply', trigger: { kind: 'mention', messageId: 'm1' } }),
    envelope('action', { opId: 'op-1', turnId: 't-1', name: 'post', phase: 'started' }),
    envelope('action', { opId: 'op-1', turnId: 't-1', name: 'post', phase: 'succeeded' }),
    envelope('action', { opId: 'op-2', turnId: 't-1', name: 'recall', phase: 'started' }),
    envelope('action', { opId: 'op-2', turnId: 't-1', name: 'recall', phase: 'failed' }),
    envelope('turn', {
      turnId: 't-1',
      attemptId: 1,
      outcome: 'spoke',
      reason: null,
      think: 'Ζωή said hello',
      posted: [{ opId: 'op-1', messageId: 'p1' }, { opId: 'op-3', messageId: 'p2' }],
      usage: { prompt: 40000, cached: 10000, cacheWrite: 1200, completion: 500 },
      budget: { dropped: { recent: 8, emoji: 14 } },
      limits: [
        { kind: 'budget-drop', where: 'recent', lost: 8 },
        { kind: 'budget-drop', where: 'emoji', lost: 14 },
        { kind: 'message-cut', where: 'post', lost: 120 },
      ],
    }),
    envelope('turn.start', { turnId: 't-2', attemptId: 1, mode: 'reply', trigger: { kind: 'reply' } }),
    envelope('turn', { turnId: 't-2', attemptId: 1, outcome: 'skip', reason: 'model-skip', usage: { prompt: 30000, cached: null, completion: 20 }, budget: { dropped: { recent: 2 } }, limits: [] }),
    envelope('turn.start', { turnId: 't-2', attemptId: 2, mode: 'reply', trigger: { kind: 'reply' } }),
    envelope('turn', { turnId: 't-2', attemptId: 2, outcome: 'refused', reason: 'daily-cap', usage: null, budget: { dropped: {} }, limits: [{ kind: 'daily-cap', where: 'llm.maxRequestsPerDay', lost: null }] }),
    envelope('turn', { turnId: 't-9', attemptId: 1, outcome: 'error', reason: 'timeout', usage: { prompt: 50000, cached: 5000, completion: 0 } }),
    envelope('memory', { batchId: 'b-1', stage: 'two', batch: { messageIds: ['m1', 'm2'], consumed: 2 }, limits: [{ kind: 'over-limit', where: 'character', lost: 300 }, { kind: 'clamp', where: 'episodes', lost: null }] }),
    envelope('system', { event: 'pause', by: 'owner' }),
    envelope('system', { event: 'resume', by: 'owner' }),
    envelope('system', { event: 'pause', by: 'owner' }),
    'not a record',
    null,
  ];
}

test('report: percentile interpolates between ranks and ignores non-numbers', () => {
  assert.equal(percentile([4, 1, 3, 2], 50), 2.5);
  assert.equal(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 90), 91);
  assert.equal(percentile([7], 90), 7);
  assert.equal(percentile([1, null, 'x', 3, Number.NaN], 50), 2);
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([1, 2, 3], 0), 1);
  assert.equal(percentile([1, 2, 3], 100), 3);
});

test('report: tally counts turns by outcome and trigger, reasons, actions, usage, drops and own messages', () => {
  const t = tally(fixtureDay());
  assert.equal(t.records, 15);
  assert.deepEqual(t.turns, { spoke: { mention: 1 }, skip: { reply: 1 }, refused: { reply: 1 }, error: { '-': 1 } });
  assert.deepEqual(t.reasons, { skip: { 'model-skip': 1 }, refused: { 'daily-cap': 1 }, error: { timeout: 1 } });
  assert.deepEqual(t.actions, { post: { started: 1, succeeded: 1 }, recall: { started: 1, failed: 1 } });
  assert.deepEqual(t.prompt, [40000, 30000, 50000]);
  assert.deepEqual(t.cached, { cached: 15000, prompt: 90000, counted: 2, cacheWrite: 1200, writeCounted: 1 });
  assert.deepEqual(t.dropped, { recent: 10, emoji: 14 });
  assert.equal(t.ownMessages, 2);
  assert.equal(t.memoryBatches, 1);
  assert.deepEqual(t.system, { pause: 2, resume: 1 });
  assert.equal(t.limits.length, 6);
  assert.equal(t.fileBytes, null);
});

test('report: limitsTable sums count and lost per kind in the design order', () => {
  assert.deepEqual(limitsTable(fixtureDay()), [
    { kind: 'budget-drop', count: 2, lost: 22 },
    { kind: 'message-cut', count: 1, lost: 120 },
    { kind: 'daily-cap', count: 1, lost: null },
    { kind: 'over-limit', count: 1, lost: 300 },
    { kind: 'clamp', count: 1, lost: null },
  ]);
  // The bare entries tally collects give the same table.
  assert.deepEqual(limitsTable(tally(fixtureDay()).limits), limitsTable(fixtureDay()));
  // An unknown kind goes last; records of other kinds add nothing.
  assert.deepEqual(limitsTable([{ kind: 'zz-new', lost: 3 }, envelope('system', { event: 'x', limits: [{ kind: 'clamp', lost: 1 }] })]), [{ kind: 'zz-new', count: 1, lost: 3 }]);
});

test('report: renderDay prints every section with N/A for missing and none for empty', () => {
  const t = tally(fixtureDay());
  t.fileBytes = 4096;
  const text = renderDay('2026-10-13', t);
  assert.match(text, /^## 2026-10-13\n/);
  assert.match(text, /File bytes: 4096/);
  assert.match(text, /\| outcome \| - \| mention \| reply \| total \|/);
  assert.match(text, /\| spoke \| 0 \| 1 \| 0 \| 1 \|/);
  assert.match(text, /\| refused \| daily-cap \| 1 \|/);
  assert.ok(text.includes('| action | failed | started | succeeded | total |\n| --- | --- | --- | --- | --- |\n| post | 0 | 1 | 1 | 2 |\n| recall | 1 | 1 | 0 | 2 |'));
  assert.match(text, /\| prompt tokens median \| 40000 \|/);
  assert.match(text, /\| prompt tokens p90 \| 48000 \|/);
  assert.match(text, /\| cached share \| 16\.7% \|/);
  assert.match(text, /\| cache-write tokens \| 1200 \|/);
  assert.match(text, /\| emoji \| 14 \|/);
  assert.match(text, /\| budget-drop \| 2 \| 22 \|/);
  assert.match(text, /\| daily-cap \| 1 \| N\/A \|/);
  assert.match(text, /Own messages: 2/);
  assert.match(text, /\| pause \| 2 \|/);

  const empty = renderDay('2026-10-14', tally([]));
  assert.match(empty, /File bytes: N\/A/);
  assert.match(empty, /### Turns by outcome and trigger\n\nnone/);
  assert.match(empty, /### Limits\n\nnone/);
  assert.match(empty, /\| prompt tokens median \| N\/A \|/);
  assert.match(empty, /\| cached share \| N\/A \|/);
  assert.match(empty, /\| cache-write tokens \| N\/A \|/);
});

test('report: tallyLog reads model-answered lines per day and leaves what the log lacks N/A', () => {
  const line = (time, fields) => JSON.stringify({ level: 'info', time, msg: 'turn: model answered', ...fields });
  const lines = [
    line('2026-10-12T09:00:00.000Z', { trigger: 'mention', usage: { prompt_tokens: 40000, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 20000, cache_write_tokens: 3000 } }, budget: { recent: { used: 10, kept: 3, dropped: 4 }, used: 100, limit: 50000 } }),
    `Oct 12 10:00:00 host node[1]: ${line('2026-10-12T10:00:00.000Z', { trigger: 'reply', usage: { prompt_tokens: 44000, completion_tokens: 200 }, budget: { recent: { dropped: 1 }, emoji: { dropped: 6 } } })}`,
    line('2026-10-13T00:00:01.000Z', { trigger: null, usage: {} }),
    JSON.stringify({ level: 'info', time: '2026-10-12T11:00:00.000Z', msg: 'turn: skipped' }),
    'garbage {not json',
    '',
  ];
  const days = tallyLog(lines);
  assert.deepEqual([...days.keys()], ['2026-10-12', '2026-10-13']);
  const d12 = days.get('2026-10-12');
  assert.deepEqual(d12.turns, { [LOG_OUTCOME]: { mention: 1, reply: 1 } });
  assert.deepEqual(d12.prompt, [40000, 44000]);
  assert.deepEqual(d12.cached, { cached: 20000, prompt: 40000, counted: 1, cacheWrite: 3000, writeCounted: 1 });
  assert.deepEqual(d12.dropped, { recent: 5, emoji: 6 });
  for (const key of ['reasons', 'actions', 'limits', 'ownMessages', 'memoryBatches', 'system', 'fileBytes']) assert.equal(d12[key], null, key);
  const text = renderDay('2026-10-12', d12);
  assert.match(text, /### Skip and refusal reasons\n\nN\/A/);
  assert.match(text, /### Limits\n\nN\/A/);
  assert.match(text, /Own messages: N\/A/);
  assert.match(text, /\| cached share \| 50\.0% \|/);
  assert.equal(days.get('2026-10-13').prompt.length, 0);
  assert.deepEqual(days.get('2026-10-13').turns, { [LOG_OUTCOME]: { '-': 1 } });
  assert.equal(NA, 'N/A');
});
