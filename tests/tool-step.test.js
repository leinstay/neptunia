// Tests for src/behavior/tool-step.js: the pure parts of a step of a turn that calls tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../src/ops/index.js';
import { buildSkills } from '../src/skills/registry.js';
import { SKILL_DEFINITIONS } from '../src/skills/definitions.js';
import {
  appendStep,
  cutToFit,
  deltaLines,
  roomLeft,
  segments,
  stepNote,
  stepVerdict,
  thinkMissing,
} from '../src/behavior/tool-step.js';
import { labels } from './fixtures/labels.js';

const registry = buildSkills({ table: SKILL_DEFINITIONS });
const definitionOf = (name) => registry.get(name);
const isRead = (call) => registry.get(call.name).effects === 'read';

test('segments: consecutive reads are one parallel segment, every other call is a barrier of its own, in her order', () => {
  const calls = [
    'web.search',
    'memory.search',
    'message.create',
    'web.read',
    'draw.create',
    'draw.create',
    'task.status',
    'web.search',
  ].map((name, i) => ({ name, id: `c${i}` }));
  const out = segments(calls, isRead);
  assert.deepEqual(
    out.map((s) => [s.parallel, s.calls.map((c) => c.id)]),
    [
      [true, ['c0', 'c1']],
      [false, ['c2']],
      [true, ['c3']],
      [false, ['c4']],
      [false, ['c5']],
      [true, ['c6', 'c7']],
    ]
  );
  assert.deepEqual(segments([], isRead), []);
  assert.deepEqual(
    out.flatMap((s) => s.calls).map((c) => c.id),
    calls.map((c) => c.id)
  );
});

const outcome = (name, status = 'ok') => ({ name, result: { status } });

test('stepVerdict: all-quiet completion, every call an ok effect, speech goes out and nothing is fresh', () => {
  assert.deepEqual(stepVerdict([outcome('draw.create'), outcome('message.react.add')], { definitionOf }), {
    speak: true,
    fresh: false,
  });
  assert.deepEqual(stepVerdict([], { definitionOf }), { speak: true, fresh: false });
});

test('stepVerdict: an accepted job covers speech and needs no further request', () => {
  assert.deepEqual(stepVerdict([outcome('task.run')], { definitionOf }), { speak: true, fresh: false });
});

test('stepVerdict: a data result or a failure holds the speech and the next request follows', () => {
  assert.deepEqual(stepVerdict([outcome('web.search')], { definitionOf }), { speak: false, fresh: true });
  assert.deepEqual(stepVerdict([outcome('draw.create', 'failed')], { definitionOf }), { speak: false, fresh: true });
  assert.deepEqual(stepVerdict([outcome('message.create'), outcome('draw.create', 'denied')], { definitionOf }), {
    speak: false,
    fresh: true,
  });
  assert.deepEqual(stepVerdict([outcome('nope.none')], { definitionOf }), { speak: false, fresh: true });
  assert.deepEqual(stepVerdict([outcome('message.create', 'unknown')], { definitionOf }), {
    speak: false,
    fresh: true,
  });
});

test('stepVerdict: an inner turn with an open follow-up is fresh even when every call covered speech', () => {
  assert.deepEqual(stepVerdict([outcome('task.run')], { definitionOf, openFollowUp: true }), {
    speak: true,
    fresh: true,
  });
});

test('roomLeft: the last continuation request is always reserved as the final one', () => {
  const room = (step, extra = {}) => roomLeft({ step, maxSteps: 3, elapsedMs: 0, timeBudgetMs: 1000, ...extra });
  assert.deepEqual(room(0), { run: true, capReason: null, next: 'normal', tokensOver: false });
  assert.deepEqual(room(1), { run: true, capReason: null, next: 'normal', tokensOver: false });
  // Step 2 is the last answer that may call; the request after it is the final one.
  assert.deepEqual(room(2), { run: true, capReason: null, next: 'final', tokensOver: false });
  // The final answer's calls get loop-cap results, nothing follows.
  assert.deepEqual(room(3), { run: false, capReason: 'steps', next: 'none', tokensOver: false });
  assert.equal(roomLeft({ step: 0, maxSteps: 1, timeBudgetMs: 10 }).next, 'final');
});

test('roomLeft: a spent time budget stops the calls and makes the next request final; a spent token room only the latter', () => {
  assert.deepEqual(roomLeft({ step: 0, maxSteps: 4, elapsedMs: 1000, timeBudgetMs: 1000 }), {
    run: false,
    capReason: 'time',
    next: 'final',
    tokensOver: false,
  });
  assert.deepEqual(roomLeft({ step: 1, maxSteps: 4, elapsedMs: 999, timeBudgetMs: 1000 }), {
    run: true,
    capReason: null,
    next: 'normal',
    tokensOver: false,
  });
  const over = roomLeft({ step: 0, maxSteps: 4, tokens: { used: 49_000, max: 50_000, reserve: 2_000 } });
  assert.deepEqual(over, { run: true, capReason: null, next: 'final', tokensOver: true });
  assert.equal(
    roomLeft({ step: 0, maxSteps: 4, tokens: { used: 47_999, max: 50_000, reserve: 2_000 } }).tokensOver,
    false
  );
});

test('cutToFit: the longest texts are cut first, none below the floor', () => {
  const [a, b] = cutToFit(['a'.repeat(1000), 'b'.repeat(500)], 300, 400);
  assert.ok(Array.from(a).length < 1000 && Array.from(a).length >= 400);
  assert.equal(b, 'b'.repeat(500));
  const [c, d] = cutToFit(['a'.repeat(1000), 'b'.repeat(1000)], 5000, 400);
  assert.ok(Array.from(c).length <= 401 && Array.from(d).length <= 401);
  assert.deepEqual(cutToFit(['short'], 100, 400), ['short']);
  assert.deepEqual(cutToFit(['x'.repeat(900)], 0), ['x'.repeat(900)]);
});

test('deltaLines: new lines are numbered past the floor, the search handles and an earlier delta, her own lines skipped', () => {
  const lines = [{ id: 'm1' }, { id: 'mine' }, { id: 'm2' }, { id: 'mine2' }, { id: 'm3' }];
  const out = deltaLines({ lines, floor: 40, taken: 0, ownIds: ['mine', 'mine2'] });
  assert.equal(out.offset, 40);
  assert.deepEqual(
    out.lines.map((l) => l.id),
    ['m1', 'm2', 'm3']
  );
  assert.deepEqual(
    [...out.idByIndex],
    [
      [41, 'm1'],
      [42, 'm2'],
      [43, 'm3'],
    ]
  );
  assert.equal(out.next, 44);
  // A memory.search of the turn took handles up to 61: the delta starts after them.
  const gap = deltaLines({ lines: [{ id: 'n1' }], floor: 40, taken: 61 });
  assert.deepEqual([...gap.idByIndex], [[62, 'n1']]);
  assert.equal(gap.next, 63);
  // A second delta continues after the first one.
  const again = deltaLines({ lines: [{ id: 'z' }], floor: 40, taken: out.next - 1, ownIds: new Set() });
  assert.deepEqual([...again.idByIndex], [[44, 'z']]);
  assert.deepEqual(deltaLines({ lines: [], floor: 7 }), { lines: [], offset: 7, idByIndex: new Map(), next: 8 });
});

test('thinkMissing: the trimmed answer must start with <think>', () => {
  assert.equal(thinkMissing('<think>x</think><msg>a</msg>'), false);
  assert.equal(thinkMissing('  \n<think>x'), false);
  assert.equal(thinkMissing('<msg>a</msg>'), true);
  assert.equal(thinkMissing(''), true);
  assert.equal(thinkMissing(undefined), true);
  assert.equal(thinkMissing('text <think>x</think>'), true);
});

test('stepNote: held, delta, deliveries, last, open, diagnostics in that order; empty when there is nothing', () => {
  assert.equal(stepNote({ labels }), '');
  const note = stepNote({
    labels,
    held: true,
    deltaText: '#41 a: hi',
    deliveries: [{ n: 1, total: 2, code: 'send-failed' }],
    last: true,
    open: 'OPEN',
    diagnostics: ['D1', 'D2'],
  });
  const at = (text) => note.indexOf(text);
  const order = [
    labels.task.step.held,
    labels.task.step.delta,
    '#41 a: hi',
    '1 of 2 sent (send-failed)',
    labels.task.step.last,
    'OPEN',
    labels.task.diagnostics,
    'D1',
    'D2',
  ].map(at);
  assert.ok(
    order.every((n) => n >= 0),
    note
  );
  assert.deepEqual(
    [...order].sort((x, y) => x - y),
    order
  );
  assert.equal(stepNote({ labels, last: true }), labels.task.step.last);
  assert.equal(stepNote({ labels, deltaText: 'L' }), `${labels.task.step.delta}\nL`);
});

const calls = [
  { id: 's1c1', name: 'draw.create', apiName: 'draw_create', args: { text: 'a cat' } },
  { id: 's1c2', name: 'nope.none', apiName: 'nope_none', args: {} },
];
const results = [
  { text: 'RESULT ONE', status: 'failed' },
  { text: 'RESULT TWO', status: 'invalid' },
];
const first = [
  { role: 'system', content: 'S' },
  { role: 'user', content: 'U' },
];

test('appendStep native: her assistant message with tool_calls, one tool message per call (refused ones too), then the note', () => {
  const out = appendStep({
    transport: 'native',
    messages: first,
    rawText: '<think>t</think>',
    calls,
    results,
    note: 'NOTE',
  });
  assert.equal(out.length, 6);
  assert.deepEqual(out.slice(0, 2), first);
  assert.deepEqual(out[2], {
    role: 'assistant',
    content: '<think>t</think>',
    tool_calls: [
      { id: 's1c1', type: 'function', function: { name: 'draw_create', arguments: '{"text":"a cat"}' } },
      { id: 's1c2', type: 'function', function: { name: 'nope_none', arguments: '{}' } },
    ],
  });
  assert.deepEqual(out[3], { role: 'tool', tool_call_id: 's1c1', content: 'RESULT ONE' });
  assert.deepEqual(out[4], { role: 'tool', tool_call_id: 's1c2', content: 'RESULT TWO' });
  assert.deepEqual(out[5], { role: 'user', content: [{ type: 'text', text: 'NOTE' }] });
  assert.equal(first.length, 2);
});

test('appendStep native: no text gives null content, no note adds no user message, the API name is derived when missing', () => {
  const out = appendStep({
    transport: 'native',
    messages: first,
    calls: [{ id: 'a', name: 'draw.create', args: {} }],
    results: [{ text: 'r' }],
  });
  assert.equal(out.length, 4);
  assert.equal(out[2].content, null);
  assert.equal(out[2].tool_calls[0].function.name, 'draw_create');
  assert.equal(out.at(-1).role, 'tool');
});

test('appendStep text: her raw text verbatim, then one user message of tool_result blocks and the note', () => {
  const raw = '<think>t</think>\n<tool_call>{"name": "draw.create"}</tool_call>';
  const out = appendStep({ transport: 'text', messages: first, rawText: raw, calls, results, note: 'NOTE' });
  assert.equal(out.length, 4);
  assert.deepEqual(out[2], { role: 'assistant', content: raw });
  assert.equal(out[3].role, 'user');
  assert.deepEqual(
    out[3].content.map((p) => p.type),
    ['text', 'text', 'text']
  );
  assert.equal(
    out[3].content[0].text,
    '<tool_result id="s1c1" name="draw.create" status="failed">\nRESULT ONE\n</tool_result>'
  );
  assert.equal(
    out[3].content[1].text,
    '<tool_result id="s1c2" name="nope.none" status="invalid">\nRESULT TWO\n</tool_result>'
  );
  assert.equal(out[3].content[2].text, 'NOTE');
  assert.equal(
    appendStep({ transport: 'text', messages: first, rawText: raw, calls, results }).at(-1).content.length,
    2
  );
});

test('appendStep: every request is the previous one plus what is appended, the first messages untouched', () => {
  for (const transport of ['native', 'text']) {
    const one = appendStep({
      transport,
      messages: first,
      rawText: 'a',
      calls: [calls[0]],
      results: [results[0]],
      note: 'n',
    });
    const two = appendStep({ transport, messages: one, rawText: 'b', calls: [calls[1]], results: [results[1]] });
    assert.deepEqual(two.slice(0, one.length), one, transport);
    assert.equal(two[0], first[0]);
    assert.equal(two[1], first[1]);
    assert.ok(two.length > one.length);
  }
});

test('stepNote: the late-media lines come under their own lead, right after the delta', () => {
  const note = stepNote({ labels, deltaText: 'D', lateText: '#3 clip' });
  assert.equal(note, `${labels.task.step.delta}\nD\n\n${labels.task.step.late}\n#3 clip`);
  assert.equal(stepNote({ labels, lateText: '#3 clip' }), `${labels.task.step.late}\n#3 clip`);
});
