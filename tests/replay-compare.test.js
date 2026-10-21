// Tests for tools/replay-compare.mjs: the old side read from the baseline folder's format (raw text with the
// retired tags, replay.out, the provider's meta), the new side from runs.jsonl lines, the blind sheet and key, the
// metrics table and the pass bar of the stage 4 plan. Temporary folders, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MANUAL_CHECKS, main, newTurnOf, oldCallsOf, pairSides, passBar, readNewSide, readOldSide, renderMetrics } from '../tools/replay-compare.mjs';
import { runRecord } from '../tools/replay.mjs';
import { sheetPairIds } from '../tools/lib/pair.mjs';
import { CliError } from '../tools/lib/cli.mjs';
import { tempDir } from './fixtures/tmp.js';

const CHANNEL = '123456789012345678';
const TRIGGER = (n) => `22345678901234567${n}`;

/** One old scenario folder: her raw text, the single mode's JSON, the provider's meta. */
function oldScenario(root, label, { text, messages = [], triggerId, reactions = [], gif = null, cost = 0.2, ms = 9000 }) {
  const dir = path.join(root, label);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ans-001.txt'), text);
  fs.writeFileSync(path.join(dir, 'replay.out'), JSON.stringify({ trigger: { id: triggerId }, answers: [{ think: 't', messages, skip: false, reactions, gif }], usage: { requests: 1, promptTokens: 100, completionTokens: 10 } }));
  fs.writeFileSync(path.join(dir, 'ans-001.meta.json'), JSON.stringify({ usage: { input_tokens: 3, cache_creation_input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 50 }, total_cost_usd: cost, duration_ms: ms }));
  fs.writeFileSync(path.join(dir, 'req-001.json'), JSON.stringify({ model: 'm', purpose: 'reply', system: 's', messages: [{ role: 'user', content: '<chat>\nAlice: hello there\nZoe: hi\n</chat>' }] }));
}

const step = (n, { calls = [], messages = [], held = false, thinkMissing = false, reactions = [], gif = null, usage = { prompt_tokens: 100, completion_tokens: 10, cost: 0.1 } } = {}) => ({
  step: n, answer: { messages: messages.map((text) => ({ text, replyTo: null })), reactions: reactions.map((emoji) => ({ to: 1, emoji })), gif, skip: false, think: 'x' },
  calls: calls.map(([skill, args, status = 'ok', code]) => ({ call: { skill, args, body: '' }, outcome: { verdict: { stage: 'gateway', ok: status === 'ok' }, executed: null, result: { skill, status, ...(code ? { code } : {}), data: { text: '' } } }, ms: 5 })),
  dropped: 0, capped: null, held, thinkMissing, coerced: 0, usage, ms: 100, requestChars: 10,
});

/** A runs.jsonl line of the new side. */
function newLine(id, triggerId, steps) {
  const record = runRecord(id, 0, { answer: steps[0].answer, call: null, callError: null, extraCalls: 0, usage: steps[0].usage, outcome: null, followUp: null, loop: { steps, ms: 300 } });
  return { id, scenario: id, channelId: CHANNEL, triggerId, context: [{ author: 'Alice', text: 'hello there' }], counts: {}, ...record };
}

test('oldCallsOf: calls by their skill, a picture alone or inside a call as draw.create, in the order written', () => {
  const calls = oldCallsOf('<msg>x</msg><call skill="web.search" goal="g">chess</call><draw self="yes">a cat</draw><call skill="message.create" channel="#d"><draw>a dog</draw></call><call skill="intent.set"/>');
  assert.deepEqual(calls, [
    { name: 'web.search', args: { goal: 'g', text: 'chess' } },
    { name: 'draw.create', args: { text: 'a cat', self: true } },
    { name: 'draw.create', args: { text: 'a dog', self: false, channel: '#d' } },
    { name: 'intent.set', args: {} },
  ]);
  assert.deepEqual(oldCallsOf('<msg>only speech</msg>'), []);
});

test('replay-compare: old scenarios paired with new lines by the trigger message; the sheet is blind, the key says which is which; the metrics hold the pass bar', () => {
  const root = tempDir('nep-compare-');
  const oldDir = path.join(root, 'old');
  const newDir = path.join(root, 'new');
  oldScenario(oldDir, 'S08', { text: '<think>t</think><msg>sorry</msg><call skill="message.create" channel="#d"><draw self="yes">scene</draw></call>', messages: ['sorry'], triggerId: TRIGGER(8) });
  oldScenario(oldDir, 'S21', { text: '<think>t</think><msg>just chat</msg>', messages: ['just chat'], triggerId: TRIGGER(1), cost: 0.3, ms: 5000 });
  oldScenario(oldDir, 'S30', { text: '<think>t</think><skip/>', triggerId: TRIGGER(2) });
  // The new side: S08 draws well, S21 chats, S30 is missing; one line has no old scenario.
  fs.mkdirSync(path.join(newDir, 'S08'), { recursive: true });
  fs.mkdirSync(path.join(newDir, 'S21'), { recursive: true });
  fs.writeFileSync(path.join(newDir, 'S08', 'runs.jsonl'), `${JSON.stringify(newLine('p1', TRIGGER(8), [step(0, { messages: ['redoing it'], calls: [['draw.create', { text: 'scene', self: true, channel: '#d' }]], usage: { prompt_tokens: 1200, completion_tokens: 40, cost: 0.15, prompt_tokens_details: { cached_tokens: 1000 } } })]))}\n`);
  fs.writeFileSync(path.join(newDir, 'S21', 'runs.jsonl'), `${JSON.stringify(newLine('p1', TRIGGER(1), [step(0, { messages: ['plain chat'], usage: { prompt_tokens: 1100, completion_tokens: 20, cost: 0.2 } })]))}\n${JSON.stringify(newLine('p2', TRIGGER(7), [step(0, { messages: ['stray'] })]))}\n`);

  const old = readOldSide(oldDir);
  assert.deepEqual(old.map((o) => [o.label, o.triggerId, o.calls.map((c) => c.name), o.requests, o.tokens.prompt, o.tokens.cacheRead, o.cost, o.ms, o.thinkMissing]), [
    ['S08', TRIGGER(8), ['draw.create'], 1, 1003, 900, 0.2, 9000, false],
    ['S21', TRIGGER(1), [], 1, 1003, 900, 0.3, 5000, false],
    ['S30', TRIGGER(2), [], 1, 1003, 900, 0.2, 9000, false],
  ]);
  assert.deepEqual(old[0].context, [{ author: 'Alice', text: 'hello there' }, { author: 'Zoe', text: 'hi' }]);
  assert.equal(readNewSide(newDir).length, 3);
  const paired = pairSides(old, readNewSide(newDir));
  assert.deepEqual([paired.pairs.map((p) => p.label), paired.missing, paired.extra], [['S08', 'S21'], ['S30'], ['p2']]);
  const turn = paired.pairs[0].new;
  assert.deepEqual([turn.calls, turn.leaks, turn.requests, turn.tokens.cacheRead], [[{ name: 'draw.create', args: { text: 'scene', self: true, channel: '#d' }, status: 'ok', code: null, step: 0 }], 0, 1, 1000]);
  assert.deepEqual(turn.answer.drawings, [{ text: 'scene' }]);

  const out = path.join(root, 'cmp');
  const result = main([oldDir, newDir, '--out', out], { rng: () => 0.1 });
  assert.equal(result.code, 0, JSON.stringify(result.result.failed));
  assert.deepEqual([result.result.pairs, result.result.missing, result.result.extra], [2, ['S30'], ['p2']]);
  const sheet = fs.readFileSync(path.join(out, 'sheet.html'), 'utf8');
  assert.deepEqual(sheetPairIds(sheet), ['S08', 'S21']);
  assert.ok(sheet.includes('Alice') && sheet.includes('hello there') && sheet.includes('drawing: scene'));
  assert.ok(!/old|new|tool call|text tags/i.test(sheet.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<script>[\s\S]*?<\/script>/, '').replace(/<title>[^<]*<\/title>/, '')), 'nothing on the sheet names a side');
  const key = JSON.parse(fs.readFileSync(path.join(out, 'key.json'), 'utf8'));
  assert.deepEqual([key.a, key.b, key.pairs.S08.first, key.pairs.S21.first], ['old (text tags)', 'new (tool calls)', 'A', 'A']);
  const metrics = fs.readFileSync(path.join(out, 'metrics.md'), 'utf8');
  assert.ok(metrics.includes('2 paired scenario(s); no new run for: S30; no old scenario for: p2'));
  assert.ok(metrics.includes('- PASS: zero held-text leaks (0 leak(s))'));
  assert.ok(metrics.includes('- PASS: S08, S09 draw.create with a channel and a boolean self'));
  assert.ok(metrics.includes('- PASS: S21-S25 (chat) make no calls'));
  assert.ok(/\| S08 \| draw\.create \| draw\.create:ok \| 0 \|/.test(metrics), metrics);
  // The scenarios no run holds are skipped by their checks, not failed.
  assert.ok(metrics.includes('no such scenario in this run'));
  // A non-empty output folder is refused.
  assert.throws(() => main([oldDir, newDir, '--out', out]), /not empty/);
});

test('replay-compare: speech posted beside a call that failed or has to be read is a leak; the pass bar fails and the exit code says so', () => {
  const leaky = newTurnOf(newLine('p1', TRIGGER(3), [step(0, { messages: ['claiming it is done'], calls: [['web.search', { query: 'q' }, 'ok']] }), step(1, { messages: ['again'], calls: [['message.delete', { message: '#1' }, 'invalid', 'invalid-args']] }), step(2, { messages: ['fine'], held: true, calls: [['web.search', { query: 'q' }, 'ok']] })]));
  assert.equal(leaky.leaks, 2, 'a data result and a refusal both need reading first; a held step leaks nothing');
  const tidy = newTurnOf(newLine('p2', TRIGGER(4), [step(0, { messages: ['sent'], calls: [['message.create', { text: 'x' }, 'ok']] })]));
  assert.equal(tidy.leaks, 0);
  const pair = (label, turn) => ({ label, old: { requests: 1, cost: 0.2, calls: [], tokens: {}, ms: 1 }, new: turn });
  const checks = passBar([pair('S11', leaky), pair('S26', { ...tidy, calls: [{ name: 'draw.create', args: {}, status: 'ok' }, { name: 'draw.create', args: {}, status: 'ok' }] }), pair('S22', { ...tidy, calls: [{ name: 'web.search', args: {}, status: 'ok' }] })]);
  const by = (needle) => checks.find((check) => check.name.startsWith(needle));
  assert.deepEqual([by('zero held-text leaks').pass, by('S26-S28').pass, by('S21-S25').pass], [false, false, false]);
  assert.match(by('S26-S28').detail, /S26/);
  assert.equal(by('S08').pass, null);
  // Too many requests and too dear.
  const dear = passBar([{ label: 'S01', old: { requests: 1, cost: 0.1, calls: [] }, new: { ...tidy, requests: 3, cost: 0.2, label: 'S01' } }]);
  assert.deepEqual([dear.find((c) => c.name.startsWith('mean requests')).pass, dear.find((c) => c.name.startsWith('mean cost')).pass], [false, false]);
  assert.ok(dear.some((c) => c.name.startsWith('S01 by a reader') && c.pass === null));
  assert.ok(Object.keys(MANUAL_CHECKS).includes('S17'));
  const md = renderMetrics({ pairs: [pair('S11', leaky)], missing: [], extra: [] });
  assert.ok(md.includes('- FAIL: zero held-text leaks (2 leak(s))'));
});

test('replay-compare: arguments and folders are checked before anything is written', () => {
  const root = tempDir('nep-compare-args-');
  for (const argv of [[], ['a', 'b'], ['a', '--out', 'o'], ['a', 'b', '--out'], ['a', 'b', '--out', 'o', '--bogus']]) assert.throws(() => main(argv), CliError, argv.join(' '));
  assert.throws(() => main([path.join(root, 'none'), root, '--out', path.join(root, 'o')]), /not a folder/);
  assert.throws(() => main([root, root, '--out', path.join(root, 'o')]), /no scenario/);
});
