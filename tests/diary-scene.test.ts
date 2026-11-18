// The diary's scene helper (src/behavior/diary-scene.ts) against a fake llm client: what its request carries and how
// its answer is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCENE_SETS, buildScene, drawSceneSets } from '../src/behavior/diary-scene.ts';

const SEEDS = ['place', 'setting', 'detail', 'activity', 'subject', 'twist']
  .map((family) => `# ${family}\n${Array.from({ length: SCENE_SETS }, (_, i) => `${family} ${i}`).join('\n')}`)
  .join('\n');

const SETS = [
  ['a pier', 'fog', 'a rusted bell', 'fishing', 'gulls', 'a power cut'],
  ['a roof', 'rain', 'a broken chair', 'drying laundry', 'pigeons', 'a lost key'],
];

const PROMPT = 'Build a scene from the sets.';
const CARD = 'THE PERSONA CHARACTER TEXT';

/** A fake client that answers `text` and records each request. */
function fakeLlm(text: string) {
  const calls: Array<{ messages: Array<{ role: string; content: string }>; options: Record<string, unknown> }> = [];
  return {
    calls,
    complete: (messages: Array<{ role: string; content: string }>, options: object) => {
      calls.push({ messages, options: options as Record<string, unknown> });
      return Promise.resolve({ text, usage: { prompt_tokens: 120, completion_tokens: 40 } });
    },
  };
}

const hot = {
  config: { bot: { name: CARD }, models: { byPurpose: { 'diary-scene': 'x/scene-model' } } },
  prompts: { 'diary-scene': PROMPT, character: CARD },
};
// 2026-11-18 14:00 UTC, a Wednesday.
const NOW = Date.UTC(2026, 10, 18, 14, 0);

function run(text: string, kind = 'status') {
  const llm = fakeLlm(text);
  return { llm, result: buildScene({ hot, llm, kind, sets: SETS, now: NOW, timezone: 'UTC' }) };
}

test('sends the prompt file as the system message and only the kind, the sets and the moment as the user message', async () => {
  // Bug: the persona's character text or memory reaches the helper, or a block is missing.
  const { llm, result } = run(JSON.stringify({ set: 1, used: ['a pier'], scene: 'A pier in fog.' }));
  await result;
  const [call] = llm.calls;
  assert.equal(call.messages.length, 2);
  assert.deepEqual(call.messages[0], { role: 'system', content: PROMPT });
  const user = call.messages[1].content;
  const tags = [...user.matchAll(/^<(\w+)>$/gm)].map((match) => match[1]);
  assert.deepEqual(tags, ['kind', 'sets', 'now']);
  assert.match(user, /<kind>\nstatus\n<\/kind>/);
  assert.match(user, /1\.\na pier\nfog\na rusted bell\nfishing\ngulls\na power cut/);
  assert.match(user, /<now>\n.*Wednesday.*14:00/);
  assert.ok(!user.includes(CARD));
  assert.equal(call.options.purpose, 'diary-scene');
  assert.equal(call.options.role, 'analyzer');
  assert.equal(call.options.model, 'x/scene-model');
});

test('sends the request on the role it is given, so two models can be compared on one set', async () => {
  // Bug: the role is fixed, and a run meant for the core model goes to the analyzer.
  const llm = fakeLlm(JSON.stringify({ set: 1, used: ['a pier'], scene: 'A pier in fog.' }));
  await buildScene({ hot, llm, kind: 'status', sets: SETS, now: NOW, timezone: 'UTC', role: 'core' });
  assert.equal(llm.calls[0].options.role, 'core');
  assert.equal(llm.calls[0].options.purpose, 'diary-scene');
});

test('returns the set, the kept lines, the scene and the tokens of a valid answer', async () => {
  // Bug: the chosen set or its lines are lost, or the tokens are not read.
  const { result } = run(JSON.stringify({ set: 2, used: ['a roof', 'rain'], scene: ' A wet roof at noon. ' }));
  const scene = await result;
  assert.equal(scene.ok, true);
  assert.deepEqual(scene.ok && { set: scene.set, used: scene.used, scene: scene.scene }, {
    set: 2,
    used: ['a roof', 'rain'],
    scene: 'A wet roof at noon.',
  });
  assert.deepEqual(scene.tokens, { in: 120, out: 40 });
  assert.deepEqual(scene.sets, SETS);
});

test('takes set 0 with no lines and an empty scene as no set working', async () => {
  // Bug: an honest "nothing fits" read as a failure.
  const scene = await run(JSON.stringify({ set: 0, used: [], scene: '' })).result;
  assert.equal(scene.ok && scene.set, 0);
});

const FAILURES: Array<[string, string]> = [
  ['not-json', 'A pier in fog.'],
  ['not-json', '[1, 2]'],
  ['fields', JSON.stringify({ set: 1, used: ['a pier'] })],
  ['fields', JSON.stringify({ set: 1, used: ['a pier'], scene: 'x', mood: 'calm' })],
  ['fields', JSON.stringify({ set: 1.5, used: [], scene: 'x' })],
  ['fields', JSON.stringify({ set: 1, used: 'a pier', scene: 'x' })],
  ['set-out-of-range', JSON.stringify({ set: 3, used: [], scene: 'x' })],
  ['set-out-of-range', JSON.stringify({ set: -1, used: [], scene: 'x' })],
  ['line-not-in-set', JSON.stringify({ set: 1, used: ['a roof'], scene: 'x' })],
  ['line-not-in-set', JSON.stringify({ set: 0, used: ['a pier'], scene: '' })],
  ['scene-empty', JSON.stringify({ set: 1, used: ['a pier'], scene: '  ' })],
  ['scene-without-set', JSON.stringify({ set: 0, used: [], scene: 'A pier.' })],
];

for (const [reason, text] of FAILURES) {
  test(`fails with ${reason} for the answer ${text}`, async () => {
    // Bug: a malformed answer passes as a scene, or fails under the wrong name.
    const scene = await run(text).result;
    assert.equal(scene.ok ? 'ok' : scene.reason, reason);
  });
}

test('fails with request-failed when the request throws', async () => {
  // Bug: a provider error ends the calibration run.
  const llm = { complete: () => Promise.reject(new Error('timeout')) };
  const scene = await buildScene({ hot, llm, kind: 'picture', sets: SETS, now: NOW, timezone: 'UTC' });
  assert.equal(scene.ok ? 'ok' : scene.reason, 'request-failed');
});

test('refuses a kind that gets no scene before any request', async () => {
  // Bug: a text kind is sent to the helper.
  const llm = fakeLlm('{}');
  await assert.rejects(buildScene({ hot, llm, kind: 'thought', sets: SETS, now: NOW, timezone: 'UTC' }), /thought/);
  assert.equal(llm.calls.length, 0);
});

test('draws eight sets, the same for the same random source, leaving out the lines recent entries built on', () => {
  // Bug: a set of a recent entry is offered again, or one seed gives two draws.
  const seq = () => {
    let x = 0.137;
    return () => (x = (x * 9301 + 0.49297) % 1);
  };
  const posts = [{ plan: { seeds: [['place 0', 'setting 0']], seed: 1 } }];
  const first = drawSceneSets({ seedsText: SEEDS, posts, rng: seq() });
  assert.equal(first.length, SCENE_SETS);
  assert.deepEqual(drawSceneSets({ seedsText: SEEDS, posts, rng: seq() }), first);
  assert.ok(first.every((set) => set.length === 6 && !set.includes('place 0') && !set.includes('setting 0')));
});
