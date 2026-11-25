// The checked commit of a role's selection (src/subharness/selection.ts), the part the command tests do not reach: a
// failed check that must leave the role free for the next choice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkedSelection } from '../../../src/subharness/selection.ts';
import type { EnableDeps, SubharnessResult } from '../../../src/subharness/control.ts';
import { fakeVendor } from '../../fixtures/fake-vendor.ts';
import { fakeFetch } from '../../fixtures/keys-rig.ts';
import { tempDir } from '../../fixtures/tmp.ts';
import fs from 'node:fs';
import path from 'node:path';
import type { BackendResult } from '../../../src/agent-runner/backend.ts';
import { createConsole } from '../../../src/interface/commands/console.ts';
import type { ConsoleDeps } from '../../../src/interface/commands/console.ts';
import { readKeysFile, writeKeysFile } from '../../fixtures/keys-file.ts';
import type { KeysFile } from '../../fixtures/keys-file.ts';

const SAVED: SubharnessResult = { ok: true, code: 'ok', changed: true, message: 'saved' };

function rig(reply: () => boolean) {
  const privateDir = tempDir('nep-selection-');
  fakeVendor(privateDir, 'claude', { loggedIn: true });
  const ran: Array<string | undefined> = [];
  const deps: EnableDeps = {
    privateDir,
    fetch: fakeFetch().fetch,
    runBackend: (_name, _brief, model) => {
      ran.push(model);
      const ok = reply();
      return Promise.resolve({ ok, text: ok ? 'ok' : '', exitCode: ok ? 0 : 1 });
    },
  };
  return { deps, ran };
}

const select = (deps: EnableDeps, effort?: string): Promise<SubharnessResult> =>
  checkedSelection(
    deps,
    { claim: 'dev', backend: 'claude', keyValue: '', model: 'sonnet', ...(effort === undefined ? {} : { effort }) },
    () => 'the same',
    () => SAVED
  );

test('a selection after a refused one is saved, because the refused one holds the role no longer', async () => {
  // Catches: the failed check keeps its claim, so every later choice of that role answers selection-changed.
  let answers = false;
  const { deps } = rig(() => answers);
  assert.equal((await select(deps)).code, 'model-rejected');
  answers = true;
  assert.equal((await select(deps)).code, 'ok');
});

// PR 1, sources without an enable step: the command surface over the real console and table. `/subharness` keeps the
// plain status and the account commands of each backend; `use`, `model`, `mode`, `enable` and `disable` leave the family,
// refused with their replacement. Model selection is `/model set <role> <model> --via <backend> [--effort <e>]` for every
// agent role and memory, verified before it is saved and committed only if nothing moved while the check ran. Execution
// settings are `/agent mode <agent> [<mode>]`, the same writes and the same unit re-render as the old `mode`. The backend
// checks are injected, the vendor CLIs disposable fakes.
// Changed: the agent `dev` is gone with the development agents (maintainer, 2026-11-16),
// so the agent checks use `server`.

const OWNER = { id: 'owner' };

type Checked = { name: string; model: string | undefined; effort: string | undefined };

function commandsModelSourcesRig(
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

// /model set

// Changed: the agents `dev` and `thinker` are gone with the development agents, and `watcher` with the watcher
// (maintainer, 2026-11-16).
for (const role of ['scout', 'server']) {
  test(`/model set ${role} --via stores the source, the model and the effort after one reply`, async () => {
    // The lead: routes are named direct-api, claude-harness, codex-harness and opencode-harness.
    // Catches: --via open to memory alone, or an agent's source and model written in two steps that can part.
    const { desk, privateDir, checks } = commandsModelSourcesRig({ backends: ['codex'] });
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
  // The lead: routes are named direct-api, claude-harness, codex-harness and opencode-harness.
  // Catches: "gave no reply" for all three, or a model request spent on a backend that cannot answer.
  const absent = commandsModelSourcesRig();
  const noInstall = await absent.desk.run(
    'model.set',
    { role: 'server', model: 'sonnet', via: 'claude-harness' },
    OWNER
  );
  assert.equal(noInstall.code, 'not-installed');
  assert.deepEqual(absent.checks, []);

  const out = commandsModelSourcesRig();
  fakeVendor(out.privateDir, 'claude');
  const noLogin = await out.desk.run('model.set', { role: 'server', model: 'sonnet', via: 'claude-harness' }, OWNER);
  assert.equal(noLogin.code, 'not-logged-in');
  assert.deepEqual(out.checks, []);

  const rejecting = commandsModelSourcesRig({}, () => ({
    ok: false,
    text: '',
    exitCode: 1,
    detail: 'that model is not on this plan',
  }));
  fakeVendor(rejecting.privateDir, 'claude', { loggedIn: true });
  const rejected = await rejecting.desk.run(
    'model.set',
    { role: 'server', model: 'sonnet', via: 'claude-harness' },
    OWNER
  );
  assert.equal(rejected.code, 'model-rejected');
  assert.ok(rejected.text.includes('that model is not on this plan'), rejected.text);

  for (const one of [absent, out, rejecting]) {
    const stored = readKeysFile(one.privateDir).subharness;
    assert.equal(stored.uses?.server, undefined);
    assert.equal(stored.models?.server, undefined);
  }
});

test('a stale check of an agent never overwrites the choice made while it ran', async () => {
  // The lead: routes are named direct-api, claude-harness, codex-harness and opencode-harness.
  // Catches: the slow probe's success written last, so the owner's newer choice silently disappears.
  let releaseFirst: (value: BackendResult) => void = () => {};
  const first = new Promise<BackendResult>((resolve) => (releaseFirst = resolve));
  const { desk, privateDir } = commandsModelSourcesRig({ backends: ['claude', 'codex'] }, (one) =>
    one.model === 'slow' ? first : { ok: true, text: 'ok', exitCode: 0 }
  );
  fakeVendor(privateDir, 'claude', { loggedIn: true });
  fakeVendor(privateDir, 'codex', { loggedIn: true });
  const slow = desk.run('model.set', { role: 'server', model: 'slow', via: 'claude-harness' }, OWNER);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const quick = await desk.run('model.set', { role: 'server', model: 'quick', via: 'codex-harness' }, OWNER);
  assert.equal(quick.status, 'ok', quick.text);
  releaseFirst({ ok: true, text: 'ok', exitCode: 0 });
  const answer = await slow;
  assert.equal(answer.code, 'selection-changed');
  const stored = readKeysFile(privateDir).subharness;
  assert.equal(stored.uses?.server, 'codex');
  assert.equal(stored.models?.server, 'quick');
});

test('a logout while the check runs keeps the selection from being saved', async () => {
  // The lead: routes are named direct-api, claude-harness, codex-harness and opencode-harness.
  // Catches: a role saved on an account that is gone by the time the reply arrives.
  let release: (value: BackendResult) => void = () => {};
  const held = new Promise<BackendResult>((resolve) => (release = resolve));
  const { desk, privateDir } = commandsModelSourcesRig({}, () => held);
  const vendor = fakeVendor(privateDir, 'claude', { loggedIn: true });
  const slow = desk.run('model.set', { role: 'server', model: 'sonnet', via: 'claude-harness' }, OWNER);
  await new Promise((resolve) => setTimeout(resolve, 20));
  fs.rmSync(path.join(vendor.home, 'credentials'));
  release({ ok: true, text: 'ok', exitCode: 0 });
  assert.equal((await slow).code, 'source-changed');
  assert.equal(readKeysFile(privateDir).subharness.uses?.server, undefined);
});
