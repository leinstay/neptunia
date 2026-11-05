// Speech and drawing behind `/keys check` and `model set`. Speech has a probe of its own: one short synthesis on its
// endpoint, as a real voice message goes out. A drawing cannot be probed for cents, because a request bills a whole
// picture, so its check answers an explicit `unsupported` and sends nothing. Neither is ever worded as a refused key:
// `failed` means the provider or the network said no. The provider is a fake fetch; a key never appears in an answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRole } from '../src/keys/check.ts';
import { createKeysCommands } from '../src/keys/commands.ts';
import { createKeyRing } from '../src/keys/ring.ts';
import { createKeyStore } from '../src/keys/store.ts';
import { createKeyFailover } from '../src/llm/key-failover.ts';
import { BASE_URL, SECRET, fakeFetch, fakePause, healthy } from './fixtures/keys-rig.ts';
import type { Call, Reply } from './fixtures/keys-rig.ts';
import { tempDir } from './fixtures/tmp.ts';

const T0 = Date.parse('2026-11-05T09:00:00Z');
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
  if (withKey) store.addCore({ name: 'core-1', value: SECRET });
  const ring = createKeyRing({ store, failover: createKeyFailover({ now: () => T0 }) });
  const { fetch, calls } = fakeFetch(answer);
  const saved: Array<[string, string]> = [];
  const keys = createKeysCommands({
    store,
    ring,
    fetch,
    baseUrl: () => BASE_URL,
    defaults: {},
    currentModel: () => model,
    speechVoice: () => 'voice-1',
    saveModel: (role, id) => {
      saved.push([role, id]);
      return Promise.resolve();
    },
    pause: fakePause(null),
  });
  return { keys, calls, saved };
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

test('a drawing check sends nothing and says the capability is unsupported, never that the key failed', async () => {
  // Bug: `no probe for the drawing role` prints as a failed check, and the owner replaces a working key.
  const { fetch, calls } = fakeFetch();
  const result = await checkRole({ ...input, fetch, role: 'drawing', model: 'x/draw' });
  assert.deepEqual(calls, []);
  assert.equal(result.ok, false);
  assert.equal(result.capability, 'unsupported');
  assert.equal(result.status, null);
  assert.equal(result.error, null);
});

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

test('/keys check drawing answers unsupported, which is not a failure', async () => {
  // Bug: the console turns the unimplemented check into exit 1 and the setup flow stops on it.
  const { keys, calls } = rig();
  const answer = await keys.run('keys.check', { role: 'drawing' }, null);
  assert.equal(answer.status, 'unsupported');
  assert.deepEqual(calls, []);
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

test('model set drawing saves the model unverified, since nothing can check it for cents', async () => {
  // Bug: the unimplemented check refuses every drawing model, so the role cannot be set from the chat at all.
  const { keys, calls, saved } = rig();
  const answer = await keys.run('model.set', { role: 'drawing', model: 'x/draw' }, null);
  assert.equal(answer.status, 'ok', answer.text);
  assert.deepEqual(saved, [['drawing', 'x/draw']]);
  assert.deepEqual(calls, []);
});
