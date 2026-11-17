// What the chooser and the setter take as each backend's effort levels: the survey in src/subharness/models.ts reaches
// the chooser (src/subharness/model-capabilities.ts) and the setter takes exactly those (src/subharness/control.ts), and
// an opencode row saves under opencode's own model name. The vendor is a fake.
// Changed: the agent `dev` is gone with the development agents (maintainer, 2026-11-16),
// so the agent checks use `server`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setAgentModel } from '../src/subharness/control.ts';
import type { EnableDeps } from '../src/subharness/control.ts';
import { modelRoleRegistry, roleSources } from '../src/subharness/model-capabilities.ts';
import { openPicker, pickerReduce } from '../interfaces/cli/model-picker.ts';
import type { PickerEvent, PickerState } from '../interfaces/cli/model-picker.ts';
import { fakeVendor } from './fixtures/fake-vendor.ts';
import { readKeysFile, writeKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';

function rig() {
  const privateDir = tempDir('nep-effort-facts-');
  writeKeysFile(privateDir, { subharness: { key: null, modes: {}, uses: {} } });
  fakeVendor(privateDir, 'claude', { loggedIn: true });
  const runs: Array<unknown> = [];
  const deps: EnableDeps = {
    privateDir,
    runBackend: (_name, _brief, _model, effort) => {
      runs.push(effort);
      return Promise.resolve({ ok: true, text: 'ok', exitCode: 0 });
    },
    fetch: () => Promise.resolve(new Response('{}', { status: 200 })),
  };
  return { deps, privateDir, runs };
}

test('a logged-in claude offers every level of the survey', async () => {
  // Catches: xhigh and max unreachable from the chooser, or the global three offered in place of what claude takes.
  const { deps } = rig();
  const read = await roleSources({ ...deps, baseUrl: 'https://openrouter.test', openRouterKey: null }, 'server');
  const claude = read.sources.find((one) => one.via === 'claude');
  assert.deepEqual(claude?.effort, ['low', 'medium', 'high', 'xhigh', 'max']);
});

test('the setter stores a level claude takes for an agent', async () => {
  // Catches: the chooser offering max and the setter refusing it after the confirmation.
  // Changed: the memory writer's effort is on the route scale of its chain (slice 4), so its half is deleted.
  const { deps, privateDir, runs } = rig();
  const agent = await setAgentModel(deps, 'server', 'opus', 'max', 'claude');
  assert.equal(agent.ok, true, agent.message);
  assert.deepEqual(runs, ['max']);
  assert.equal(readKeysFile(privateDir).subharness.efforts?.server, 'max');
});

test('the setter refuses xhigh on opencode and runs nothing', async () => {
  // Catches: a level no opencode model was surveyed for saved, so the agent's next real run fails on its variant.
  const { deps, privateDir, runs } = rig();
  const answer = await setAgentModel(deps, 'server', 'openrouter/vendor/text-1', 'xhigh', 'opencode');
  assert.equal(answer.code, 'unknown-effort');
  assert.deepEqual(runs, []);
  assert.equal(readKeysFile(privateDir).subharness.efforts?.server, undefined);
});

test('the word default clears an agent effort after its reply check', async () => {
  // Catches: the chooser's "model default" leaving the old level in force, because omission keeps it.
  const { deps, privateDir } = rig();
  await setAgentModel(deps, 'server', 'opus', 'high', 'claude');
  const answer = await setAgentModel(deps, 'server', 'opus', 'default');
  assert.equal(answer.ok, true, answer.message);
  assert.equal(readKeysFile(privateDir).subharness.efforts?.server, undefined);
});

test('an opencode model from the listing is committed under the name opencode runs', () => {
  // Catches: a bare OpenRouter id saved, which passes the reply check and fails `opencode run -m` at the next real run.
  const source = {
    id: 'backend:opencode',
    providerType: 'subharness',
    via: 'opencode',
    label: 'OpenCode',
    account: 'oc',
    code: 'ok',
    setup: [],
    listing: 'observed',
    models: [{ id: 'vendor/text-1', evidence: 'observed', saveAs: 'openrouter/vendor/text-1' }],
    effort: ['low', 'medium', 'high'],
    manualModel: true,
  } as const;
  const steps: ReadonlyArray<(state: PickerState) => PickerEvent> = [
    // Changed: the server sits under Errand, the Development group being gone (maintainer, 2026-11-16).
    () => ({ kind: 'choose', id: 'errand' }),
    () => ({ kind: 'choose', id: 'server' }),
    (state) => ({
      kind: 'sources',
      revision: state.revision,
      read: { role: 'server', current: null, sources: [source] },
    }),
    () => ({ kind: 'choose', id: 'subharness' }),
    () => ({ kind: 'choose', id: source.id }),
    () => ({ kind: 'choose', id: 'vendor/text-1' }),
    () => ({ kind: 'choose', id: 'keep' }),
  ];
  let state = openPicker(modelRoleRegistry());
  for (const next of steps) state = pickerReduce(state, next(state)).state;
  const saved = pickerReduce(state, { kind: 'confirm' }).effects[0];
  assert.deepEqual(saved?.kind === 'commit' ? saved.command.args : null, {
    role: 'server',
    model: 'openrouter/vendor/text-1',
    // The lead: routes are named direct-api, claude-harness, codex-harness and opencode-harness (owner, 2026-11-06).
    via: 'opencode-harness',
  });
});
