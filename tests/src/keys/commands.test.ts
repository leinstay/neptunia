// Tests for src/keys/commands.ts, the commands of `keys add|remove|list|check` and an agent's `model set`, and for their
// recorded checks. The store is a temp folder, the chains a map the commands write through `saveRoutes`, the
// provider a fake fetch, the chat a scripted dialog, the pause a fake that keeps its reason. The tests assert on what is
// saved, sent and paused, and on a key value never appearing in an answer; the wording of an answer is not tested.
// keys.json holds named keys and a role's model is the first route of its chain, so the first key writes a chain of one
// route per mandatory role. The chain commands follow the key commands below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createKeysCommands, reasonedPause } from '../../../src/keys/commands.ts';
import { createAdmin } from '../../../src/admin.ts';
import { makeStore } from '../../fixtures/admin-store.ts';
import { createKeyStore, KEYS_FILE } from '../../../src/keys/store.ts';
import type { KeyStore } from '../../../src/keys/store.ts';
import { isRouteRole } from '../../../src/llm/route-text.ts';
import { harnessEffort } from '../../../src/llm/route-text.ts';
import { checkedRoute } from '../../../src/subharness/selection.ts';
import { fakeVendor } from '../../fixtures/fake-vendor.ts';
import type { Route, RouteRole } from '../../../src/llm/route-text.ts';
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
} from '../../fixtures/keys-rig.ts';
import type { Call, Reply } from '../../fixtures/keys-rig.ts';
import type { PauseControl, KeysDeps } from '../../../src/keys/commands.ts';
import { tempDir } from '../../fixtures/tmp.ts';
import { startCore } from '../../../src/core.ts';
import { runCli, withRig } from '../../fixtures/core-units.ts';
import type { Core, Dirs, Llm } from '../../fixtures/core-units.ts';
import { readKeysFile, writeKeysFile } from '../../fixtures/keys-file.ts';

// The first key asks four models.
const MANDATORY = ['core', 'memory', 'analyzer', 'embedding'];
const DEFAULTS = Object.fromEntries(MANDATORY.map((role) => [role, `default/${role}`]));

const api = (key: string, model: string): Route => ({ via: 'api', key, model, effort: null });

/** The key commands over `store` and a map of chains, with `pause`. */
function commandsOver(store: KeyStore, pause: PauseControl, fetch: typeof globalThis.fetch) {
  const chains: Partial<Record<RouteRole, Array<Route>>> = {};
  const chainOf = (role: string): Array<Route> => (isRouteRole(role) ? (chains[role] ?? []) : []);
  const keys = createKeysCommands({
    store,
    ring: chainRing(store, chainOf),
    fetch,
    baseUrl: () => BASE_URL,
    defaults: DEFAULTS,
    currentModel: (role) => chainOf(role)[0]?.model ?? '',
    pause,
    chainOf,
    saveRoutes: (role, routes) => {
      chains[role] = routes;
      return Promise.resolve();
    },
  });
  return { keys, chains };
}

function rig(answer: (call: Call) => Reply = healthy, paused: string | null = null) {
  const privateDir = tempDir('keys-commands-');
  const store = createKeyStore({ privateDir });
  const { fetch, calls } = fakeFetch(answer);
  const pause = fakePause(paused);
  const { keys, chains } = commandsOver(store, pause, fetch);
  return { keys, store, calls, pause, chains, file: path.join(privateDir, KEYS_FILE) };
}

const BLANKS = ['', '', '', ''];

test('the first key asks the value without echo, then the four models with the defaults offered, checks each and writes their chains', async () => {
  const { keys, store, calls, chains } = rig();
  const { dialog, asked } = scriptedDialog([SECRET, 'custom/core', '', '', '']);
  const answer = await keys.run('keys.add', { name: 'core-1' }, dialog);
  assert.equal(answer.status, 'ok');
  assert.equal(asked[0]?.secret, true, 'the value is asked as a secret');
  // Bug caught: asking the models in another order, or without the tracked default on offer.
  MANDATORY.forEach((role, i) => {
    const entry = asked[i + 1];
    assert.ok(entry?.question.includes(role), `question ${i + 1} is about ${role}`);
  });
  const memoryQuestion = asked[2];
  assert.ok(memoryQuestion?.question.includes('default/memory'), 'the default is shown');
  // Bug caught: the four models saved where no reader looks, so a fresh install has no route for the core.
  assert.deepEqual(chains, {
    core: [api('core-1', 'custom/core')],
    memory: [api('core-1', 'default/memory')],
    analyzer: [api('core-1', 'default/analyzer')],
    embedding: [api('core-1', 'default/embedding')],
  });
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
  const sent = calls[0];
  assert.ok(sent?.url.endsWith('/auth/key'));
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

test('removing the key the core runs on pauses the persona as no-core-route; removing another key does not', async () => {
  // The pause is named for a core with no route.
  const { keys, store, pause, chains } = rig();
  store.add({ name: 'core-1', value: SECRET });
  store.add({ name: 'core-2', value: SECRET_2 });
  chains.core = [api('core-1', 'x/core')];
  assert.equal((await keys.run('keys.remove', { name: 'core-2' }, null)).status, 'ok');
  assert.deepEqual(pause.pauses, [], 'the core still has its key');
  assert.equal((await keys.run('keys.remove', { name: 'core-1' }, null)).status, 'ok');
  // Bug caught: the last removal refused, or allowed without the pause, so the persona keeps answering with no key to answer on.
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
  // Catches: the owner's /pause after the last key's removal keeps the reason no-core-route, so the next add wakes the
  // persona while the owner edits data/.
  const held = makeStore();
  const admin = createAdmin({
    hot: { config: { bot: { owners: [] } }, prompts: {} },
    store: held,
  });
  const store = createKeyStore({ privateDir: tempDir('keys-commands-') });
  const pause = reasonedPause({ run: (op, args) => admin.run(op, args, {}), store: held });
  const { keys, chains } = commandsOver(store, pause, fakeFetch().fetch);
  store.add({ name: 'core-1', value: SECRET });
  // The next add of a non-empty keys.json goes in as a named key, with no models asked.
  store.add({ name: 'spare', value: SECRET_3 });
  chains.core = [api('core-1', 'x/core'), api('core-2', 'x/core')];
  await keys.run('keys.remove', { name: 'core-1' }, null);
  assert.equal(pause.reason(), 'no-core-route');
  await admin.run('bot.pause', {}, {});
  await keys.run('keys.add', { name: 'core-2' }, scriptedDialog([SECRET_2]).dialog);
  assert.equal(store.valueOf('core-2'), SECRET_2);
  const data = held.state.data;
  assert.equal(data.paused, true);
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
  const onRouteCall = onRoute.calls[0];
  assert.equal(onRouteCall?.auth, SECRET_3, "the route's key, not the first key of the file");
  assert.equal(onRouteCall?.body?.model, 'current/vision');
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
  // The role's key is its route's, here a route on a key keys.json lacks.
  const { keys, calls, chains } = rig();
  chains.core = [api('missing', 'x/core')];
  const answer = await keys.run('keys.check', { role: 'core' }, null);
  assert.equal(answer.status, 'failed');
  assert.deepEqual(calls, []);
});

// `/keys check memory` and `neptunia keys check memory` check the path the memory writer runs on and name it. On the direct path the check is the one request on the memory key. On a subharness path
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
  // Every role runs on its chain; here every role's chain names every key of the store.
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

// The recorded check of the core model: `/model set core` and `/keys check core` record the check they ran for its
// selection (src/setup/model-check.ts), so a launch reads its readiness with no model request.

// The recorded check

function keysRig(status: number) {
  const privateDir = tempDir('nep-readiness-keys-');
  const store = createKeyStore({ privateDir });
  store.add({ name: 'core-1', value: SECRET });
  // Every role runs on its chain; here every role's chain names every key of the store.
  const chainOf = everyKeyChains(store, (role) => `current/${role}`);
  const ring = chainRing(store, chainOf);
  const { fetch, calls } = fakeFetch(() => ({
    status,
    body: { choices: [{ message: { content: 'ok' } }], usage: { cost: 0 } },
  }));
  const recorded: Array<unknown> = [];
  const keys = createKeysCommands({
    store,
    ring,
    chainOf,
    saveRoutes: () => Promise.resolve(),
    fetch,
    baseUrl: () => BASE_URL,
    defaults: {},
    currentModel: () => 'vendor/core-1',
    pause: fakePause(),
    recordCheck: (role, check) => recorded.push({ role, ...check }),
  });
  return { keys, recorded, calls };
}

test('/model set core records the check it ran, for that selection', async () => {
  // Catches: a model saved and checked, and readiness still asking for a check that already happened.
  const { keys, recorded, calls } = keysRig(200);
  // A model role is set as one route of its chain, so the route names its key.
  const answer = await keys.run('model.set', { role: 'core', model: 'core-1/vendor/core-2' }, null);
  assert.equal(answer.status, 'ok', answer.text);
  assert.equal(calls.length, 1);
  assert.deepEqual(recorded, [{ role: 'core', selection: 'openrouter:vendor/core-2', ok: true, code: null }]);
});

test('/keys check core records a failure, so a key revoked since setup blocks the next launch', async () => {
  // Catches: the old success stands after the owner saw the check fail.
  const { keys, recorded } = keysRig(401);
  await keys.run('keys.check', { role: 'core' }, null);
  assert.deepEqual(recorded, [{ role: 'core', selection: 'openrouter:vendor/core-1', ok: false, code: 'http-401' }]);
});

// The chain commands: `/model show`, `/model set <role> <route>`, `/model add` and `/model remove`. A route on a key is
// checked with one request on that key and model, a route on a harness with one reply through it, and nothing is saved
// on a refusal. The harness check is a fake unless a test runs the real check of src/subharness/selection.ts on a fake
// vendor.

const harness = (model: string): Route => ({ via: 'harness', backend: 'claude', model, effort: null });

/** The model of a chain's first route, '' for none. */
const firstModel = (chain: ReadonlyArray<Route> | undefined): string => chain?.[0]?.model ?? '';

function routeRig(
  chains: Partial<Record<RouteRole, Array<Route>>> = {},
  answer: (call: Call) => Reply = healthy,
  llm: Record<string, unknown> = {},
  check?: KeysDeps['checkHarness']
) {
  const privateDir = tempDir('keys-route-commands-');
  const store = createKeyStore({ privateDir });
  // keys.json holds named keys, and the ring is the core's view of the chains.
  store.add({ name: 'helpers', value: SECRET });
  store.add({ name: 'spare', value: SECRET_2 });
  const { fetch, calls } = fakeFetch(answer);
  const held: Partial<Record<RouteRole, Array<Route>>> = { ...chains };
  const ring = chainRing(store, (role) => (isRouteRole(role) ? (held[role] ?? []) : []));
  const harnessChecks: Array<Route> = [];
  let harnessOk = true;
  const pause = fakePause(null);
  const keys = createKeysCommands({
    store,
    ring,
    fetch,
    baseUrl: () => BASE_URL,
    defaults: {},
    llmConfig: () => llm,
    currentModel: (role) => (isRouteRole(role) ? firstModel(held[role]) : ''),
    pause,
    chainOf: (role) => held[role] ?? [],
    saveRoutes: (role, routes) => {
      held[role] = routes;
      return Promise.resolve();
    },
    checkHarness: (route) => {
      harnessChecks.push(route);
      if (check !== undefined) return check(route);
      return Promise.resolve(harnessOk ? { ok: true, code: 'ok' } : { ok: false, code: 'not-logged-in' });
    },
  });
  return {
    keys,
    pause,
    held,
    calls,
    harnessChecks,
    refuseHarness: () => {
      harnessOk = false;
    },
  };
}

const modelsAsked = (calls: ReadonlyArray<Call>): Array<unknown> => calls.map((call) => call.body?.model);

test('model set on a key route checks that model on that key and saves the chain as that one route', async () => {
  // Catches: the check sent on another key than the route names, or the old chain kept behind the new route.
  const { keys, held, calls } = routeRig({ analyzer: [api('spare', 'old/analyzer'), api('spare', 'old/two')] });
  const answer = await keys.run('model.set', { role: 'analyzer', model: 'helpers/anthropic/claude-sonnet-6.1' }, null);
  assert.equal(answer.status, 'ok', answer.text);
  assert.deepEqual(modelsAsked(calls), ['anthropic/claude-sonnet-6.1']);
  assert.equal(calls[0]?.auth, SECRET);
  assert.deepEqual(held.analyzer, [api('helpers', 'anthropic/claude-sonnet-6.1')]);
  assert.equal(answer.text.includes(SECRET), false);
});

test('model set whose check the provider refuses saves nothing', async () => {
  // Catches: a chain replaced by a route whose model the account cannot use, so every request of the role fails.
  const refuse = (call: Call): Reply =>
    call.url.endsWith('/chat/completions') ? { status: 404, body: { error: { message: 'no' } } } : healthy(call);
  const { keys, held } = routeRig({ analyzer: [api('spare', 'old/analyzer')] }, refuse);
  const answer = await keys.run('model.set', { role: 'analyzer', model: 'helpers/x/missing' }, null);
  assert.equal(answer.status, 'failed');
  assert.deepEqual(held.analyzer, [api('spare', 'old/analyzer')]);
});

test('model set on a harness route checks it through the harness and saves it, and a refused check saves nothing', async () => {
  // Catches: a core moved onto a logged-out CLI, so every turn fails until the owner notices.
  const { keys, held, calls, harnessChecks, refuseHarness } = routeRig({ core: [api('helpers', 'x/core')] });
  const answer = await keys.run('model.set', { role: 'core', model: 'harness:claude/claude-opus-4-6' }, null);
  assert.equal(answer.status, 'ok', answer.text);
  assert.deepEqual(harnessChecks, [harness('claude-opus-4-6')]);
  assert.deepEqual(held.core, [harness('claude-opus-4-6')]);
  assert.equal(calls.length, 0);
  refuseHarness();
  const refused = await keys.run('model.set', { role: 'core', model: 'harness:claude/claude-opus-4-8' }, null);
  assert.equal(refused.status, 'failed');
  assert.deepEqual(held.core, [harness('claude-opus-4-6')]);
});

test('model set on a claude harness route with a level runs the check at that level and saves the route', async () => {
  // Catches: every level on a claude route refused as unsupported, because the check of the core reads no binary's help.
  const privateDir = tempDir('keys-route-harness-');
  fakeVendor(privateDir, 'claude', { loggedIn: true });
  const levels: Array<unknown> = [];
  const real: KeysDeps['checkHarness'] = (route) =>
    checkedRoute(
      {
        privateDir,
        fetch: () => Promise.reject(new Error('no request goes out')),
        runBackend: (_name, _brief, _model, effort) => {
          levels.push(effort);
          return Promise.resolve({ ok: true, text: 'ok', exitCode: 0 });
        },
      },
      { ...route, effort: harnessEffort(route.effort, route.backend) }
    );
  const { keys, held } = routeRig({ core: [api('helpers', 'x/core')] }, healthy, {}, real);
  const answer = await keys.run('model.set', { role: 'editor', model: 'harness:claude/claude-opus-5-5:low' }, null);
  assert.equal(answer.status, 'ok', answer.text);
  assert.deepEqual(levels, ['low']);
  assert.deepEqual(held['editor'], [{ ...harness('claude-opus-5-5'), effort: 'low' }]);
});

test('a harness route on a role that runs no CLI chat step and an unknown key are refused before anything is sent', async () => {
  // Catches: an analyzer saved on claude, or a route on a key that keys.json lacks, both failing every request later.
  const { keys, held, calls, harnessChecks } = routeRig({ analyzer: [api('helpers', 'x/analyzer')] });
  const onHarness = await keys.run('model.set', { role: 'analyzer', model: 'harness:claude/claude-opus-4-6' }, null);
  assert.equal(onHarness.code, 'route-unsupported');
  const unknown = await keys.run('model.set', { role: 'analyzer', model: 'nosuch/x/analyzer' }, null);
  assert.equal(unknown.code, 'key-unknown');
  assert.equal(calls.length + harnessChecks.length, 0);
  assert.deepEqual(held.analyzer, [api('helpers', 'x/analyzer')]);
});

test('model set, model add, model remove and keys check refuse a retired role as an unknown role', async () => {
  // Catches: a deployment that types the role names `humanizer.linter`, `humanizer.writer` or `search` gets a chain
  // written under a key nothing reads, or a check of a role that has no requests.
  const { keys, calls, harnessChecks } = routeRig();
  for (const role of ['humanizer.linter', 'humanizer.writer', 'search']) {
    for (const name of ['model.set', 'model.add']) {
      const answer = await keys.run(name, { role, model: 'helpers/x/model' }, null);
      assert.equal(answer.status, 'invalid', `${name} ${role}`);
      // The diary's role `director` ends the list of roles.
      assert.match(answer.text, /the roles are core, .*linter, editor, director$/);
    }
    const removed = await keys.run('model.remove', { role, n: 1 }, null);
    assert.equal(removed.status, 'invalid', `model.remove ${role}`);
  }
  const checked = await keys.run('keys.check', { target: 'search' }, null);
  assert.equal(checked.code, 'unknown-target', checked.text);
  assert.equal(calls.length + harnessChecks.length, 0);
});

test('model add checks the route and appends it as the fallback, and a route already in the chain is refused', async () => {
  // Catches: a fallback that replaces the first route, or the same route twice, tried twice on one failure.
  const { keys, held } = routeRig({ core: [harness('claude-opus-4-6')] });
  const added = await keys.run('model.add', { role: 'core', model: 'helpers/anthropic/claude-opus-4.6' }, null);
  assert.equal(added.status, 'ok', added.text);
  assert.deepEqual(held.core, [harness('claude-opus-4-6'), api('helpers', 'anthropic/claude-opus-4.6')]);
  const again = await keys.run('model.add', { role: 'core', model: 'helpers/anthropic/claude-opus-4.6' }, null);
  assert.equal(again.code, 'route-duplicate');
  assert.equal(held.core?.length, 2);
});

test('a fallback of the embedding role with another model is refused', async () => {
  // Catches: vectors of two models mixed in one index after a switch, so recall by meaning returns noise.
  const { keys, held, calls } = routeRig({ embedding: [api('helpers', 'openai/text-embedding-3-large')] });
  const answer = await keys.run('model.add', { role: 'embedding', model: 'spare/openai/text-embedding-3-small' }, null);
  assert.equal(answer.code, 'route-model-mismatch');
  assert.equal(calls.length, 0);
  assert.equal(held.embedding?.length, 1);
});

test('model remove drops the n-th route, refuses the last route of a mandatory role and turns an optional one off', async () => {
  // Catches: a core left with no route, which pauses the persona, or the wrong route removed by an index read from zero.
  const { keys, held } = routeRig({
    core: [harness('claude-opus-4-6'), api('helpers', 'x/core')],
    vision: [api('helpers', 'x/vision')],
  });
  assert.equal((await keys.run('model.remove', { role: 'core', index: '2' }, null)).status, 'ok');
  assert.deepEqual(held.core, [harness('claude-opus-4-6')]);
  assert.equal((await keys.run('model.remove', { role: 'core', index: '1' }, null)).code, 'route-required');
  assert.equal((await keys.run('model.remove', { role: 'core', index: '3' }, null)).code, 'route-unknown');
  assert.equal((await keys.run('model.remove', { role: 'vision', index: '1' }, null)).status, 'ok');
  assert.deepEqual(held.vision, []);
});

test('model show names every chain in the text form and never a key value', async () => {
  // Catches: a listing that cannot be typed back into /model set, or one that prints a key.
  const { keys } = routeRig({ core: [harness('claude-opus-4-6'), api('helpers', 'x/core')], vision: [] });
  const answer = await keys.run('model.show', {}, null);
  assert.equal(answer.status, 'ok');
  const core = answer.text.split('\n').find((line) => line.startsWith('core'));
  assert.ok(core?.includes('harness:claude/claude-opus-4-6'), answer.text);
  assert.ok(core?.includes('helpers/x/core'), answer.text);
  assert.equal(answer.text.includes(SECRET), false);
});

test('keys remove keeps the routes that named the key, writes their chains and pauses a core left with no route', async () => {
  // Catches: a removal that unbinds a role onto other keys unseen, or one that leaves the core with nothing to run on awake.
  const { keys, held, pause } = routeRig({
    core: [api('helpers', 'x/core')],
    analyzer: [api('helpers', 'x/analyzer')],
  });
  const answer = await keys.run('keys.remove', { name: 'helpers' }, null);
  assert.equal(answer.status, 'ok', answer.text);
  assert.deepEqual(held.analyzer, [api('helpers', 'x/analyzer')]);
  assert.deepEqual(pause.pauses, ['no-core-route']);
});

test('keys remove of a key the core does not need leaves the persona running', async () => {
  // Catches: every removal pausing the persona, though the core runs on a harness.
  const { keys, pause } = routeRig({ core: [harness('claude-opus-4-6')], analyzer: [api('spare', 'x/analyzer')] });
  assert.equal((await keys.run('keys.remove', { name: 'spare' }, null)).status, 'ok');
  assert.deepEqual(pause.pauses, []);
});

test('keys list names the roles whose chains use each key, and keys check reads a key by name', async () => {
  // Catches: a listing that hides which role a removal would leave without its key, or a check that takes a key for a role.
  const { keys, calls } = routeRig({ core: [harness('claude-opus-4-6')], analyzer: [api('helpers', 'x/analyzer')] });
  const listed = await keys.run('keys.list', {}, null);
  const line = listed.text.split('\n').find((one) => one.startsWith('helpers'));
  assert.ok(line?.includes('analyzer'), listed.text);
  const checked = await keys.run('keys.check', { target: 'spare' }, null);
  assert.equal(checked.status, 'ok', checked.text);
  assert.ok(calls.some((call) => call.url.endsWith('/auth/key') && call.auth === SECRET_2));
});

/** A provider with no endpoint for any model: an answer of 404 to a request pinned to it alone. */
const DEAD = 'deadprov';

/** OpenRouter as the live client meets it: 404 for a body whose `provider.only` names DEAD, healthy otherwise. */
function pinnedRefusal(call: Call): Reply {
  const provider = call.body?.provider;
  const only = provider !== null && typeof provider === 'object' ? (provider as { only?: unknown }).only : undefined;
  if (Array.isArray(only) && only.length === 1 && only[0] === DEAD)
    return { status: 404, body: { error: { message: 'No endpoints found' } } };
  return healthy(call);
}

test('model set refuses a route whose live requests llm.providerByModel pins to a provider with no endpoint', async () => {
  // Catches: a check sent without the routing of llm.providerByModel, which passes while every live request 404s.
  const llm = { providerByModel: { 'vendor/': { only: [DEAD] } } };
  const { keys, held } = routeRig({ analyzer: [api('spare', 'old/analyzer')] }, pinnedRefusal, llm);
  const answer = await keys.run('model.set', { role: 'analyzer', model: 'helpers/vendor/model-1' }, null);
  assert.equal(answer.status, 'failed', answer.text);
  assert.deepEqual(held.analyzer, [api('spare', 'old/analyzer')]);
});

test('model set saves the route when an entry for its role routes the model to a provider that answers', async () => {
  // Catches: a check that takes the role-less entry where the live request of that role takes the role's own.
  const llm = { providerByModel: { 'vendor/': { only: [DEAD] }, 'vendor/@analyzer': { only: ['liveprov'] } } };
  const { keys, held, calls } = routeRig({}, pinnedRefusal, llm);
  const answer = await keys.run('model.set', { role: 'analyzer', model: 'helpers/vendor/model-1' }, null);
  assert.equal(answer.status, 'ok', answer.text);
  const [check] = calls;
  assert.deepEqual(check?.body?.provider, { only: ['liveprov'] });
  assert.deepEqual(held.analyzer, [api('helpers', 'vendor/model-1')]);
});

test('model set refuses a route marked byok whose check the provider bills on its own capacity', async () => {
  // Catches: a check that passes where the live client's BYOK guard refuses every answer of the route.
  const llm = { providerByModel: { 'vendor/': { only: ['liveprov'], byok: true } } };
  const { keys, held, calls } = routeRig({}, healthy, llm);
  const answer = await keys.run('model.set', { role: 'analyzer', model: 'helpers/vendor/model-1' }, null);
  assert.equal(answer.status, 'failed', answer.text);
  const [check] = calls;
  assert.deepEqual(check?.body?.provider, { only: ['liveprov'] });
  assert.equal(held.analyzer, undefined);
});

test('keys check of a humanizer role checks its route in force with the routing of its role', async () => {
  // Catches: a role of the chains that keys check takes for a key name, or checks without its own routing.
  const llm = { providerByModel: { 'vendor/': { only: [DEAD] } } };
  const { keys, calls } = routeRig({ 'linter': [api('helpers', 'vendor/model-1')] }, pinnedRefusal, llm);
  const answer = await keys.run('keys.check', { target: 'linter' }, null);
  assert.equal(answer.status, 'failed', answer.text);
  assert.equal(calls.length, 1);
  const [check] = calls;
  assert.equal(check?.body?.model, 'vendor/model-1');
});

// Speech and drawing behind `/keys check` and `model set`, with the provider's listing of a drawing model.

/** The audio bytes OpenRouter answers a synthesis with. */
const AUDIO: Reply = { status: 200, body: 'ID3-synthetic-audio' };

function mediaRig({
  answer = healthy,
  model = 'x/media',
  withKey = true,
}: { answer?: (call: Call) => Reply; model?: string; withKey?: boolean } = {}) {
  const privateDir = tempDir('keys-media-');
  const store = createKeyStore({ privateDir });
  if (withKey) store.add({ name: 'core-1', value: SECRET });
  // Every role runs on its chain; here every role's chain names every key of the store.
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

test('/keys check speech goes out on the role key with the configured voice and answers ok', async () => {
  // Bug: the command path knows no voice, so the enabled role still cannot be checked from the chat.
  const { keys, calls } = mediaRig({ answer: () => AUDIO });
  const answer = await keys.run('keys.check', { role: 'speech' }, null);
  assert.equal(answer.status, 'ok', answer.text);
  const speech = calls[0];
  assert.equal(speech?.body?.voice, 'voice-1');
});

test('/keys check drawing answers ok on a model the listing holds with image output', async () => {
  // The drawing check reads the free listing, so a drawing model is checked like any role.
  const { keys } = mediaRig({ answer: listing, model: 'x/draw' });
  const answer = await keys.run('keys.check', { role: 'drawing' }, null);
  assert.equal(answer.status, 'ok', answer.text);
});

for (const role of ['speech', 'drawing']) {
  test(`/keys check ${role} on a role switched off says off and sends nothing`, async () => {
    // Bug: a role the owner left off is checked with an empty model and reads as a broken key.
    const { keys, calls } = mediaRig({ model: '' });
    const answer = await keys.run('keys.check', { role }, null);
    assert.equal(answer.status, 'not_configured');
    assert.deepEqual(calls, []);
  });
}

test('model set drawing changes nothing and says why on a model with no image output', async () => {
  // Bug: a text model is written as the drawing route and every drawing fails later.
  const { keys, chains } = mediaRig({ answer: listing });
  const answer = await keys.run('model.set', { role: 'drawing', model: 'core-1/x/text' }, null);
  assert.equal(answer.status, 'failed');
  assert.match(answer.text, /no image output/);
  assert.equal(chains.drawing, undefined);
});

test('model set drawing writes the route unchecked when the listing cannot be read', async () => {
  // A listing that is refused leaves the role unchecked.
  const { keys, calls, chains } = mediaRig({ answer: () => ({ status: 401, body: {} }) });
  const answer = await keys.run('model.set', { role: 'drawing', model: 'core-1/x/draw' }, null);
  assert.equal(answer.status, 'ok', answer.text);
  assert.deepEqual(chains.drawing, [{ via: 'api', key: 'core-1', model: 'x/draw', effort: null }]);
  // The request is the model's own listing.
  assert.deepEqual(
    calls.map((call) => call.url.slice(BASE_URL.length)),
    ['/models/x/draw/endpoints']
  );
});

const CORE_T0 = Date.parse('2026-11-02T09:00:00Z');
const VALUE_1 = 'sk-or-v1-SECRETVALUE-core-one-1111';
const VALUE_2 = 'sk-or-v1-SECRETVALUE-core-two-2222';

/** The core of the units rig, with an empty environment: its keys can only come from `keys.json`. */
function startOnKeyStore(dirs: Dirs, llm: Llm): Promise<Core> {
  return startCore({
    paths: dirs.paths,
    env: {},
    interfaces: [],
    llm,
    embedder: { embed: () => Promise.resolve([]) },
    now: () => CORE_T0,
  });
}

const p = (dirs: Dirs, line: string): ReturnType<typeof runCli> => runCli(dirs, ['-p', line]);

// The core role runs on its chain, here one route on each of the two keys.
const ON_BOTH_KEYS = {
  models: {
    routes: {
      core: [
        { via: 'api', key: 'core-1', model: 'x/core', effort: null },
        { via: 'api', key: 'core-2', model: 'x/core', effort: null },
      ],
    },
  },
};

test('a core with a keys.json starts without a key in its environment, lists keys by name and last four, and the last removal pauses the persona', async () => {
  await withRig({ config: ON_BOTH_KEYS }, async ({ dirs, llm, cores }) => {
    const store = createKeyStore({ privateDir: dirs.privateDir });
    store.add({ name: 'core-1', value: VALUE_1 });
    store.add({ name: 'core-2', value: VALUE_2 });
    // Bug caught: the core refusing to start for want of OPENROUTER_CORE_KEY although the key store holds the keys.
    cores.push(await startOnKeyStore(dirs, llm));

    const listed = await p(dirs, '/keys list');
    assert.equal(listed.code, 0, listed.stderr.slice(-1000));
    assert.ok(listed.stdout.includes('core-1') && listed.stdout.includes('1111') && listed.stdout.includes('2222'));
    assert.ok(!listed.stdout.includes('SECRETVALUE'));

    assert.equal((await p(dirs, '/keys remove core-2')).code, 0);
    assert.ok(!(await p(dirs, '/status')).stdout.includes('no-core-route'), 'one key is left: the persona runs');

    assert.equal((await p(dirs, '/keys remove core-1')).code, 0);
    const paused = await p(dirs, '/status');
    // Bug caught: the last removal leaving the persona running with no key, or pausing without saying why.
    assert.ok(paused.stdout.includes('paused') && paused.stdout.includes('no-core-route'), paused.stdout);
    assert.deepEqual(store.names(), []);

    assert.equal((await p(dirs, '/resume')).code, 0);
    assert.ok(!(await p(dirs, '/status')).stdout.includes('no-core-route'));
    assert.equal((await p(dirs, '/pause')).code, 0);
    // Bug caught: the reason of an earlier pause kept in the state, so a pause typed at the console reads as a missing key.
    const again = await p(dirs, '/status');
    assert.ok(again.stdout.includes('paused'));
    assert.ok(!again.stdout.includes('no-core-route'), again.stdout);
  });
});

test('a key command that asks for a value with no terminal to ask in is refused and writes nothing', async () => {
  await withRig({}, async ({ dirs, llm, cores }) => {
    createKeyStore({ privateDir: dirs.privateDir }).add({ name: 'core-1', value: VALUE_1 });
    cores.push(await startOnKeyStore(dirs, llm));
    const run = await p(dirs, '/keys add art');
    assert.equal(run.code, 1);
    assert.deepEqual(createKeyStore({ privateDir: dirs.privateDir }).names(), ['core-1']);
  });
});

const HARNESS_T0 = Date.parse('2026-11-06T09:00:00Z');
const VALUE = 'sk-or-v1-SECRETVALUE-harness-1111';
const ON_CLAUDE = { backend: 'claude', model: 'claude-opus-4-6', effort: null };

/** The core of the units rig with an empty environment: its keys can only come from `keys.json`. */
function start(dirs: Dirs, llm: Llm): Promise<Core> {
  return startCore({
    paths: dirs.paths,
    env: {},
    interfaces: [],
    llm,
    embedder: { embed: () => Promise.resolve([]) },
    now: () => HARNESS_T0,
  });
}

/** keys.json with one core key (unless `keys` is false) and, when `harness` is set, the core role on claude. */
function store(dirs: Dirs, harness: boolean, keys = true): void {
  writeKeysFile(dirs.privateDir, {
    core: keys ? [{ name: 'core-1', value: VALUE }] : [],
    subharness: { key: null, modes: {}, ...(harness ? { core: ON_CLAUDE } : {}) },
  });
  // The core probes the harness the persona's turns run on at start and sleeps with core-down when it cannot answer,
  // so a harness core here has its CLI installed and logged in: the fake vendor, which runs no model.
  if (harness) fakeVendor(dirs.privateDir, 'claude', { loggedIn: true });
}

test('removing the last core key while the core role runs on a harness leaves the persona running and says the harness needs no key', async () => {
  // Catches: the last removal pausing the persona with no-core-route although claude answers their turns on its own login.
  await withRig({}, async ({ dirs, llm, cores }) => {
    store(dirs, true);
    cores.push(await start(dirs, llm));
    const removed = await p(dirs, '/keys remove core-1');
    assert.equal(removed.code, 0, removed.stderr.slice(-1000));
    assert.match(removed.stdout, /claude/, 'the answer names the harness');
    assert.ok(!removed.stdout.includes('no-core-route'), removed.stdout);
    const status = await p(dirs, '/status');
    assert.ok(!status.stdout.includes('paused'), status.stdout);
    const file = readKeysFile(dirs.privateDir);
    assert.deepEqual(file.core, [], 'the key is gone');
    assert.deepEqual(file.subharness.core, ON_CLAUDE, 'the core route stays');
  });
});

test('removing the last core key while the core role runs on the API still pauses the persona as no-core-route', async () => {
  // Catches: the harness exemption widened to every core, so a direct core with no key keeps answering into errors.
  await withRig({}, async ({ dirs, llm, cores }) => {
    store(dirs, false);
    cores.push(await start(dirs, llm));
    const removed = await p(dirs, '/keys remove core-1');
    assert.equal(removed.code, 0, removed.stderr.slice(-1000));
    const status = await p(dirs, '/status');
    assert.ok(status.stdout.includes('paused') && status.stdout.includes('no-core-route'), status.stdout);
  });
});

test('/model set core <model> with no key and no binding while on a harness is refused and the route stays', async () => {
  // Catches: the return to the API accepted with no key to run it on, which leaves the persona on a route that cannot run.
  await withRig({}, async ({ dirs, llm, cores }) => {
    store(dirs, true, false);
    cores.push(await start(dirs, llm));
    const set = await p(dirs, '/model set core vendor/core-2');
    assert.notEqual(set.code, 0, set.stdout);
    assert.deepEqual(readKeysFile(dirs.privateDir).subharness.core, ON_CLAUDE);
  });
});

test('/keys check core on a harness core with no key is not reported as a missing key', async () => {
  // Catches: the check asking for a core key for a role the harness serves.
  await withRig({}, async ({ dirs, llm, cores }) => {
    store(dirs, true, false);
    cores.push(await start(dirs, llm));
    const checked = await p(dirs, '/keys check core');
    const said = checked.stdout + checked.stderr;
    assert.ok(!/has no key/.test(said), said);
    assert.equal(checked.code, 0, said);
  });
});

test('/keys check core on a direct core with no key is reported as missing its key', async () => {
  // Catches: the harness rule leaking to a core on the API, whose missing key must still be named.
  await withRig({}, async ({ dirs, llm, cores }) => {
    store(dirs, false, false);
    cores.push(await start(dirs, llm));
    const checked = await p(dirs, '/keys check core');
    assert.notEqual(checked.code, 0);
    assert.match(checked.stdout + checked.stderr, /no key/);
  });
});
