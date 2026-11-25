// Tests for src/speech/index.ts, the voice client of createSpeech. A voice message is never refused for a count of
// the day, and a local layer that still sets `speech.maxPerDay` changes nothing. A failed pronunciation pass throws a
// prepare SpeechError and synthesizes nothing. No call reaches a provider or ffmpeg.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../../../src/tools/operations/index.ts';
import { createSpeech, SpeechError } from '../../../src/speech/index.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { chainsOf } from '../../fixtures/chains.ts';

import { CODE } from '../../../src/tools/codes.ts';

const NOW = Date.parse('2026-10-31T12:00:00Z');

test('speech.say: a hundred and one voice messages in one day all reach the synthesis, a stale daily cap included', async () => {
  let fetched = 0;
  // `state` is a stale option of an earlier client; the options variable keeps it out of the excess property check.
  const options = {
    getConfig: () => ({
      models: { routes: chainsOf({ speech: 'vendor-d/voice' }) },
      speech: { voice: 'voice-1', timeoutMs: 1000, maxChars: 1500, maxPerDay: 2 },
      llm: { baseUrl: 'https://openrouter.ai/api/v1' },
    }),
    getPrompts: () => ({ speech: 'prepare it' }),
    apiKey: 'k',
    llm: {
      complete: (messages: Array<{ role: string; content: string }>) =>
        Promise.resolve({ text: messages[1]?.content ?? '' }),
    },
    state: { data: {}, markDirty() {} },
    fetchImpl: () => {
      fetched += 1;
      return Promise.resolve(new Response('down', { status: 500, headers: { 'content-type': 'text/plain' } }));
    },
    now: () => NOW,
  };
  const speech = createSpeech(options);
  const stages: Array<string> = [];
  await withCapturedLogs(async () => {
    for (let n = 0; n < 101; n += 1) {
      await assert.rejects(speech.say({ text: `hello there ${n}` }), (err) => {
        assert.ok(err instanceof SpeechError);
        stages.push(err.stage);
        return true;
      });
    }
  });
  assert.deepEqual([...new Set(stages)], ['synth']);
  assert.equal(fetched, 101);
});

function speechWith(complete: () => Promise<{ text?: string }>) {
  const state = { data: {}, markDirty() {} };
  let fetched = 0;
  // `state` is a stale option of an earlier client; the options variable keeps it out of the excess property check.
  const options = {
    getConfig: () => ({ speech: { maxPerDay: 5 } }),
    getPrompts: () => ({ speech: 'prepare it' }),
    apiKey: 'k',
    llm: { complete },
    state,
    fetchImpl: async () => {
      fetched += 1;
      throw new Error('must not be called');
    },
  };
  const speech = createSpeech(options);
  return { speech, state, fetched: () => fetched };
}

const CASES: Array<[string, () => Promise<{ text?: string }>, string]> = [
  [
    'an error',
    async () => {
      throw new Error('provider down');
    },
    'error',
  ],
  [
    'a timeout',
    async () => {
      throw Object.assign(new Error('slow'), { name: 'TimeoutError' });
    },
    'timeout',
  ],
  ['a changed word', async () => ({ text: 'something else' }), 'mismatch'],
];

for (const [name, complete, reason] of CASES) {
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
