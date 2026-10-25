// A failed pronunciation pass fails the whole voice.say call: nothing is synthesized, sent or counted.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSpeech, SpeechError } from '../src/speech/index.js';
import '../src/ops/index.js';
import { getOp } from '../src/ops/registry.js';
import { CODE } from '../src/skills/codes.js';

function speechWith(complete) {
  const state = { data: {}, markDirty() {} };
  let fetched = 0;
  const speech = createSpeech({
    getConfig: () => ({ speech: { maxPerDay: 5 } }),
    getPrompts: () => ({ 'speech-prepare': 'prepare it' }),
    apiKey: 'k',
    llm: { complete },
    state,
    fetchImpl: async () => { fetched += 1; throw new Error('must not be called'); },
  });
  return { speech, state, fetched: () => fetched };
}

for (const [name, complete, reason] of [
  ['an error', async () => { throw new Error('provider down'); }, 'error'],
  ['a timeout', async () => { throw Object.assign(new Error('slow'), { name: 'TimeoutError' }); }, 'timeout'],
  ['a changed word', async () => ({ text: 'something else' }), 'mismatch'],
]) {
  test(`speech.say: ${name} in the pronunciation pass throws a prepare SpeechError and synthesizes nothing`, async () => {
    const { speech, state, fetched } = speechWith(complete);
    await assert.rejects(speech.say({ text: 'hello there' }), (err) => {
      assert.ok(err instanceof SpeechError);
      assert.equal(err.stage, 'prepare');
      assert.equal(err.code, CODE.SPEECH_PREPARE_FAILED);
      assert.equal(err.reason, reason);
      return true;
    });
    assert.equal(fetched(), 0);
    assert.deepEqual(state.data, {});
  });
}

test('voice.say: a failed pronunciation pass is a failed result with the reason, and nothing is sent', async () => {
  const sent = [];
  const speech = { say: async () => { throw new SpeechError('prepare', CODE.SPEECH_PREPARE_FAILED, 'x', { reason: 'timeout' }); } };
  const env = {
    hot: { config: { speech: { maxChars: 100 } } },
    speech,
    port: { iface: 'discord', send: async (...args) => { sent.push(args); return { status: 'ok' }; } },
    assertNotPaused() {},
    resolvedGuildId: () => 'g',
  };
  const result = await getOp('voice.say').run({ text: 'hello' }, { env, channelId: 'c1' });
  assert.equal(result.status, 'failed');
  assert.equal(result.code, CODE.SPEECH_PREPARE_FAILED);
  assert.deepEqual(result.data, { stage: 'prepare', reason: 'timeout' });
  assert.match(result.summary, /pronunciation pass/);
  assert.equal(sent.length, 0);
});
