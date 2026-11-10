// Tests for src/keys/commands.ts, the commands of `keys add|remove|list|check` and an agent's `model set`, and for their
// lines in the command table. The store is a temp folder, the chains a map the commands write through `saveRoutes`, the
// provider a fake fetch, the chat a scripted dialog, the pause a fake that keeps its reason. The tests assert on what is
// saved, sent and paused, and on a key value never appearing in an answer; the wording of an answer is not tested.
// Changed: keys.json holds named keys and a role's model is the first route of its chain (spec 2026-11-09-model-routes,
// slice 4), so the first key writes a chain of one route per mandatory role, and the direct `model set` of a model role
// is gone with `models.base` (its chain commands are in tests/keys-route-commands.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createKeysCommands, reasonedPause } from '../src/keys/commands.ts';
import { createAdmin } from '../src/admin.ts';
import { makeStore } from './fixtures/admin-store.ts';
import { createKeyStore, KEYS_FILE } from '../src/keys/store.ts';
import type { KeyStore } from '../src/keys/store.ts';
import { isRouteRole } from '../src/llm/route-text.ts';
import type { Route, RouteRole } from '../src/llm/route-text.ts';
import { parseCommandLine } from '../src/interface/commands/table.ts';
import {
  BASE_URL,
  SECRET,
  SECRET_2,
  SECRET_3,
  chainRing,
  fakeFetch,
  fakePause,
  healthy,
  scriptedDialog,
  everyKeyChains,
} from './fixtures/keys-rig.ts';
import type { Call, Reply } from './fixtures/keys-rig.ts';
import type { PauseControl, KeysDeps } from '../src/keys/commands.ts';
import { tempDir } from './fixtures/tmp.ts';

const MANDATORY = ['core', 'memory', 'analyzer', 'embedding'];
const DEFAULTS = Object.fromEntries(MANDATORY.map((role) => [role, `default/${role}`]));

const api = (key: string, model: string): Route => ({ via: 'api', key, model, effort: null });

/** The key commands over `store` and a map of chains, with `pause`; what `model set` of an agent saved. */
function commandsOver(store: KeyStore, pause: PauseControl, fetch: typeof globalThis.fetch) {
  const chains: Partial<Record<RouteRole, Array<Route>>> = {};
  const chainOf = (role: string): Array<Route> => (isRouteRole(role) ? (chains[role] ?? []) : []);
  const saved: Array<[string, string]> = [];
  const keys = createKeysCommands({
    store,
    ring: chainRing(store, chainOf),
    fetch,
    baseUrl: () => BASE_URL,
    defaults: DEFAULTS,
    currentModel: (role) => chainOf(role)[0]?.model ?? '',
    saveModel: (role, model) => {
      saved.push([role, model]);
      return Promise.resolve();
    },
    pause,
    chainOf,
    saveRoutes: (role, routes) => {
      chains[role] = routes;
      return Promise.resolve();
    },
  });
  return { keys, chains, saved };
}

function rig(answer: (call: Call) => Reply = healthy, paused: string | null = null) {
  const privateDir = tempDir('keys-commands-');
  const store = createKeyStore({ privateDir });
  const { fetch, calls } = fakeFetch(answer);
  const pause = fakePause(paused);
  const { keys, chains, saved } = commandsOver(store, pause, fetch);
  return { keys, store, calls, pause, chains, saved, file: path.join(privateDir, KEYS_FILE) };
}

const BLANKS = ['', '', '', ''];

test('the first key asks the value without echo, then the four models with the defaults offered, checks each and writes their chains', async () => {
  const { keys, store, calls, chains, saved } = rig();
  const { dialog, asked } = scriptedDialog([SECRET, 'custom/core', '', '', '']);
  const answer = await keys.run('keys.add', { name: 'core-1' }, dialog);
  assert.equal(answer.status, 'ok');
  assert.equal(asked[0]?.secret, true, 'the value is asked as a secret');
  // Bug caught: asking the models in another order, or without the tracked default on offer.
  MANDATORY.forEach((role, i) =>
    assert.ok(asked[i + 1]?.question.includes(role), `question ${i + 1} is about ${role}`)
  );
  assert.ok(asked[2]?.question.includes('default/memory'), 'the default is shown');
  // Bug caught: the four models saved where no reader looks any more, so a fresh install has no route for her core.
  assert.deepEqual(chains, {
    core: [api('core-1', 'custom/core')],
    memory: [api('core-1', 'default/memory')],
    analyzer: [api('core-1', 'default/analyzer')],
    embedding: [api('core-1', 'default/embedding')],
  });
  assert.deepEqual(saved, [], 'no model is saved outside the chains');
  assert.deepEqual(store.names(), ['core-1']);
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

test('the first key refuses to finish when one mandatory model fails its check, and saves nothing', async () => {
  const echo = (call: Call): Reply =>
    call.url.endsWith('/embeddings')
      ? { status: 404, body: { error: { message: `No such model for key ${SECRET}` } } }
      : healthy(call);
  const { keys, store, chains, file } = rig(echo);
  const { dialog } = scriptedDialog([SECRET, ...BLANKS]);
  const answer = await keys.run('keys.add', { name: 'core-1' }, dialog);
  // Bug caught: the key written before the checks run, so a fresh install ends half-configured with a model that fails.
  assert.equal(answer.status, 'failed');
  assert.ok(
    answer.text.includes('embedding') && answer.text.includes('default/embedding'),
    'names the role and model that failed'
  );
  assert.ok(!answer.text.includes('SECRETVALUE'), 'the provider echoed the key; the answer must not');
  assert.deepEqual(chains, {}, 'no chain is written');
  assert.deepEqual(store.names(), []);
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
  assert.deepEqual(store.names(), []);
});

test('a later add checks the key with /auth/key only, trims the paste, and saves it', async () => {
  const { keys, store, calls } = rig();
  store.add({ name: 'core-1', value: SECRET });
  const answer = await keys.run('keys.add', { name: 'core-2' }, scriptedDialog([`  ${SECRET_2}\n`]).dialog);
  assert.equal(answer.status, 'ok');
  assert.equal(calls.length, 1, 'one request');
  assert.ok(calls[0]?.url.endsWith('/auth/key'));
  // Bug caught: the trailing newline of a paste stored with the key, so every request of it fails with a bad header.
  assert.equal(store.valueOf('core-2'), SECRET_2);
});

test('a later add whose key /auth/key rejects is not saved', async () => {
  const { keys, store } = rig((call) =>
    call.url.endsWith('/auth/key') ? { status: 401, body: { error: { message: 'User not found.' } } } : healthy(call)
  );
  store.add({ name: 'core-1', value: SECRET });
  const answer = await keys.run('keys.add', { name: 'core-2' }, scriptedDialog([SECRET_2]).dialog);
  assert.equal(answer.status, 'failed');
  assert.deepEqual(store.names(), ['core-1']);
});

test('a name already in use is refused before the value is asked or anything is sent', async () => {
  const { keys, store, calls } = rig();
  store.add({ name: 'core-1', value: SECRET });
  const { dialog, asked } = scriptedDialog([SECRET_2]);
  const answer = await keys.run('keys.add', { name: 'core-1' }, dialog);
  assert.equal(answer.status, 'invalid');
  assert.deepEqual(asked, []);
  assert.deepEqual(calls, []);
});

test('removing the key her core runs on pauses her as no-core-route; removing another key does not', async () => {
  // Changed: `/keys remove` replaces `/keys core remove`, and the pause is named for a core with no route.
  const { keys, store, pause, chains } = rig();
  store.add({ name: 'core-1', value: SECRET });
  store.add({ name: 'core-2', value: SECRET_2 });
  chains.core = [api('core-1', 'x/core')];
  assert.equal((await keys.run('keys.remove', { name: 'core-2' }, null)).status, 'ok');
  assert.deepEqual(pause.pauses, [], 'her core still has its key');
  assert.equal((await keys.run('keys.remove', { name: 'core-1' }, null)).status, 'ok');
  // Bug caught: the last removal refused, or allowed without the pause, so she keeps answering with no key to answer on.
  assert.deepEqual(pause.pauses, ['no-core-route']);
  assert.deepEqual(store.names(), []);
  assert.equal((await keys.run('keys.remove', { name: 'core-1' }, null)).status, 'invalid', 'an unknown name');
});

test('the next first key resumes a no-core-route pause, and a later add leaves a pause the owner gave alone', async () => {
  const afterRemoval = rig(healthy, 'no-core-route');
  await afterRemoval.keys.run('keys.add', { name: 'core-1' }, scriptedDialog([SECRET, ...BLANKS]).dialog);
  assert.equal(afterRemoval.pause.resumes, 1);

  const owner = rig(healthy, 'owner');
  owner.store.add({ name: 'core-1', value: SECRET });
  owner.chains.core = [api('core-1', 'x/core')];
  await owner.keys.run('keys.add', { name: 'core-2' }, scriptedDialog([SECRET_2]).dialog);
  // Bug caught: adding a key undoing a pause the owner set for editing data/.
  assert.equal(owner.pause.resumes, 0);
});

test('an owner pause given over no-core-route stays when the next key is added', async () => {
  // Catches: the owner's /pause after the last key's removal keeps the reason no-core-route, so the next add wakes her
  // while he edits data/.
  const state = makeStore();
  const admin = createAdmin({ hot: { config: { bot: { owners: [] } }, prompts: {} }, store: state });
  const store = createKeyStore({ privateDir: tempDir('keys-commands-') });
  const pause = reasonedPause({ run: (op, args) => admin.run(op, args, {}), store: state });
  const { keys, chains } = commandsOver(store, pause, fakeFetch().fetch);
  store.add({ name: 'core-1', value: SECRET });
  // Changed: `/keys remove`; the next add of a non-empty keys.json goes in as a named key, with no models asked.
  store.add({ name: 'spare', value: SECRET_3 });
  chains.core = [api('core-1', 'x/core'), api('core-2', 'x/core')];
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
  store.add({ name: 'core-1', value: SECRET });
  store.add({ name: 'art', value: SECRET_3 });
  const answer = await keys.run('keys.list', {}, null);
  assert.equal(answer.status, 'ok');
  // Bug caught: a listing that prints the stored row, value and all.
  assert.ok(!answer.text.includes('SECRETVALUE'), 'no value');
  assert.ok(answer.text.includes('core-1') && answer.text.includes('WXYZ'), answer.text);
  assert.ok(answer.text.includes('art') && answer.text.includes('EFGH'), answer.text);
});

test("keys check sends one request on the key of the role's route and names model, key name and is_byok", async () => {
  const byok =
    (is: boolean) =>
    (call: Call): Reply =>
      call.url.endsWith('/chat/completions')
        ? { status: 200, body: { choices: [{ message: { content: 'ok' } }], usage: { cost: 0.01, is_byok: is } } }
        : healthy(call);
  const onRoute = rig(byok(true));
  onRoute.store.add({ name: 'core-1', value: SECRET });
  onRoute.store.add({ name: 'art', value: SECRET_3 });
  onRoute.chains.vision = [api('art', 'current/vision')];
  const onArt = await onRoute.keys.run('keys.check', { role: 'vision' }, null);
  assert.equal(onArt.status, 'ok');
  assert.equal(onRoute.calls.length, 1);
  assert.equal(onRoute.calls[0]?.auth, SECRET_3, "the route's key, not the first key of the file");
  assert.equal(onRoute.calls[0]?.body?.model, 'current/vision');
  assert.ok(onArt.text.includes('current/vision') && onArt.text.includes('art'));

  const plain = rig(byok(false));
  plain.store.add({ name: 'art', value: SECRET_3 });
  plain.chains.vision = [api('art', 'current/vision')];
  const notByok = await plain.keys.run('keys.check', { role: 'vision' }, null);
  // Bug caught: the answer not saying whether the key was used as BYOK, the one thing the check exists to prove.
  assert.notEqual(onArt.text, notByok.text, 'is_byok true and false read differently');
  assert.ok(!onArt.text.includes('SECRETVALUE') && !notByok.text.includes('SECRETVALUE'));
});

test('keys check with no key for the role fails without sending anything', async () => {
  // Changed: the role's key is its route's (slice 4), here a route on a key keys.json lacks.
  const { keys, calls, chains } = rig();
  chains.core = [api('missing', 'x/core')];
  const answer = await keys.run('keys.check', { role: 'core' }, null);
  assert.equal(answer.status, 'failed');
  assert.deepEqual(calls, []);
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

// `/keys check memory` and `neptunia keys check memory` (stage T.2 of the master plan) check the path her memory writer
// runs on now and name it. On the direct path the check is the one request on the memory key. On a subharness path
// (`claude` or `codex`, src/subharness/memory-path.ts) it is the probe through that backend, and no request goes out on
// the OpenRouter key. The deps `memoryPath` and `probeMemory` carry what the core reads from keys.json and what
// `memoryProbe` (src/subharness/memory-probe.ts) answers. The provider is a fake fetch.

const T0 = Date.parse('2026-11-05T09:00:00Z');

type Probe = Awaited<ReturnType<NonNullable<KeysDeps['probeMemory']>>>;

function checkMemoryRig({
  path,
  probe,
  withKey = true,
}: {
  path: NonNullable<ReturnType<NonNullable<KeysDeps['memoryPath']>>>;
  probe: Probe;
  withKey?: boolean;
}) {
  const store = createKeyStore({ privateDir: tempDir('keys-memory-') });
  if (withKey) store.add({ name: 'core-1', value: SECRET });
  // Changed: every role runs on its chain (slice 4); here every role's chain names every key of the store.
  const chainOf = everyKeyChains(store, (role) => `current/${role}`);
  const ring = chainRing(store, chainOf);
  const { fetch, calls } = fakeFetch();
  const probes: Array<number> = [];
  const recorded: Array<string> = [];
  const keys = createKeysCommands({
    store,
    ring,
    chainOf,
    saveRoutes: () => Promise.resolve(),
    fetch,
    baseUrl: () => BASE_URL,
    defaults: {},
    currentModel: () => 'x/memory',
    saveModel: () => Promise.resolve(),
    pause: fakePause(null),
    memoryPath: () => path,
    probeMemory: () => {
      probes.push(1);
      return Promise.resolve(probe);
    },
    recordCheck: (role) => recorded.push(role),
  });
  return { keys, calls, probes, recorded };
}

const CLAUDE = { kind: 'subharness', backend: 'claude', model: 'sonnet' } as const;

test('with memory on claude, the check runs the probe, sends nothing to OpenRouter and names the path', async () => {
  // Catches: the check proves the direct key while the writer runs through claude, so a dead login reads as healthy.
  const { keys, calls, probes } = checkMemoryRig({ path: CLAUDE, probe: { ok: true, at: T0 } });
  const answer = await keys.run('keys.check', { role: 'memory' }, null);
  assert.equal(answer.status, 'ok', answer.text);
  assert.deepEqual(calls, []);
  assert.equal(probes.length, 1);
  assert.match(answer.text, /claude/);
  assert.match(answer.text, /sonnet/);
});

test('with memory on claude, a failed probe is a failed check that names the path and the code', async () => {
  // Catches: a logged-out claude reports ok because the unused direct key still answers.
  const { keys } = checkMemoryRig({ path: CLAUDE, probe: { ok: false, code: 'not-logged-in', at: T0 } });
  const answer = await keys.run('keys.check', { role: 'memory' }, null);
  assert.equal(answer.status, 'failed');
  assert.match(answer.text, /claude/);
  assert.match(answer.text, /not-logged-in/);
});

test('with memory on claude and no core key, the check still runs and is not refused for a missing key', async () => {
  // Catches: the check demands an OpenRouter key for a writer that does not use one.
  const { keys, probes } = checkMemoryRig({ path: CLAUDE, probe: { ok: true, at: T0 }, withKey: false });
  const answer = await keys.run('keys.check', { role: 'memory' }, null);
  assert.equal(answer.status, 'ok', answer.text);
  assert.equal(probes.length, 1);
});

test('the check of the subharness path records no direct selection for the memory role', async () => {
  // Catches: readiness keeps a direct-route check for a path the writer is not on.
  const { keys, recorded } = checkMemoryRig({ path: CLAUDE, probe: { ok: true, at: T0 } });
  await keys.run('keys.check', { role: 'memory' }, null);
  assert.deepEqual(recorded, []);
});

test('with memory on the direct path, the check is one request on the memory key and the answer says direct', async () => {
  // Catches: the fix routes every memory check to the probe and the direct route is never proved again.
  const { keys, calls, probes } = checkMemoryRig({ path: { kind: 'direct' }, probe: { ok: true, at: T0 } });
  const answer = await keys.run('keys.check', { role: 'memory' }, null);
  assert.equal(answer.status, 'ok', answer.text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.auth, SECRET);
  assert.deepEqual(probes, []);
  assert.match(answer.text, /direct/);
});

test('a check of another role is the same request whatever the memory path is', async () => {
  // Catches: the memory path leaks into the check of the analyzer role.
  const { keys, calls, probes } = checkMemoryRig({ path: CLAUDE, probe: { ok: true, at: T0 } });
  const answer = await keys.run('keys.check', { role: 'analyzer' }, null);
  assert.equal(answer.status, 'ok', answer.text);
  assert.equal(calls.length, 1);
  assert.deepEqual(probes, []);
});
