// The interface field of a model call (src/llm/openrouter.ts#createLlm): the turn hands its interface as `iface`,
// the usage line names it, and the request body never carries it (PR 7a). Kept apart from tests/openrouter.test.js,
// which is at its recorded length.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLlm } from '../src/llm/openrouter.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import type { Untyped } from '../src/tools/types.ts';
import { wrongly } from './fixtures/loose-types.ts';

function baseConfig() {
  return {
    models: { base: { core: 'test-model' } },
    llm: {
      baseUrl: 'https://openrouter.ai/api/v1',
      temperature: 1,
      maxOutputTokens: 100,
      maxRequestTokens: 1000,
      maxRequestsPerDay: 300,
      timeoutMs: 5000,
      retries: 2,
    },
    context: { vision: { tokensPerImage: 1600 } },
  };
}

function fakeState() {
  return { data: {}, markDirty: () => {} };
}

function fakeCalibrator() {
  return { ratio: 1, apply: (n: number) => n, observe: () => {} };
}

function okResponse(text: string, usage: object): Response {
  // A fake of the three members of a Response that createLlm reads.
  return wrongly({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ choices: [{ message: { content: text } }], usage }),
  });
}

test('complete: the interface of the turn is logged on its usage line and never sent', async () => {
  const sent: Array<Untyped> = [];
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig(),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: (_url: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(wrongly<string>(init?.body)));
      return Promise.resolve(okResponse('yes', { prompt_tokens: 10, completion_tokens: 2, cost: 0.001 }));
    },
  });
  const complete = wrongly<(messages: unknown, options: unknown) => Promise<unknown>>(llm.complete);
  const { logs } = await withCapturedLogs(() =>
    complete([{ role: 'user', content: 'hi' }], { role: 'core', purpose: 'reply', iface: 'cli' })
  );
  const [line] = logs.filter((l) => l.msg === 'llm: usage');
  assert.equal(line.iface, 'cli');
  assert.equal(JSON.stringify(sent[0]).includes('cli'), false, 'the interface is not in the body');
});
