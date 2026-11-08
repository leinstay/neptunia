// A failed pronunciation pass fails the whole voice.say call: nothing is synthesized, sent or counted.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSpeech, SpeechError } from '../src/speech/index.ts';
import '../src/tools/impl/index.ts';
import { getOp } from '../src/tools/impl/registry.ts';
import { CODE } from '../src/tools/codes.ts';
import { asResult } from '../src/tools/impl/index.ts';
import type { Env } from '../src/tools/impl/env.ts';

function speechWith(complete: () => Promise<{ text?: string }>) {
  const state = { data: {}, markDirty() {} };
  let fetched = 0;
  // `state` is a stale option of an earlier client; the options variable keeps it out of the excess property check.
  const options = {
    getConfig: () => ({ speech: { maxPerDay: 5 } }),
    getPrompts: () => ({ 'speech-prepare': 'prepare it' }),
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

test('voice.say: a failed pronunciation pass is a failed result with the reason, and nothing is sent', async () => {
  const sent: Array<Array<unknown>> = [];
  const speech = {
    say: async () => {
      throw new SpeechError('prepare', CODE.SPEECH_PREPARE_FAILED, 'x', { reason: 'timeout' });
    },
  };
  const env = {
    resolvedPlaceId: () => 'g1',
    hot: { config: { speech: { maxChars: 100 } } },
    speech,
    port: {
      iface: 'discord',
      send: async (...args: Array<unknown>) => {
        sent.push(args);
        return { status: 'ok' };
      },
    },
    assertNotPaused() {},
    resolvedRootId: () => 'g',
  };
  // The fake env carries only what voice.say reads.
  const run = getOp('voice.say')?.run({ text: 'hello' }, { env: env as unknown as Env, placeId: 'c1' });
  const result = asResult(await run);
  assert.equal(result.status, 'failed');
  assert.equal(result.code, CODE.SPEECH_PREPARE_FAILED);
  assert.deepEqual(result.data, { stage: 'prepare', reason: 'timeout' });
  assert.match(result.summary, /pronunciation pass/);
  assert.equal(sent.length, 0);
});
