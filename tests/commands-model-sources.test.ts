// PR 1, sources without an enable step: the command surface over the real console and table. `/subharness` keeps the
// plain status and the account commands of each backend; `use`, `model`, `mode`, `enable` and `disable` leave the family,
// refused with their replacement. Model selection is `/model set <role> <model> --via <backend> [--effort <e>]` for every
// agent role and memory, verified before it is saved and committed only if nothing moved while the check ran. Execution
// settings are `/agent mode <agent> [<mode>]`, the same writes and the same unit re-render as the old `mode`. The backend
// checks are injected, the vendor CLIs disposable fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { BackendResult } from '../src/agent-runner/backend.ts';
import { createConsole } from '../src/interface/commands/console.ts';
import type { ConsoleDeps } from '../src/interface/commands/console.ts';
import { parseCommandLine, parseCommandWords } from '../src/interface/commands/table.ts';
import { subharnessCommand } from '../src/interface/commands/subharness.ts';
import { fakeVendor } from './fixtures/fake-vendor.ts';
import { readKeysFile, writeKeysFile } from './fixtures/keys-file.ts';
import type { KeysFile } from './fixtures/keys-file.ts';
import { fakeFetch } from './fixtures/keys-rig.ts';
import { tempDir } from './fixtures/tmp.ts';

const OWNER = { id: 'owner' };

type Checked = { name: string; model: string | undefined; effort: string | undefined };

function rig(
  subharness: Partial<KeysFile['subharness']> = {},
  check: (one: Checked) => BackendResult | Promise<BackendResult> = () => ({ ok: true, text: 'ok', exitCode: 0 })
) {
  const privateDir = tempDir('nep-model-commands-');
  writeKeysFile(privateDir, { subharness: { key: null, modes: {}, ...subharness } });
  const checks: Array<Checked> = [];
  const applied: Array<[string, string]> = [];
  const given: ConsoleDeps['subharness'] = {
    runBackend: (name, _brief, model, effort) => {
      const one = { name, model, effort };
      checks.push(one);
      return Promise.resolve(check(one));
    },
    fetch: fakeFetch().fetch,
    helpOf: () => Promise.resolve('Options:\n  --effort <level>\n'),
    applyMode: (agent, mode) => {
      applied.push([agent, mode]);
      return Promise.resolve('the unit took it');
    },
  };
  const desk = createConsole({
    runOp: () => Promise.resolve({ status: 'ok', code: '', summary: '', data: null }),
    ownerReads: { lessons: () => '' },
    places: () => ['g1'],
    selfId: () => 'self-1',
    hot: { config: { bot: { owners: [] } } },
    privateDir,
    dataDir: privateDir,
    memoryDb: null,
    usage: null,
    metrics: null,
    chatLines: () => [],
    now: () => 0,
    subharness: given,
  });
  return { privateDir, desk, checks, applied, deps: { ...given, privateDir } };
}

// The family

for (const backend of ['codex', 'claude', 'opencode']) {
  for (const action of ['login', 'status', 'logout']) {
    test(`/subharness ${backend} ${action} parses as its own leaf, in the chat and on argv`, () => {
      // Catches: the backend word falling through to a usage error, or the two spellings differing.
      const expected = { ok: true, name: `subharness.${backend}.${action}`, args: {} };
      assert.deepEqual(parseCommandLine(`/subharness ${backend} ${action}`), expected);
      assert.deepEqual(parseCommandWords(['subharness', backend, action]), expected);
    });
  }
}

test('opencode login takes the extra key by name', () => {
  // Catches: opencode with no way to say which key it runs on, since it has no vendor login of its own here.
  assert.deepEqual(parseCommandLine('/subharness opencode login --key oc-1'), {
    ok: true,
    name: 'subharness.opencode.login',
    args: { key: 'oc-1' },
  });
});

// The handler of the account commands in the core

test('the core answers a status of one backend, and tells a login to go to a terminal', async () => {
  // Catches: the core process starting an interactive vendor login with nobody attached.
  const { deps } = rig();
  const vendor = fakeVendor(deps.privateDir, 'claude', { loggedIn: true });
  assert.equal((await subharnessCommand(deps, 'subharness.claude.status', {})).status, 'ok');
  const login = await subharnessCommand(deps, 'subharness.claude.login', {});
  assert.equal(login.status, 'failed');
  assert.ok(login.text.includes('neptunia subharness claude login'), login.text);
  assert.deepEqual(vendor.calls(), ['auth status']);
});

// /model set

for (const role of ['scout', 'server', 'dev', 'watcher', 'thinker']) {
  test(`/model set ${role} --via stores the source, the model and the effort after one reply`, async () => {
    // The lead: routes are named direct-api, claude-harness, codex-harness and opencode-harness (owner, 2026-11-06).
    // Catches: --via open to memory alone, or an agent's source and model written in two steps that can part.
    const { desk, privateDir, checks } = rig({ backends: ['codex'] });
    fakeVendor(privateDir, 'claude', { loggedIn: true });
    const answer = await desk.run('model.set', { role, model: 'sonnet', via: 'claude-harness', effort: 'high' }, OWNER);
    assert.equal(answer.status, 'ok', answer.text);
    assert.deepEqual(checks, [{ name: 'claude', model: 'sonnet', effort: 'high' }]);
    const stored = readKeysFile(privateDir).subharness;
    assert.equal(stored.uses?.[role], 'claude');
    assert.equal(stored.models?.[role], 'sonnet');
    assert.equal(stored.efforts?.[role], 'high');
  });
}

test('a missing install, a missing login and a provider rejection are three answers, and none saves', async () => {
  // The lead: routes are named direct-api, claude-harness, codex-harness and opencode-harness (owner, 2026-11-06).
  // Catches: "gave no reply" for all three, or a model request spent on a backend that cannot answer.
  const absent = rig();
  const noInstall = await absent.desk.run('model.set', { role: 'dev', model: 'sonnet', via: 'claude-harness' }, OWNER);
  assert.equal(noInstall.code, 'not-installed');
  assert.deepEqual(absent.checks, []);

  const out = rig();
  fakeVendor(out.privateDir, 'claude');
  const noLogin = await out.desk.run('model.set', { role: 'dev', model: 'sonnet', via: 'claude-harness' }, OWNER);
  assert.equal(noLogin.code, 'not-logged-in');
  assert.deepEqual(out.checks, []);

  const rejecting = rig({}, () => ({ ok: false, text: '', exitCode: 1, detail: 'that model is not on this plan' }));
  fakeVendor(rejecting.privateDir, 'claude', { loggedIn: true });
  const rejected = await rejecting.desk.run(
    'model.set',
    { role: 'dev', model: 'sonnet', via: 'claude-harness' },
    OWNER
  );
  assert.equal(rejected.code, 'model-rejected');
  assert.ok(rejected.text.includes('that model is not on this plan'), rejected.text);

  for (const one of [absent, out, rejecting]) {
    const stored = readKeysFile(one.privateDir).subharness;
    assert.equal(stored.uses?.dev, undefined);
    assert.equal(stored.models?.dev, undefined);
  }
});

test('a stale check of an agent never overwrites the choice made while it ran', async () => {
  // The lead: routes are named direct-api, claude-harness, codex-harness and opencode-harness (owner, 2026-11-06).
  // Catches: the slow probe's success written last, so the owner's newer choice silently disappears.
  let releaseFirst: (value: BackendResult) => void = () => {};
  const first = new Promise<BackendResult>((resolve) => (releaseFirst = resolve));
  const { desk, privateDir } = rig({ backends: ['claude', 'codex'] }, (one) =>
    one.model === 'slow' ? first : { ok: true, text: 'ok', exitCode: 0 }
  );
  fakeVendor(privateDir, 'claude', { loggedIn: true });
  fakeVendor(privateDir, 'codex', { loggedIn: true });
  const slow = desk.run('model.set', { role: 'dev', model: 'slow', via: 'claude-harness' }, OWNER);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const quick = await desk.run('model.set', { role: 'dev', model: 'quick', via: 'codex-harness' }, OWNER);
  assert.equal(quick.status, 'ok', quick.text);
  releaseFirst({ ok: true, text: 'ok', exitCode: 0 });
  const answer = await slow;
  assert.equal(answer.code, 'selection-changed');
  const stored = readKeysFile(privateDir).subharness;
  assert.equal(stored.uses?.dev, 'codex');
  assert.equal(stored.models?.dev, 'quick');
});

test('a logout while the check runs keeps the selection from being saved', async () => {
  // The lead: routes are named direct-api, claude-harness, codex-harness and opencode-harness (owner, 2026-11-06).
  // Catches: a role saved on an account that is gone by the time the reply arrives.
  let release: (value: BackendResult) => void = () => {};
  const held = new Promise<BackendResult>((resolve) => (release = resolve));
  const { desk, privateDir } = rig({}, () => held);
  const vendor = fakeVendor(privateDir, 'claude', { loggedIn: true });
  const slow = desk.run('model.set', { role: 'dev', model: 'sonnet', via: 'claude-harness' }, OWNER);
  await new Promise((resolve) => setTimeout(resolve, 20));
  fs.rmSync(path.join(vendor.home, 'credentials'));
  release({ ok: true, text: 'ok', exitCode: 0 });
  assert.equal((await slow).code, 'source-changed');
  assert.equal(readKeysFile(privateDir).subharness.uses?.dev, undefined);
});

test('/agent mode stores the mode and re-renders the unit, as subharness mode did', async () => {
  // Catches: the move dropping the unit hook, so a mode only reaches keys.json and the sandbox stays as it was.
  const { desk, privateDir, applied } = rig();
  const answer = await desk.run('agent.mode', { agent: 'scout', mode: 'read' }, OWNER);
  assert.equal(answer.status, 'ok', answer.text);
  assert.ok(answer.text.includes('the unit took it'), answer.text);
  assert.equal(readKeysFile(privateDir).subharness.modes.scout, 'read');
  assert.deepEqual(applied, [['scout', 'read']]);
});

test('/agent mode with no mode reports it, writes nothing and touches no unit', async () => {
  // Catches: a read that re-renders and restarts a running agent.
  const { desk, privateDir, applied } = rig({ modes: { dev: 'full' } });
  const answer = await desk.run('agent.mode', { agent: 'dev' }, OWNER);
  assert.equal(answer.status, 'ok');
  assert.ok(answer.text.includes('full'), answer.text);
  assert.deepEqual(applied, []);
  assert.equal(readKeysFile(privateDir).subharness.modes.dev, 'full');
});
