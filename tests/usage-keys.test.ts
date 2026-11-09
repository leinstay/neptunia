// Tests for the key name on the usage line of the chat client (src/llm/openrouter.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLlm } from '../src/llm/openrouter.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';

const NOW = Date.parse('2026-11-20T12:00:00Z');

function coreLlm() {
  const llm = createLlm({
    apiKey: 'core-a',
    getConfig: () =>
      ({
        models: { base: { core: 'x/core' } },
        llm: {
          baseUrl: 'http://x',
          timeoutMs: 1000,
          retries: 0,
          maxRequestTokens: 1e6,
          maxOutputTokens: 10,
          maxRequestsPerDay: 100,
        },
      }) as never,
    calibrator: { apply: (n: number) => n, observe() {} },
    state: { data: {}, markDirty() {} },
    now: () => NOW,
    fetchImpl: (() =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
        json: () =>
          Promise.resolve({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 5, cost: 0.5 } }),
      })) as never,
  });
  const ask = () => withCapturedLogs(() => llm.complete([{ role: 'user', content: 'hi' }], { role: 'core' }));
  return { ask };
}

test('createLlm: a request on the main key leaves the key field out of the usage line', async () => {
  const { ask } = coreLlm();
  const { logs } = await ask();
  assert.ok(!('key' in (logs.find((line) => line.msg === 'llm: usage') ?? {})));
});
