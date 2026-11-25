// Tests for scripts/lib/replay-records.ts: a scenario turn's record read off its report, and a scenario's summary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenarioSummary, turnRecord } from '../../../scripts/lib/replay-records.ts';
import type { TurnReport } from '../../../scripts/lib/turn-report.ts';

/** The report of a turn whose steps made `calls` (one list per step) and that sent `messages`. */
function report(
  calls: Array<Array<{ name: string; status: string | null }>>,
  messages: Array<string> = []
): TurnReport {
  return {
    turnId: 't',
    sample: 1,
    steps: calls.map((list, i) => ({ step: i + 1, calls: list })),
    reply: { messages, reactions: [], skipped: messages.length === 0 },
    writes: [],
    keptCalls: [],
    totalMs: null,
    stepCount: calls.length,
    callCount: calls.flat().length,
    outcome: messages.length > 0 ? 'spoke' : 'skip',
    endedBecause: null,
    helperRequests: [],
    diary: null,
  };
}

test('a turn decided to call when any step made a call, its calls in order with their status', () => {
  const record = turnRecord(
    { scenario: 's', run: 0 },
    report([[{ name: 'memory_search', status: 'ok' }], [{ name: 'message_create', status: null }], []], ['ναι'])
  );
  assert.equal(record.decision, 'call');
  assert.deepEqual(record.calls, [
    { name: 'memory_search', status: 'ok' },
    { name: 'message_create', status: null },
  ]);
  assert.equal(turnRecord({ scenario: 's', run: 0 }, report([[]])).decision, 'no-call');
});

test("a multi-step scenario's summary gives each run's decisions as letters, one group per step", () => {
  const call = [[{ name: 'rule_add', status: 'ok' }]];
  const records = [
    turnRecord({ scenario: 's', run: 0, step: 1 }, report(call)),
    turnRecord({ scenario: 's', run: 0, step: 2, turn: 1 }, report([[]], ['ok'])),
    turnRecord({ scenario: 's', run: 0, step: 2, turn: 2 }, report(call)),
    turnRecord({ scenario: 's', run: 1, step: 1 }, report([[]])),
    turnRecord({ scenario: 's', run: 1, step: 2, turn: 1 }, report([[]])),
  ];
  const summary = scenarioSummary(records, { steps: 2 });
  assert.deepEqual(summary.patterns, ['C NC', 'N N']);
  assert.deepEqual([summary.runs, summary.turns, summary.calls, summary.noCall, summary.spoke], [2, 5, 2, 3, 1]);
  assert.deepEqual(summary.byName, { rule_add: 2 });
});

test("a multi-step scenario's summary states that the persona's earlier lines lack their trigger link, a one-turn one does not", () => {
  const records = [turnRecord({ scenario: 's', run: 0, step: 1 }, report([[]], ['ok']))];
  assert.match(String(scenarioSummary(records, { steps: 1 }).limit), /turn triggered by/);
  assert.equal('limit' in scenarioSummary(records), false);
});
