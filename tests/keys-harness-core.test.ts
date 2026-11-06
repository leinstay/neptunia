// A core on a harness needs no API key (owner, 2026-11-06). The tests run a real core over temp folders (the rig of
// tests/fixtures/core-units.ts) with a `keys.json` whose `subharness.core` record puts her turns on the claude harness,
// and drive the owner's commands through the chat's `-p`. No model is asked and no provider is reached: a harness
// route is only a record here, and the commands under test send no request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startCore } from '../src/core.ts';
import { readKeysFile, writeKeysFile } from './fixtures/keys-file.ts';
import { runCli, settle, withRig } from './fixtures/core-units.ts';
import type { Core, Dirs, Llm } from './fixtures/core-units.ts';

const T0 = Date.parse('2026-11-06T09:00:00Z');
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
    now: () => T0,
  });
}

/** keys.json with one core key (unless `keys` is false) and, when `harness` is set, her core on claude. */
function store(dirs: Dirs, harness: boolean, keys = true): void {
  writeKeysFile(dirs.privateDir, {
    core: keys ? [{ name: 'core-1', value: VALUE }] : [],
    subharness: { key: null, modes: {}, ...(harness ? { core: ON_CLAUDE } : {}) },
  });
}

const p = (dirs: Dirs, line: string): ReturnType<typeof runCli> => runCli(dirs, ['-p', line]);

test('removing the last core key while her core runs on a harness leaves her running and says the harness needs no key', async () => {
  // Catches: the last removal pausing her with no-core-key although claude answers her turns on its own login.
  await withRig({}, async ({ dirs, llm, cores }) => {
    store(dirs, true);
    cores.push(await start(dirs, llm));
    const removed = await p(dirs, '/keys core remove core-1');
    assert.equal(removed.code, 0, removed.stderr.slice(-1000));
    assert.match(removed.stdout, /claude/, 'the answer names the harness');
    assert.ok(!removed.stdout.includes('no-core-key'), removed.stdout);
    const status = await p(dirs, '/status');
    assert.ok(!status.stdout.includes('paused'), status.stdout);
    const file = readKeysFile(dirs.privateDir);
    assert.deepEqual(file.core, [], 'the key is gone');
    assert.deepEqual(file.subharness.core, ON_CLAUDE, 'her route stays');
  });
});

test('removing the last core key while her core runs on the API still pauses her as no-core-key', async () => {
  // Catches: the harness exemption widened to every core, so a direct core with no key keeps answering into errors.
  await withRig({}, async ({ dirs, llm, cores }) => {
    store(dirs, false);
    cores.push(await start(dirs, llm));
    const removed = await p(dirs, '/keys core remove core-1');
    assert.equal(removed.code, 0, removed.stderr.slice(-1000));
    const status = await p(dirs, '/status');
    assert.ok(status.stdout.includes('paused') && status.stdout.includes('no-core-key'), status.stdout);
  });
});

test('a core with a harness route and no core key starts and stays running, not paused', async () => {
  // Catches: a start that treats the empty key list as a reason to pause or to refuse, for a core that needs no key.
  await withRig({}, async ({ dirs, llm, cores }) => {
    store(dirs, true, false);
    cores.push(await start(dirs, llm));
    await settle();
    const status = await p(dirs, '/status');
    assert.equal(status.code, 0, status.stderr.slice(-1000));
    assert.ok(!status.stdout.includes('paused'), status.stdout);
    assert.ok(!status.stdout.includes('no-core-key'), status.stdout);
  });
});

test('/model set core <model> with no key and no binding while on a harness is refused and the route stays', async () => {
  // Catches: the return to the API accepted with no key to run it on, which leaves her on a route that cannot run.
  await withRig({}, async ({ dirs, llm, cores }) => {
    store(dirs, true, false);
    cores.push(await start(dirs, llm));
    const set = await p(dirs, '/model set core vendor/core-2');
    assert.notEqual(set.code, 0, set.stdout);
    assert.deepEqual(readKeysFile(dirs.privateDir).subharness.core, ON_CLAUDE);
  });
});

test('/keys check core on a harness core with no key is not reported as a missing key', async () => {
  // Catches: the check telling the owner to add a core key for a role the harness serves.
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
