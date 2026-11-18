// Tests for src/llm/chain-client.ts: each request of a role walks the role's chain of routes. An API route goes to
// the role's client with the route's key and model, a harness route with the route itself, and a route that is
// unavailable hands the same request to the next route. The clients are fakes that record what they were asked and
// answer or fail as scripted; no provider and no CLI is reached.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChainClient, reportingFailures } from '../src/llm/chain-client.ts';
import { createRouteChain } from '../src/llm/route-chain.ts';
import type { CompleteResult } from '../src/llm/openrouter.ts';

const MESSAGES = [{ role: 'user', content: 'Is the trip still on?' }];
const KEYS: Record<string, string> = { main: 'sk-main-0001', spare: 'sk-spare-0002', helpers: 'sk-helpers-0003' };
const ANSWER: CompleteResult = { text: 'ok', usage: {}, estimated: 0 };

type Asked = { role: string; options: Record<string, unknown> };
type Outcome = 'ok' | Error;

const http = (statusCode: number, body = '') => Object.assign(new Error(`http ${statusCode}`), { statusCode, body });
const coded = (code: string) => Object.assign(new Error(code), { code });

/** A client named `name` that records each request and answers with the next scripted outcome, `ok` when none is left. */
function fakeClient(name: string, log: Array<Asked & { client: string }>, script: Array<Outcome> = []) {
  return {
    complete(_messages: unknown, options?: unknown): Promise<CompleteResult> {
      const asked = (options ?? {}) as Record<string, unknown>;
      log.push({ client: name, role: String(asked.role), options: asked });
      const next = script.shift() ?? 'ok';
      return next === 'ok' ? Promise.resolve(ANSWER) : Promise.reject(next);
    },
  };
}

/** The options the `n`-th recorded request was sent with, empty when there is none. */
const optionsOf = (asked: ReadonlyArray<Asked>, n: number): Record<string, unknown> => asked[n]?.options ?? {};

/** The `via` of the route the `n`-th recorded request was sent on. */
const viaOf = (asked: ReadonlyArray<Asked>, n: number): unknown =>
  (optionsOf(asked, n).chainRoute as { via?: unknown })?.via;

function rig(
  config: unknown,
  scripts: { core?: Array<Outcome>; memory?: Array<Outcome>; direct?: Array<Outcome> } = {}
) {
  const clock = { at: Date.parse('2026-11-09T09:00:00Z') };
  const asked: Array<Asked & { client: string }> = [];
  const clients = {
    core: fakeClient('core', asked, scripts.core),
    memory: fakeClient('memory', asked, scripts.memory),
    direct: fakeClient('direct', asked, scripts.direct),
  };
  const client = createChainClient({
    getConfig: () => config,
    keys: {
      valueOf: (name) => (Object.hasOwn(KEYS, name) ? (KEYS[name] ?? null) : null),
    },
    chain: createRouteChain({ now: () => clock.at, retryMs: () => 30 * 60_000 }),
    executor: (role) => (role === 'core' ? clients.core : role === 'memory' ? clients.memory : clients.direct),
  });
  return { client, asked, clock };
}

const CORE_CHAIN = {
  models: {
    routes: {
      core: [
        { via: 'harness', backend: 'claude', model: 'claude-opus-4-6' },
        { via: 'api', key: 'helpers', model: 'anthropic/claude-opus-4.6' },
      ],
    },
  },
};

test('an API route sends the request to the role client with the key of that route, by name and value', async () => {
  // Catches: the request going out on the first core key instead of the key the route names.
  const config = { models: { routes: { analyzer: [{ via: 'api', key: 'helpers', model: 'openai/gpt-6.1-sol' }] } } };
  const { client, asked } = rig(config);
  await client.complete(MESSAGES, { role: 'analyzer', model: 'openai/gpt-6.1-sol' });
  assert.equal(asked.length, 1);
  assert.equal(asked[0]?.client, 'direct');
  assert.deepEqual(optionsOf(asked, 0).routeKey, { name: 'helpers', value: KEYS.helpers });
  assert.equal(optionsOf(asked, 0).model, 'openai/gpt-6.1-sol');
});

test('a harness route of the core goes to the core client with the route itself', async () => {
  // Changed: a role that neither its route nor llm.routeEffort gives an effort runs at medium (the owner, 2026-11-10),
  // so the route arrives with that effort and native thinking instead of none.
  // Catches: a harness route sent to the API client, which posts a CLI model id to OpenRouter.
  const { client, asked } = rig(CORE_CHAIN);
  await client.complete(MESSAGES, { role: 'core' });
  assert.equal(asked[0]?.client, 'core');
  assert.deepEqual(optionsOf(asked, 0).chainRoute, {
    via: 'harness',
    backend: 'claude',
    model: 'claude-opus-4-6',
    effort: 'medium',
    isThinking: true,
  });
});

test('a spent subscription window hands the same request to the API route, counted once against the day', async () => {
  // Catches: the step failing although a fallback route exists, or the day's count taken twice for one step.
  const { client, asked } = rig(CORE_CHAIN, { core: [coded('subscription-exhausted')] });
  const answer = await client.complete(MESSAGES, { role: 'core' });
  assert.equal(answer.text, 'ok');
  assert.equal(asked.length, 2);
  assert.equal(viaOf(asked, 1), 'api');
  assert.deepEqual(optionsOf(asked, 1).routeKey, { name: 'helpers', value: KEYS.helpers });
  assert.equal(optionsOf(asked, 1).model, 'anthropic/claude-opus-4.6', 'the API route sends its own model');
  assert.equal(optionsOf(asked, 0).countAgainstDailyCap, undefined);
  assert.equal(optionsOf(asked, 1).countAgainstDailyCap, false);
});

test('the next request after a switch starts on the later route', async () => {
  // Catches: every turn waiting on the spent harness again before it reaches the route that works.
  const { client, asked } = rig(CORE_CHAIN, { core: [coded('subscription-exhausted')] });
  await client.complete(MESSAGES, { role: 'core' });
  await client.complete(MESSAGES, { role: 'core' });
  assert.equal(asked.length, 3);
  assert.equal(viaOf(asked, 2), 'api');
});

test('a failure that would fail on any route is thrown at once and moves nothing', async () => {
  // Catches: a 400 repeated on every route, spending every key on a request that cannot succeed.
  const config = {
    models: {
      routes: {
        analyzer: [
          { via: 'api', key: 'main', model: 'openai/gpt-6.1-sol' },
          { via: 'api', key: 'spare', model: 'openai/gpt-6.1-sol' },
        ],
      },
    },
  };
  const { client, asked } = rig(config, { direct: [http(400)] });
  await assert.rejects(client.complete(MESSAGES, { role: 'analyzer' }), { statusCode: 400 });
  assert.equal(asked.length, 1);
  await client.complete(MESSAGES, { role: 'analyzer' });
  assert.deepEqual(optionsOf(asked, 1).routeKey, { name: 'main', value: KEYS.main });
});

test('a chain of one route fails with that route own error', async () => {
  // Catches: a single harness core reporting routes-exhausted where she was told subscription-exhausted before.
  const config = { models: { routes: { core: [{ via: 'harness', backend: 'claude', model: 'claude-opus-4-6' }] } } };
  const { client } = rig(config, { core: [coded('subscription-exhausted')] });
  await assert.rejects(client.complete(MESSAGES, { role: 'core' }), { code: 'subscription-exhausted' });
});

test('a longer chain whose every route is unavailable fails with routes-exhausted after one try of each', async () => {
  // Catches: a request looping over its routes forever, or trying a spent route twice.
  const { client, asked } = rig(CORE_CHAIN, { core: [coded('subscription-login'), http(402)] });
  await assert.rejects(client.complete(MESSAGES, { role: 'core' }), { code: 'routes-exhausted' });
  assert.equal(asked.length, 2);
});

test('a route whose key keys.json lacks is skipped with no request', async () => {
  // Catches: a request sent with an empty key, which the provider answers 401 after the rails counted it.
  const config = {
    models: {
      routes: {
        vision: [
          { via: 'api', key: 'gone', model: 'google/gemini-4-argon' },
          { via: 'api', key: 'helpers', model: 'google/gemini-4-argon' },
        ],
      },
    },
  };
  const { client, asked } = rig(config);
  await client.complete(MESSAGES, { role: 'vision' });
  assert.equal(asked.length, 1);
  assert.deepEqual(optionsOf(asked, 0).routeKey, { name: 'helpers', value: KEYS.helpers });
  assert.equal(optionsOf(asked, 0).countAgainstDailyCap, undefined, 'a skipped route counted nothing');
});

test('a role with no usable route goes to its client unchanged, which refuses it as a role with no key', async () => {
  // Catches: a role whose only key left keys.json answered silently or sent with an empty key.
  const config = { models: { routes: { analyzer: [{ via: 'api', key: 'gone', model: 'openai/gpt-6.1-sol' }] } } };
  const { client, asked } = rig(config, { direct: [coded('ROLE_KEY_MISSING')] });
  await assert.rejects(client.complete(MESSAGES, { role: 'analyzer' }), { code: 'ROLE_KEY_MISSING' });
  assert.equal(asked.length, 1);
  assert.equal(optionsOf(asked, 0).routeKey, undefined);
});

test('an API route with an effort sends it as reasoning, and a caller reasoning stays', async () => {
  // Catches: the route's effort lost, or written over a request that brought its own reasoning.
  const config = {
    models: { routes: { analyzer: [{ via: 'api', key: 'helpers', model: 'openai/gpt-6.1-sol', effort: 'low' }] } },
  };
  const { client, asked } = rig(config);
  await client.complete(MESSAGES, { role: 'analyzer' });
  await client.complete(MESSAGES, { role: 'analyzer', reasoning: { effort: 'high' } });
  assert.deepEqual(optionsOf(asked, 0).reasoning, { effort: 'low' });
  assert.deepEqual(optionsOf(asked, 1).reasoning, { effort: 'high' });
});

test('the first route keeps the model the caller chose for its purpose', async () => {
  // Catches: a `models.byPurpose` pin overwritten by the route's model on the route in force.
  const config = { models: { routes: { analyzer: [{ via: 'api', key: 'helpers', model: 'openai/gpt-6.1-sol' }] } } };
  const { client, asked } = rig(config);
  await client.complete(MESSAGES, { role: 'analyzer', purpose: 'split', model: 'pinned/split-model' });
  assert.equal(optionsOf(asked, 0).model, 'pinned/split-model');
});

test('the key of a role is the key of its first usable API route', () => {
  // Catches: the embedder reading the first core key while the role's chain names another.
  const config = {
    models: {
      routes: {
        embedding: [
          { via: 'api', key: 'gone', model: 'openai/text-embedding-3-large' },
          { via: 'api', key: 'helpers', model: 'openai/text-embedding-3-large' },
        ],
        core: [{ via: 'harness', backend: 'claude', model: 'claude-opus-4-6' }],
      },
    },
  };
  const { client } = rig(config);
  assert.equal(client.keyOf('embedding'), KEYS.helpers);
  assert.equal(client.keyOf('core'), null);
});

test('a request of a role outside the chains goes to its client unchanged', async () => {
  // Catches: an agent role or a probe without a role given a route it never had.
  const { client, asked } = rig(CORE_CHAIN);
  await client.complete(MESSAGES, { role: 'scout', model: 'x/y' });
  assert.equal(optionsOf(asked, 0).chainRoute, undefined);
  assert.equal(optionsOf(asked, 0).routeKey, undefined);
});

const EMBEDDING_CHAIN = {
  models: {
    routes: {
      embedding: [
        { via: 'api', key: 'main', model: 'openai/text-embedding-3-large' },
        { via: 'api', key: 'helpers', model: 'openai/text-embedding-3-large' },
      ],
    },
  },
};

test('a spent key reported by a client of its own moves the role to its next route', () => {
  // Catches: the embedder failing on a spent key forever, since its requests never pass the chain client.
  const { client } = rig(EMBEDDING_CHAIN);
  assert.deepEqual(client.keyRouteOf('embedding'), { name: 'main', value: KEYS.main });
  client.report('embedding', http(402));
  assert.deepEqual(client.keyRouteOf('embedding'), { name: 'helpers', value: KEYS.helpers });
});

test('a failure reported that would fail on any route moves nothing', () => {
  // Catches: a 500 of the embedder burning through the keys of its chain.
  const { client } = rig(EMBEDDING_CHAIN);
  client.report('embedding', http(500));
  client.report('embedding', new Error('timed out'));
  assert.deepEqual(client.keyRouteOf('embedding'), { name: 'main', value: KEYS.main });
});

test('the route a probe found down moves the role on, and says whether another route is now in force', () => {
  // Catches: a failed probe pausing her although a later route of the core's chain works.
  const { client } = rig(CORE_CHAIN);
  assert.equal(client.moveOn('core', 'subscription-login'), true);
  assert.equal(client.inForce('core')?.via, 'api');
  assert.equal(client.moveOn('core', 'http-402'), false, 'the first failed within the minute, so nothing is left');
});

test('a client wrapped for its role reports each failed call and passes the answer and the error on', async () => {
  // Catches: the embedder's spent key never reaching the chain, or the wrapper swallowing the failure.
  const reported: Array<[string, unknown]> = [];
  const failure = http(402);
  const client = reportingFailures(
    { embed: (fail: boolean) => (fail ? Promise.reject(failure) : Promise.resolve([1])) },
    'embedding',
    (role, error) => reported.push([role, error])
  );
  assert.deepEqual(await client.embed(false), [1]);
  await assert.rejects(client.embed(true), (error) => error === failure);
  assert.deepEqual(reported, [['embedding', failure]]);
});

test("a role's route with no effort takes the default effort of llm.routeEffort, on a key or a harness", async () => {
  // Catches: the core's routes sent with no effort although the shipped setting names the lowest one.
  const config = { ...CORE_CHAIN, llm: { routeEffort: { core: 'low' } } };
  const { client, asked } = rig(config, { core: [coded('subscription-exhausted')] });
  await client.complete(MESSAGES, { role: 'core' });
  assert.equal((optionsOf(asked, 0).chainRoute as { effort?: unknown }).effort, 'low');
  assert.deepEqual(optionsOf(asked, 1).reasoning, { effort: 'low' });
});

test('an effort the route names wins over the default of llm.routeEffort', async () => {
  // Catches: the setting overriding the owner's own `:high` on a route.
  const config = {
    models: { routes: { core: [{ via: 'api', key: 'helpers', model: 'x/core', effort: 'high' }] } },
    llm: { routeEffort: { core: 'low' } },
  };
  const { client, asked } = rig(config);
  await client.complete(MESSAGES, { role: 'core' });
  assert.deepEqual(optionsOf(asked, 0).reasoning, { effort: 'high' });
});

test('disabled sends no reasoning on an API route and no effort on a claude harness', async () => {
  // Changed: `disabled` of the standard scale replaces `lowest` (the owner, 2026-11-09). A claude harness at `disabled`
  // reached its run as `low`, and the expectation was wrong: `disabled` means no native reasoning, claude turns that
  // off with MAX_THINKING_TOKENS=0, and `--effort low` is a second switch that shortens everything the model writes
  // (the owner, 2026-11-15).
  // Catches: `disabled` sent to the provider as an effort it does not know, reasoning added to a core that sent none,
  // or a claude core at `disabled` run with `--effort low` and a think of a few words.
  const config = { ...CORE_CHAIN, llm: { routeEffort: { core: 'disabled' } } };
  const { client, asked } = rig(config, { core: [coded('subscription-exhausted')] });
  await client.complete(MESSAGES, { role: 'core' });
  const sent = optionsOf(asked, 0).chainRoute as { effort?: unknown; isThinking?: unknown };
  assert.equal(sent.effort, null);
  assert.equal(sent.isThinking, false);
  assert.equal(optionsOf(asked, 1).reasoning, undefined);
});

test('a codex harness route at disabled runs at low with no native thinking', async () => {
  // Catches: the claude fix applied to codex, which has no switch for its thinking, so `disabled` reaches it with no
  // effort and it runs at its own default level.
  const route = { via: 'harness', backend: 'codex', model: 'gpt-6.1-sol' };
  const { client, asked } = rig({ models: { routes: { core: [route] } }, llm: { routeEffort: { core: 'disabled' } } });
  await client.complete(MESSAGES, { role: 'core' });
  const sent = optionsOf(asked, 0).chainRoute as { effort?: unknown; isThinking?: unknown };
  assert.equal(sent.effort, 'low');
  assert.equal(sent.isThinking, false);
});

test('a claude harness route that names disabled runs with no effort whatever llm.routeEffort says', async () => {
  // Catches: the route's own `:disabled` replaced by the role's default, or turned into `low` on the way to the CLI.
  const route = { via: 'harness', backend: 'claude', model: 'claude-opus-4-6', effort: 'disabled' };
  const { client, asked } = rig({ models: { routes: { core: [route] } }, llm: { routeEffort: { core: 'high' } } });
  await client.complete(MESSAGES, { role: 'core' });
  const sent = optionsOf(asked, 0).chainRoute as { effort?: unknown; isThinking?: unknown };
  assert.equal(sent.effort, null);
  assert.equal(sent.isThinking, false);
});

test('a claude harness route at high runs at high with native thinking', async () => {
  // Catches: the no-effort rule for claude applied to every level, so a route at `high` loses its `--effort`.
  const route = { via: 'harness', backend: 'claude', model: 'claude-opus-4-6', effort: 'high' };
  const { client, asked } = rig({ models: { routes: { core: [route] } }, llm: { routeEffort: { core: 'disabled' } } });
  await client.complete(MESSAGES, { role: 'core' });
  const sent = optionsOf(asked, 0).chainRoute as { effort?: unknown; isThinking?: unknown };
  assert.equal(sent.effort, 'high');
  assert.equal(sent.isThinking, true);
});

test('an explicit disabled on a route wins over a default effort of llm.routeEffort', async () => {
  // Catches: a route the owner set to `:disabled` still sent with the role's default reasoning.
  const config = {
    models: { routes: { analyzer: [{ via: 'api', key: 'helpers', model: 'x/a', effort: 'disabled' }] } },
    llm: { routeEffort: { analyzer: 'high' } },
  };
  const { client, asked } = rig(config);
  await client.complete(MESSAGES, { role: 'analyzer' });
  assert.equal(optionsOf(asked, 0).reasoning, undefined);
});

test('a harness route whose effort is a level asks its run for native thinking, and disabled does not', async () => {
  // Changed: `disabled` on claude reaches the run as no effort, not `low`. The old expectation was wrong: `disabled`
  // means no native reasoning, claude turns that off with MAX_THINKING_TOKENS=0, and `--effort low` is a second
  // switch that shortens everything the model writes (the owner, 2026-11-15).
  // Catches: the memory writer unable to tell `disabled` from `low` once both reach it as `--effort low`, so a
  // disabled role thinks, or a role at `medium` runs with its thinking switched off.
  const route = { via: 'harness', backend: 'claude', model: 'claude-opus-4-6' };
  const medium = rig({ models: { routes: { memory: [route] } }, llm: { routeEffort: { memory: 'medium' } } });
  await medium.client.complete(MESSAGES, { role: 'memory' });
  const asked = optionsOf(medium.asked, 0).chainRoute as { effort?: unknown; isThinking?: unknown };
  assert.equal(asked.effort, 'medium');
  assert.equal(asked.isThinking, true);
  const disabled = rig({ models: { routes: { memory: [route] } }, llm: { routeEffort: { memory: 'disabled' } } });
  await disabled.client.complete(MESSAGES, { role: 'memory' });
  const off = optionsOf(disabled.asked, 0).chainRoute as { effort?: unknown; isThinking?: unknown };
  assert.equal(off.effort, null);
  assert.equal(off.isThinking, false);
});

test('a text role whose route and llm.routeEffort name no effort sends reasoning at medium', async () => {
  // Catches: a helper that answers in text (the analyzer, vision, video, quick search) left at the provider's own
  // default when the owner set no effort for it, instead of the engine's medium.
  for (const role of ['analyzer', 'vision', 'video', 'search']) {
    const config = {
      models: { routes: { [role]: [{ via: 'api', key: 'helpers', model: 'x/helper' }] } },
      llm: { routeEffort: { core: 'disabled' } },
    };
    const { client, asked } = rig(config);
    await client.complete(MESSAGES, { role });
    assert.deepEqual(optionsOf(asked, 0).reasoning, { effort: 'medium' }, role);
  }
});

test('a harness role that llm.routeEffort does not name runs its CLI at medium with native thinking', async () => {
  // Catches: the memory writer left at the CLI's own default when a deployment's llm.routeEffort omits memory.
  const route = { via: 'harness', backend: 'claude', model: 'claude-opus-4-6' };
  const { client, asked } = rig({ models: { routes: { memory: [route] } }, llm: { routeEffort: {} } });
  await client.complete(MESSAGES, { role: 'memory' });
  const sent = optionsOf(asked, 0).chainRoute as { effort?: unknown; isThinking?: unknown };
  assert.equal(sent.effort, 'medium');
  assert.equal(sent.isThinking, true);
});

test('a role that produces no text sends no reasoning when nothing names its effort', async () => {
  // Catches: the medium default sent as `reasoning` to an embedding, speech or image model, which takes no such field.
  for (const role of ['embedding', 'speech', 'drawing']) {
    const config = { models: { routes: { [role]: [{ via: 'api', key: 'helpers', model: 'x/media' }] } } };
    const { client, asked } = rig(config);
    await client.complete(MESSAGES, { role });
    assert.equal(optionsOf(asked, 0).reasoning, undefined, role);
  }
});

test("the diary's director role walks the analyzer's chain while it has no route, and its own once it has one", async () => {
  // Catches: a scene request with no route of its own refused as a role with no key, or kept on the analyzer after the
  // scene role got a route.
  const analyzer = [{ via: 'api', key: 'helpers', model: 'openai/gpt-6.1-sol' }];
  const fallback = rig({ models: { routes: { analyzer } } });
  await fallback.client.complete(MESSAGES, { role: 'director' });
  assert.deepEqual(optionsOf(fallback.asked, 0).routeKey, { name: 'helpers', value: KEYS.helpers });
  const own = rig({
    models: { routes: { analyzer, 'director': [{ via: 'api', key: 'spare', model: 'x/scene' }] } },
  });
  await own.client.complete(MESSAGES, { role: 'director' });
  assert.deepEqual(optionsOf(own.asked, 0).routeKey, { name: 'spare', value: KEYS.spare });
});

test('an API route sends the strict response format and a harness route sends none', async () => {
  // Catches: a harness run handed a response format it cannot enforce, or an API route that drops the schema.
  const format = { name: 'scene', schema: { type: 'object' } };
  const onKey = rig({ models: { routes: { 'director': [{ via: 'api', key: 'main', model: 'x/scene' }] } } });
  await onKey.client.complete(MESSAGES, { role: 'director', responseFormat: format });
  assert.deepEqual(optionsOf(onKey.asked, 0).responseFormat, format);
  const onHarness = rig({
    models: { routes: { 'director': [{ via: 'harness', backend: 'claude', model: 'claude-opus-4-8' }] } },
  });
  await onHarness.client.complete(MESSAGES, { role: 'director', responseFormat: format });
  assert.equal(viaOf(onHarness.asked, 0), 'harness');
  assert.equal(Object.hasOwn(optionsOf(onHarness.asked, 0), 'responseFormat'), false);
});
