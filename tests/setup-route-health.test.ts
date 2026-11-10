// src/setup/route-health.ts: the `routes` check of `neptunia doctor`. Every part of Neptunia is checked for real on what
// it runs on now: a role on the API with one minimal request on its own key and model, a role or an agent on a harness
// with the vendor's own status command. A connection that is set up and used by nothing is checked too: a key no route
// names with the free read of its record, a logged-in harness no role uses with its status command. The owner's word of
// 2026-11-08. keys.json and config.json in a temp dir, fetch and the vendors are fakes.
// Changed: every role runs on its chain in `models.routes` (spec 2026-11-09-model-routes, slice 4), so the rig gives each
// role of MODELS a chain of one route on `core-1`, or on the key `options.keys` names, and none for a role set to false.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { routeHealth } from '../src/setup/route-health.ts';
import { BASE_URL, fakeFetch, healthy } from './fixtures/keys-rig.ts';
import type { Call, Reply } from './fixtures/keys-rig.ts';
import { writeKeysFile } from './fixtures/keys-file.ts';
import type { KeysFile } from './fixtures/keys-file.ts';
import { fakeVendor } from './fixtures/fake-vendor.ts';
import { tempDir } from './fixtures/tmp.ts';

const CORE_VALUE = 'sk-or-v1-core-value-1111';
const EXTRA_VALUE = 'sk-or-v1-extra-value-2222';
const MODELS = {
  core: 'x/core',
  memory: 'x/memory',
  analyzer: 'x/analyzer',
  vision: false,
  video: false,
  embedding: 'x/embedding',
  speech: false,
  drawing: 'x/drawing',
};

/** A deployment with the key `core-1` and `keys` beside it; fetch refuses the models in `refused`. */
function rig(
  keys: Partial<KeysFile> = {},
  options: { refused?: Array<string>; models?: Record<string, unknown>; keys?: Record<string, string> } = {}
) {
  const privateDir = tempDir('nep-route-health-');
  writeKeysFile(privateDir, {
    core: [{ name: 'core-1', value: CORE_VALUE }],
    subharness: { key: null, modes: {} },
    ...keys,
  });
  const refused = new Set(options.refused ?? []);
  const answer = (call: Call): Reply =>
    refused.has(String(call.body?.model))
      ? { status: 401, body: { error: { message: 'User not found' } } }
      : healthy(call);
  const { fetch, calls } = fakeFetch(answer);
  // The doctor's config is the merged one, so the routing config.json holds is laid over the test's values, read at the run.
  const config = () => {
    const stored = JSON.parse(fs.readFileSync(path.join(privateDir, 'config', 'config.json'), 'utf8')) as {
      models?: object;
      llm?: object;
    };
    const chains = Object.fromEntries(
      Object.entries({ ...MODELS, ...options.models }).map(([role, model]) => [
        role,
        model === false ? [] : [{ via: 'api', key: options.keys?.[role] ?? 'core-1', model, effort: null }],
      ])
    );
    const own = (stored.models as { routes?: object } | undefined)?.routes;
    return {
      llm: { baseUrl: BASE_URL, ...stored.llm },
      models: { ...stored.models, routes: { ...chains, ...own } },
      speech: { voice: '' },
    };
  };
  const run = () => routeHealth({ privateDir, config: config(), fetch });
  const asked = (model: string): Array<Call> => calls.filter((call) => call.body?.model === model);
  return { privateDir, run, calls, asked };
}

test('a core on the API whose key the provider refuses fails the check, naming the core and its key', async () => {
  // Catches: a doctor that says healthy while every turn of hers fails on a revoked key.
  const { run } = rig({}, { refused: ['x/core'] });
  const health = await run();
  assert.equal(health.status, 'fail');
  const line = health.detail.split('\n').find((one) => one.startsWith('core'));
  assert.ok(line?.includes('core-1'), health.detail);
  assert.equal(health.detail.includes(CORE_VALUE), false, 'no key value is printed');
});

test('a role whose chain names another key is asked on that key with its own model', async () => {
  // Catches: every role checked on the core's key, so an analyzer whose own key was revoked passes.
  const { run, asked } = rig({ extra: { side: EXTRA_VALUE } }, { keys: { analyzer: 'side' } });
  await run();
  assert.deepEqual(
    asked('x/analyzer').map((call) => call.auth),
    [EXTRA_VALUE]
  );
  assert.deepEqual(
    asked('x/core').map((call) => call.auth),
    [CORE_VALUE]
  );
});

test('a role switched off is named off and not asked, and drawing is named and not asked', async () => {
  // Catches: a request for a switched-off role, or a whole picture billed by a health check.
  const { run, asked } = rig({}, { models: { vision: 'x/vision', video: false } });
  const health = await run();
  assert.ok(health.detail.includes('video: off'), health.detail);
  assert.equal(asked('x/drawing').length, 0);
  assert.equal(asked('x/vision').length, 1);
  assert.ok(/drawing: .*x\/drawing/.test(health.detail), health.detail);
});

test('the memory writer on a harness that is logged out fails the check, and its API model is not asked', async () => {
  // Catches: the memory key probed for a writer that runs on a subscription, so its dropped login passes.
  const { privateDir, run, asked } = rig({
    subharness: { key: null, modes: {}, memory: { backend: 'codex', model: 'gpt-6.1-sol', effort: null } },
  });
  fakeVendor(privateDir, 'codex', { loggedIn: false });
  const health = await run();
  assert.equal(health.status, 'fail');
  assert.ok(/memory: codex-harness .*not logged in/.test(health.detail), health.detail);
  assert.equal(asked('x/memory').length, 0);
});

test('an agent on a harness that is logged out is reported as a warning', async () => {
  // Catches: a dev agent whose claude login dropped left out of the doctor, or failing it although she runs on.
  const { privateDir, run } = rig({ subharness: { key: null, modes: {}, uses: { dev: 'claude' } } });
  fakeVendor(privateDir, 'claude', { loggedIn: false });
  const health = await run();
  assert.equal(health.status, 'warn');
  assert.ok(/dev: claude-harness .*not logged in/.test(health.detail), health.detail);
});

test('a key no route names is read for free and reported unused', async () => {
  // Catches: a key the owner entered and forgot, revoked or spent, never shown because no role uses it.
  const { run, calls } = rig({ extra: { spare: EXTRA_VALUE } });
  const health = await run();
  const read = calls.filter((call) => call.url.endsWith('/auth/key'));
  assert.deepEqual(
    read.map((call) => [call.method, call.auth]),
    [['GET', EXTRA_VALUE]]
  );
  assert.ok(/spare: used by no route/.test(health.detail), health.detail);
});

test('a harness logged in that no role or agent uses is reported unused', async () => {
  // Catches: a codex login nobody uses left invisible, so the owner cannot tell what is still connected.
  const { privateDir, run } = rig();
  fakeVendor(privateDir, 'codex', { loggedIn: true });
  const health = await run();
  assert.ok(/codex-harness: used by nothing .*logged in/.test(health.detail), health.detail);
  assert.equal(health.status, 'ok');
});

test('two roles on the same model and key are asked once', async () => {
  // Catches: one paid request per role where one proves both, so a doctor run costs a request per line.
  const { run, asked } = rig({}, { models: { memory: 'x/core' } });
  await run();
  assert.equal(asked('x/core').length, 1);
});

test('a core chain whose harness is logged out but whose API route answers warns, naming both routes', async () => {
  // Catches: a doctor that fails her core although the route behind the spent harness carries her turns.
  const { privateDir, run } = rig();
  fakeVendor(privateDir, 'claude', { loggedIn: false });
  const file = path.join(privateDir, 'config', 'config.json');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  const routes = {
    core: [
      { via: 'harness', backend: 'claude', model: 'claude-opus-4-6' },
      { via: 'api', key: 'core-1', model: 'x/core' },
    ],
  };
  fs.writeFileSync(file, JSON.stringify({ ...stored, models: { routes } }));
  const health = await run();
  assert.equal(health.status, 'warn', health.detail);
  const lines = health.detail.split('\n').filter((one) => one.startsWith('core'));
  assert.equal(lines.length, 2, health.detail);
  assert.ok(lines[1]?.includes('core-1'), health.detail);
});

test('no harness logged in warns with the command that logs one in', async () => {
  // Catches: the agents left with no runtime and the doctor silent about it, since no route names a harness (the
  // `features` check that said so is folded into `routes`, CLI audit 2026-11-09).
  const { run } = rig();
  const health = await run();
  assert.equal(health.status, 'warn', health.detail);
  assert.ok(health.detail.includes('neptunia subharness'), health.detail);
});

test('a stored effort level on a role whose model takes no reasoning is reported as a warning naming the role', async () => {
  // Catches: a level config.json holds for embedding, which no request sends, left unseen by the doctor.
  const { run, privateDir } = rig();
  const routes = { embedding: [{ via: 'api', key: 'core-1', model: 'x/embedding', effort: 'high' }] };
  fs.mkdirSync(path.join(privateDir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(privateDir, 'config', 'config.json'), JSON.stringify({ models: { routes } }));
  const health = await run();
  assert.match(health.detail, /^embedding: effort high .*disabled$/m);
});
