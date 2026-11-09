// Tests for the chain commands of src/keys/commands.ts: `/model show`, `/model set <role> <route>`, `/model add` and
// `/model remove`. A route on a key is checked with one request on that key and model, a route on a harness with one
// reply through it, and nothing is saved on a refusal. The store is a temp folder, the provider a fake fetch, the harness
// check a fake; the tests assert on what is saved and sent, never on wording.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKeysCommands } from '../src/keys/commands.ts';
import { createKeyRing } from '../src/keys/ring.ts';
import { createKeyStore } from '../src/keys/store.ts';
import { createKeyFailover } from '../src/llm/key-failover.ts';
import { isRouteRole } from '../src/llm/route-text.ts';
import type { Route, RouteRole } from '../src/llm/route-text.ts';
import { BASE_URL, SECRET, SECRET_2, fakeFetch, fakePause, healthy } from './fixtures/keys-rig.ts';
import type { Call, Reply } from './fixtures/keys-rig.ts';
import { tempDir } from './fixtures/tmp.ts';

const api = (key: string, model: string): Route => ({ via: 'api', key, model, effort: null });
const harness = (model: string): Route => ({ via: 'harness', backend: 'claude', model, effort: null });

/** The model of a chain's first route, '' for none. */
const firstModel = (chain: ReadonlyArray<Route> | undefined): string => chain?.[0]?.model ?? '';

function rig(chains: Partial<Record<RouteRole, Array<Route>>> = {}, answer: (call: Call) => Reply = healthy) {
  const privateDir = tempDir('keys-route-commands-');
  const store = createKeyStore({ privateDir });
  store.addExtra({ name: 'helpers', value: SECRET });
  store.addExtra({ name: 'spare', value: SECRET_2 });
  const ring = createKeyRing({ store, failover: createKeyFailover({ now: () => 0 }) });
  const { fetch, calls } = fakeFetch(answer);
  const held: Partial<Record<RouteRole, Array<Route>>> = { ...chains };
  const harnessChecks: Array<Route> = [];
  let harnessOk = true;
  const pause = fakePause(null);
  const keys = createKeysCommands({
    store,
    ring,
    fetch,
    baseUrl: () => BASE_URL,
    defaults: {},
    currentModel: (role) => (isRouteRole(role) ? firstModel(held[role]) : ''),
    saveModel: () => Promise.resolve(),
    pause,
    chainOf: (role) => held[role] ?? [],
    saveRoutes: (role, routes) => {
      held[role] = routes;
      return Promise.resolve();
    },
    checkHarness: (route) => {
      harnessChecks.push(route);
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
  const { keys, held, calls } = rig({ analyzer: [api('spare', 'old/analyzer'), api('spare', 'old/two')] });
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
  const { keys, held } = rig({ analyzer: [api('spare', 'old/analyzer')] }, refuse);
  const answer = await keys.run('model.set', { role: 'analyzer', model: 'helpers/x/missing' }, null);
  assert.equal(answer.status, 'failed');
  assert.deepEqual(held.analyzer, [api('spare', 'old/analyzer')]);
});

test('model set on a harness route checks it through the harness and saves it, and a refused check saves nothing', async () => {
  // Catches: a core moved onto a logged-out CLI, so every turn fails until the owner notices.
  const { keys, held, calls, harnessChecks, refuseHarness } = rig({ core: [api('helpers', 'x/core')] });
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

test('a harness route on a role that runs no CLI chat step and an unknown key are refused before anything is sent', async () => {
  // Catches: an analyzer saved on claude, or a route on a key that keys.json lacks, both failing every request later.
  const { keys, held, calls, harnessChecks } = rig({ analyzer: [api('helpers', 'x/analyzer')] });
  const onHarness = await keys.run('model.set', { role: 'analyzer', model: 'harness:claude/claude-opus-4-6' }, null);
  assert.equal(onHarness.code, 'route-unsupported');
  const unknown = await keys.run('model.set', { role: 'analyzer', model: 'nosuch/x/analyzer' }, null);
  assert.equal(unknown.code, 'key-unknown');
  assert.equal(calls.length + harnessChecks.length, 0);
  assert.deepEqual(held.analyzer, [api('helpers', 'x/analyzer')]);
});

test('model add checks the route and appends it as the fallback, and a route already in the chain is refused', async () => {
  // Catches: a fallback that replaces the first route, or the same route twice, tried twice on one failure.
  const { keys, held } = rig({ core: [harness('claude-opus-4-6')] });
  const added = await keys.run('model.add', { role: 'core', model: 'helpers/anthropic/claude-opus-4.6' }, null);
  assert.equal(added.status, 'ok', added.text);
  assert.deepEqual(held.core, [harness('claude-opus-4-6'), api('helpers', 'anthropic/claude-opus-4.6')]);
  const again = await keys.run('model.add', { role: 'core', model: 'helpers/anthropic/claude-opus-4.6' }, null);
  assert.equal(again.code, 'route-duplicate');
  assert.equal(held.core?.length, 2);
});

test('a fallback of the embedding role with another model is refused', async () => {
  // Catches: vectors of two models mixed in one index after a switch, so recall by meaning returns noise.
  const { keys, held, calls } = rig({ embedding: [api('helpers', 'openai/text-embedding-3-large')] });
  const answer = await keys.run('model.add', { role: 'embedding', model: 'spare/openai/text-embedding-3-small' }, null);
  assert.equal(answer.code, 'route-model-mismatch');
  assert.equal(calls.length, 0);
  assert.equal(held.embedding?.length, 1);
});

test('model remove drops the n-th route, refuses the last route of a mandatory role and turns an optional one off', async () => {
  // Catches: a core left with no route, which pauses her, or the wrong route removed by an index read from zero.
  const { keys, held } = rig({
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
  const { keys } = rig({ core: [harness('claude-opus-4-6'), api('helpers', 'x/core')], vision: [] });
  const answer = await keys.run('model.show', {}, null);
  assert.equal(answer.status, 'ok');
  const core = answer.text.split('\n').find((line) => line.startsWith('core'));
  assert.ok(core?.includes('harness:claude/claude-opus-4-6'), answer.text);
  assert.ok(core?.includes('helpers/x/core'), answer.text);
  assert.equal(answer.text.includes(SECRET), false);
});

test('keys remove keeps the routes that named the key, writes their chains and pauses a core left with no route', async () => {
  // Catches: a removal that unbinds a role onto other keys unseen, or one that leaves her core with nothing to run on awake.
  const { keys, held, pause } = rig({ core: [api('helpers', 'x/core')], analyzer: [api('helpers', 'x/analyzer')] });
  const answer = await keys.run('keys.remove', { name: 'helpers' }, null);
  assert.equal(answer.status, 'ok', answer.text);
  assert.deepEqual(held.analyzer, [api('helpers', 'x/analyzer')]);
  assert.deepEqual(pause.pauses, ['no-core-route']);
});

test('keys remove of a key her core does not need leaves her running', async () => {
  // Catches: every removal pausing her, though her core runs on a harness.
  const { keys, pause } = rig({ core: [harness('claude-opus-4-6')], analyzer: [api('spare', 'x/analyzer')] });
  assert.equal((await keys.run('keys.remove', { name: 'spare' }, null)).status, 'ok');
  assert.deepEqual(pause.pauses, []);
});

test('keys list names the roles whose chains use each key, and keys check reads a key by name', async () => {
  // Catches: a listing that hides which role a removal would leave without its key, or a check that takes a key for a role.
  const { keys, calls } = rig({ core: [harness('claude-opus-4-6')], analyzer: [api('helpers', 'x/analyzer')] });
  const listed = await keys.run('keys.list', {}, null);
  const line = listed.text.split('\n').find((one) => one.startsWith('helpers'));
  assert.ok(line?.includes('analyzer'), listed.text);
  const checked = await keys.run('keys.check', { target: 'spare' }, null);
  assert.equal(checked.status, 'ok', checked.text);
  assert.ok(calls.some((call) => call.url.endsWith('/auth/key') && call.auth === SECRET_2));
});
