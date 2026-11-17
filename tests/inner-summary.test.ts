// Tests for scripts/lib/inner-summary.ts: the facts of one `replay.ts --inner` sample and the summary over the samples
// that compares two variants of the heartbeat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { innerSummary, sampleFacts } from '../scripts/lib/inner-summary.ts';
import type { SampleFacts } from '../scripts/lib/inner-summary.ts';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const at = { now: NOW, timezone: 'UTC', directOf: (place: string) => place === 'd1' };

const request = (promptTokens: number | null, blocks: Array<{ name: string; chars: number }> = []) => ({
  usage: promptTokens === null ? null : { prompt_tokens: promptTokens },
  blocks: blocks.map((block) => ({ ...block, segment: 'tail', source: 'x', reason: 'kept' })),
});
const answer = (think: string, calls: Array<{ skill: string; args: Record<string, unknown> }> = [], skip = false) => ({
  think,
  calls,
  skip,
});

test('sampleFacts: a proposed intention.set ends the sample with its place, due, recurrence and purpose length', () => {
  const facts = sampleFacts(
    {
      requests: [
        request(9000, [
          { name: 'self', chars: 1200 },
          { name: 'inner', chars: 300 },
        ]),
        request(9400),
      ],
      answers: [
        answer('look around', [{ skill: 'memory.search', args: { query: 'q' } }]),
        answer('decide', [
          {
            skill: 'intention.set',
            args: { text: 'ask how the trip went', place: '#general', due: '8h', every: 'day' },
          },
        ]),
      ],
      actions: [
        { skill: 'memory.search', status: 'executed', result: 'ok', target: {} },
        { skill: 'intention.set', status: 'proposed', result: 'ok', target: { channel: 'c1' } },
      ],
    },
    at
  );
  assert.equal(facts.promptTokens, 9000);
  assert.deepEqual(facts.blocks, [
    { name: 'self', chars: 1200 },
    { name: 'inner', chars: 300 },
  ]);
  assert.deepEqual(facts.requests, [
    { promptTokens: 9000, thinkChars: 11 },
    { promptTokens: 9400, thinkChars: 6 },
  ]);
  assert.equal(facts.thinkChars, 17);
  assert.deepEqual(facts.calls, [
    { name: 'memory.search', status: 'executed', code: null },
    { name: 'intention.set', status: 'proposed', code: null },
  ]);
  assert.deepEqual(facts.end, {
    kind: 'intention',
    change: 'set',
    place: '#general',
    direct: false,
    dueInMinutes: 480,
    recurs: true,
    purposeWords: 5,
  });
});

test('sampleFacts: a skip after a refused call is a skip, and the refusal keeps its code', () => {
  const facts = sampleFacts(
    {
      requests: [request(8000)],
      answers: [answer('nothing', [{ skill: 'message.create', args: { text: 'hi' } }], true)],
      actions: [{ skill: 'message.create', status: 'refused', result: 'error', code: 'heartbeat-only', target: {} }],
    },
    at
  );
  assert.deepEqual(facts.calls, [{ name: 'message.create', status: 'refused', code: 'heartbeat-only' }]);
  assert.deepEqual(facts.end, { kind: 'skip' });
});

test('sampleFacts: an intention in a direct chat with no due and no recurrence', () => {
  const facts = sampleFacts(
    {
      requests: [request(null)],
      answers: [answer('', [{ skill: 'intention.set', args: { text: 'write to her', place: 'd1', every: 'none' } }])],
      actions: [{ skill: 'intention.set', status: 'proposed', result: 'ok', target: { channel: 'd1' } }],
    },
    at
  );
  assert.equal(facts.promptTokens, null);
  assert.deepEqual(facts.end, {
    kind: 'intention',
    change: 'set',
    place: 'd1',
    direct: true,
    dueInMinutes: null,
    recurs: false,
    purposeWords: 3,
  });
});

test('sampleFacts: a refused intention change is no ending; neither a skip nor a change is `other`', () => {
  const facts = sampleFacts(
    {
      requests: [request(100)],
      answers: [answer('', [{ skill: 'intention.cancel', args: { id: 'i1' } }])],
      actions: [{ skill: 'intention.cancel', status: 'refused', result: 'error', code: 'not-found', target: {} }],
    },
    at
  );
  assert.deepEqual(facts.end, { kind: 'other' });
});

const sample = (end: SampleFacts['end'], extra: Partial<SampleFacts> = {}): SampleFacts => ({
  promptTokens: 1000,
  blocks: [],
  requests: [],
  thinkChars: 100,
  calls: [],
  end,
  ...extra,
});
const intention = (place: string | null, direct: boolean | null, dueInMinutes: number | null): SampleFacts['end'] => ({
  kind: 'intention',
  change: 'set',
  place,
  direct,
  dueInMinutes,
  recurs: false,
  purposeWords: 4,
});

test('innerSummary: counts and shares of skips, places, direct chats, far dues, refusals, and the sizes', () => {
  const summary = innerSummary([
    sample({ kind: 'skip' }, { thinkChars: 50, promptTokens: 900 }),
    sample(intention('#general', false, 600), {
      thinkChars: 300,
      promptTokens: 1100,
      calls: [{ name: 'message.create', status: 'refused', code: 'heartbeat-only' }],
    }),
    sample(intention('#general', false, 30), { thinkChars: 200, promptTokens: 1000 }),
    sample(intention('d1', true, null), {
      thinkChars: 100,
      promptTokens: null,
      calls: [
        { name: 'message.create', status: 'refused', code: 'heartbeat-only' },
        { name: 'errand.code', status: 'refused', code: 'cooldown' },
      ],
    }),
    sample(intention(null, null, 420), { thinkChars: 400, promptTokens: 1300 }),
  ]);
  assert.equal(summary.samples, 5);
  assert.deepEqual(summary.skips, { count: 1, share: 0.2 });
  assert.deepEqual(summary.intentions, { count: 4, share: 0.8 });
  assert.deepEqual(summary.withPlace, { count: 3, share: 0.75 });
  assert.deepEqual(summary.direct, { count: 1, share: 0.25 });
  assert.deepEqual(summary.dueOverSixHours, { count: 2, share: 0.5 });
  assert.deepEqual(summary.places, [
    { place: '#general', count: 2, share: 0.5 },
    { place: 'd1', count: 1, share: 0.25 },
  ]);
  assert.deepEqual(summary.refused, [
    { code: 'heartbeat-only', count: 2 },
    { code: 'cooldown', count: 1 },
  ]);
  assert.deepEqual(summary.thinkChars, { median: 200, max: 400 });
  assert.deepEqual(summary.promptTokens, { median: 1050, max: 1300 });
});

test('innerSummary: with no intention the shares over intentions are none', () => {
  const summary = innerSummary([sample({ kind: 'skip' }), sample({ kind: 'other' })]);
  assert.deepEqual(summary.skips, { count: 1, share: 0.5 });
  assert.deepEqual(summary.withPlace, { count: 0, share: null });
  assert.deepEqual(summary.places, []);
});
