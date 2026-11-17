// Speech and drawing behind `/keys check` and `model set`. Speech has a probe of its own: one short synthesis on its
// endpoint, as a real voice message goes out. A drawing request bills a whole picture, so the drawing check reads the
// provider's free listing of that one model instead and asks whether it has image output. A listing that
// cannot be read leaves the role unchecked, `unsupported`, and is never worded as a refused key. The provider is a fake fetch; a key never appears in an answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRole } from '../src/keys/check.ts';
import { createKeysCommands } from '../src/keys/commands.ts';
import { createKeyStore } from '../src/keys/store.ts';
import { BASE_URL, SECRET, chainRing, everyKeyChains, fakeFetch, fakePause, healthy } from './fixtures/keys-rig.ts';
import type { Call, Reply } from './fixtures/keys-rig.ts';
import { tempDir } from './fixtures/tmp.ts';

const input = { baseUrl: BASE_URL, keyName: 'core-1', value: SECRET };

/** The audio bytes OpenRouter answers a synthesis with. */
const AUDIO: Reply = { status: 200, body: 'ID3-synthetic-audio' };

function rig({
  answer = healthy,
  model = 'x/media',
  withKey = true,
}: { answer?: (call: Call) => Reply; model?: string; withKey?: boolean } = {}) {
  const privateDir = tempDir('keys-media-');
  const store = createKeyStore({ privateDir });
  if (withKey) store.add({ name: 'core-1', value: SECRET });
  // Changed: every role runs on its chain (slice 4); here every role's chain names every key of the store.
  const chainOf = everyKeyChains(store, (role) => `current/${role}`);
  const ring = chainRing(store, chainOf);
  const { fetch, calls } = fakeFetch(answer);
  const chains: Record<string, unknown> = {};
  const keys = createKeysCommands({
    store,
    ring,
    chainOf,
    saveRoutes: (role, routes) => {
      chains[role] = routes;
      return Promise.resolve();
    },
    fetch,
    baseUrl: () => BASE_URL,
    defaults: {},
    currentModel: () => model,
    speechVoice: () => 'voice-1',
    pause: fakePause(null),
  });
  return { keys, calls, chains };
}

test('the speech probe sends one short synthesis on the speech endpoint with the voice and the key', async () => {
  // Bug: a chat completion to a speech model fails on a healthy key, or a real voice message's length is billed.
  const { fetch, calls } = fakeFetch(() => AUDIO);
  const result = await checkRole({ ...input, fetch, role: 'speech', model: 'x/voice', voice: 'voice-1' });
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(calls.length, 1);
  assert.ok(calls[0]?.url.endsWith('/audio/speech'));
  assert.equal(calls[0]?.auth, SECRET);
  assert.equal(calls[0]?.body?.model, 'x/voice');
  assert.equal(calls[0]?.body?.voice, 'voice-1');
  assert.ok(String(calls[0]?.body?.input).length <= 8, 'a few characters, so a check costs next to nothing');
});

test('a provider that refuses the speech probe is a failed check with its status and without the key', async () => {
  // Bug: a revoked key on the speech role reads as "no probe", so the owner never learns the key is bad.
  const { fetch } = fakeFetch(() => ({ status: 401, body: { error: { message: `Invalid key ${SECRET}` } } }));
  const result = await checkRole({ ...input, fetch, role: 'speech', model: 'x/voice', voice: 'voice-1' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.capability, undefined);
  assert.match(result.error ?? '', /Invalid key/);
  assert.ok(!JSON.stringify(result).includes(SECRET));
});

/**
 * The provider as it lists models: each model's own listing under `/models/<id>/endpoints`, a drawing model and a text
 * model, 404 for any other id, and the list of all models, which holds the text model alone as the real one leaves out
 * a model that only makes pictures. A probe answer for anything else.
 */
function listing(call: Call): Reply {
  const own = (output: string): Reply => ({
    status: 200,
    body: { data: { architecture: { input_modalities: ['text'], output_modalities: [output] }, endpoints: [{}] } },
  });
  if (call.url.endsWith('/models/x/draw/endpoints')) return own('image');
  if (call.url.endsWith('/models/x/text/endpoints')) return own('text');
  if (call.url.endsWith('/endpoints')) return { status: 404, body: { error: { message: 'no such model' } } };
  if (call.url.endsWith('/models'))
    return {
      status: 200,
      body: { data: [{ id: 'x/text', architecture: { input_modalities: ['text'], output_modalities: ['text'] } }] },
    };
  return healthy(call);
}

test('a drawing check passes on a model the listing holds with image output and requests no picture', async () => {
  // Bug: the check sends a generation and bills a whole picture, or refuses a model that draws.
  const { fetch, calls } = fakeFetch(listing);
  const result = await checkRole({ ...input, fetch, role: 'drawing', model: 'x/draw' });
  assert.equal(result.ok, true);
  assert.equal(result.capability, undefined);
  // Changed: the list of all models leaves out a model that only makes pictures, so the check reads the model's own
  // listing. On a live deployment the check of a working drawing model failed against the list of all models.
  assert.deepEqual(
    calls.map((call) => [call.method, call.url.slice(BASE_URL.length)]),
    [['GET', '/models/x/draw/endpoints']]
  );
});

test('a drawing check fails with the reason on a model the provider does not list', async () => {
  // Bug: a mistyped model id is saved as the drawing model and every drawing fails later.
  const { fetch } = fakeFetch(listing);
  const result = await checkRole({ ...input, fetch, role: 'drawing', model: 'x/none' });
  assert.equal(result.ok, false);
  assert.equal(result.capability, undefined);
  assert.match(result.error ?? '', /does not list/);
});

test('a drawing check fails with the reason on a model the listing holds with text output only', async () => {
  // Bug: a text model is saved as the drawing model and every drawing fails later.
  const { fetch } = fakeFetch(listing);
  const result = await checkRole({ ...input, fetch, role: 'drawing', model: 'x/text' });
  assert.equal(result.ok, false);
  assert.equal(result.capability, undefined);
  assert.match(result.error ?? '', /no image output/);
});

for (const [name, answer] of [
  ['answers 401', () => ({ status: 401, body: { error: { message: 'no' } } })],
  [
    'throws',
    () => {
      throw new Error('offline');
    },
  ],
] as const) {
  test(`a drawing check leaves the role unchecked when the listing ${name}`, async () => {
    // Bug: a listing the provider did not give refuses a working drawing model.
    const { fetch } = fakeFetch(answer);
    const result = await checkRole({ ...input, fetch, role: 'drawing', model: 'x/draw' });
    assert.equal(result.ok, false);
    assert.equal(result.capability, 'unsupported');
    assert.equal(result.error, null);
  });
}

test('a role with no probe at all is unsupported as well', async () => {
  // Bug: the fallthrough of the check labels every unimplemented role as a failure of its credentials.
  const { fetch, calls } = fakeFetch();
  const result = await checkRole({ ...input, fetch, role: 'nosuch', model: 'x/any' });
  assert.deepEqual(calls, []);
  assert.equal(result.capability, 'unsupported');
  assert.equal(result.error, null);
});

test('/keys check speech goes out on the role key with the configured voice and answers ok', async () => {
  // Bug: the command path knows no voice, so the enabled role still cannot be checked from the chat.
  const { keys, calls } = rig({ answer: () => AUDIO });
  const answer = await keys.run('keys.check', { role: 'speech' }, null);
  assert.equal(answer.status, 'ok', answer.text);
  assert.equal(calls[0]?.body?.voice, 'voice-1');
});

test('/keys check drawing answers ok on a model the listing holds with image output', async () => {
  // Changed: the drawing check reads the free listing, so a drawing model is checked like any role.
  const { keys } = rig({ answer: listing, model: 'x/draw' });
  const answer = await keys.run('keys.check', { role: 'drawing' }, null);
  assert.equal(answer.status, 'ok', answer.text);
});

for (const role of ['speech', 'drawing']) {
  test(`/keys check ${role} on a role switched off says off and sends nothing`, async () => {
    // Bug: a role the owner left off is checked with an empty model and reads as a broken key.
    const { keys, calls } = rig({ model: '' });
    const answer = await keys.run('keys.check', { role }, null);
    assert.equal(answer.status, 'not_configured');
    assert.deepEqual(calls, []);
  });
}

test('model set drawing changes nothing and says why on a model with no image output', async () => {
  // Bug: a text model is written as the drawing route and every drawing fails later.
  const { keys, chains } = rig({ answer: listing });
  const answer = await keys.run('model.set', { role: 'drawing', model: 'core-1/x/text' }, null);
  assert.equal(answer.status, 'failed');
  assert.match(answer.text, /no image output/);
  assert.equal(chains.drawing, undefined);
});

test('model set drawing writes the route unchecked when the listing cannot be read', async () => {
  // Changed: the check reads the listing; a listing that is refused leaves the role as unchecked as before.
  const { keys, calls, chains } = rig({ answer: () => ({ status: 401, body: {} }) });
  const answer = await keys.run('model.set', { role: 'drawing', model: 'core-1/x/draw' }, null);
  assert.equal(answer.status, 'ok', answer.text);
  assert.deepEqual(chains.drawing, [{ via: 'api', key: 'core-1', model: 'x/draw', effort: null }]);
  // Changed: the request is the model's own listing (see the passing check above).
  assert.deepEqual(
    calls.map((call) => call.url.slice(BASE_URL.length)),
    ['/models/x/draw/endpoints']
  );
});
