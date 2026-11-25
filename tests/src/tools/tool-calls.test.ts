// Tests for src/tools/tool-calls.ts: the calls of an answer as records, the narrow coercion of
// argument types, the words of a call's result, and when a finished call covers speech.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../../src/tools/operations/index.ts';
import { buildSkills } from '../../../src/tools/registry.ts';
import { SKILL_DEFINITIONS } from '../../../src/tools/definitions.ts';
import { schemaError } from '../../../src/tools/schema.ts';
import { toolCallsOf } from '../../../src/llm/openrouter.ts';
import { coerceArgs, coversSpeech, normalizeCalls, toolResultText } from '../../../src/tools/tool-calls.ts';
import { labels as fixtureLabels, labels } from '../../fixtures/labels.ts';
import { fill } from '../../../src/format.ts';
import { appendStep } from '../../../src/behavior/tool-step.ts';
import { untaggedNote } from '../../../src/behavior/turn.ts';
import '../../../src/tools/operations/index.ts';

const registry = buildSkills({ table: SKILL_DEFINITIONS });

type CallInput = { id: string | null; name: string; arguments: unknown };

const native = (calls: Array<CallInput>) =>
  toolCallsOf(calls.map((c) => ({ id: c.id, function: { name: c.name, arguments: c.arguments } })));

const normal = (calls: Array<CallInput>, extra: Record<string, unknown> = {}) =>
  normalizeCalls({ calls: native(calls), registry, step: 1, ...extra });

test('normalizeCalls: a valid native call becomes a record with the dotted name and parsed arguments', () => {
  const [call] = normal([{ id: 'c1', name: 'draw_create', arguments: '{"text":"a cat","self":true}' }]);
  assert.deepEqual(call, {
    id: 'c1',
    index: 0,
    name: 'draw.create',
    apiName: 'draw_create',
    raw: '{"text":"a cat","self":true}',
    args: { text: 'a cat', self: true },
    problem: null,
  });
});

test('normalizeCalls: malformed arguments give malformed-call, with the raw text kept', () => {
  const [call] = normal([{ id: 'c1', name: 'draw_create', arguments: '{"text": ' }]);
  assert.equal(call.problem, 'malformed-call');
  assert.equal(call.name, 'draw.create');
  assert.equal(call.raw, '{"text": ');
  assert.deepEqual(call.args, {});
  assert.equal(normal([{ id: 'c1', name: 'draw_create', arguments: '[1]' }])[0].problem, 'malformed-call');
});

test('normalizeCalls: a finish reason of length makes every call truncated-call', () => {
  const calls = normal(
    [
      { id: 'a', name: 'draw_create', arguments: '{"text":"x"}' },
      { id: 'b', name: 'nope', arguments: '{' },
    ],
    { finishReason: 'length' }
  );
  assert.deepEqual(
    calls.map((c) => c.problem),
    ['truncated-call', 'truncated-call']
  );
  assert.equal(
    normal([{ id: 'a', name: 'draw_create', arguments: '{"text":"x"}' }], { finishReason: 'stop' })[0].problem,
    null
  );
});

test('normalizeCalls: an unknown name is unknown-skill and nothing is repaired', () => {
  const [a] = normal([{ id: 'a', name: 'draw_creat', arguments: '{}' }]);
  assert.equal(a.problem, 'unknown-skill');
  assert.equal(a.name, 'draw_creat');
  // A call carries API names: the dotted one is not a tool of the persona's.
  assert.equal(normal([{ id: 'a', name: 'draw.create', arguments: '{}' }])[0].problem, 'unknown-skill');
});

test('normalizeCalls: a repeated id gets ~2, ~3; a missing one s<step>c<n>', () => {
  const calls = normal(
    [
      { id: 'x', name: 'draw_create', arguments: '{}' },
      { id: 'x', name: 'draw_create', arguments: '{}' },
      { id: 'x', name: 'draw_create', arguments: '{}' },
      { id: null, name: 'draw_create', arguments: '{}' },
      { id: '', name: 'draw_create', arguments: '' },
    ],
    { step: 3 }
  );
  assert.deepEqual(
    calls.map((c) => c.id),
    ['x', 'x~2', 'x~3', 's3c4', 's3c5']
  );
  assert.deepEqual(
    calls.map((c) => c.index),
    [0, 1, 2, 3, 4]
  );
  assert.equal(new Set(calls.map((c) => c.id)).size, 5);
  assert.deepEqual(calls[4].args, {});
});

const schema = registry.get('draw.create')?.argsSchema;

test('coerceArgs: "true" and "5" are read as a boolean and an integer, and each one is reported', () => {
  const given = { text: 'a', self: 'true' };
  const out = coerceArgs(given, schema);
  assert.deepEqual(out.args, { text: 'a', self: true });
  assert.deepEqual(out.coerced, [{ arg: 'self', to: true }]);
  assert.deepEqual(given, { text: 'a', self: 'true' });
  assert.deepEqual(coerceArgs({ self: ' FALSE ' }, schema).args, { self: false });
  const intSchema = registry.get('intention.set')?.argsSchema;
  const number = coerceArgs({ settle: '5', perday: ' 12 ' }, intSchema);
  assert.deepEqual(number.args, { settle: 5, perday: 12 });
  assert.deepEqual(number.coerced, [
    { arg: 'settle', to: 5 },
    { arg: 'perday', to: 12 },
  ]);
});

test('coerceArgs: "yes", "1", null, a number for a boolean and a decimal for an integer are left for the schema to refuse', () => {
  for (const value of ['yes', '1', 'maybe', null, 1, 0, '']) {
    const out = coerceArgs({ text: 't', people: [], self: value }, schema);
    assert.deepEqual(out.args, { text: 't', people: [], self: value }, String(value));
    assert.deepEqual(out.coerced, []);
    assert.equal(schemaError(out.args, schema), 'args.self:type', String(value));
  }
  const intSchema = registry.get('intention.set')?.argsSchema;
  assert.deepEqual(coerceArgs({ settle: '5.5', perday: 'five' }, intSchema).coerced, []);
});

test('coerceArgs: top level only, unknown keys and strings for string arguments are untouched', () => {
  const out = coerceArgs({ text: 'true', people: [], extra: 'true', nested: { self: 'true' } }, schema);
  assert.deepEqual(out.args, { text: 'true', people: [], extra: 'true', nested: { self: 'true' } });
  assert.deepEqual(out.coerced, []);
  assert.equal(schemaError(out.args, schema), 'args.extra:unknown');
});

test('schema refusals the engine relies on: an unknown key and an enum violation', () => {
  // The schema is `errand.list`'s.
  const errands = registry.get('errand.list')?.argsSchema;
  assert.equal(schemaError({ state: 'done', other: 1 }, errands), 'args.other:unknown');
  assert.equal(schemaError({ state: 'sometimes' }, errands), 'args.state:enum');
  assert.equal(schemaError({ state: 'done' }, errands), null);
});

test('toolResultText: the status words, the reason from the code, the data cut to maxChars', () => {
  const resultLabels = labels.tools.result;
  const ok = toolResultText({ status: 'ok', data: { text: 'result data' } }, labels);
  assert.equal(ok, `${resultLabels.ok}\nresult data`);
  const refused = toolResultText({ status: 'denied', code: 'not-allowed' }, labels);
  assert.ok(refused.includes(resultLabels.reasons['not-allowed']), refused);
  // A cut result ends with the line that says it was cut (labels.task.step.cut), after the ellipsis of the cut data.
  const { cut } = labels.task.step;
  assert.ok(
    toolResultText({ status: 'ok', data: { text: 'x'.repeat(100) } }, labels, { maxChars: 20 }).endsWith(`…\n${cut}`)
  );
  assert.equal(toolResultText(null, labels), '');
  // Unknown status reads as failed; a code with no wording falls to the other-reason words.
  assert.ok(toolResultText({ status: 'weird', code: 'no-such-code' }, labels).includes(resultLabels.reasons.other));
});

test('toolResultText: a catalogue answer is rendered by the caller, else as JSON; a data-less ok gives the code', () => {
  const rows = [{ name: 'a' }];
  assert.ok(toolResultText({ status: 'ok', data: { rows } }, labels, { rowsText: () => 'ROWS' }).endsWith('ROWS'));
  assert.ok(toolResultText({ status: 'ok', data: { rows } }, labels).endsWith(JSON.stringify(rows)));
});

test('toolResultText: a coerced value is told in the result text, before the outcome', () => {
  const text = toolResultText({ status: 'ok', data: { text: '' } }, labels, {
    coerced: [
      { arg: 'self', to: true },
      { arg: 'settle', to: 5 },
    ],
  });
  const lines = text.split('\n');
  const resultLabels = labels.tools.result;
  assert.equal(lines[0], resultLabels.coerced.replace('{arg}', 'self').replace('{value}', 'true'));
  assert.equal(lines[1], resultLabels.coerced.replace('{arg}', 'settle').replace('{value}', '5'));
  assert.equal(lines[2], resultLabels.ok);
});

test('coversSpeech: an ok effect or job covers speech, data and any other status do not', () => {
  assert.equal(coversSpeech({ result: 'effect' }, { status: 'ok' }), true);
  assert.equal(coversSpeech({ result: 'job' }, { status: 'ok' }), true);
  assert.equal(coversSpeech({ result: 'data' }, { status: 'ok' }), false);
  assert.equal(coversSpeech({ result: 'effect' }, { status: 'failed' }), false);
  assert.equal(coversSpeech({ result: 'effect' }, { status: 'unknown' }), false);
  assert.equal(coversSpeech(null, { status: 'ok' }), false);
  assert.equal(coversSpeech(registry.get('errand.scout'), { status: 'ok' }), true);
  assert.equal(coversSpeech(registry.get('web.search'), { status: 'ok' }), false);
});

test('toolResultText: reasonOf words a call that did not work in detail; a result that went well keeps its lead', () => {
  const labels = {
    tools: {
      result: {
        ok: 'worked',
        failed: 'failed: {reason}',
        refused: 'refused: {reason}',
        reasons: { 'invalid-args': 'not written the way the skill takes it', other: 'something went wrong' },
      },
    },
  };
  const refused = { status: 'invalid', code: 'invalid-args', reason: 'args.x:unknown' };
  assert.equal(toolResultText(refused, labels), 'refused: not written the way the skill takes it');
  assert.equal(
    toolResultText(refused, labels, { reasonOf: () => 'the skill takes no x' }),
    'refused: the skill takes no x'
  );
  assert.equal(
    toolResultText(refused, labels, { reasonOf: () => '' }),
    'refused: not written the way the skill takes it',
    'an empty detail falls back to the code'
  );
  assert.equal(
    toolResultText({ status: 'ok', data: { text: 'rows' } }, labels, { reasonOf: () => 'never used' }),
    'worked\nrows'
  );
});

// A result's machine `reason` may have words of its own under `labels.tools.result.reasons`; they win over the words of
// the code. Made-up texts: the tests check which entry is read, never what it says.
const reasonLabels = {
  tools: {
    result: {
      ok: 'worked',
      refused: 'refused: {reason}',
      reasons: {
        'not-allowed': 'CODE WORDS',
        'publication-boundary': 'REASON WORDS',
        'message-deleted': 'DELETED WORDS',
        'unknown-message': 'UNKNOWN WORDS',
        other: 'OTHER WORDS',
      },
    },
  },
};

test('toolResultText: a reason with words of its own is read instead of the words of the code', () => {
  const denied = { status: 'denied', code: 'not-allowed', reason: 'publication-boundary' };
  assert.equal(toolResultText(denied, reasonLabels), 'refused: REASON WORDS');
});

test('toolResultText: a reason without words leaves the words of the code', () => {
  const { result } = reasonLabels.tools;
  const reasons: Record<string, string> = { ...result.reasons };
  delete reasons['publication-boundary'];
  const bare = { tools: { result: { refused: 'refused: {reason}', reasons } } };
  const denied = { status: 'denied', code: 'not-allowed', reason: 'publication-boundary' };
  assert.equal(toolResultText(denied, bare), 'refused: CODE WORDS');
});

test('toolResultText: a deleted message keeps the words of message-deleted under its code unknown-message', () => {
  const gone = { status: 'invalid', code: 'unknown-message', reason: 'message-deleted' };
  assert.equal(toolResultText(gone, reasonLabels), 'refused: DELETED WORDS');
});

test('toolResultText: a reason equal to the code reads the words of that code once', () => {
  const same = { status: 'denied', code: 'not-allowed', reason: 'not-allowed' };
  assert.equal(toolResultText(same, reasonLabels), 'refused: CODE WORDS');
});

// A model sometimes writes a tool call as text with attributes, and what reaches the parser is a name such as
// `media_look" tool_id="media1`. A name with a quote or a space is no tool: the call is refused as malformed with a
// result the persona reads, and the broken name never goes back to the provider or into a result's attributes.

// What a provider's tool-call schema takes for a function name.
const PROVIDER_NAME = /^[a-zA-Z0-9_.-]+$/;

const QUOTED = 'media_look" tool_id="media1';

const SPACED = 'media look';

const namesNative = (name: string) =>
  normalizeCalls({
    calls: toolCallsOf([{ id: 'c1', function: { name, arguments: '{"url":"https://example.org/a.png"}' } }]),
    registry,
    step: 1,
  });

for (const broken of [QUOTED, SPACED]) {
  test(`a native call named ${JSON.stringify(broken)} is refused as malformed, not looked up as a skill`, () => {
    // Bug: it reads as `unknown-skill` and the result names the broken text back as if it were a tool the persona could call.
    const [call] = namesNative(broken);
    assert.equal(call?.problem, 'malformed-call');
    // The ordinary case keeps its own answer: the persona still hears that a tool does not exist.
    assert.equal(namesNative('media_lookup')[0]?.problem, 'unknown-skill');
  });

  test(`the step after a native call named ${JSON.stringify(broken)} goes back with a name the provider takes`, () => {
    // Bug: the assistant message repeats the broken name, the provider answers 400, and the whole turn is lost.
    const calls = namesNative(broken);
    const text = toolResultText({ status: 'invalid', code: calls[0]?.problem }, labels);
    assert.notEqual(text, '');
    const messages = appendStep({ messages: [], calls, results: [{ text }] });
    const sent = (messages[0]?.tool_calls as Array<{ function: { name: string } }> | undefined)?.[0]?.function.name;
    assert.match(String(sent), PROVIDER_NAME);
    assert.equal(messages[1]?.role, 'tool');
    assert.equal(messages[1]?.content, text, 'the persona reads the refusal');
  });
}

// What the persona's eyes saw of a picture they drew comes back in the call's result.
const SEEN_LABELS = { tools: { result: { ok: 'OK:', seen: 'SEEN {description}', unseen: 'UNSEEN' } } };

test('toolResultText: the description of a result follows its data, worded by labels.tools.result.seen', () => {
  // Bug: the result keeps only `data.text`, and the description of the picture the persona drew never reaches them.
  const text = toolResultText(
    { status: 'ok', data: { text: 'posted', description: 'a laptop with its screen on the outside of the lid' } },
    SEEN_LABELS
  );
  assert.equal(text, 'OK:\nposted\nSEEN a laptop with its screen on the outside of the lid');
});

test("toolResultText: a picture the persona's eyes could not look at is told with labels.tools.result.unseen", () => {
  // Bug: a failed look renders like a result with no description, and the persona assumes the picture came out as asked.
  const text = toolResultText({ status: 'ok', data: { text: 'posted', descriptionFailed: true } }, SEEN_LABELS);
  assert.equal(text, 'OK:\nposted\nUNSEEN');
});

// A call under the errand tool's current name is the persona's own call on the native transport.
test("the same call under the new name is a call of the persona's", () => {
  const [native] = normalizeCalls({
    calls: toolCallsOf([{ id: 'c1', function: { name: 'errand_scout', arguments: '{"goal":"x"}' } }]),
    registry,
    step: 1,
  });
  assert.deepEqual([native?.problem, native?.name], [null, 'errand.scout']);
});

test('toolResultText: a reason with its own values is filled with them', async () => {
  const { toolResultText } = await import('../../../src/tools/tool-calls.ts');
  const block = toolResultText(
    { skill: 'web.search', status: 'failed', code: 'provider', values: { status: '503' } },
    labels
  );
  const resultLabels = labels.tools.result;
  assert.ok(block.includes(fill(resultLabels.reasons.provider, { status: '503' })), block);
  assert.ok(!block.includes('{status}'), block);
});

// One handle per person, a line's author is the handle alone (authors.line).
const mentionFeedbackLabels = {
  ...fixtureLabels,
  authors: { line: '{handle}', lineAccount: '{handle} ({iface} {id})', unknown: 'someone' },
};

const YOB = '100000000000000001';

const NORTY = '100000000000000002';

const NORA = '100000000000000003';

const names = new Map([
  [YOB, ['Yob', 'Βοβ']],
  [NORTY, ['🌸Norty🌸', 'Norti']],
  [NORA, ['Nor']],
]);

const handles = new Map([
  [YOB, 'uq03j'],
  [NORTY, 'ueyi7'],
  [NORA, 'u0nor'],
]);

test('untaggedNote: one note per untagged name with the handle, nothing without handles or labels', () => {
  const handleToId = new Map([...handles].map(([id, handle]) => [handle, id]));
  const request = { handles: handleToId, memberNames: names, mentionedIds: [] };
  assert.equal(
    untaggedNote('@Yob and @Norti', request, mentionFeedbackLabels),
    '@Yob tagged nobody; handle @uq03j @Norti tagged nobody; handle @ueyi7'
  );
  assert.equal(untaggedNote('@Yob', { ...request, mentionedIds: [YOB] }, mentionFeedbackLabels), '');
  assert.equal(untaggedNote('@Yob', { ...request, handles: null }, mentionFeedbackLabels), '');
  assert.equal(untaggedNote('@Yob', request, { tools: { result: {} } }), '');
  const result = { status: 'ok', note: 'NOTE' };
  assert.ok(toolResultText(result, mentionFeedbackLabels).endsWith('\nNOTE'));
});
