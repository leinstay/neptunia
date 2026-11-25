// Tests for src/setup/readiness.ts: `evaluateReadiness` (src/setup/readiness.ts) turns the public health results into
// the first incomplete requirement of a chat launch, `gatherHealth` reads them with no provider in reach, the recorded
// check of the core model (src/setup/model-check.ts) ties a check to its selection, and `decideLaunch` says what a launch
// does. Pure over injected results; only the files of a temp data folder are real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { decideLaunch, evaluateReadiness, gatherHealth } from '../../../src/setup/readiness.ts';
import type { ReadinessHealth, Requirement } from '../../../src/setup/readiness.ts';

import { tempDir } from '../../fixtures/tmp.ts';

import { writeKeysFile } from '../../fixtures/keys-file.ts';
import { fakeVendor } from '../../fixtures/fake-vendor.ts';

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
  // Catches: a stopped core sends the owner through a setup that erases the settings.
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

// A launch asks nothing of a harness that carries the core (docs/setup.md, chat readiness): a harness is checked when it
// is installed or logged in and when a model is chosen on it, never when a chat opens. The private folder is a temp dir
// and the vendor CLI a fake that records each call, so no process of a real vendor starts.

const CORE = { backend: 'claude', model: 'claude-opus-4-6', effort: null };

test('a launch reads a harness core as served and starts none of its CLI, logged out as it is', async () => {
  // Catches: every chat launch running the vendor's status command, a check at use the owner ruled out.
  const dir = tempDir('nep-readiness-harness-');
  writeKeysFile(dir, { subharness: { key: null, modes: {}, core: CORE } });
  const vendor = fakeVendor(dir, 'claude', { loggedIn: false });
  const health = await gatherHealth({
    privateDir: dir,
    dataDir: dir,
    unitDir: dir,
    link: () => Promise.resolve({ kind: 'down' }),
  });
  assert.deepEqual(vendor.calls(), []);
  assert.equal(health.model.harness, true);
  assert.equal(
    evaluateReadiness(health).failed.some((one) => one.requirement === 'core-model'),
    false
  );
});

test('a launch with the core on the API and no check recorded still names the missing check', async () => {
  // Catches: the harness rule read for every core, so a direct core with no checked model opens a chat that cannot answer.
  const dir = tempDir('nep-readiness-direct-');
  writeKeysFile(dir);
  const health = await gatherHealth({
    privateDir: dir,
    dataDir: dir,
    unitDir: dir,
    link: () => Promise.resolve({ kind: 'down' }),
  });
  const failure = evaluateReadiness(health).failed.find((one) => one.requirement === 'core-model');
  assert.equal(failure?.code, 'check-missing');
});
