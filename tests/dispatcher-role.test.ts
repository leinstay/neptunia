// Tests for the model role `dispatcher` (src/llm/roles.ts, src/llm/route-text.ts, src/keys/commands.ts,
// src/keys/check.ts, src/interface/commands/table.ts): it holds a chain of routes with no default model and no
// reasoning effort, the first key asks for its model as for every mandatory role, its check sends one chat request,
// and `/model set dispatcher` passes the command table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKeysCommands } from '../src/keys/commands.ts';
import { checkRole } from '../src/keys/check.ts';
import { createKeyStore } from '../src/keys/store.ts';
import { isRouteRole, parseRouteText } from '../src/llm/route-text.ts';
import type { Route, RouteRole } from '../src/llm/route-text.ts';
import { dispatcherModel } from '../src/llm/roles.ts';
import { parseCommandLine } from '../src/interface/commands/table.ts';
import { BASE_URL, SECRET, chainRing, fakeFetch, fakePause, scriptedDialog } from './fixtures/keys-rig.ts';
import { chainsOf } from './fixtures/chains.ts';
import { tempDir } from './fixtures/tmp.ts';

const DEFAULTS = { core: 'd/core', memory: 'd/memory', analyzer: 'd/analyzer', embedding: 'd/embedding' };

function firstKeyRig() {
  const store = createKeyStore({ privateDir: tempDir('dispatcher-role-') });
  const { fetch, calls } = fakeFetch();
  const chains: Partial<Record<RouteRole, Array<Route>>> = {};
  const chainOf = (role: string): Array<Route> => (isRouteRole(role) ? (chains[role] ?? []) : []);
  const keys = createKeysCommands({
    store,
    ring: chainRing(store, chainOf),
    fetch,
    baseUrl: () => BASE_URL,
    defaults: DEFAULTS,
    currentModel: (role) => chainOf(role)[0]?.model ?? '',
    pause: fakePause(null),
    chainOf,
    saveRoutes: (role, routes) => {
      chains[role] = routes;
      return Promise.resolve();
    },
  });
  return { keys, chains, calls, store };
}

test('the first key asks for the dispatcher model and saves its chain on the new key', async () => {
  // Bug caught: a fresh install with no dispatcher route, so every errand of hers fails before it runs.
  const { keys, chains } = firstKeyRig();
  const { dialog, asked } = scriptedDialog([SECRET, '', '', '', '', 'x/dispatcher']);
  const answer = await keys.run('keys.add', { name: 'main' }, dialog);
  assert.equal(answer.status, 'ok');
  assert.ok(asked[5]?.question.includes('dispatcher'));
  assert.deepEqual(chains.dispatcher, [{ via: 'api', key: 'main', model: 'x/dispatcher', effort: null }]);
});

test('the first key refuses a blank dispatcher model, since the role has no default, and saves nothing', async () => {
  const { keys, store } = firstKeyRig();
  const { dialog } = scriptedDialog([SECRET, '', '', '', '', '']);
  const answer = await keys.run('keys.add', { name: 'main' }, dialog);
  assert.notEqual(answer.status, 'ok');
  assert.deepEqual(store.names(), []);
});

test('the dispatcher check sends one chat request with no reasoning', async () => {
  const { fetch, calls } = fakeFetch();
  const result = await checkRole({
    fetch,
    baseUrl: BASE_URL,
    role: 'dispatcher',
    model: 'x/d',
    keyName: 'k',
    value: SECRET,
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.body?.model, 'x/d');
  assert.equal(Object.hasOwn(calls[0]?.body ?? {}, 'reasoning'), false);
});

test('a dispatcher route takes no reasoning level, and its model is its first route with no default', () => {
  // Bug caught: a provider reasoning effort on the dispatcher's requests.
  assert.equal('code' in parseRouteText('dispatcher', 'main/x/d:low'), true);
  assert.equal('code' in parseRouteText('dispatcher', 'main/x/d'), false);
  assert.equal(dispatcherModel({}), undefined);
  assert.equal(dispatcherModel({ models: { routes: chainsOf({ dispatcher: 'x/d' }) } }), 'x/d');
});

test('/model set dispatcher passes the command table', () => {
  assert.equal(parseCommandLine('/model set dispatcher main/x/d').ok, true);
});
