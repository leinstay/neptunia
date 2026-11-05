// The nested model selector (cli/model-picker.ts): its pure reducer over fixed source descriptors, then the same flow
// through Ink. The order is category, role, provider type, source, model, effort, review. Nothing leaves before the
// confirmation, a commit carries one revision and an answer of an older revision moves nothing, and a setup detour comes
// back to the same selector. The role registry is the real one; no core and no provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { createElement } from 'react';
import { render } from 'ink';
import { roleConfigKeys } from '../src/llm/roles.ts';
import { modelRoleRegistry } from '../src/subharness/model-capabilities.ts';
import type { RoleSources, SourceDescriptor } from '../src/subharness/model-capabilities.ts';
import { ModelPicker, openPicker, pickerReduce, pickerReview, pickerRows } from '../cli/model-picker.ts';
import type { PickerEffect, PickerEvent, PickerState, PickerCommand } from '../cli/model-picker.ts';

const API: SourceDescriptor = {
  id: 'api:openrouter',
  providerType: 'api',
  via: null,
  label: 'OpenRouter',
  account: 'core key one',
  code: 'ok',
  setup: [],
  listing: 'observed',
  models: [{ id: 'vendor/voice-1', evidence: 'observed' }],
  effort: { evidence: 'unsupported', levels: [] },
  manualModel: true,
};
const CODEX: SourceDescriptor = {
  id: 'backend:codex',
  providerType: 'subharness',
  via: 'codex',
  label: 'Codex',
  account: null,
  code: 'ok',
  setup: [],
  listing: 'suggestion',
  models: [{ id: 'suggested-1', evidence: 'suggestion' }],
  effort: { evidence: 'unknown', levels: [] },
  manualModel: true,
};
const CLAUDE_OUT: SourceDescriptor = {
  ...CODEX,
  id: 'backend:claude',
  via: 'claude',
  label: 'Claude',
  code: 'not-logged-in',
  listing: 'none',
  models: [],
  setup: [{ command: '/subharness claude login', masked: false }],
};
const OPENCODE_ABSENT: SourceDescriptor = {
  ...CODEX,
  id: 'backend:opencode',
  via: 'opencode',
  label: 'OpenCode',
  code: 'not-installed',
  listing: 'none',
  models: [],
  setup: [{ command: '/subharness opencode login --key ', masked: false }],
};

const read = (
  role: string,
  sources: ReadonlyArray<SourceDescriptor>,
  current: RoleSources['current'] = null
): RoleSources => ({
  role,
  current,
  sources,
});

function play(
  from: PickerState,
  events: ReadonlyArray<PickerEvent>
): { state: PickerState; effects: Array<PickerEffect> } {
  let state = from;
  const effects: Array<PickerEffect> = [];
  for (const event of events) {
    const step = pickerReduce(state, event);
    state = step.state;
    effects.push(...step.effects);
  }
  return { state, effects };
}

const opened = (): PickerState => openPicker(modelRoleRegistry());
const choose = (...ids: ReadonlyArray<string>): Array<PickerEvent> => ids.map((id) => ({ kind: 'choose', id }));

/** Category and role chosen, the role's sources answered. */
function atRole(
  group: string,
  role: string,
  sources: ReadonlyArray<SourceDescriptor>,
  current: RoleSources['current'] = null
): PickerState {
  const { state } = play(opened(), choose(group, role));
  return play(state, [{ kind: 'sources', revision: state.revision, read: read(role, sources, current) }]).state;
}

const committed = (effects: ReadonlyArray<PickerEffect>): Array<PickerCommand> =>
  effects.flatMap((one) => (one.kind === 'commit' ? [one.command] : []));
const rowIds = (state: PickerState): Array<string> => pickerRows(state).map((one) => one.id);

test('the steps run in the agreed order, and opening asks nothing', () => {
  // Catches: a role list ahead of the categories, or a chooser that probes by being opened.
  const first = opened();
  assert.equal(first.step, 'group');
  assert.deepEqual(rowIds(first), ['main', 'errand', 'development']);
  const role = play(first, choose('main'));
  assert.equal(role.state.step, 'role');
  assert.deepEqual(role.effects, []);
  const loading = play(role.state, choose('speech'));
  assert.equal(loading.state.step, 'providerType');
  assert.deepEqual(loading.effects, [{ kind: 'readSources', role: 'speech', revision: loading.state.revision }]);
  const answered = play(loading.state, [
    { kind: 'sources', revision: loading.state.revision, read: read('speech', [API]) },
  ]);
  assert.deepEqual(rowIds(answered.state), ['api']);
  assert.equal(play(answered.state, choose('api')).state.step, 'source');
  assert.equal(play(answered.state, choose('api', 'api:openrouter')).state.step, 'model');
});

test('Main, Voice, API, the route and a model commit the speech role, whose key is models.base.speech', () => {
  // Catches: the display name reaching the setter, a write to a key that nothing reads.
  const at = play(atRole('main', 'speech', [API]), choose('api', 'api:openrouter', 'vendor/voice-1'));
  assert.equal(at.state.step, 'review');
  const saved = play(at.state, [{ kind: 'confirm' }]);
  assert.deepEqual(committed(saved.effects), [
    { name: 'model.set', args: { role: 'speech', model: 'vendor/voice-1' } },
  ]);
  // roleConfigKeys answers the path as parts, as tests/roles.test.ts pins, so the spec's includes of a dotted string could never hold.
  assert.equal(roleConfigKeys(committed(saved.effects)[0]?.args.role)?.join('.'), 'models.base.speech');
});

test('nothing commits before the confirmation, and a double confirmation commits once', () => {
  // Catches: highlighting that saves, or Enter pressed twice checking the model twice.
  const steps = play(atRole('errand', 'scout', [CODEX]), choose('subharness', 'backend:codex', 'suggested-1', 'keep'));
  assert.deepEqual(committed(steps.effects), []);
  assert.equal(steps.state.step, 'review');
  const saved = play(steps.state, [{ kind: 'confirm' }, { kind: 'confirm' }]);
  assert.deepEqual(committed(saved.effects), [
    { name: 'model.set', args: { role: 'scout', model: 'suggested-1', via: 'codex' } },
  ]);
});

test('Development offers thinker and dev, and watcher is a separate row', () => {
  // Catches: a stale list hiding thinker, or watcher treated as one more development agent.
  const rows = pickerRows(play(opened(), choose('development')).state);
  assert.deepEqual(
    rows
      .filter((one) => one.utility !== true)
      .map((one) => one.id)
      .sort(),
    ['dev', 'thinker']
  );
  assert.deepEqual(
    rows.filter((one) => one.utility === true).map((one) => one.id),
    ['watcher']
  );
});

test('the three kinds of evidence are told apart on the rows and in the review', () => {
  // Catches: a fixed alias drawn like an observed listing, the owner trusting an entitlement nobody checked.
  const api = play(atRole('main', 'speech', [API]), choose('api', 'api:openrouter')).state;
  assert.equal(pickerRows(api).find((one) => one.id === 'vendor/voice-1')?.evidence, 'observed');
  const codex = play(atRole('errand', 'scout', [CODEX]), choose('subharness', 'backend:codex')).state;
  assert.equal(pickerRows(codex).find((one) => one.id === 'suggested-1')?.evidence, 'suggestion');
  const typed = play(codex, [{ kind: 'manual', model: 'typed-by-hand' }, ...choose('keep')]).state;
  assert.equal(pickerReview(typed)?.evidence, 'unknown');
  assert.equal(pickerReview(typed)?.model, 'typed-by-hand');
});

test('the review names what will be saved', () => {
  // Catches: a confirmation that hides the actual route behind a friendly name.
  const at = play(atRole('errand', 'scout', [CODEX]), choose('subharness', 'backend:codex', 'suggested-1', 'keep'));
  // The whole shape is the point: the review names every field that will be saved.
  assert.deepEqual(pickerReview(at.state), {
    group: 'errand',
    role: 'scout',
    label: 'Scout',
    providerType: 'subharness',
    sourceId: 'backend:codex',
    via: 'codex',
    model: 'suggested-1',
    evidence: 'suggestion',
    effort: 'keep',
  });
});

test('a missing install, a missing login and a rejection are three different disabled rows', () => {
  // Catches: one "unavailable" for all three, and Enter going through on any of them.
  const rejected: SourceDescriptor = {
    ...CODEX,
    id: 'backend:rejected',
    code: 'provider-rejected',
    listing: 'failed',
    models: [],
  };
  const at = play(atRole('errand', 'scout', [CLAUDE_OUT, OPENCODE_ABSENT, rejected]), choose('subharness')).state;
  const rows = pickerRows(at);
  assert.deepEqual(
    rows.map((one) => one.code),
    ['not-logged-in', 'not-installed', 'provider-rejected']
  );
  assert.equal(new Set(rows.map((one) => one.disabled)).size, 3);
  assert.ok(rows.every((one) => typeof one.disabled === 'string' && one.disabled !== ''));
  const pressed = play(at, choose('backend:claude'));
  assert.equal(pressed.state.step, 'source');
  assert.deepEqual(pressed.effects, []);
});

test('a role-unsupported combination stays visible as a disabled provider or source', () => {
  // Catches: a text-only CLI vanishing with no reason, or being selectable for the voice.
  const unsupported: SourceDescriptor = { ...CODEX, code: 'role-unsupported', listing: 'none', models: [] };
  const at = atRole('main', 'speech', [API, unsupported]);
  const rows = pickerRows(at);
  assert.deepEqual(
    rows.map((one) => one.id),
    ['api', 'subharness']
  );
  // A disabled row must say why, and the type alone would accept an empty reason.
  assert.equal((rows.find((one) => one.id === 'subharness')?.disabled ?? '').length > 0, true);
  const pressed = play(at, choose('subharness'));
  assert.equal(pressed.state.step, 'providerType');
});

// Effort

test('unknown effort offers only keep and the model default', () => {
  // Catches: low, medium and high fabricated for a model whose levels nobody established.
  const at = play(atRole('errand', 'scout', [CODEX]), choose('subharness', 'backend:codex', 'suggested-1')).state;
  assert.equal(at.step, 'effort');
  assert.deepEqual(rowIds(at), ['keep', 'default']);
});

test('observed effort offers its levels and commits the chosen one', () => {
  // Catches: the chosen level dropped on the way to the setter.
  const proven: SourceDescriptor = { ...CODEX, effort: { evidence: 'observed', levels: ['minimal', 'high'] } };
  const at = play(atRole('errand', 'scout', [proven]), choose('subharness', 'backend:codex', 'suggested-1'));
  assert.deepEqual(rowIds(at.state), ['keep', 'default', 'minimal', 'high']);
  const saved = play(at.state, [...choose('high'), { kind: 'confirm' }]);
  assert.deepEqual(committed(saved.effects), [
    { name: 'model.set', args: { role: 'scout', model: 'suggested-1', via: 'codex', effort: 'high' } },
  ]);
});

test('unsupported effort skips the step and commits no effort', () => {
  // Catches: the core asked for a provider effort it rejects.
  const at = play(atRole('main', 'speech', [API]), choose('api', 'api:openrouter', 'vendor/voice-1')).state;
  assert.equal(at.step, 'review');
});

test("keep on the memory writer sends its stored effort, because the setter's omission clears it", () => {
  // Catches: an omitted field deciding, so keeping the writer's effort silently resets it.
  const current = { via: 'codex', model: 'old', effort: 'high' } as const;
  const steps = play(atRole('main', 'memory', [CODEX], current), [
    ...choose('subharness', 'backend:codex', 'suggested-1', 'keep'),
    { kind: 'confirm' },
  ]);
  assert.equal(committed(steps.effects)[0]?.args.effort, 'high');
  const reset = play(atRole('main', 'memory', [CODEX], current), [
    ...choose('subharness', 'backend:codex', 'suggested-1', 'default'),
    { kind: 'confirm' },
  ]);
  assert.equal(committed(reset.effects)[0]?.args.effort, undefined);
});

// Stale answers

test('the sources of a role left behind do not land on the next role', () => {
  // Catches: stale model rows crossing roles, the owner picking a speech model for the analyzer.
  const first = play(opened(), choose('main', 'speech'));
  const old = first.state.revision;
  const second = play(first.state, [{ kind: 'back' }, ...choose('analyzer')]);
  assert.ok(second.state.revision > old);
  const late = play(second.state, [{ kind: 'sources', revision: old, read: read('speech', [API]) }]);
  assert.equal(late.state.role, 'analyzer');
  assert.deepEqual(rowIds(late.state), []);
  assert.deepEqual(late.effects, []);
});

test('a failed read of the sources is visible and retries under a new revision', () => {
  // Catches: a failed read drawn as a role that has no sources.
  const first = play(opened(), choose('main', 'speech')).state;
  const failed = play(first, [{ kind: 'sourcesFailed', revision: first.revision, code: 'no-answer' }]).state;
  assert.equal(failed.error?.code, 'no-answer');
  const retried = play(failed, [{ kind: 'retry' }]);
  assert.deepEqual(retried.effects, [{ kind: 'readSources', role: 'speech', revision: retried.state.revision }]);
  assert.ok(retried.state.revision > first.revision);
});

test('a check that succeeds after the selection moved leaves the new selection untouched', () => {
  // Catches: the old route reported saved over a selection the owner has changed since.
  const other: SourceDescriptor = { ...CODEX, id: 'backend:other', via: 'claude', label: 'Other' };
  const at = play(
    atRole('errand', 'scout', [CODEX, other]),
    choose('subharness', 'backend:codex', 'suggested-1', 'keep')
  );
  const saving = play(at.state, [{ kind: 'confirm' }]);
  const old = saving.state.revision;
  assert.equal(saving.state.step, 'saving');
  const moved = play(saving.state, [
    { kind: 'back' },
    { kind: 'back' },
    { kind: 'back' },
    ...choose('backend:other'),
  ]).state;
  assert.equal(moved.sourceId, 'backend:other');
  const late = play(moved, [{ kind: 'saved', revision: old, status: 'ok', code: 'ok', text: 'saved' }]);
  assert.equal(late.state.sourceId, 'backend:other');
  assert.equal(late.state.step, moved.step);
  assert.deepEqual(late.effects, []);
});

for (const code of ['not-installed', 'not-logged-in', 'model-rejected', 'selection-changed', 'source-changed']) {
  test(`a commit refused with ${code} keeps the selection, shows the code and retries once`, () => {
    // Catches: a failed check saved as partial progress, or the selection lost so the owner starts over.
    const at = play(atRole('errand', 'scout', [CODEX]), choose('subharness', 'backend:codex', 'suggested-1', 'keep'));
    const saving = play(at.state, [{ kind: 'confirm' }]).state;
    const failed = play(saving, [
      { kind: 'saved', revision: saving.revision, status: 'failed', code, text: 'refused' },
    ]).state;
    assert.equal(failed.step, 'review');
    assert.equal(failed.error?.code, code);
    assert.equal(failed.model, 'suggested-1');
    const again = play(failed, [{ kind: 'confirm' }]);
    assert.equal(committed(again.effects).length, 1);
  });
}

test('a successful commit ends the selector with what was saved', () => {
  // Catches: a menu that stays open, or a success reported by the state alone and not by the core's answer.
  const at = play(atRole('errand', 'scout', [CODEX]), choose('subharness', 'backend:codex', 'suggested-1', 'keep'));
  const saving = play(at.state, [{ kind: 'confirm' }]).state;
  const done = play(saving, [
    { kind: 'saved', revision: saving.revision, status: 'ok', code: 'ok', text: 'dev now runs' },
  ]);
  assert.equal(done.state.step, 'done');
  assert.equal(done.state.savedText, 'dev now runs');
});

// Setup detours

test('a login detour comes back to the same role and source, which is now selectable', () => {
  // Catches: the setup detour losing the unfinished role, the owner starting over from the top.
  const start = play(atRole('errand', 'scout', [CLAUDE_OUT, CODEX]), choose('subharness')).state;
  const detour = play(start, [{ kind: 'setup', sourceId: 'backend:claude', command: '/subharness claude login' }]);
  assert.deepEqual(detour.effects, [{ kind: 'runSetup', command: '/subharness claude login', masked: false }]);
  const back = play(detour.state, [{ kind: 'setupDone', ok: true }]);
  assert.deepEqual(back.effects, [{ kind: 'readSources', role: 'scout', revision: back.state.revision }]);
  const fresh: SourceDescriptor = {
    ...CLAUDE_OUT,
    code: 'ok',
    listing: 'suggestion',
    models: [{ id: 'sonnet', evidence: 'suggestion' }],
    setup: [],
  };
  const answered = play(back.state, [
    { kind: 'sources', revision: back.state.revision, read: read('scout', [fresh, CODEX]) },
  ]).state;
  assert.equal(answered.role, 'scout');
  assert.equal(answered.step, 'source');
  assert.equal(answered.highlightedId, 'backend:claude');
  assert.equal(pickerRows(answered).find((one) => one.id === 'backend:claude')?.disabled, undefined);
  assert.equal(play(answered, choose('backend:claude')).state.step, 'model');
});

test('a cancelled detour leaves the unfinished selection as it was', () => {
  // Catches: Escape in the masked dialog tearing down the selector behind it.
  const start = play(atRole('errand', 'scout', [CLAUDE_OUT, CODEX]), choose('subharness')).state;
  const detour = play(start, [
    { kind: 'setup', sourceId: 'backend:claude', command: '/subharness claude login' },
  ]).state;
  const back = play(detour, [{ kind: 'setupDone', ok: false }]);
  assert.deepEqual(back.effects, []);
  assert.equal(back.state.role, 'scout');
  assert.equal(back.state.step, 'source');
});

test('a masked key command goes out marked masked, and refuses a command the source does not list', () => {
  // Catches: the key dialog drawn in the clear, or an arbitrary command run from the chooser.
  const noKey: SourceDescriptor = {
    ...API,
    code: 'no-key',
    listing: 'none',
    models: [],
    setup: [{ command: '/keys extra add <name>', masked: true }],
  };
  const at = play(atRole('main', 'drawing', [noKey]), choose('api')).state;
  const asked = play(at, [{ kind: 'setup', sourceId: noKey.id, command: '/keys extra add <name>' }]);
  assert.deepEqual(asked.effects, [{ kind: 'runSetup', command: '/keys extra add <name>', masked: true }]);
  const other = play(at, [{ kind: 'setup', sourceId: noKey.id, command: '/config set anything' }]);
  assert.deepEqual(other.effects, []);
});

// The screen

function terminal() {
  let screen = '';
  const stdout = Object.assign(
    new Writable({
      write(chunk: Buffer | string, _encoding, done) {
        const visible = stripVTControlCharacters(String(chunk));
        if (visible.includes('\n')) screen = visible;
        done();
      },
    }),
    { columns: 100, rows: 30, isTTY: true }
  );
  const stdin = Object.assign(new Readable({ read() {} }), {
    isTTY: true,
    setRawMode: () => stdin,
    ref: () => stdin,
    unref: () => stdin,
    setEncoding: () => stdin,
  });
  return { stdout, stdin, type: (text: string): void => void stdin.push(text), screen: () => screen };
}

const pause = (ms = 50): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const ENTER = '\r';
const ESC = '\u001b';

async function pressed(type: (text: string) => void, keys: ReadonlyArray<string>): Promise<void> {
  for (const key of keys) {
    type(key);
    await pause();
  }
}

function drawPicker(over: {
  read: (role: string) => Promise<RoleSources>;
  commit?: (command: PickerCommand) => Promise<{ status: string; code: string; text: string }>;
}) {
  const rig = terminal();
  const commits: Array<PickerCommand> = [];
  let closes = 0;
  const app = render(
    createElement(ModelPicker, {
      env: {
        registry: modelRoleRegistry(),
        read: over.read,
        commit: (command: PickerCommand) => {
          commits.push(command);
          return over.commit?.(command) ?? Promise.resolve({ status: 'ok', code: 'ok', text: 'saved it' });
        },
        setup: () => Promise.resolve(true),
      },
      active: true,
      close: () => {
        closes += 1;
      },
    }),
    {
      stdin: rig.stdin,
      stdout: rig.stdout,
      exitOnCtrlC: false,
      interactive: true,
      patchConsole: false,
    }
  );
  return { rig, commits, app, closes: () => closes };
}

test('the keys walk the screen to one commit of the speech role, double Enter on the review included', async () => {
  // Catches: the screen drifting from the reducer, or the review's Enter reaching the setter twice.
  const { rig, commits, app, closes } = drawPicker({ read: (role) => Promise.resolve(read(role, [API])) });
  try {
    await pause();
    await pressed(rig.type, [
      ENTER, // Main
      'Voice',
      ENTER, // the role, filtered
      ENTER, // API
      ENTER, // the source
      ENTER, // the model
    ]);
    await pause();
    assert.ok(rig.screen().includes('speech'), rig.screen());
    assert.ok(rig.screen().includes('vendor/voice-1'), rig.screen());
    assert.deepEqual(commits, []);
    await pressed(rig.type, [ENTER, ENTER]);
    await pause();
    assert.deepEqual(commits, [{ name: 'model.set', args: { role: 'speech', model: 'vendor/voice-1' } }]);
    assert.equal(closes(), 0);
    assert.ok(rig.screen().includes('saved it'), rig.screen());
  } finally {
    app.unmount();
  }
});

test('Escape at the top closes the selector, and a late read afterwards draws nothing and commits nothing', async () => {
  // Catches: a closed overlay's listing repainting the screen or reaching a save.
  let release: (value: RoleSources) => void = () => {};
  const held = new Promise<RoleSources>((resolve) => (release = resolve));
  const { rig, commits, app, closes } = drawPicker({ read: () => held });
  try {
    await pause();
    await pressed(rig.type, [ENTER, ENTER]);
    await pressed(rig.type, [ESC]);
    await pause(100);
    await pressed(rig.type, [ESC]);
    await pause(100);
    await pressed(rig.type, [ESC]);
    await pause(100);
    assert.equal(closes(), 1);
    release(read('core', [{ ...API, label: 'A late source row' }]));
    await pause();
    assert.equal(rig.screen().includes('A late source row'), false, rig.screen());
    assert.deepEqual(commits, []);
  } finally {
    app.unmount();
  }
});

test('a refused commit stays on the review with the reason on the screen', async () => {
  // Catches: a failed check that looks saved, or the owner thrown back to the start.
  const { rig, commits, app } = drawPicker({
    read: (role) => Promise.resolve(read(role, [API])),
    commit: () => Promise.resolve({ status: 'failed', code: 'model-rejected', text: 'that model is not on this key' }),
  });
  try {
    await pause();
    await pressed(rig.type, [ENTER, 'Voice', ENTER, ENTER, ENTER, ENTER, ENTER]);
    await pause();
    assert.ok(rig.screen().includes('that model is not on this key'), rig.screen());
    assert.equal(commits.length, 1);
    assert.ok(rig.screen().includes('vendor/voice-1'), rig.screen());
  } finally {
    app.unmount();
  }
});
