// The source step of the model selector (cli/model-picker.ts) offers the four route names, `direct-api`,
// `claude-harness`, `codex-harness` and `opencode-harness`, and commits the name it showed as `--via`, because the
// command takes only those. The sources are fixed descriptors; the stored backend word stays the key of a descriptor
// (`via: 'codex'`) and of the role's current record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelRoleRegistry } from '../src/subharness/model-capabilities.ts';
import type { RoleSources, SourceDescriptor } from '../src/subharness/model-capabilities.ts';
import { openPicker, pickerReduce, pickerRows } from '../cli/model-picker.ts';
import type { PickerEffect, PickerEvent, PickerState } from '../cli/model-picker.ts';

const API: SourceDescriptor = {
  id: 'api:openrouter',
  providerType: 'api',
  via: null,
  label: 'OpenRouter',
  account: null,
  code: 'ok',
  setup: [],
  listing: 'observed',
  models: [{ id: 'vendor/invented-1', evidence: 'observed' }],
  effort: { evidence: 'unsupported', levels: [] },
  manualModel: true,
};
const CODEX: SourceDescriptor = {
  ...API,
  id: 'backend:codex',
  providerType: 'subharness',
  via: 'codex',
  label: 'Codex',
  listing: 'suggestion',
  models: [{ id: 'suggested-1', evidence: 'suggestion' }],
  effort: { evidence: 'unknown', levels: [] },
};
const CLAUDE: SourceDescriptor = { ...CODEX, id: 'backend:claude', via: 'claude', label: 'Claude' };
const OPENCODE: SourceDescriptor = { ...CODEX, id: 'backend:opencode', via: 'opencode', label: 'OpenCode' };

function play(from: PickerState, events: ReadonlyArray<PickerEvent>) {
  let state = from;
  const effects: Array<PickerEffect> = [];
  for (const event of events) {
    const step = pickerReduce(state, event);
    state = step.state;
    effects.push(...step.effects);
  }
  return { state, effects };
}

const choose = (...ids: ReadonlyArray<string>): Array<PickerEvent> => ids.map((id) => ({ kind: 'choose', id }));

/** The picker at `role` of `group` with the sources answered. */
function atRole(
  group: string,
  role: string,
  sources: ReadonlyArray<SourceDescriptor>,
  current: RoleSources['current']
) {
  const { state } = play(openPicker(modelRoleRegistry()), choose(group, role));
  const read: RoleSources = { role, current, sources };
  return play(state, [{ kind: 'sources', revision: state.revision, read }]).state;
}

const labelOf = (state: PickerState, id: string): string => pickerRows(state).find((row) => row.id === id)?.label ?? '';

test('the source step of a harness role offers claude-harness, codex-harness and opencode-harness', () => {
  // Catches: the owner choosing a row called Claude, then reading `via claude-harness` in the status and not matching them.
  const at = atRole('errand', 'scout', [CLAUDE, CODEX, OPENCODE], null);
  const step = play(at, choose('subharness')).state;
  // The lead: the state is named `picked` beside its `step` field, for the chain rule.
  const picked = step;
  assert.equal(picked.step, 'source');
  assert.ok(labelOf(step, 'backend:claude').includes('claude-harness'), labelOf(step, 'backend:claude'));
  assert.ok(labelOf(step, 'backend:codex').includes('codex-harness'), labelOf(step, 'backend:codex'));
  assert.ok(labelOf(step, 'backend:opencode').includes('opencode-harness'), labelOf(step, 'backend:opencode'));
});

test('the source step of an API role offers direct-api', () => {
  // Catches: the API route left as OpenRouter while the status prints direct-api for the same route.
  const at = atRole('main', 'speech', [API], null);
  const step = play(at, choose('api')).state;
  const picked = step;
  assert.equal(picked.step, 'source');
  assert.ok(labelOf(step, 'api:openrouter').includes('direct-api'), labelOf(step, 'api:openrouter'));
});

test('a harness chosen in the selector commits its route name as --via', () => {
  // Catches: the stored word committed, which the command now refuses as an unknown backend.
  const at = atRole('errand', 'scout', [CODEX], null);
  const steps = play(at, choose('subharness', 'backend:codex', 'suggested-1', 'keep'));
  const saved = play(steps.state, [{ kind: 'confirm' }]);
  const commits = saved.effects.flatMap((one) => (one.kind === 'commit' ? [one.command] : []));
  assert.deepEqual(commits, [
    { name: 'model.set', args: { role: 'scout', model: 'suggested-1', via: 'codex-harness' } },
  ]);
});

test('the harness a role is stored on is still marked in force', () => {
  // Catches: the stored word compared with the route name, so the row of the source in force loses its mark.
  const current = { via: 'codex', model: 'old', effort: null };
  const step = play(atRole('errand', 'scout', [CLAUDE, CODEX], current), choose('subharness')).state;
  const rows = pickerRows(step);
  assert.equal(rows.find((row) => row.id === 'backend:codex')?.current, 'in force');
  assert.equal(rows.find((row) => row.id === 'backend:claude')?.current, undefined);
});
