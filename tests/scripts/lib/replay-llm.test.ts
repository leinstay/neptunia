// Tests for scripts/lib/replay-llm.ts: the client of a replay records each completion, a failed one with its code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordingLlm, replayWithoutCache } from '../../../scripts/lib/replay-llm.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { parseArgs } from '../../../scripts/lib/replay-args.ts';

test('recordingLlm notes the failure code of a failed completion', async () => {
  const calls: Array<Untyped> = [];
  const err = Object.assign(new Error('rate limited'), { statusCode: 429 });
  const llm = recordingLlm(
    {
      complete: async () => {
        throw err;
      },
    },
    calls,
    { errorCodeOf: (e: Untyped) => (e.statusCode === 429 ? 'provider-limit' : 'error') }
  );
  await assert.rejects(llm.complete([], { purpose: 'reply' }));
  assert.equal(calls[0].code, 'provider-limit');
  assert.match(calls[0].error, /rate limited/);
});

test('replay: recordingLlm keeps the native tool calls and the finish reason of each answer, for the diary brief and the inner report', async () => {
  const { recordingLlm } = await import('../../../scripts/lib/replay-llm.ts');
  const toolCalls = [
    { id: 'c1', name: 'draw_create', arguments: '{"text":"a cat"}', parsed: { text: 'a cat' }, parseError: null },
  ];
  const real = {
    complete: async () => ({ text: '<think>t</think>', toolCalls, finishReason: 'stop', usage: { prompt_tokens: 3 } }),
    other: () => 'x',
  };
  const calls: Array<Untyped> = [];
  const llm = recordingLlm(real, calls);
  await llm.complete([], { purpose: 'reply' });
  assert.deepEqual(
    calls.map((c) => [c.purpose, c.text, c.toolCalls, c.finishReason]),
    [['reply', '<think>t</think>', toolCalls, 'stop']]
  );
  const plain = recordingLlm({ complete: async () => ({ text: 'x', usage: null }) }, calls);
  await plain.complete([], {});
  assert.deepEqual([calls[1].toolCalls, calls[1].finishReason], [null, null]);
});

test('--no-cache: the trigger runs are marked like a live turn unless it is given; no other mode takes the flag', () => {
  assert.equal(parseArgs(['--loop-triggers', '--triggers', 't.txt']).noCache, false);
  assert.equal(parseArgs(['--loop-triggers', '--triggers', 't.txt', '--no-cache']).noCache, true);
  assert.throws(() => parseArgs(['123456789012345678', '223456789012345678', '--no-cache']), /usage/);
  assert.throws(() => parseArgs(['--skills', 'a.json', '--no-cache']), /usage/);
  const trigger = (extra = []) =>
    replayWithoutCache(parseArgs(['--loop-triggers', '--triggers', 't.txt', ...extra]), false);
  assert.equal(trigger(), false, 'one sample, no scenario file: still marked');
  assert.equal(trigger(['--no-cache'] as unknown as Parameters<typeof trigger>[0]), true);
  // The other single-sample runs stay unmarked, as before.
  assert.equal(replayWithoutCache(parseArgs(['123456789012345678', '223456789012345678']), false), true);
  assert.equal(
    replayWithoutCache(parseArgs(['123456789012345678', '223456789012345678', '--samples', '3']), false),
    false
  );
});
