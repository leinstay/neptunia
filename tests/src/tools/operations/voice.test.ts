import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SpeechError } from '../../../../src/speech/index.ts';
import { CODE } from '../../../../src/tools/codes.ts';
import type { Env } from '../../../../src/tools/operations/env.ts';
import { asResult } from '../../../../src/tools/operations/index.ts';
import { getOp } from '../../../../src/tools/operations/registry.ts';

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
