// What the chooser learns from an installed backend. Effort levels read from its help
// (src/subharness/place.ts#effortLevelsOfHelp) reach the chooser as observed (src/subharness/model-capabilities.ts) and the
// setter takes exactly those (src/subharness/control.ts), and an opencode row saves under opencode's own model name. The
// help text copies the installed Claude's wrapping; the vendor is a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setAgentModel } from '../src/subharness/control.ts';
import type { EnableDeps } from '../src/subharness/control.ts';
import { setMemoryPath } from '../src/subharness/memory-path.ts';
import { modelRoleRegistry, roleSources } from '../src/subharness/model-capabilities.ts';
import { openPicker, pickerReduce } from '../cli/model-picker.ts';
import type { PickerEvent, PickerState } from '../cli/model-picker.ts';
import { effortLevelsOfHelp } from '../src/subharness/place.ts';
import { fakeVendor } from './fixtures/fake-vendor.ts';
import { readKeysFile, writeKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';

const LISTED = `Options:
  --debug-file <path>       Write debug logs
  --effort <level>          Effort level for the current session
                            (low, medium, high, xhigh, max)
  --environment <id>        Create a new cloud session (one, two)
`;
const FLAG_ONLY = 'Options:\n  --effort <level>  reasoning effort\n  --model <model>  (one, two)\n';

function rig(help: string) {
  const privateDir = tempDir('nep-effort-help-');
  writeKeysFile(privateDir, { subharness: { key: null, modes: {}, uses: {} } });
  fakeVendor(privateDir, 'claude', { loggedIn: true });
  const deps: EnableDeps = {
    privateDir,
    runBackend: () => Promise.resolve({ ok: true, text: 'ok', exitCode: 0 }),
    fetch: () => Promise.resolve(new Response('{}', { status: 200 })),
    helpOf: () => Promise.resolve(help),
  };
  return { deps, privateDir };
}

const claudeOf = async (help: string) => {
  const { deps } = rig(help);
  const read = await roleSources({ ...deps, baseUrl: 'https://openrouter.test', openRouterKey: null }, 'dev');
  return read.sources.find((one) => one.via === 'claude');
};

test('the levels a wrapped help lists under --effort are read, and a neighbouring list is not', () => {
  // Catches: a parser that stops at the line break, or that takes another flag's parenthesis for the levels.
  assert.deepEqual(effortLevelsOfHelp(LISTED), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(effortLevelsOfHelp(FLAG_ONLY), []);
  assert.deepEqual(effortLevelsOfHelp(''), []);
});

test('a level no setter could store is left out of what is read', () => {
  // Catches: a new word in a later release offered and then refused after the owner confirmed it.
  const help = '  --effort <level>  Effort (low, turbo)\n';
  assert.deepEqual(effortLevelsOfHelp(help), ['low']);
});

test('levels listed in help are observed evidence for the source', async () => {
  // Catches: the installed binary's list discarded, so xhigh and max stay unreachable from the chooser.
  assert.deepEqual((await claudeOf(LISTED))?.effort, {
    evidence: 'observed',
    levels: ['low', 'medium', 'high', 'xhigh', 'max'],
  });
});

test('a flag with no list stays unknown', async () => {
  // Catches: the global low, medium and high offered because the flag exists.
  assert.deepEqual((await claudeOf(FLAG_ONLY))?.effort, { evidence: 'unknown', levels: [] });
});

test('a help that cannot run stays unknown and leaves the source usable', async () => {
  // Catches: a broken help turning a logged-in backend into an error.
  const { deps } = rig('');
  const read = await roleSources(
    {
      ...deps,
      baseUrl: 'https://openrouter.test',
      openRouterKey: null,
      helpOf: () => Promise.reject(new Error('no help')),
    },
    'dev'
  );
  const claude = read.sources.find((one) => one.via === 'claude');
  assert.equal(claude?.code, 'ok');
  assert.deepEqual(claude?.effort, { evidence: 'unknown', levels: [] });
});

test('the setter stores a level the binary lists, for an agent and for the writer', async () => {
  // Catches: the chooser offering max and the setter refusing it after the confirmation.
  const { deps, privateDir } = rig(LISTED);
  const agent = await setAgentModel(deps, 'dev', 'opus', 'max', 'claude');
  assert.equal(agent.ok, true, agent.message);
  assert.equal(readKeysFile(privateDir).subharness.efforts?.dev, 'max');
  const writer = await setMemoryPath(deps, 'claude', 'opus', 'xhigh');
  assert.equal(writer.ok, true, writer.message);
  assert.equal(readKeysFile(privateDir).subharness.memory?.effort, 'xhigh');
});

test('the setter refuses a level this binary does not list', async () => {
  // Catches: xhigh saved for a CLI that fails on it at the next real run.
  const { deps, privateDir } = rig(FLAG_ONLY);
  const answer = await setAgentModel(deps, 'dev', 'opus', 'xhigh', 'claude');
  assert.equal(answer.code, 'unknown-effort');
  assert.equal(readKeysFile(privateDir).subharness.efforts?.dev, undefined);
});

test('the word default clears an agent effort after its reply check', async () => {
  // Catches: the chooser's "model default" leaving the old level in force, because omission keeps it.
  const { deps, privateDir } = rig(LISTED);
  await setAgentModel(deps, 'dev', 'opus', 'high', 'claude');
  const answer = await setAgentModel(deps, 'dev', 'opus', 'default');
  assert.equal(answer.ok, true, answer.message);
  assert.equal(readKeysFile(privateDir).subharness.efforts?.dev, undefined);
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
    effort: { evidence: 'unknown', levels: [] },
    manualModel: true,
  } as const;
  const steps: ReadonlyArray<(state: PickerState) => PickerEvent> = [
    () => ({ kind: 'choose', id: 'development' }),
    () => ({ kind: 'choose', id: 'dev' }),
    (state) => ({ kind: 'sources', revision: state.revision, read: { role: 'dev', current: null, sources: [source] } }),
    () => ({ kind: 'choose', id: 'subharness' }),
    () => ({ kind: 'choose', id: source.id }),
    () => ({ kind: 'choose', id: 'vendor/text-1' }),
    () => ({ kind: 'choose', id: 'keep' }),
  ];
  let state = openPicker(modelRoleRegistry());
  for (const next of steps) state = pickerReduce(state, next(state)).state;
  const saved = pickerReduce(state, { kind: 'confirm' }).effects[0];
  assert.deepEqual(saved?.kind === 'commit' ? saved.command.args : null, {
    role: 'dev',
    model: 'openrouter/vendor/text-1',
    // The lead: routes are named direct-api, claude-harness, codex-harness and opencode-harness (owner, 2026-11-06).
    via: 'opencode-harness',
  });
});
