// The effort a role runs at on the direct path (spec 2026-11-02 PR 5 "A path per role"): `llm.reasoningByRole.<role>`
// is read at each request (src/llm/roles.ts#reasoningOf) and sent as the body's `reasoning` by the client
// (src/llm/openrouter.ts#createLlm). The fetch is a fake that keeps each body; no request leaves the process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLlm } from '../src/llm/openrouter.ts';
import { reasoningOf } from '../src/llm/roles.ts';
import type { Untyped } from '../src/tools/types.ts';
import { wrongly } from './fixtures/loose-types.ts';

function configWith(reasoningByRole: Record<string, unknown>) {
  return {
    models: { base: { core: 'test-model', analyzer: 'test-analyzer' } },
    llm: {
      baseUrl: 'https://openrouter.ai/api/v1',
      temperature: 1,
      maxOutputTokens: 100,
      maxRequestTokens: 1000,
      maxRequestsPerDay: 300,
      timeoutMs: 5000,
      retries: 2,
      reasoningByRole,
    },
    context: { vision: { tokensPerImage: 1600 } },
  };
}

/** One completion for `role` under `reasoningByRole`; resolves with the body that was sent. */
async function bodyOf(
  reasoningByRole: Record<string, unknown>,
  options: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const sent: Array<Untyped> = [];
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => configWith(reasoningByRole),
    calibrator: { apply: (n: number) => n, observe: () => {} },
    state: { data: {}, markDirty: () => {} },
    fetchImpl: (_url: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(wrongly<string>(init?.body)));
      return Promise.resolve(
        wrongly<Response>({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              choices: [{ message: { content: 'ok' } }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            }),
        })
      );
    },
  });
  const complete = wrongly<(messages: unknown, options: unknown) => Promise<unknown>>(llm.complete);
  await complete([{ role: 'user', content: 'hi' }], options);
  return wrongly<Record<string, unknown>>(sent[0]);
}

test('a request of a role with an effort set carries it, and a role with none carries no reasoning', async () => {
  // Catches: "model set analyzer --effort high" saved and never sent, or one role's effort sent on every role.
  const settings = { analyzer: { effort: 'high' } };
  assert.deepEqual((await bodyOf(settings, { role: 'analyzer', purpose: 'address' })).reasoning, { effort: 'high' });
  assert.equal(Object.hasOwn(await bodyOf(settings, { role: 'vision', purpose: 'describe' }), 'reasoning'), false);
});

test("a call's own reasoning wins over the role's setting, which applies to the calls without one", async () => {
  // Catches: the video describer's fixed low effort overwritten by a role setting it was tuned against.
  const settings = { analyzer: { effort: 'high' } };
  const own = await bodyOf(settings, { role: 'analyzer', purpose: 'address', reasoning: { effort: 'low' } });
  assert.deepEqual(own.reasoning, { effort: 'low' });
  assert.deepEqual((await bodyOf(settings, { role: 'analyzer', purpose: 'room' })).reasoning, { effort: 'high' });
});

test('the core never carries provider reasoning, while another role with a setting does', async () => {
  // Catches: a hand-written core entry turning on provider reasoning for her replies, which the owner ruled out.
  const settings = { core: { effort: 'high' }, analyzer: { effort: 'low' } };
  assert.equal(Object.hasOwn(await bodyOf(settings, { role: 'core', purpose: 'reply' }), 'reasoning'), false);
  assert.deepEqual((await bodyOf(settings, { role: 'analyzer', purpose: 'address' })).reasoning, { effort: 'low' });
});

test('a setting whose effort is no level is not sent', () => {
  // Catches: a typo in config.local passed through to the provider, which then refuses every request of the role.
  const config = { llm: { reasoningByRole: { analyzer: { effort: 'hihg' } } } };
  assert.equal(reasoningOf(config, 'analyzer'), undefined);
  assert.deepEqual(reasoningOf({ llm: { reasoningByRole: { analyzer: { effort: 'medium' } } } }, 'analyzer'), {
    effort: 'medium',
  });
});
