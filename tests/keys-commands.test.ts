// Tests for src/keys/commands.ts, the commands of `keys core|extra|bind|unbind|check` and `model set`, and for their
// lines in the command table. The store is a temp folder, the provider a fake fetch, the chat a scripted dialog, the
// pause a fake that keeps its reason. The tests assert on what is saved, sent and paused, and on a key value never
// appearing in an answer; the wording of an answer is not tested.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createKeysCommands } from '../src/keys/commands.ts';
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
  const answer = await keys.run('keys.core.add', { name: 'core-1' }, dialog);
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
  const answer = await keys.run('keys.core.add', { name: 'core-1' }, dialog);
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
  assert.equal((await keys.run('keys.core.add', { name: 'core-1' }, null)).status, 'invalid');
  assert.equal((await keys.run('keys.core.add', { name: 'core-1' }, scriptedDialog(['  ']).dialog)).status, 'invalid');
  const pasted = await keys.run(
    'keys.core.add',
    { name: `core-1 ${SECRET}` },
    scriptedDialog([SECRET, ...BLANKS]).dialog
  );
  // Bug caught: the owner pastes the key after the name; the refusal echoes the line and the key reaches the screen and the log.
  assert.equal(pasted.status, 'invalid');
  assert.ok(!pasted.text.includes('SECRETVALUE'));
  assert.deepEqual(calls, []);
  assert.deepEqual(store.coreNames(), []);
});

test('a later core add checks the key with /auth/key only, trims the paste, and saves it', async () => {
  const { keys, store, calls } = rig();
  store.addCore({ name: 'core-1', value: SECRET });
  const answer = await keys.run('keys.core.add', { name: 'core-2' }, scriptedDialog([`  ${SECRET_2}\n`]).dialog);
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
  const answer = await keys.run('keys.core.add', { name: 'core-2' }, scriptedDialog([SECRET_2]).dialog);
  assert.equal(answer.status, 'failed');
  assert.deepEqual(store.coreNames(), ['core-1']);
});

test('a name already in use is refused before the value is asked or anything is sent', async () => {
  const { keys, store, calls } = rig();
  store.addCore({ name: 'core-1', value: SECRET });
  const { dialog, asked } = scriptedDialog([SECRET_2]);
  const answer = await keys.run('keys.core.add', { name: 'core-1' }, dialog);
  assert.equal(answer.status, 'invalid');
  assert.deepEqual(asked, []);
  assert.deepEqual(calls, []);
});

test('removing the last core key pauses her as no-core-key; removing another key does not', async () => {
  const { keys, store, pause } = rig();
  store.addCore({ name: 'core-1', value: SECRET });
  store.addCore({ name: 'core-2', value: SECRET_2 });
  assert.equal((await keys.run('keys.core.remove', { name: 'core-2' }, null)).status, 'ok');
  assert.deepEqual(pause.pauses, [], 'one key is still there');
  assert.equal((await keys.run('keys.core.remove', { name: 'core-1' }, null)).status, 'ok');
  // Bug caught: the last removal refused, or allowed without the pause, so she keeps answering with no key to answer on.
  assert.deepEqual(pause.pauses, ['no-core-key']);
  assert.deepEqual(store.coreNames(), []);
  assert.equal((await keys.run('keys.core.remove', { name: 'core-1' }, null)).status, 'invalid', 'an unknown name');
});

test('the next core add resumes a no-core-key pause, and leaves a pause the owner gave alone', async () => {
  const afterRemoval = rig(healthy, 'no-core-key');
  await afterRemoval.keys.run('keys.core.add', { name: 'core-1' }, scriptedDialog([SECRET, ...BLANKS]).dialog);
  assert.equal(afterRemoval.pause.resumes, 1);

  const owner = rig(healthy, 'owner');
  owner.store.addCore({ name: 'core-1', value: SECRET });
  await owner.keys.run('keys.core.add', { name: 'core-2' }, scriptedDialog([SECRET_2]).dialog);
  // Bug caught: adding a key undoing a pause the owner set for editing data/.
  assert.equal(owner.pause.resumes, 0);
});

test('a failed add does not resume the no-core-key pause', async () => {
  const { keys, pause } = rig(
    (call) => (call.url.endsWith('/embeddings') ? { status: 404, body: 'gone' } : healthy(call)),
    'no-core-key'
  );
  await keys.run('keys.core.add', { name: 'core-1' }, scriptedDialog([SECRET, ...BLANKS]).dialog);
  assert.equal(pause.resumes, 0);
});

test('listings show names, last four characters, grants and bound roles, never a value', async () => {
  const { keys, store } = rig();
  store.addCore({ name: 'core-1', value: SECRET, grant: 200, resetDay: 22 });
  store.addCore({ name: 'core-2', value: SECRET_2 });
  await keys.run('keys.extra.add', { name: 'art' }, scriptedDialog([SECRET_3]).dialog);
  store.bind('drawing', 'art');
  const core = await keys.run('keys.core.list', {}, null);
  const extra = await keys.run('keys.extra.list', {}, null);
  for (const answer of [core, extra]) {
    assert.equal(answer.status, 'ok');
    // Bug caught: a listing that prints the stored row, value and all.
    assert.ok(!answer.text.includes('SECRETVALUE'), 'no value');
  }
  assert.ok(
    core.text.includes('core-1') &&
      core.text.includes('WXYZ') &&
      core.text.includes('core-2') &&
      core.text.includes('ABCD')
  );
  assert.ok(core.text.includes('200') && core.text.includes('22'), 'grant and reset day');
  assert.ok(extra.text.includes('art') && extra.text.includes('EFGH') && extra.text.includes('drawing'));
});

test('binding an unknown key name or role is refused and changes nothing; a core name is not an extra key', async () => {
  const { keys, store } = rig();
  store.addCore({ name: 'core-1', value: SECRET });
  store.addExtra({ name: 'art', value: SECRET_3 });
  for (const args of [
    { role: 'drawing', name: 'nope' },
    { role: 'drawing', name: 'core-1' },
    { role: 'sorcery', name: 'art' },
  ]) {
    // Bug caught: a mistyped name accepted, so the role is bound to a key that does not exist and its requests go nowhere.
    assert.equal((await keys.run('keys.bind', args, null)).status, 'invalid', JSON.stringify(args));
  }
  assert.equal(store.boundTo('drawing'), null);
  assert.equal((await keys.run('keys.bind', { role: 'drawing', name: 'art' }, null)).status, 'ok');
  assert.equal(store.boundTo('drawing'), 'art');
  assert.equal((await keys.run('keys.extra.remove', { name: 'art' }, null)).status, 'invalid', 'still bound');
  assert.equal((await keys.run('keys.unbind', { role: 'drawing' }, null)).status, 'ok');
  assert.equal((await keys.run('keys.unbind', { role: 'drawing' }, null)).status, 'invalid', 'nothing to unbind');
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
  assert.deepEqual(parsed('/keys core add core-1'), { name: 'keys.core.add', args: { name: 'core-1' } });
  assert.deepEqual(parsed('/keys core remove core-1'), { name: 'keys.core.remove', args: { name: 'core-1' } });
  assert.deepEqual(parsed('/keys core list'), { name: 'keys.core.list', args: {} });
  assert.deepEqual(parsed('/keys extra add art'), { name: 'keys.extra.add', args: { name: 'art' } });
  assert.deepEqual(parsed('/keys extra list'), { name: 'keys.extra.list', args: {} });
  assert.deepEqual(parsed('/keys bind drawing art'), { name: 'keys.bind', args: { role: 'drawing', name: 'art' } });
  assert.deepEqual(parsed('/keys unbind drawing'), { name: 'keys.unbind', args: { role: 'drawing' } });
  assert.deepEqual(parsed('/keys check vision'), { name: 'keys.check', args: { role: 'vision' } });
  assert.deepEqual(parsed('/model set vision x/y'), { name: 'model.set', args: { role: 'vision', model: 'x/y' } });
  for (const line of ['/keys', '/keys bind drawing', '/keys check', '/keys core add'])
    assert.equal(refused(line), true, `${line} is refused with a reason`);
});

// `keys core grant <name> <usd> <day>` and `keys core grant <name> none` (spec 2026-11-02, follow-up 4): the grant of a
// stored core key changes with no value asked for and none shown.

/** A dialog that fails the test when it is asked anything. */
const silentDialog = {
  ask: (question: string): Promise<string> => Promise.reject(new Error(`asked: ${question}`)),
};

test('the table parses keys core grant with a day, and with none', () => {
  // Catches: the line falls through to "no subcommand" and the owner cannot change a grant from the chat.
  const parsed = (line: string) => {
    const result = parseCommandLine(line);
    return result.ok ? { name: result.name, args: result.args } : result.reason;
  };
  assert.deepEqual(parsed('/keys core grant core-1 200 22'), {
    name: 'keys.core.grant',
    args: { name: 'core-1', usd: '200', day: '22' },
  });
  assert.deepEqual(parsed('/keys core grant core-1 none'), {
    name: 'keys.core.grant',
    args: { name: 'core-1', usd: 'none' },
  });
});

test('keys core grant sets the grant and reset day of a stored key without asking for its value', async () => {
  // Catches: the command asks for the key again, or saves the grant under the wrong key.
  const { keys, store } = rig();
  store.addCore({ name: 'core-1', value: SECRET });
  const answer = await keys.run('keys.core.grant', { name: 'core-1', usd: '200', day: '22' }, silentDialog);
  assert.equal(answer.status, 'ok');
  assert.deepEqual(store.list().core[0], { name: 'core-1', last4: 'WXYZ', grant: 200, resetDay: 22 });
  assert.equal(answer.text.includes('SECRETVALUE'), false);
});

test('keys core grant with none clears the grant', async () => {
  // Catches: "none" is read as a number, fails, and an old grant can never be taken off a key.
  const { keys, store } = rig();
  store.addCore({ name: 'core-1', value: SECRET, grant: 200, resetDay: 22 });
  const answer = await keys.run('keys.core.grant', { name: 'core-1', usd: 'none' }, silentDialog);
  assert.equal(answer.status, 'ok');
  assert.deepEqual(store.list().core[0], { name: 'core-1', last4: 'WXYZ', grant: null, resetDay: null });
});

test('keys core grant refuses a missing day, a bad amount and an unknown key, and changes nothing', async () => {
  // Catches: a grant without a reset day is saved, and the week line divides by a day that does not exist.
  const { keys, store } = rig();
  store.addCore({ name: 'core-1', value: SECRET, grant: 200, resetDay: 22 });
  for (const args of [
    { name: 'core-1', usd: '150' },
    { name: 'core-1', usd: 'lots', day: '3' },
    { name: 'core-1', usd: '150', day: '0' },
    { name: 'core-9', usd: '150', day: '3' },
  ]) {
    const answer = await keys.run('keys.core.grant', args, silentDialog);
    assert.equal(answer.status, 'invalid', JSON.stringify(args));
    assert.equal(answer.text.includes('SECRETVALUE'), false);
  }
  assert.deepEqual(store.list().core[0], { name: 'core-1', last4: 'WXYZ', grant: 200, resetDay: 22 });
});
