// The direct path of `model set <role> <model> [--provider <slug>] [--effort <level>]` (src/keys/commands.ts,
// src/keys/models.ts, spec 2026-11-02 PR 5 "A path per role"): `--provider` writes the role's `llm.providerByModel`
// route with `byok` kept, `--effort` writes `llm.reasoningByRole.<role>`, each only after the one-request check passed
// with that provider or effort in its body; the dialog offers OpenRouter's `/models` filtered by role. The store is a
// temp folder, the provider a fake fetch, the saves fakes that record what they were given.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKeysCommands } from '../src/keys/commands.ts';
import type { Dialog } from '../src/keys/commands.ts';
import { listRoleModels } from '../src/keys/models.ts';
import { createKeyRing } from '../src/keys/ring.ts';
import { createKeyStore } from '../src/keys/store.ts';
import { createKeyFailover } from '../src/llm/key-failover.ts';
import { parseCommandLine } from '../src/interface/commands/table.ts';
import { BASE_URL, SECRET, fakeFetch, fakePause, healthy } from './fixtures/keys-rig.ts';
import type { Call, Reply } from './fixtures/keys-rig.ts';
import { tempDir } from './fixtures/tmp.ts';

const T0 = Date.parse('2026-11-02T09:00:00Z');

/** OpenRouter's `/models`: one model of each kind a role filter tells apart. */
const CATALOG = {
  data: [
    { id: 'v/text', architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
    { id: 'v/seeing', architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } },
    { id: 'v/watching', architecture: { input_modalities: ['text', 'image', 'video'], output_modalities: ['text'] } },
    { id: 'v/painter', architecture: { input_modalities: ['text', 'image'], output_modalities: ['image'] } },
    { id: 'v/voice', architecture: { input_modalities: ['text'], output_modalities: ['audio'] } },
    { id: 'v/vectors', architecture: { input_modalities: ['text'], output_modalities: ['embeddings'] } },
  ],
};

/** Healthy, with the catalog on `/models` and a 404 for the model `x/gone`. */
function provider(call: Call): Reply {
  if (call.url.endsWith('/models')) return { status: 200, body: CATALOG };
  if (call.body?.model === 'x/gone') return { status: 404, body: { error: { message: 'No endpoints found' } } };
  return healthy(call);
}

type Rig = {
  run: (
    args: Record<string, unknown>,
    dialog?: Dialog | null
  ) => ReturnType<ReturnType<typeof createKeysCommands>['run']>;
  calls: Array<Call>;
  models: Array<[string, string]>;
  routes: Array<[string, Record<string, unknown>]>;
  settings: Array<[string, unknown]>;
};

/** Key commands over one core key, the live routes given, and fake saves; `withSaves: false` leaves the new saves out. */
function rig(liveRoutes: Record<string, unknown> = {}, withSaves = true): Rig {
  const store = createKeyStore({ privateDir: tempDir('keys-direct-') });
  store.addCore({ name: 'core-1', value: SECRET });
  const ring = createKeyRing({ store, failover: createKeyFailover({ now: () => T0 }) });
  const { fetch, calls } = fakeFetch(provider);
  const models: Rig['models'] = [];
  const routes: Rig['routes'] = [];
  const settings: Rig['settings'] = [];
  const keys = createKeysCommands({
    store,
    ring,
    fetch,
    baseUrl: () => BASE_URL,
    defaults: {},
    currentModel: (role) => `current/${role}`,
    saveModel: (role, model) => {
      models.push([role, model]);
      return Promise.resolve();
    },
    pause: fakePause(),
    ...(withSaves
      ? {
          routes: () => liveRoutes,
          saveRoute: (key: string, value: Record<string, unknown>) => {
            routes.push([key, value]);
            return Promise.resolve();
          },
          saveSetting: (path: string, value: unknown) => {
            settings.push([path, value]);
            return Promise.resolve();
          },
        }
      : {}),
  });
  return { run: (args, dialog = null) => keys.run('model.set', args, dialog), calls, models, routes, settings };
}

const chatCalls = (calls: Array<Call>): Array<Call> => calls.filter((call) => call.url.endsWith('/chat/completions'));

// --provider

test('a provider writes the route of that model for that role after a check through that provider', async () => {
  // Catches: the route saved without a check, or the check sent through OpenRouter's own pick of provider.
  const { run, calls, routes, models } = rig();
  const answer = await run({ role: 'analyzer', model: 'openai/gpt-6.1-sol', provider: 'openai' });
  assert.equal(answer.status, 'ok');
  const [check] = chatCalls(calls);
  assert.deepEqual((check?.body?.provider as { only?: unknown } | undefined)?.only, ['openai']);
  assert.deepEqual(routes, [['openai/gpt-6.1-sol@analyzer', { only: ['openai'], allow_fallbacks: false }]]);
  assert.deepEqual(models, [['analyzer', 'openai/gpt-6.1-sol']]);
});

test('a provider keeps byok true from the route that applies to the model now', async () => {
  // Catches: a provider change silently drops byok, and the role starts spending OpenRouter credit unnoticed.
  const { run, routes, calls } = rig({ 'anthropic/': { only: ['anthropic'], byok: true } });
  await run({ role: 'memory', model: 'anthropic/claude-opus-4.6', provider: 'amazon-bedrock' });
  assert.deepEqual(routes, [
    ['anthropic/claude-opus-4.6@memory', { only: ['amazon-bedrock'], allow_fallbacks: false, byok: true }],
  ]);
  const [check] = chatCalls(calls);
  assert.equal(Object.hasOwn((check?.body?.provider as object | undefined) ?? {}, 'byok'), false);
});

test('a provider on a model with no route writes no byok', async () => {
  // Catches: byok true written by default, so every answer from OpenRouter capacity throws not-byok.
  const { run, routes } = rig();
  await run({ role: 'vision', model: 'google/gemini-3.8-flash', provider: 'google-vertex' });
  assert.equal(routes.length, 1);
  assert.equal(Object.hasOwn(routes[0]?.[1] ?? {}, 'byok'), false);
});

test('a provider whose check fails writes no route and no model', async () => {
  // Catches: the route written before the check, which leaves the role pinned to a provider that cannot serve it.
  const { run, routes, models, calls } = rig();
  const answer = await run({ role: 'analyzer', model: 'x/gone', provider: 'openai' });
  assert.equal(answer.status, 'failed');
  assert.deepEqual((chatCalls(calls)[0]?.body?.provider as { only?: unknown } | undefined)?.only, ['openai']);
  assert.deepEqual(routes, []);
  assert.deepEqual(models, []);
});

test('a provider slug with other characters is refused before anything is sent', async () => {
  // Catches: "OpenAI, Azure" written as one slug, which OpenRouter matches to no provider and every request fails.
  const { run, calls, routes } = rig();
  const answer = await run({ role: 'analyzer', model: 'openai/gpt-6.1-sol', provider: 'OpenAI,azure' });
  assert.equal(answer.status, 'invalid');
  assert.equal(answer.code, 'bad-provider');
  assert.deepEqual(calls, []);
  assert.deepEqual(routes, []);
});

test('a provider without a route writer answers failed and sends nothing', async () => {
  // Catches: the check spent and the model saved while the route the owner asked for is silently dropped.
  const { run, calls, models } = rig({}, false);
  const answer = await run({ role: 'analyzer', model: 'openai/gpt-6.1-sol', provider: 'openai' });
  assert.equal(answer.status, 'failed');
  assert.deepEqual(calls, []);
  assert.deepEqual(models, []);
});

// --effort

test('an effort writes the reasoning setting of the role after a check that carries it', async () => {
  // Catches: the effort saved without a check, or a model that refuses reasoning accepted because the check sent none.
  const { run, calls, settings } = rig();
  const answer = await run({ role: 'analyzer', model: 'openai/gpt-6.1-sol', effort: 'high' });
  assert.equal(answer.status, 'ok');
  assert.deepEqual(chatCalls(calls)[0]?.body?.reasoning, { effort: 'high' });
  assert.deepEqual(settings, [['llm.reasoningByRole.analyzer', { effort: 'high' }]]);
});

test('an effort whose check fails saves no setting and no model', async () => {
  // Catches: the effort written before the check and left on a role whose model change was refused.
  const { run, settings, models, calls } = rig();
  await run({ role: 'analyzer', model: 'x/gone', effort: 'low' });
  assert.deepEqual(chatCalls(calls)[0]?.body?.reasoning, { effort: 'low' });
  assert.deepEqual(settings, []);
  assert.deepEqual(models, []);
});

test('an effort that is no level is refused before anything is sent', async () => {
  // Catches: "xhigh" written into the setting, which a provider refuses on every later request of the role.
  const { run, calls, settings } = rig();
  const answer = await run({ role: 'analyzer', model: 'openai/gpt-6.1-sol', effort: 'xhigh' });
  assert.equal(answer.code, 'unknown-effort');
  assert.deepEqual(calls, []);
  assert.deepEqual(settings, []);
});

test('an effort on a role without reasoning is refused before anything is sent', async () => {
  // Catches: a reasoning setting on the embedding or drawing role, whose endpoints take no reasoning at all.
  for (const role of ['embedding', 'speech', 'drawing']) {
    const { run, calls, settings } = rig();
    const answer = await run({ role, model: 'v/any', effort: 'low' });
    assert.equal(answer.code, 'effort-unsupported', role);
    assert.deepEqual(calls, [], role);
    assert.deepEqual(settings, [], role);
  }
});

test('an effort on the core is refused: the core never uses provider reasoning', async () => {
  // Catches: provider reasoning switched on for her replies, which the owner ruled out (her thinking is her <think>).
  const { run, calls } = rig();
  const answer = await run({ role: 'core', model: 'anthropic/claude-opus-4.6', effort: 'low' });
  assert.equal(answer.code, 'effort-unsupported');
  assert.deepEqual(calls, []);
});

// the model list

test('the text roles are offered the models with text in and text out', async () => {
  // Catches: an image or embedding model offered for the analyzer, which fails its first classification.
  const { fetch } = fakeFetch(provider);
  for (const role of ['core', 'memory', 'analyzer'])
    assert.deepEqual(await listRoleModels({ fetch, baseUrl: BASE_URL, value: SECRET }, role), [
      'v/text',
      'v/seeing',
      'v/watching',
    ]);
});

test('vision is offered the models that take images and video the models that take video', async () => {
  // Catches: a text-only model offered for vision, which answers every picture without seeing it.
  const { fetch } = fakeFetch(provider);
  const input = { fetch, baseUrl: BASE_URL, value: SECRET };
  assert.deepEqual(await listRoleModels(input, 'vision'), ['v/seeing', 'v/watching']);
  assert.deepEqual(await listRoleModels(input, 'video'), ['v/watching']);
});

test('drawing, speech and embedding are each offered the models of their output', async () => {
  // Catches: chat models offered for drawing, speech or embedding, whose endpoints refuse them.
  const { fetch } = fakeFetch(provider);
  const input = { fetch, baseUrl: BASE_URL, value: SECRET };
  assert.deepEqual(await listRoleModels(input, 'drawing'), ['v/painter']);
  assert.deepEqual(await listRoleModels(input, 'speech'), ['v/voice']);
  assert.deepEqual(await listRoleModels(input, 'embedding'), ['v/vectors']);
});

test('an unreadable model list is empty', async () => {
  // Catches: a failed /models throws out of the dialog, so the owner cannot type a model either.
  const { fetch } = fakeFetch(() => ({ status: 500, body: 'down' }));
  assert.deepEqual(await listRoleModels({ fetch, baseUrl: BASE_URL, value: SECRET }, 'analyzer'), []);
});

test('model set with no model asks with the role list and saves a checked answer from outside it', async () => {
  // Catches: the list used as a whitelist, so a model OpenRouter lists under another modality cannot be chosen.
  const { run, models } = rig();
  const offered: Array<ReadonlyArray<string> | undefined> = [];
  const dialog: Dialog = {
    ask: (_question, options) => {
      offered.push(options?.choices);
      return Promise.resolve('x/typed-by-hand');
    },
  };
  const answer = await run({ role: 'video' }, dialog);
  assert.equal(answer.status, 'ok');
  assert.deepEqual(offered, [['v/watching']]);
  assert.deepEqual(models, [['video', 'x/typed-by-hand']]);
});

// the table

test('the table parses model set with a provider and an effort', () => {
  // Catches: the flags refused as unknown, so neither setting can be given from the chat.
  const parsed = parseCommandLine('/model set analyzer openai/gpt-6.1-sol --provider openai --effort high');
  assert.equal(parsed.ok, true);
  if (parsed.ok)
    assert.deepEqual(parsed.args, {
      role: 'analyzer',
      model: 'openai/gpt-6.1-sol',
      provider: 'openai',
      effort: 'high',
    });
});

test('the table parses model set for the memory role', () => {
  // Catches: "memory" refused as no model role, so the memory writer's model and key path cannot be set.
  const parsed = parseCommandLine('/model set memory anthropic/claude-opus-4.6');
  assert.equal(parsed.ok, true);
});
