// PR 2, one setup flow and readiness: `evaluateReadiness` (src/setup/readiness.ts) turns the public health results into
// the first incomplete requirement of a chat launch, `gatherHealth` reads them with no provider in reach, the recorded
// check of the core model (src/setup/model-check.ts) ties a check to its selection, and `decideLaunch` says what a launch
// does. Pure over injected results; only the files of a temp data folder are real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createConsole } from '../src/interface/commands/console.ts';
import { createKeysCommands } from '../src/keys/commands.ts';
import { createKeyRing } from '../src/keys/ring.ts';
import { createKeyStore } from '../src/keys/store.ts';
import { createKeyFailover } from '../src/llm/key-failover.ts';
import { recordCoreCheck } from '../src/setup/model-check.ts';
import { decideLaunch, evaluateReadiness, gatherHealth } from '../src/setup/readiness.ts';
import type { ReadinessHealth, Requirement } from '../src/setup/readiness.ts';
import { BASE_URL, SECRET, fakeFetch, fakePause } from './fixtures/keys-rig.ts';
import { tempDir } from './fixtures/tmp.ts';

const SELECTION = 'openrouter:vendor/core-1';

const HEALTHY: ReadinessHealth = {
  identity: 'ok',
  config: 'ok',
  services: 'ok',
  core: 'listening',
  link: 'authenticated',
  model: { selection: SELECTION, check: { selection: SELECTION, ok: true, code: null, at: 1 } },
  memory: { service: 'ok', writer: 'ok' },
  optional: {},
};

test('a healthy installation is ready, with nothing to repair', () => {
  // Catches: readiness that blocks a working install on some unrelated field.
  assert.deepEqual(evaluateReadiness(HEALTHY), { ready: true, first: null, failed: [] });
});

test('search, media, mirrors and subharnesses the owner did not choose never block, nor do ones that are down', () => {
  // Catches: an optional service turned into a gate, so a chat refuses to open over a mirror.
  const optional = { search: 'off', media: 'down', mirrors: 'off', subharness: 'not-logged-in' };
  assert.equal(evaluateReadiness({ ...HEALTHY, optional }).ready, true);
});

const CASES: ReadonlyArray<[string, Partial<ReadinessHealth>, Requirement, string]> = [
  ['no CLI identity', { identity: 'missing' }, 'cli-identity', 'no-token'],
  ['a local config that does not parse', { config: 'invalid' }, 'local-config', 'config-invalid'],
  ['no installed service', { services: 'not-installed' }, 'services', 'no-units'],
  ['a core that is down', { core: 'down', link: 'untested' }, 'core-running', 'core-down'],
  ['a saved token the core rejects', { link: 'refused' }, 'cli-link', 'token-rejected'],
  ['no chosen core model', { model: { selection: null, check: null } }, 'core-model', 'no-model'],
  ['a model never checked', { model: { selection: SELECTION, check: null } }, 'core-model', 'check-missing'],
  [
    'a model changed since its check',
    { model: { selection: 'openrouter:vendor/core-2', check: { selection: SELECTION, ok: true, code: null, at: 1 } } },
    'core-model',
    'check-stale',
  ],
  [
    'a saved credential the provider refuses',
    { model: { selection: SELECTION, check: { selection: SELECTION, ok: false, code: 'http-401', at: 1 } } },
    'core-model',
    'check-failed',
  ],
  ['a memory service that is down', { memory: { service: 'down', writer: 'ok' } }, 'memory', 'memory-service-down'],
  ['a memory writer that is down', { memory: { service: 'ok', writer: 'down' } }, 'memory', 'memory-writer-down'],
];

for (const [what, change, requirement, code] of CASES) {
  test(`${what} blocks at ${requirement} with ${code} and a repair`, () => {
    // Catches: a token file or a key that merely exists reads as ready, or a failure with no way out.
    const readiness = evaluateReadiness({ ...HEALTHY, ...change });
    assert.equal(readiness.ready, false);
    assert.equal(readiness.first, requirement);
    const [failure] = readiness.failed;
    assert.equal(failure?.code, code);
    assert.notEqual(failure?.repair ?? '', '');
  });
}

test('several gaps report the earliest as the place to enter, and all of them as failed', () => {
  // Catches: setup entered at the model while the core it would check through is not running.
  const readiness = evaluateReadiness({
    ...HEALTHY,
    identity: 'missing',
    core: 'down',
    link: 'untested',
    model: { selection: null, check: null },
  });
  assert.equal(readiness.first, 'cli-identity');
  assert.deepEqual(
    readiness.failed.map((one) => one.requirement),
    ['cli-identity', 'core-running', 'core-model']
  );
});

test('an unavailable core is a repair of the service, never a reinstall', () => {
  // Catches: a stopped core sends the owner through a setup that erases his settings.
  const [failure] = evaluateReadiness({ ...HEALTHY, core: 'down', link: 'untested' }).failed;
  assert.ok(failure?.repair.includes('neptunia services start'), failure?.repair);
});

// Reading the health

/** A data folder at some stage of an install. */
function folder(stage: { token?: boolean; config?: string; unit?: boolean } = {}) {
  const dataDir = tempDir('nep-readiness-');
  const unitDir = tempDir('nep-readiness-units-');
  if (stage.token === true) {
    fs.mkdirSync(path.join(dataDir, 'clients'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'clients', 'cli.token'), 'token\n', { mode: 0o600 });
    fs.writeFileSync(
      path.join(dataDir, 'clients.json'),
      JSON.stringify({ cli: { kind: 'cli', tokenFile: 'clients/cli.token', permissions: [] } })
    );
  }
  if (stage.config !== undefined) {
    fs.mkdirSync(path.join(dataDir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'config', 'config.json'), stage.config);
  }
  if (stage.unit === true) fs.writeFileSync(path.join(unitDir, 'neptunia-core.service'), '[Unit]\n');
  return { dataDir, unitDir };
}

test('an empty folder and no socket read as no identity, no config, no units and a core that is down', async () => {
  // Catches: the read needing a working core, which is exactly when setup has to run.
  const { dataDir, unitDir } = folder();
  const health = await gatherHealth({
    privateDir: dataDir,
    dataDir,
    unitDir,
    link: () => Promise.resolve({ kind: 'down' }),
  });
  assert.equal(health.identity, 'missing');
  assert.equal(health.config, 'missing');
  assert.equal(health.services, 'not-installed');
  assert.equal(health.core, 'down');
  assert.equal(health.link, 'untested');
});

test('a local config that does not parse is reported, and left as it is', async () => {
  // Catches: readiness that throws on the very file it is meant to report, or one that rewrites it.
  const { dataDir, unitDir } = folder({ config: '{ not json' });
  const health = await gatherHealth({
    privateDir: dataDir,
    dataDir,
    unitDir,
    link: () => Promise.resolve({ kind: 'down' }),
  });
  assert.equal(health.config, 'invalid');
  assert.equal(fs.readFileSync(path.join(dataDir, 'config', 'config.json'), 'utf8'), '{ not json');
});

test('a token file the core rejects counts as an identity and a refused link', async () => {
  // Catches: "the token file exists" read as an authenticated connection.
  const { dataDir, unitDir } = folder({ token: true, unit: true });
  const health = await gatherHealth({
    privateDir: dataDir,
    dataDir,
    unitDir,
    link: () => Promise.resolve({ kind: 'rejected' }),
  });
  assert.equal(health.identity, 'ok');
  assert.equal(health.services, 'ok');
  assert.equal(health.core, 'listening');
  assert.equal(health.link, 'refused');
});

test('with the link up the model and memory come from one read-only command of the core', async () => {
  // Catches: gathering that repeats a probe, or asks anything that spends a request, on every launch.
  const { dataDir, unitDir } = folder({ token: true, unit: true, config: '{}' });
  const asked: Array<string> = [];
  const check = { selection: SELECTION, ok: true, code: null, at: 1 };
  const health = await gatherHealth({
    privateDir: dataDir,
    dataDir,
    unitDir,
    link: () =>
      Promise.resolve({
        kind: 'up',
        ask: (command) => {
          asked.push(command.name);
          const text = JSON.stringify({
            model: { selection: SELECTION, check },
            memory: { service: 'ok', writer: 'ok' },
          });
          return Promise.resolve({ status: 'ok', text });
        },
      }),
  });
  assert.deepEqual(asked, ['status.readiness']);
  assert.deepEqual(evaluateReadiness(health), { ready: true, first: null, failed: [] });
});

// The recorded check

function keysRig(status: number) {
  const privateDir = tempDir('nep-readiness-keys-');
  const store = createKeyStore({ privateDir });
  store.addCore({ name: 'core-1', value: SECRET });
  const ring = createKeyRing({ store, failover: createKeyFailover({ now: () => 1 }) });
  const { fetch, calls } = fakeFetch(() => ({
    status,
    body: { choices: [{ message: { content: 'ok' } }], usage: { cost: 0 } },
  }));
  const recorded: Array<unknown> = [];
  const keys = createKeysCommands({
    store,
    ring,
    fetch,
    baseUrl: () => BASE_URL,
    defaults: {},
    currentModel: () => 'vendor/core-1',
    saveModel: () => Promise.resolve(),
    pause: fakePause(),
    recordCheck: (role, check) => recorded.push({ role, ...check }),
  });
  return { keys, recorded, calls };
}

test('/model set core records the check it ran, for that selection', async () => {
  // Catches: a model saved and checked, and readiness still asking for a check that already happened.
  const { keys, recorded, calls } = keysRig(200);
  const answer = await keys.run('model.set', { role: 'core', model: 'vendor/core-2' }, null);
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

test('status.readiness answers from what the core holds and sends no request', async () => {
  // Catches: the launch's health read spends a model request on every chat opened.
  const dir = tempDir('nep-readiness-console-');
  recordCoreCheck(dir, { selection: 'openrouter:vendor/core-1', ok: true, code: null, at: 5 });
  const { fetch, calls } = fakeFetch();
  const desk = createConsole({
    runOp: () => Promise.resolve({ status: 'ok', code: '', summary: '', data: null }),
    ownerReads: { lessons: () => '' },
    places: () => ['g1'],
    selfId: () => 'self-1',
    hot: { config: { bot: { owners: [] }, models: { base: { core: 'vendor/core-1' } } } },
    privateDir: dir,
    dataDir: dir,
    memoryDb: null,
    usage: null,
    metrics: null,
    chatLines: () => [],
    now: () => 0,
    subharness: { fetch, runBackend: () => Promise.reject(new Error('no model run')) },
  });
  const answer = await desk.run('status.readiness', {}, { id: 'owner' });
  assert.equal(answer.status, 'ok', answer.text);
  const read = JSON.parse(answer.text) as Pick<ReadinessHealth, 'model' | 'memory'>;
  assert.equal(read.model.selection, 'openrouter:vendor/core-1');
  assert.equal(read.model.check?.ok, true);
  assert.equal(read.memory.service, 'down');
  assert.deepEqual(calls, []);
});

// The launch

const notReady = evaluateReadiness({ ...HEALTHY, core: 'down', link: 'untested' });
const ready = evaluateReadiness(HEALTHY);

test('a terminal launch that is ready opens the chat, and one that is not enters setup at the gap', () => {
  // Catches: a completed-once flag, which opens a chat over a core that has since gone.
  assert.deepEqual(decideLaunch({ terminal: true, readiness: ready }), { kind: 'chat' });
  assert.deepEqual(decideLaunch({ terminal: true, readiness: notReady }), { kind: 'setup', at: 'core-running' });
});

test('with no terminal a launch that is not ready is setup-required and names the repair', () => {
  // Catches: a script waits on Ink or on a question, instead of getting something it can act on.
  const decision = decideLaunch({ terminal: false, readiness: notReady });
  assert.equal(decision.kind, 'setup-required');
  assert.ok(decision.kind === 'setup-required' && decision.text.includes('neptunia services start'));
});
