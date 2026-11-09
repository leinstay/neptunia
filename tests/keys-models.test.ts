// The models src/keys/models.ts offers a role: OpenRouter's `/models` filtered by what the role takes in and gives back,
// and the table's lines of `model set`. The provider is a fake fetch.
// Changed: a model role is set as one route of its chain (spec 2026-11-09-model-routes, slice 4), whose text names its
// effort, and `/routes set` pins its providers, so the tests of `--provider`, `--effort` and the model dialog of the
// direct `model set` are deleted with them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listRoleModels } from '../src/keys/models.ts';
import { parseCommandLine } from '../src/interface/commands/table.ts';
import { BASE_URL, SECRET, fakeFetch, healthy } from './fixtures/keys-rig.ts';
import type { Call, Reply } from './fixtures/keys-rig.ts';

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
