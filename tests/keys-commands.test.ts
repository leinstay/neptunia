// Tests for src/keys/commands.ts, the commands of `keys core|extra|bind|unbind|check` and `model set`, and for their
// lines in the command table. The store is a temp folder, the provider a fake fetch, the chat a scripted dialog, the
// pause a fake that keeps its reason. The tests assert on what is saved, sent and paused, and on a key value never
// appearing in an answer; the wording of an answer is not tested.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createKeysCommands, reasonedPause } from '../src/keys/commands.ts';
import { createAdmin } from '../src/admin.ts';
import { makeStore } from './fixtures/admin-store.ts';
import { createKeyRing } from '../src/keys/ring.ts';
import { createKeyStore, KEYS_FILE } from '../src/keys/store.ts';
import { createKeyFailover } from '../src/llm/key-failover.ts';
import { parseCommandLine } from '../src/interface/commands/table.ts';
import {
  BASE_URL,
  SECRET,
  SECRET_2,
  SECRET_3,
  fakeFetch,
  fakePause,
  healthy,
  scriptedDialog,
} from './fixtures/keys-rig.ts';
import type { Call, Reply } from './fixtures/keys-rig.ts';
import { tempDir } from './fixtures/tmp.ts';

const T0 = Date.parse('2026-11-02T09:00:00Z');
const MANDATORY = ['core', 'memory', 'analyzer', 'embedding'];
const DEFAULTS = Object.fromEntries(MANDATORY.map((role) => [role, `default/${role}`]));

function rig(answer: (call: Call) => Reply = healthy, paused: string | null = null) {
  const privateDir = tempDir('keys-commands-');
  const store = createKeyStore({ privateDir });
  const ring = createKeyRing({ store, failover: createKeyFailover({ now: () => T0 }) });
  const { fetch, calls } = fakeFetch(answer);
  const pause = fakePause(paused);
  const saved: Array<[string, string]> = [];
  const keys = createKeysCommands({
    store,
    ring,
    fetch,
    baseUrl: () => BASE_URL,
    defaults: DEFAULTS,
    currentModel: (role) => `current/${role}`,
    saveModel: (role, model) => {
      saved.push([role, model]);
      return Promise.resolve();
    },
    pause,
  });
  return { keys, store, calls, pause, saved, file: path.join(privateDir, KEYS_FILE) };
}

const BLANKS = ['', '', '', ''];

test('the first core add asks the value without echo, then the four models with the defaults offered, and checks each', async () => {
  const { keys, store, calls, saved } = rig();
  const { dialog, asked } = scriptedDialog([SECRET, 'custom/core', '', '', '']);
  const answer = await keys.run('keys.add', { name: 'core-1' }, dialog);
  assert.equal(answer.status, 'ok');
  assert.equal(asked[0]?.secret, true, 'the value is asked as a secret');
  // Bug caught: asking the models in another order, or without the tracked default on offer.
  MANDATORY.forEach((role, i) =>
    assert.ok(asked[i + 1]?.question.includes(role), `question ${i + 1} is about ${role}`)
  );
  assert.ok(asked[2]?.question.includes('default/memory'), 'the default is shown');
  assert.deepEqual(saved, [
    ['core', 'custom/core'],
    ['memory', 'default/memory'],
    ['analyzer', 'default/analyzer'],
    ['embedding', 'default/embedding'],
  ]);
  assert.deepEqual(store.coreNames(), ['core-1']);
  assert.deepEqual(calls.map((call) => call.body?.model).sort(), [
    'custom/core',
    'default/analyzer',
    'default/embedding',
    'default/memory',
  ]);
  assert.ok(
    calls.every((call) => call.auth === SECRET),
    'every probe goes out on the new key'
  );
  assert.ok(answer.text.includes('0.03'), 'the cost of the four requests is reported');
  assert.ok(!answer.text.includes('SECRETVALUE'));
});

test('the first core add refuses to finish when one mandatory model fails its check, and saves nothing', async () => {
  const echo = (call: Call): Reply =>
    call.url.endsWith('/embeddings')
      ? { status: 404, body: { error: { message: `No such model for key ${SECRET}` } } }
      : healthy(call);
  const { keys, store, saved, file } = rig(echo);
  const { dialog } = scriptedDialog([SECRET, ...BLANKS]);
  const answer = await keys.run('keys.add', { name: 'core-1' }, dialog);
  // Bug caught: the key written before the checks run, so a fresh install ends half-configured with a model that fails.
  assert.equal(answer.status, 'failed');
  assert.ok(
    answer.text.includes('embedding') && answer.text.includes('default/embedding'),
    'names the role and model that failed'
  );
  assert.ok(!answer.text.includes('SECRETVALUE'), 'the provider echoed the key; the answer must not');
  assert.deepEqual(saved, [], 'no model is saved');
  assert.deepEqual(store.coreNames(), []);
  assert.equal(fs.existsSync(file), false);
});

test('a first add with no dialog, an empty value or a pasted line sends nothing and saves nothing', async () => {
  const { keys, calls, store } = rig();
  assert.equal((await keys.run('keys.add', { name: 'core-1' }, null)).status, 'invalid');
  assert.equal((await keys.run('keys.add', { name: 'core-1' }, scriptedDialog(['  ']).dialog)).status, 'invalid');
  const pasted = await keys.run('keys.add', { name: `core-1 ${SECRET}` }, scriptedDialog([SECRET, ...BLANKS]).dialog);
  // Bug caught: the owner pastes the key after the name; the refusal echoes the line and the key reaches the screen and the log.
  assert.equal(pasted.status, 'invalid');
  assert.ok(!pasted.text.includes('SECRETVALUE'));
  assert.deepEqual(calls, []);
  assert.deepEqual(store.coreNames(), []);
});

test('a later core add checks the key with /auth/key only, trims the paste, and saves it', async () => {
  const { keys, store, calls } = rig();
  store.addCore({ name: 'core-1', value: SECRET });
  const answer = await keys.run('keys.add', { name: 'core-2' }, scriptedDialog([`  ${SECRET_2}\n`]).dialog);
  assert.equal(answer.status, 'ok');
  assert.equal(calls.length, 1, 'one request');
  assert.ok(calls[0]?.url.endsWith('/auth/key'));
  // Bug caught: the trailing newline of a paste stored with the key, so every request of it fails with a bad header.
  assert.equal(store.valueOf('core-2'), SECRET_2);
});

test('a later core add whose key /auth/key rejects is not saved', async () => {
  const { keys, store } = rig((call) =>
    call.url.endsWith('/auth/key') ? { status: 401, body: { error: { message: 'User not found.' } } } : healthy(call)
  );
  store.addCore({ name: 'core-1', value: SECRET });
  const answer = await keys.run('keys.add', { name: 'core-2' }, scriptedDialog([SECRET_2]).dialog);
  assert.equal(answer.status, 'failed');
  assert.deepEqual(store.coreNames(), ['core-1']);
});

test('a name already in use is refused before the value is asked or anything is sent', async () => {
  const { keys, store, calls } = rig();
  store.addCore({ name: 'core-1', value: SECRET });
  const { dialog, asked } = scriptedDialog([SECRET_2]);
  const answer = await keys.run('keys.add', { name: 'core-1' }, dialog);
  assert.equal(answer.status, 'invalid');
  assert.deepEqual(asked, []);
  assert.deepEqual(calls, []);
});

test('removing the last core key pauses her as no-core-route; removing another key does not', async () => {
  // Changed: `/keys remove` replaces `/keys core remove`, and the pause is named for a core with no route.
  const { keys, store, pause } = rig();
  store.addCore({ name: 'core-1', value: SECRET });
  store.addCore({ name: 'core-2', value: SECRET_2 });
  assert.equal((await keys.run('keys.remove', { name: 'core-2' }, null)).status, 'ok');
  assert.deepEqual(pause.pauses, [], 'one key is still there');
  assert.equal((await keys.run('keys.remove', { name: 'core-1' }, null)).status, 'ok');
  // Bug caught: the last removal refused, or allowed without the pause, so she keeps answering with no key to answer on.
  assert.deepEqual(pause.pauses, ['no-core-route']);
  assert.deepEqual(store.coreNames(), []);
  assert.equal((await keys.run('keys.remove', { name: 'core-1' }, null)).status, 'invalid', 'an unknown name');
});

test('the next core add resumes a no-core-route pause, and leaves a pause the owner gave alone', async () => {
  const afterRemoval = rig(healthy, 'no-core-route');
  await afterRemoval.keys.run('keys.add', { name: 'core-1' }, scriptedDialog([SECRET, ...BLANKS]).dialog);
  assert.equal(afterRemoval.pause.resumes, 1);

  const owner = rig(healthy, 'owner');
  owner.store.addCore({ name: 'core-1', value: SECRET });
  await owner.keys.run('keys.add', { name: 'core-2' }, scriptedDialog([SECRET_2]).dialog);
  // Bug caught: adding a key undoing a pause the owner set for editing data/.
  assert.equal(owner.pause.resumes, 0);
});

test('an owner pause given over no-core-route stays when the next core key is added', async () => {
  // Catches: the owner's /pause after the last key's removal keeps the reason no-core-route, so the next add wakes her
  // while he edits data/.
  const state = makeStore();
  const admin = createAdmin({ hot: { config: { bot: { owners: [] } }, prompts: {} }, store: state });
  const privateDir = tempDir('keys-commands-');
  const store = createKeyStore({ privateDir });
  const ring = createKeyRing({ store, failover: createKeyFailover({ now: () => T0 }) });
  const pause = reasonedPause({ run: (op, args) => admin.run(op, args, {}), store: state });
  const keys = createKeysCommands({
    store,
    ring,
    fetch: fakeFetch().fetch,
    baseUrl: () => BASE_URL,
    defaults: DEFAULTS,
    currentModel: (role) => `current/${role}`,
    saveModel: () => Promise.resolve(),
    pause,
  });
  store.addCore({ name: 'core-1', value: SECRET });
  // Changed: `/keys remove`; the next add of a non-empty keys.json goes in as a named key, with no models asked.
  store.addExtra({ name: 'spare', value: SECRET_3 });
  await keys.run('keys.remove', { name: 'core-1' }, null);
  assert.equal(pause.reason(), 'no-core-route');
  await admin.run('bot.pause', {}, {});
  await keys.run('keys.add', { name: 'core-2' }, scriptedDialog([SECRET_2]).dialog);
  assert.equal(store.valueOf('core-2'), SECRET_2);
  assert.equal(state.state.data.paused, true);
  assert.equal(pause.reason(), 'owner');
});

test('a failed add does not resume the no-core-route pause', async () => {
  const { keys, pause } = rig(
    (call) => (call.url.endsWith('/embeddings') ? { status: 404, body: 'gone' } : healthy(call)),
    'no-core-route'
  );
  await keys.run('keys.add', { name: 'core-1' }, scriptedDialog([SECRET, ...BLANKS]).dialog);
  assert.equal(pause.resumes, 0);
});

test('the listing shows every key by name and last four characters, never a value', async () => {
  // Changed: one `/keys list` of named keys replaces the core and extra listings and their grants.
  const { keys, store } = rig();
  store.addCore({ name: 'core-1', value: SECRET });
  store.addExtra({ name: 'art', value: SECRET_3 });
  const answer = await keys.run('keys.list', {}, null);
  assert.equal(answer.status, 'ok');
  // Bug caught: a listing that prints the stored row, value and all.
  assert.ok(!answer.text.includes('SECRETVALUE'), 'no value');
  assert.ok(answer.text.includes('core-1') && answer.text.includes('WXYZ'), answer.text);
  assert.ok(answer.text.includes('art') && answer.text.includes('EFGH'), answer.text);
});

test("keys check sends one request on the role's own key and names model, key name and is_byok", async () => {
  const byok =
    (is: boolean) =>
    (call: Call): Reply =>
      call.url.endsWith('/chat/completions')
        ? { status: 200, body: { choices: [{ message: { content: 'ok' } }], usage: { cost: 0.01, is_byok: is } } }
        : healthy(call);
  const bound = rig(byok(true));
  bound.store.addCore({ name: 'core-1', value: SECRET });
  bound.store.addExtra({ name: 'art', value: SECRET_3 });
  bound.store.bind('vision', 'art');
  const onExtra = await bound.keys.run('keys.check', { role: 'vision' }, null);
  assert.equal(onExtra.status, 'ok');
  assert.equal(bound.calls.length, 1);
  assert.equal(bound.calls[0]?.auth, SECRET_3, 'the bound key, not the core key');
  assert.equal(bound.calls[0]?.body?.model, 'current/vision');
  assert.ok(onExtra.text.includes('current/vision') && onExtra.text.includes('art'));

  const plain = rig(byok(false));
  plain.store.addCore({ name: 'core-1', value: SECRET });
  plain.store.addExtra({ name: 'art', value: SECRET_3 });
  plain.store.bind('vision', 'art');
  const notByok = await plain.keys.run('keys.check', { role: 'vision' }, null);
  // Bug caught: the answer not saying whether the key was used as BYOK, the one thing the check exists to prove.
  assert.notEqual(onExtra.text, notByok.text, 'is_byok true and false read differently');
  assert.ok(!onExtra.text.includes('SECRETVALUE') && !notByok.text.includes('SECRETVALUE'));
});

test('keys check with no key for the role fails without sending anything', async () => {
  const { keys, calls } = rig();
  const answer = await keys.run('keys.check', { role: 'core' }, null);
  assert.equal(answer.status, 'failed');
  assert.deepEqual(calls, []);
});

test("model set checks the model on the role's key first and saves only a model that answers", async () => {
  const gone = (call: Call): Reply =>
    call.body?.model === 'x/gone' ? { status: 404, body: { error: { message: 'No endpoints found' } } } : healthy(call);
  const { keys, store, saved, calls } = rig(gone);
  store.addCore({ name: 'core-1', value: SECRET });
  const refused = await keys.run('model.set', { role: 'analyzer', model: 'x/gone' }, null);
  // Bug caught: saving the model first and finding out on the next turn that every analyzer request fails.
  assert.equal(refused.status, 'failed');
  assert.deepEqual(saved, []);
  const accepted = await keys.run('model.set', { role: 'analyzer', model: 'x/fine' }, null);
  assert.equal(accepted.status, 'ok');
  assert.deepEqual(saved, [['analyzer', 'x/fine']]);
  assert.ok(calls.every((call) => call.auth === SECRET));
});

test('model set for an errand or development role saves at once: its ids are not OpenRouter model ids', async () => {
  const { keys, saved, calls } = rig();
  for (const role of ['scout', 'server', 'thinker', 'dev'])
    assert.equal((await keys.run('model.set', { role, model: 'openrouter/x/model' }, null)).status, 'ok', role);
  // Bug caught: a chat completion sent for an OpenCode id, which OpenRouter answers with 404 and blocks the change.
  assert.deepEqual(calls, []);
  assert.equal(saved.length, 4);
});

test('the table parses the keys commands to the names and arguments the commands answer to', () => {
  const parsed = (line: string) => {
    const result = parseCommandLine(line);
    return result.ok ? { name: result.name, args: result.args } : result.reason;
  };
  const refused = (line: string): boolean => !parseCommandLine(line).ok;
  // Changed: the named-key commands replace `core`, `extra`, `bind` and `unbind`, and `check` takes a role or a key.
  assert.deepEqual(parsed('/keys add core-1'), { name: 'keys.add', args: { name: 'core-1' } });
  assert.deepEqual(parsed('/keys remove core-1'), { name: 'keys.remove', args: { name: 'core-1' } });
  assert.deepEqual(parsed('/keys list'), { name: 'keys.list', args: {} });
  assert.deepEqual(parsed('/keys check vision'), { name: 'keys.check', args: { target: 'vision' } });
  assert.deepEqual(parsed('/model set vision x/y'), { name: 'model.set', args: { role: 'vision', model: 'x/y' } });
  for (const line of ['/keys', '/keys bind drawing art', '/keys check', '/keys add'])
    assert.equal(refused(line), true, `${line} is refused with a reason`);
});
