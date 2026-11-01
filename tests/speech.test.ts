// The voice client (src/speech/index.ts#createSpeech) with no daily cap (PR 7d, plan section 4.5): a voice message is
// never refused for a count of the day, and a local layer not yet cut that still sets `speech.maxPerDay` changes
// nothing. Each call here gets through the pronunciation pass and fails at the synthesis, whose fetch is a fake that
// answers 500, so no provider and no ffmpeg is reached.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpeech, SpeechError } from '../src/speech/index.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';

const NOW = Date.parse('2026-10-31T12:00:00Z');

test('speech.say: a hundred and one voice messages in one day all reach the synthesis, a stale daily cap included', async () => {
  let fetched = 0;
  // `state` is a stale option of an earlier client; the options variable keeps it out of the excess property check.
  const options = {
    getConfig: () => ({
      models: { base: { speech: 'vendor-d/voice' } },
      speech: { voice: 'voice-1', timeoutMs: 1000, maxChars: 1500, maxPerDay: 2 },
      llm: { baseUrl: 'https://openrouter.ai/api/v1' },
    }),
    getPrompts: () => ({ 'speech-prepare': 'prepare it' }),
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
