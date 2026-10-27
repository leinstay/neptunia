// Tests for src/tools/tool-calls.ts: the calls of an answer as records, the narrow coercion of
// argument types, the words of a call's result, and when a finished call covers speech.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../src/tools/impl/index.ts';
import { buildSkills } from '../src/tools/registry.ts';
import { SKILL_DEFINITIONS } from '../src/tools/definitions.ts';
import { schemaError } from '../src/tools/schema.ts';
import { toolCallsOf } from '../src/llm/openrouter.js';
import { coerceArgs, coversSpeech, normalizeCalls, toolResultText } from '../src/tools/tool-calls.ts';
import { labels } from './fixtures/labels.js';

const registry = buildSkills({ table: SKILL_DEFINITIONS });
const native = (calls) =>
  toolCallsOf(calls.map((c) => ({ id: c.id, function: { name: c.name, arguments: c.arguments } })));
const normal = (calls, extra = {}) => normalizeCalls({ calls: native(calls), registry, step: 1, ...extra });

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

test('normalizeCalls: an unknown name is unknown-skill and nothing is repaired, either transport', () => {
  const [a] = normal([{ id: 'a', name: 'draw_creat', arguments: '{}' }]);
  assert.equal(a.problem, 'unknown-skill');
  assert.equal(a.name, 'draw_creat');
  // The native transport carries API names: the dotted one is not a tool of hers.
  assert.equal(normal([{ id: 'a', name: 'draw.create', arguments: '{}' }])[0].problem, 'unknown-skill');
  // The text transport keeps dotted names: the API name is not one.
  const text = normalizeCalls({
    calls: [
      { id: null, name: 'draw_create', arguments: '{}', parsed: {}, parseError: null },
      { id: null, name: 'draw.create', arguments: '{}', parsed: {}, parseError: null },
    ],
    transport: 'text',
    registry,
    step: 2,
  });
  assert.deepEqual(
    text.map((c) => c.problem),
    ['unknown-skill', null]
  );
  assert.equal(text[1].apiName, 'draw_create');
});

test('normalizeCalls: a parse error of the text transport is malformed-call, an unclosed block at the length limit truncated-call', () => {
  const calls = [
    { id: null, name: '', arguments: '{', parsed: null, parseError: 'malformed' },
    { id: null, name: '', arguments: '{', parsed: null, parseError: 'truncated' },
    { id: null, name: 'draw.create', arguments: '{}', parsed: null, parseError: 'nested' },
  ];
  assert.deepEqual(
    normalizeCalls({ calls, transport: 'text', registry }).map((c) => c.problem),
    ['malformed-call', 'truncated-call', 'malformed-call']
  );
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

const schema = registry.get('draw.create').argsSchema;

test('coerceArgs: "true" and "5" are read as a boolean and an integer, and each one is reported', () => {
  const given = { text: 'a', self: 'true' };
  const out = coerceArgs(given, schema);
  assert.deepEqual(out.args, { text: 'a', self: true });
  assert.deepEqual(out.coerced, [{ arg: 'self', to: true }]);
  assert.deepEqual(given, { text: 'a', self: 'true' });
  assert.deepEqual(coerceArgs({ self: ' FALSE ' }, schema).args, { self: false });
  const intSchema = registry.get('intent.set').argsSchema;
  const number = coerceArgs({ settle: '5', perday: ' 12 ' }, intSchema);
  assert.deepEqual(number.args, { settle: 5, perday: 12 });
  assert.deepEqual(number.coerced, [
    { arg: 'settle', to: 5 },
    { arg: 'perday', to: 12 },
  ]);
});

test('coerceArgs: "yes", "1", null, a number for a boolean and a decimal for an integer are left for the schema to refuse', () => {
  for (const value of ['yes', '1', 'maybe', null, 1, 0, '']) {
    const out = coerceArgs({ text: 't', self: value }, schema);
    assert.deepEqual(out.args, { text: 't', self: value }, String(value));
    assert.deepEqual(out.coerced, []);
    assert.equal(schemaError(out.args, schema), 'args.self:type', String(value));
  }
  const intSchema = registry.get('intent.set').argsSchema;
  assert.deepEqual(coerceArgs({ settle: '5.5', perday: 'five' }, intSchema).coerced, []);
});

test('coerceArgs: top level only, unknown keys and strings for string arguments are untouched', () => {
  const out = coerceArgs({ text: 'true', extra: 'true', nested: { self: 'true' } }, schema);
  assert.deepEqual(out.args, { text: 'true', extra: 'true', nested: { self: 'true' } });
  assert.deepEqual(out.coerced, []);
  assert.equal(schemaError(out.args, schema), 'args.extra:unknown');
});

test('schema refusals the engine relies on: an unknown key and an enum violation', () => {
  const pings = registry.get('pings.set').argsSchema;
  assert.equal(schemaError({ mode: 'on', other: 1 }, pings), 'args.other:unknown');
  assert.equal(schemaError({ mode: 'sometimes' }, pings), 'args.mode:enum');
  assert.equal(schemaError({ mode: 'on' }, pings), null);
});

test('toolResultText: the status words, the reason from the code, the data cut to maxChars', () => {
  const ok = toolResultText({ status: 'ok', data: { text: 'result data' } }, labels);
  assert.equal(ok, `${labels.tools.result.ok}\nresult data`);
  const refused = toolResultText({ status: 'denied', code: 'not-allowed' }, labels);
  assert.ok(refused.includes(labels.tools.result.reasons['not-allowed']), refused);
  assert.ok(toolResultText({ status: 'ok', data: { text: 'x'.repeat(100) } }, labels, { maxChars: 20 }).endsWith('…'));
  assert.equal(toolResultText(null, labels), '');
  // Unknown status reads as failed; a code with no wording falls to the other-reason words.
  assert.ok(
    toolResultText({ status: 'weird', code: 'no-such-code' }, labels).includes(labels.tools.result.reasons.other)
  );
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
  assert.equal(lines[0], labels.tools.result.coerced.replace('{arg}', 'self').replace('{value}', 'true'));
  assert.equal(lines[1], labels.tools.result.coerced.replace('{arg}', 'settle').replace('{value}', '5'));
  assert.equal(lines[2], labels.tools.result.ok);
});

test('coversSpeech: an ok effect or job covers speech, data and any other status do not', () => {
  assert.equal(coversSpeech({ result: 'effect' }, { status: 'ok' }), true);
  assert.equal(coversSpeech({ result: 'job' }, { status: 'ok' }), true);
  assert.equal(coversSpeech({ result: 'data' }, { status: 'ok' }), false);
  assert.equal(coversSpeech({ result: 'effect' }, { status: 'failed' }), false);
  assert.equal(coversSpeech({ result: 'effect' }, { status: 'unknown' }), false);
  assert.equal(coversSpeech(null, { status: 'ok' }), false);
  assert.equal(coversSpeech(registry.get('task.run'), { status: 'ok' }), true);
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
