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
// How the turn runner said the turn ended: its outcome, its reason and the loop's cut.
const SPOKE = { outcome: 'spoke', reason: null, cut: null };
const SKIPPED = { outcome: 'skip', reason: 'nothing-to-do', cut: null };
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
      turn: SPOKE,
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
  // Changed: a heartbeat takes several intention changes, so the ending lists each change under `changes`.
  assert.deepEqual(facts.end, {
    kind: 'intention',
    changes: [{ change: 'set', place: '#general', direct: false, dueInMinutes: 480, recurs: true, purposeWords: 5 }],
  });
});

test('sampleFacts: a skip after a refused call is a skip, and the refusal keeps its code', () => {
  const facts = sampleFacts(
    {
      requests: [request(8000)],
      answers: [answer('nothing', [{ skill: 'message.create', args: { text: 'hi' } }], true)],
      actions: [{ skill: 'message.create', status: 'refused', result: 'error', code: 'heartbeat-only', target: {} }],
      turn: SKIPPED,
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
      turn: SPOKE,
    },
    at
  );
  assert.equal(facts.promptTokens, null);
  // Changed: a heartbeat takes several intention changes, so the ending lists each change under `changes`.
  assert.deepEqual(facts.end, {
    kind: 'intention',
    changes: [{ change: 'set', place: 'd1', direct: true, dueInMinutes: null, recurs: false, purposeWords: 3 }],
  });
});

test('sampleFacts: an intention saved by confirming a notice takes the place and purpose of the call the notice held', () => {
  // Bug: the confirming call carries the notice's id alone, so the ending read no place, no due time and no purpose.
  const facts = sampleFacts(
    {
      requests: [request(null)],
      answers: [
        answer('', [{ skill: 'intention.set', args: { text: 'ask how it went', place: 'd1', due: '30m' } }]),
        answer('', [{ skill: 'intention.set', args: { confirm: 'notice-1' } }]),
      ],
      actions: [
        { skill: 'intention.set', status: 'refused', code: 'intention-notice' },
        { skill: 'intention.set', status: 'proposed', result: 'ok' },
      ],
      turn: SPOKE,
    },
    at
  );
  // Changed: a heartbeat takes several intention changes, so the ending lists each change under `changes`.
  assert.deepEqual(facts.end, {
    kind: 'intention',
    changes: [{ change: 'set', place: 'd1', direct: true, dueInMinutes: 30, recurs: false, purposeWords: 4 }],
  });
});

// Bug caught: a sample with two intention changes reports only its last, or pairs a change with another call's
// arguments, so the comparison of variants miscounts the places and the dues.
test('sampleFacts: every intention change of a sample is listed in its order, and a refused one is left out', () => {
  const facts = sampleFacts(
    {
      requests: [request(100), request(200)],
      answers: [
        answer('', [
          { skill: 'intention.set', args: { text: 'share the find', place: '#general', due: '1h' } },
          { skill: 'intention.cancel', args: { id: 'missing' } },
          { skill: 'intention.set', args: { text: 'answer her question', place: 'd1', due: '10m' } },
        ]),
        answer('', [], true),
      ],
      actions: [
        { skill: 'intention.set', status: 'executed', result: 'ok', target: { channel: 'c1' } },
        { skill: 'intention.cancel', status: 'refused', code: 'not-found' },
        { skill: 'intention.set', status: 'executed', result: 'ok', target: { channel: 'd1' } },
      ],
      turn: SPOKE,
    },
    at
  );
  assert.deepEqual(facts.end, {
    kind: 'intention',
    changes: [
      { change: 'set', place: '#general', direct: false, dueInMinutes: 60, recurs: false, purposeWords: 3 },
      { change: 'set', place: 'd1', direct: true, dueInMinutes: 10, recurs: false, purposeWords: 3 },
    ],
  });
});

test('sampleFacts: a refused intention change is no ending; neither a skip nor a change is unresolved', () => {
  const facts = sampleFacts(
    {
      requests: [request(100)],
      answers: [answer('', [{ skill: 'intention.cancel', args: { id: 'i1' } }])],
      actions: [{ skill: 'intention.cancel', status: 'refused', result: 'error', code: 'not-found', target: {} }],
      turn: SPOKE,
    },
    at
  );
  // The ending `other` is gone: a turn that neither decided nor skipped is unresolved with the code that says so.
  assert.deepEqual(facts.end, { kind: 'unresolved', code: 'no-decision' });
});

test('sampleFacts: an errand only proposed in shadow ends unresolved, not a skip, though her last answer skipped', () => {
  const facts = sampleFacts(
    {
      requests: [request(100)],
      answers: [answer('', [{ skill: 'errand.scout', args: { goal: 'look' } }], true)],
      actions: [{ skill: 'errand.scout', status: 'proposed', result: 'ok', code: 'shadow', target: {} }],
      turn: SPOKE,
    },
    at
  );
  assert.deepEqual(facts.end, { kind: 'unresolved', code: 'errand-proposed' });
  assert.deepEqual(facts.errands, [{ agent: 'scout', answered: false }]);
});

test('sampleFacts: an errand whose wait found no answer ends unresolved even when she set an intention after it', () => {
  const facts = sampleFacts(
    {
      requests: [request(100), request(200)],
      answers: [
        answer('', [{ skill: 'errand.code', args: { goal: 'build' } }]),
        answer('', [{ skill: 'intention.set', args: { text: 'later' } }]),
      ],
      actions: [
        { skill: 'errand.code', status: 'executed', result: 'failed', code: 'errand-wait-ended', target: {} },
        { skill: 'intention.set', status: 'proposed', result: 'ok', target: {} },
      ],
      turn: SPOKE,
    },
    at
  );
  assert.deepEqual(facts.end, { kind: 'unresolved', code: 'errand-unanswered' });
  assert.deepEqual(facts.errands, [{ agent: 'code', answered: false }]);
});

test('sampleFacts: an answered errand and then her own skip ends skip', () => {
  const facts = sampleFacts(
    {
      requests: [request(100), request(200)],
      answers: [answer('', [{ skill: 'errand.server', args: { goal: 'check' } }]), answer('', [], true)],
      actions: [{ skill: 'errand.server', status: 'executed', result: 'ok', code: 'ok', target: {} }],
      turn: SPOKE,
    },
    at
  );
  assert.deepEqual(facts.end, { kind: 'skip' });
  assert.deepEqual(facts.errands, [{ agent: 'server', answered: true }]);
});

test('sampleFacts: a turn the step cap cut or an error ended is unresolved with its code', () => {
  const of = (turn: { outcome: string | null; reason: string | null; cut: string | null }) =>
    sampleFacts({ requests: [request(100)], answers: [answer('', [], true)], actions: [], turn }, at).end;
  assert.deepEqual(of({ outcome: 'skip', reason: 'nothing-to-do', cut: 'steps' }), {
    kind: 'unresolved',
    code: 'step-cap',
  });
  assert.deepEqual(of({ outcome: 'spoke', reason: null, cut: 'time' }), { kind: 'unresolved', code: 'time-budget' });
  assert.deepEqual(of({ outcome: 'error', reason: 'cut-off', cut: null }), { kind: 'unresolved', code: 'error' });
});

const sample = (end: SampleFacts['end'], extra: Partial<SampleFacts> = {}): SampleFacts => ({
  promptTokens: 1000,
  blocks: [],
  requests: [],
  thinkChars: 100,
  calls: [],
  errands: [],
  end,
  ...extra,
});
const intention = (place: string | null, direct: boolean | null, dueInMinutes: number | null): SampleFacts['end'] => ({
  kind: 'intention',
  changes: [{ change: 'set', place, direct, dueInMinutes, recurs: false, purposeWords: 4 }],
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
  const summary = innerSummary([sample({ kind: 'skip' }), sample({ kind: 'unresolved', code: 'error' })]);
  // `other` is gone, and the share of skips is taken over the resolved samples alone.
  assert.deepEqual(summary.skips, { count: 1, share: 1 });
  assert.deepEqual(summary.withPlace, { count: 0, share: null });
  assert.deepEqual(summary.places, []);
});

test('innerSummary: counts the three endings, unresolved of the samples, skips and intentions of the resolved', () => {
  const summary = innerSummary([
    sample({ kind: 'skip' }),
    sample(intention('#general', false, 30)),
    sample(intention('d1', true, null)),
    sample(intention(null, null, null)),
    sample({ kind: 'unresolved', code: 'errand-proposed' }),
    sample({ kind: 'unresolved', code: 'errand-proposed' }),
    sample({ kind: 'unresolved', code: 'step-cap' }),
    sample({ kind: 'unresolved', code: 'error' }),
  ]);
  assert.equal(summary.samples, 8);
  assert.deepEqual(summary.unresolved, { count: 4, share: 0.5 });
  assert.deepEqual(summary.skips, { count: 1, share: 0.25 });
  assert.deepEqual(summary.intentions, { count: 3, share: 0.75 });
  assert.deepEqual(summary.unresolvedCodes, [
    { code: 'errand-proposed', count: 2 },
    { code: 'step-cap', count: 1 },
    { code: 'error', count: 1 },
  ]);
  assert.deepEqual(summary.withPlace, { count: 2, share: 0.667 });
});

// Bug caught: a sample with two intention changes counts once in the shares over intentions, so the second wish of a
// heartbeat is missing from the places and the dues.
test('innerSummary: the shares over intentions count every change of a sample', () => {
  const two: SampleFacts['end'] = {
    kind: 'intention',
    changes: [
      { change: 'set', place: '#general', direct: false, dueInMinutes: 30, recurs: false, purposeWords: 4 },
      { change: 'set', place: 'd1', direct: true, dueInMinutes: 600, recurs: false, purposeWords: 4 },
    ],
  };
  const summary = innerSummary([sample(two), sample({ kind: 'skip' })]);
  assert.deepEqual(summary.intentions, { count: 1, share: 0.5 });
  assert.deepEqual(summary.withPlace, { count: 2, share: 1 });
  assert.deepEqual(summary.direct, { count: 1, share: 0.5 });
  assert.deepEqual(summary.dueOverSixHours, { count: 1, share: 0.5 });
});
