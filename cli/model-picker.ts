// The nested model selector of `/model` in the chat: category, role, provider type, source, model, effort, review. A pure
// reducer holds the selection, and every answer that arrives names the revision it was asked under, so the sources of a role
// left behind and a check of a selection that moved change nothing. Nothing leaves before the confirmation, and the one
// commit is the checked `model.set` command, which saves a model role's one route, or an agent's source, model and
// effort, together or not at all. A setup detour
// runs one of the commands a source lists and comes back to the same role and source. `ModelPicker` draws it with
// cli/selector.ts; bin/chat-panels.ts gives it the reads and the commit. No key value enters this state.
import { createElement as h, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { FilterLine, SelectorView, closedSelector } from './selector.ts';
import type { SelectorRow, SelectorState } from './selector.ts';
import { backspace, emptyInput, insert, moveCursor } from './state.ts';
import type { InputState } from './state.ts';

// The shapes of `/model sources`, as this package reads them: src/subharness/model-capabilities.ts writes them, and this
// package imports nothing of the engine.
type ModelRoleRow = { group: string; role: string; label: string; utility: boolean };
type SourceDescriptor = {
  id: string;
  providerType: string;
  via: string | null;
  label: string;
  account: string | null;
  code: string;
  setup: ReadonlyArray<{ command: string; masked: boolean }>;
  listing: string;
  models: ReadonlyArray<{ id: string; evidence: 'observed' | 'suggestion'; saveAs?: string }>;
  effort: { evidence: string; levels: ReadonlyArray<string> };
  manualModel: boolean;
};
type RoleSources = {
  role: string;
  current: { via: string | null; model: string | null; effort: string | null } | null;
  sources: ReadonlyArray<SourceDescriptor>;
};

export type PickerCommand = {
  name: 'model.set';
  args: { role: string; model: string; via?: string; effort?: string };
};

type PickerStep = 'group' | 'role' | 'providerType' | 'source' | 'model' | 'effort' | 'review' | 'saving' | 'done';
type Evidence = 'observed' | 'suggestion' | 'unknown';

export type PickerState = {
  step: PickerStep;
  /** every read and commit is asked under one; an answer of another changes nothing */
  revision: number;
  registry: ReadonlyArray<ModelRoleRow>;
  group: string | null;
  role: string | null;
  read: RoleSources | null;
  providerType: string | null;
  sourceId: string | null;
  model: string | null;
  evidence: Evidence | null;
  /** `keep`, `default` or a level; null when the source takes no effort from here */
  effort: string | null;
  query: string;
  highlightedId: string | null;
  /** the source whose setup is running; the sources read after it land back on that row */
  detour: string | null;
  error: { code: string; text?: string } | null;
  savedText: string | null;
};

export type PickerEvent =
  | { kind: 'choose'; id: string }
  | { kind: 'manual'; model: string }
  | { kind: 'back' }
  | { kind: 'confirm' }
  | { kind: 'retry' }
  | { kind: 'move'; delta: 1 | -1 }
  | { kind: 'filter'; query: string }
  | { kind: 'sources'; revision: number; read: RoleSources }
  | { kind: 'sourcesFailed'; revision: number; code: string }
  | { kind: 'saved'; revision: number; status: string; code: string; text: string }
  | { kind: 'setup'; sourceId: string; command: string }
  | { kind: 'setupDone'; ok: boolean; text?: string };

export type PickerEffect =
  | { kind: 'readSources'; role: string; revision: number }
  | { kind: 'commit'; revision: number; command: PickerCommand }
  | { kind: 'runSetup'; command: string; masked: boolean };

export type PickerRow = {
  id: string;
  label: string;
  detail?: string;
  disabled?: string;
  code?: string;
  evidence?: Evidence;
  utility?: boolean;
  current?: string;
};

export type PickerReview = {
  group: string;
  role: string;
  label: string;
  providerType: string;
  sourceId: string;
  via: string | null;
  model: string;
  evidence: Evidence;
  effort: string | null;
};

type PickerStepResult = { state: PickerState; effects: Array<PickerEffect> };

const GROUPS: ReadonlyArray<PickerRow> = [
  { id: 'main', label: 'Main', detail: 'The persona’s own models' },
  { id: 'errand', label: 'Errand', detail: 'The agents she sends on errands' },
  { id: 'development', label: 'Development', detail: 'The agents that work on the code' },
];

const PROVIDER_LABELS: Readonly<Record<string, string>> = { api: 'API', subharness: 'CLI backend' };

/** Why a source cannot be chosen, by its code. */
const UNAVAILABLE: Readonly<Record<string, string>> = {
  'not-installed': 'Not installed. Enter shows how to set it up.',
  'not-logged-in': 'Not logged in. Enter shows how to log in.',
  'no-key': 'No key for this role. Enter shows the key commands.',
  'provider-rejected': 'The provider refused the listing on this key.',
  'role-unsupported': 'This role cannot run here.',
};

const EVIDENCE_WORDS: Readonly<Record<Evidence, string>> = {
  observed: 'Listed by the provider just now.',
  suggestion: 'A known name, not checked against this account until the review saves it.',
  unknown: 'Typed by hand, checked with one reply when saved.',
};

const LISTING_WORDS: Readonly<Record<string, string>> = {
  observed: 'Its models are read from the provider.',
  suggestion: 'Its models are known names; this CLI has no list to ask.',
};

/** The manual row of the model step: the query as a model name. */
const MANUAL_ROW = 'manual';

export function openPicker(registry: ReadonlyArray<ModelRoleRow>): PickerState {
  const state: PickerState = {
    step: 'group',
    revision: 0,
    registry,
    group: null,
    role: null,
    read: null,
    providerType: null,
    sourceId: null,
    model: null,
    evidence: null,
    effort: null,
    query: '',
    highlightedId: null,
    detour: null,
    error: null,
    savedText: null,
  };
  return settled(state);
}

/** The sources the last read listed, none before a read. */
/** The names of the routes, as `/model set --via` takes them. This package imports nothing of the engine, so the four
 * names repeat src/subharness/route-names.ts; the source descriptor keeps the stored backend word in `via`. */
const ROUTE_NAME_OF: Readonly<Record<string, string>> = {
  claude: 'claude-harness',
  codex: 'codex-harness',
  opencode: 'opencode-harness',
};
const routeNameOf = (via: string | null): string => (via === null ? 'direct-api' : (ROUTE_NAME_OF[via] ?? via));

const listedSources = (state: PickerState) => state.read?.sources;

/** The model in force as the last read found it. */
const currentOf = (state: PickerState) => state.read?.current;

const sourceOf = (state: PickerState): SourceDescriptor | undefined =>
  listedSources(state)?.find((one) => one.id === state.sourceId);

function sourceRow(state: PickerState, source: SourceDescriptor): PickerRow {
  const reason = source.code === 'ok' ? undefined : UNAVAILABLE[source.code];
  const account = source.account === null ? '' : ` · ${source.account}`;
  const inForce = currentOf(state)?.via === source.via && source.via !== null;
  return {
    id: source.id,
    label: `${routeNameOf(source.via)} · ${source.label}${account}`,
    code: source.code,
    ...(reason === undefined ? { detail: LISTING_WORDS[source.listing] ?? '' } : { disabled: reason }),
    ...(inForce ? { current: 'in force' } : {}),
  };
}

function effortRows(state: PickerState): Array<PickerRow> {
  const stored = currentOf(state)?.effort ?? null;
  const levels = sourceOf(state)?.effort.levels ?? [];
  return [
    {
      id: 'keep',
      label: 'Keep the effort in force',
      detail: stored === null ? 'None is stored for this role.' : `Stored now: ${stored}.`,
    },
    { id: 'default', label: 'Use the model’s default', detail: 'No effort is asked for.' },
    ...levels.map((level): PickerRow => ({
      id: level,
      label: level,
      detail: 'Listed by the help of the installed backend.',
    })),
  ];
}

function rowsOfStep(state: PickerState): Array<PickerRow> {
  const { read } = state;
  switch (state.step) {
    case 'group':
      return [...GROUPS];
    case 'role':
      return state.registry
        .filter((one) => one.group === state.group)
        .map((one) => ({
          id: one.role,
          label: one.label,
          detail: `Saved as ${one.role}.`,
          ...(one.utility ? { utility: true } : {}),
        }));
    case 'providerType': {
      if (read === null) return [];
      return [...new Set(read.sources.map((one) => one.providerType))].map((type): PickerRow => {
        const all = read.sources.filter((one) => one.providerType === type);
        const refused = all.every((one) => one.code === 'role-unsupported');
        return {
          id: type,
          label: PROVIDER_LABELS[type] ?? type,
          ...(refused ? { disabled: UNAVAILABLE['role-unsupported'] ?? '' } : {}),
        };
      });
    }
    case 'source':
      return (read?.sources ?? [])
        .filter((one) => one.providerType === state.providerType)
        .map((one) => sourceRow(state, one));
    case 'model': {
      const stored = read?.current?.via === sourceOf(state)?.via ? read?.current?.model : null;
      return (sourceOf(state)?.models ?? []).map((one) => ({
        id: one.id,
        label: one.id,
        evidence: one.evidence,
        detail: EVIDENCE_WORDS[one.evidence],
        ...(stored === one.id || stored === one.saveAs ? { current: 'in force' } : {}),
      }));
    }
    case 'effort':
      return effortRows(state);
    case 'review':
    case 'saving':
    case 'done':
      return [];
  }
}

/** The rows of the step now, narrowed by the query; on the model step a query can also become a typed name. */
export function pickerRows(state: PickerState): Array<PickerRow> {
  const asked = state.query.trim().toLowerCase();
  const rows = rowsOfStep(state);
  if (asked === '') return rows;
  const found = rows.filter((row) => `${row.id} ${row.label}`.toLowerCase().includes(asked));
  const canType = state.step === 'model' && sourceOf(state)?.manualModel === true;
  if (!canType || rows.some((row) => row.id === state.query.trim())) return found;
  const typed = state.query.trim();
  return [
    ...found,
    { id: MANUAL_ROW, label: `Use “${typed}” as the model name`, evidence: 'unknown', detail: EVIDENCE_WORDS.unknown },
  ];
}

/** `state` with its highlight on a row that is there: the one it had, else the row in force, else the first. */
function settled(state: PickerState): PickerState {
  const rows = pickerRows(state);
  const kept =
    rows.find((row) => row.id === state.highlightedId) ?? rows.find((row) => row.current !== undefined) ?? rows[0];
  return { ...state, highlightedId: kept?.id ?? null };
}

const at = (state: PickerState, step: PickerStep): PickerStepResult => ({
  state: settled({ ...state, step, query: '', highlightedId: null }),
  effects: [],
});

function modelChosen(state: PickerState, model: string, evidence: Evidence): PickerStepResult {
  const saveAs = sourceOf(state)?.models.find((one) => one.id === model)?.saveAs;
  const chosen = { ...state, model: saveAs ?? model, evidence, error: null };
  return sourceOf(state)?.effort.evidence === 'unsupported'
    ? at({ ...chosen, effort: null }, 'review')
    : at(chosen, 'effort');
}

function chosen(state: PickerState, id: string): PickerStepResult {
  const still = { state, effects: [] };
  const row = pickerRows(state).find((one) => one.id === id);
  if (row === undefined || row.disabled !== undefined) return still;
  switch (state.step) {
    case 'group':
      return at({ ...state, group: id }, 'role');
    case 'role': {
      const revision = state.revision + 1;
      return {
        state: at({ ...state, role: id, revision, read: null, error: null }, 'providerType').state,
        effects: [{ kind: 'readSources', role: id, revision }],
      };
    }
    case 'providerType':
      return at({ ...state, providerType: id }, 'source');
    case 'source':
      return at({ ...state, sourceId: id, error: null }, 'model');
    case 'model':
      return id === MANUAL_ROW
        ? modelChosen(state, state.query.trim(), 'unknown')
        : modelChosen(state, id, row.evidence ?? 'unknown');
    case 'effort':
      return at({ ...state, effort: id }, 'review');
    case 'review':
    case 'saving':
    case 'done':
      return still;
  }
}

function backed(state: PickerState): PickerStepResult {
  const revision = state.revision + 1;
  const moved = { ...state, revision, error: null };
  switch (state.step) {
    case 'group':
    case 'done':
      return { state, effects: [] };
    case 'role':
      return at({ ...moved, group: null }, 'group');
    case 'providerType':
      return at({ ...moved, role: null, read: null }, 'role');
    case 'source':
      return at({ ...moved, providerType: null, sourceId: null }, 'providerType');
    case 'model':
      return at({ ...moved, sourceId: null }, 'source');
    case 'effort':
      return at({ ...moved, model: null, evidence: null, effort: null }, 'model');
    case 'review':
    case 'saving':
      return sourceOf(state)?.effort.evidence === 'unsupported'
        ? at({ ...moved, model: null, evidence: null, effort: null }, 'model')
        : at({ ...moved, effort: null }, 'effort');
  }
}

/** What the setter stores for `keep` and `default`: the memory writer's omission clears, an agent's omission keeps. */
function effortArg(state: PickerState): string | undefined {
  const via = sourceOf(state)?.via ?? null;
  if (state.effort === null) return undefined;
  if (state.effort === 'keep') return state.role === 'memory' ? (currentOf(state)?.effort ?? undefined) : undefined;
  if (state.effort === 'default') return via === null || state.role === 'memory' ? undefined : 'default';
  return state.effort;
}

/** The model roles that run on a chain of routes, as src/llm/route-text.ts lists them; the agents take `--via`. */
const CHAIN_ROLES: ReadonlyArray<string> = [
  'core',
  'memory',
  'analyzer',
  'vision',
  'video',
  'embedding',
  'speech',
  'drawing',
];

/** The args of the commit: a chain role's one route as text, an agent's model with its route name and effort. */
function commitArgs(state: PickerState, role: string, model: string): PickerCommand['args'] {
  const source = sourceOf(state);
  const via = source?.via ?? null;
  const effort = effortArg(state);
  if (CHAIN_ROLES.includes(role)) {
    const level = effort === undefined || effort === 'default' ? '' : `:${effort}`;
    const route = via === null ? `${source?.account ?? ''}/${model}` : `harness:${via}/${model}${level}`;
    return { role, model: route };
  }
  const route = via === null ? null : routeNameOf(via);
  return { role, model, ...(route === null ? {} : { via: route }), ...(effort === undefined ? {} : { effort }) };
}

function confirmed(state: PickerState): PickerStepResult {
  const { role, model } = state;
  if (state.step !== 'review' || role === null || model === null) return { state, effects: [] };
  const revision = state.revision + 1;
  return {
    state: { ...state, step: 'saving', revision, error: null },
    effects: [{ kind: 'commit', revision, command: { name: 'model.set', args: commitArgs(state, role, model) } }],
  };
}

function setupAsked(state: PickerState, sourceId: string, command: string): PickerStepResult {
  const entry = listedSources(state)
    ?.find((one) => one.id === sourceId)
    ?.setup.find((one) => one.command === command);
  if (entry === undefined) return { state, effects: [] };
  return {
    state: { ...state, detour: sourceId, error: null },
    effects: [{ kind: 'runSetup', command, masked: entry.masked }],
  };
}

function setupEnded(state: PickerState, ok: boolean, text: string | undefined): PickerStepResult {
  const { role } = state;
  if (!ok || role === null) {
    const error = text === undefined ? null : { code: 'setup-failed', text };
    return { state: { ...state, detour: null, error }, effects: [] };
  }
  const revision = state.revision + 1;
  return { state: { ...state, revision }, effects: [{ kind: 'readSources', role, revision }] };
}

function sourcesRead(state: PickerState, read: RoleSources): PickerState {
  if (state.detour === null) return settled({ ...state, read, error: null });
  return settled({ ...state, read, step: 'source', highlightedId: state.detour, detour: null, error: null });
}

function moved(state: PickerState, delta: 1 | -1): PickerState {
  const rows = pickerRows(state);
  const index = rows.findIndex((row) => row.id === state.highlightedId);
  return { ...state, highlightedId: rows[Math.min(rows.length - 1, Math.max(0, index + delta))]?.id ?? null };
}

function retried(state: PickerState): PickerStepResult {
  if (state.error === null || state.read !== null || state.role === null) return { state, effects: [] };
  const revision = state.revision + 1;
  return {
    state: { ...state, revision, error: null },
    effects: [{ kind: 'readSources', role: state.role, revision }],
  };
}

type PickerAnswer = Extract<PickerEvent, { kind: 'sources' | 'sourcesFailed' | 'saved' }>;

/** An answer of a read or a commit: one that was not asked under this revision changes nothing. */
function answered(state: PickerState, event: PickerAnswer): PickerState {
  if (event.revision !== state.revision) return state;
  switch (event.kind) {
    case 'sources':
      return sourcesRead(state, event.read);
    case 'sourcesFailed':
      return { ...state, detour: null, error: { code: event.code } };
    case 'saved':
      if (state.step !== 'saving') return state;
      return event.status === 'ok'
        ? { ...state, step: 'done', savedText: event.text }
        : { ...state, step: 'review', error: { code: event.code, text: event.text } };
  }
}

/** One event: the state after it, and what the caller must do. */
export function pickerReduce(state: PickerState, event: PickerEvent): PickerStepResult {
  switch (event.kind) {
    case 'choose':
      return chosen(state, event.id);
    case 'manual':
      return state.step === 'model' && sourceOf(state)?.manualModel === true
        ? modelChosen(state, event.model, 'unknown')
        : { state, effects: [] };
    case 'back':
      return backed(state);
    case 'confirm':
      return confirmed(state);
    case 'retry':
      return retried(state);
    case 'move':
      return { state: moved(state, event.delta), effects: [] };
    case 'filter':
      return { state: settled({ ...state, query: event.query }), effects: [] };
    case 'sources':
    case 'sourcesFailed':
    case 'saved':
      return { state: answered(state, event), effects: [] };
    case 'setup':
      return setupAsked(state, event.sourceId, event.command);
    case 'setupDone':
      return setupEnded(state, event.ok, event.text);
  }
}

/** What will be saved, once a source and a model are chosen. */
export function pickerReview(state: PickerState): PickerReview | null {
  const source = sourceOf(state);
  const row = state.registry.find((one) => one.role === state.role);
  if (source === undefined || row === undefined || state.model === null || state.evidence === null) return null;
  return {
    group: row.group,
    role: row.role,
    label: row.label,
    providerType: source.providerType,
    sourceId: source.id,
    via: source.via,
    model: state.model,
    evidence: state.evidence,
    effort: state.effort,
  };
}

// The screen

export type PickerEnv = {
  registry: ReadonlyArray<ModelRoleRow>;
  read(role: string): Promise<RoleSources>;
  commit(command: PickerCommand): Promise<{ status: string; code?: string; text: string }>;
  /** Runs one command a source lists; a masked one asks for its value in the chat's own dialog. */
  setup(command: string, masked: boolean): Promise<boolean | { ok: boolean; text: string }>;
};

const STEP_TITLES: Readonly<Record<PickerStep, string>> = {
  group: 'Choose a category',
  role: 'Choose a role',
  providerType: 'Choose a provider type',
  source: 'Choose a source',
  model: 'Choose a model',
  effort: 'Choose an effort',
  review: 'Review',
  saving: 'Checking with one reply…',
  done: 'Saved',
};

const NAME_PLACEHOLDER = '<name>';

/** The picker's rows as a selector state, so one view draws every list of the chat. */
function asSelector(state: PickerState, loadingRows: boolean): SelectorState {
  const rows = pickerRows(state).map((row): SelectorRow => ({
    ...row,
    label: row.utility === true ? `${row.label}  (utility)` : row.label,
    value: row.id,
  }));
  return {
    ...closedSelector,
    status: loadingRows ? 'loading' : state.query === '' && rows.length === 0 ? 'empty' : 'ready',
    overlayId: 'picker',
    rows,
    selectedId: state.highlightedId,
  };
}

function ReviewLines({ state }: { state: PickerState }): ReactElement | null {
  const review = pickerReview(state);
  if (review === null) return null;
  const source = sourceOf(state);
  const effort =
    review.effort === null
      ? 'Set with /model set --effort on this path'
      : review.effort === 'keep'
        ? `Keep (${currentOf(state)?.effort ?? 'none stored'})`
        : review.effort === 'default'
          ? 'The model’s default'
          : review.effort;
  return h(
    Box,
    { flexDirection: 'column' },
    h(Text, null, `Role: ${review.label} (${review.role})`),
    h(
      Text,
      null,
      `Source: ${source?.label ?? review.sourceId}${source?.account == null ? '' : ` · ${source.account}`}`
    ),
    h(Text, null, `Model: ${review.model}`),
    h(Text, { dimColor: true }, EVIDENCE_WORDS[review.evidence]),
    h(Text, null, `Effort: ${effort}`)
  );
}

/** The setup commands of one source, then the name a command needs. */
type Detour = { source: SourceDescriptor; selected: number; naming: { command: string; input: InputState } | null };

function DetourView({ detour, height }: { detour: Detour; height: number }): ReactElement {
  const { naming, source, selected } = detour;
  if (naming !== null)
    return h(
      Box,
      { flexDirection: 'column' },
      h(Text, null, naming.command),
      h(Text, null, `Name: ${naming.input.text}▏`),
      h(Text, { dimColor: true }, 'Enter continue · Esc back')
    );
  const rows = source.setup.map((one): SelectorRow => ({
    id: one.command,
    label: one.command,
    value: one.command,
    ...(one.masked ? { detail: 'Asks for the value in a masked dialog.' } : {}),
  }));
  const state: SelectorState = {
    ...closedSelector,
    status: 'ready',
    overlayId: 'setup',
    rows,
    selectedId: rows[selected]?.id ?? null,
  };
  return h(
    Box,
    { flexDirection: 'column' },
    h(Text, null, `Set up ${source.label}`),
    h(SelectorView, { state, height }),
    h(Text, { dimColor: true }, '↑↓ select · Enter run · Esc back')
  );
}

export function ModelPicker({
  env,
  active,
  close,
  height: given,
}: {
  env: PickerEnv;
  active: boolean;
  close: () => void;
  /** the rows its list may take inside the command window */
  height?: number;
}): ReactElement {
  const { stdout } = useStdout();
  const height = given ?? Math.max(3, ((stdout as { rows?: number }).rows ?? 24) - 15);
  const [state, setState] = useState(() => openPicker(env.registry));
  const [detour, setDetour] = useState<Detour | null>(null);
  const latest = useRef(state);
  const closed = useRef(false);
  const named = useRef<string | null>(null);

  function dispatch(event: PickerEvent): void {
    if (closed.current) return;
    const step = pickerReduce(latest.current, event);
    latest.current = step.state;
    setState(step.state);
    for (const effect of step.effects) perform(effect);
  }

  function perform(effect: PickerEffect): void {
    switch (effect.kind) {
      case 'readSources':
        void env.read(effect.role).then(
          (read) => dispatch({ kind: 'sources', revision: effect.revision, read }),
          () => dispatch({ kind: 'sourcesFailed', revision: effect.revision, code: 'read-failed' })
        );
        return;
      case 'commit':
        void env.commit(effect.command).then(
          (answer) =>
            dispatch({
              kind: 'saved',
              revision: effect.revision,
              status: answer.status,
              code: answer.code ?? answer.status,
              text: answer.text,
            }),
          (error: unknown) =>
            dispatch({
              kind: 'saved',
              revision: effect.revision,
              status: 'failed',
              code: 'commit-failed',
              text: error instanceof Error ? error.message : 'The command failed.',
            })
        );
        return;
      case 'runSetup': {
        const command = effect.command.replace(NAME_PLACEHOLDER, named.current ?? NAME_PLACEHOLDER);
        void env.setup(command, effect.masked).then(
          (answer) =>
            dispatch(
              typeof answer === 'boolean'
                ? { kind: 'setupDone', ok: answer }
                : { kind: 'setupDone', ok: answer.ok, text: answer.text }
            ),
          (error: unknown) =>
            dispatch({
              kind: 'setupDone',
              ok: false,
              text: error instanceof Error ? error.message : 'The command failed.',
            })
        );
      }
    }
  }

  function runDetour(source: SourceDescriptor, command: string, name: string | null): void {
    named.current = name;
    setDetour(null);
    dispatch({ kind: 'setup', sourceId: source.id, command });
  }

  function detourKeys(open: Detour, typed: string, key: Parameters<Parameters<typeof useInput>[0]>[1]): void {
    const { naming, source, selected } = open;
    if (naming !== null) {
      const { text } = naming.input;
      const name = text.trim();
      if (key.escape) setDetour({ ...open, naming: null });
      else if (key.return && name !== '') runDetour(source, naming.command, name);
      else if (key.leftArrow) setDetour({ ...open, naming: { ...naming, input: moveCursor(naming.input, -1) } });
      else if (key.rightArrow) setDetour({ ...open, naming: { ...naming, input: moveCursor(naming.input, 1) } });
      else if (key.backspace || key.delete)
        setDetour({ ...open, naming: { ...naming, input: backspace(naming.input) } });
      else if (!key.ctrl && !key.meta && !key.return && typed !== '')
        setDetour({ ...open, naming: { ...naming, input: insert(naming.input, typed) } });
      return;
    }
    if (key.escape) setDetour(null);
    else if (key.upArrow) setDetour({ ...open, selected: Math.max(0, selected - 1) });
    else if (key.downArrow) setDetour({ ...open, selected: Math.min(source.setup.length - 1, selected + 1) });
    else if (key.return) {
      const chosen = source.setup[selected];
      const command = chosen?.command;
      if (command === undefined) return;
      if (command.includes(NAME_PLACEHOLDER)) setDetour({ ...open, naming: { command, input: emptyInput() } });
      else runDetour(source, command, null);
    }
  }

  function enter(): void {
    const now = latest.current;
    // Enter on `done` does nothing: the second press of a double Enter must not hide what was saved.
    if (now.step === 'done') return;
    if (now.step === 'review') dispatch({ kind: 'confirm' });
    else if (now.error !== null && now.read === null) dispatch({ kind: 'retry' });
    else if (now.highlightedId !== null) {
      const source = listedSources(now)?.find((one) => one.id === now.highlightedId);
      if (now.step === 'source' && source !== undefined && source.code !== 'ok' && source.setup.length > 0)
        setDetour({ source, selected: 0, naming: null });
      else dispatch({ kind: 'choose', id: now.highlightedId });
    }
  }

  function escape(): void {
    const now = latest.current;
    if (now.query !== '') dispatch({ kind: 'filter', query: '' });
    else if (now.step === 'group' || now.step === 'done') {
      closed.current = true;
      close();
    } else dispatch({ kind: 'back' });
  }

  useInput(
    (typed, key) => {
      if (closed.current || (key.ctrl && typed === 'c')) return;
      if (detour !== null) {
        detourKeys(detour, typed, key);
        return;
      }
      // A setup is running: its dialog and its answer come back through the chat.
      if (latest.current.detour !== null) return;
      if (key.escape) escape();
      else if (key.return) enter();
      else if (key.upArrow) dispatch({ kind: 'move', delta: -1 });
      else if (key.downArrow) dispatch({ kind: 'move', delta: 1 });
      else if (latest.current.step === 'review' || latest.current.step === 'saving' || latest.current.step === 'done')
        return;
      else if (key.backspace || key.delete)
        dispatch({ kind: 'filter', query: [...latest.current.query].slice(0, -1).join('') });
      else if (!key.ctrl && !key.meta && !key.tab && typed !== '')
        dispatch({ kind: 'filter', query: latest.current.query + typed });
    },
    { isActive: active }
  );

  const summary = state.step === 'review' || state.step === 'saving';
  const waiting = state.step === 'providerType' && state.read === null && state.error === null;
  return h(
    Box,
    // The command window's rule frames it, so it draws no border of its own.
    { flexDirection: 'column', paddingX: 1 },
    h(Text, { bold: true, color: 'cyan' }, `Model · ${STEP_TITLES[state.step]}`),
    detour !== null
      ? h(DetourView, { detour, height })
      : state.step === 'done'
        ? h(Text, { wrap: 'wrap' }, state.savedText ?? '')
        : summary
          ? h(ReviewLines, { state })
          : h(
              Box,
              { flexDirection: 'column' },
              h(FilterLine, { query: state.query }),
              h(SelectorView, { state: asSelector(state, waiting), height })
            ),
    state.error === null
      ? null
      : h(Text, { color: 'red', wrap: 'wrap' }, state.error.text ?? `It could not be read (${state.error.code}).`),
    detour !== null
      ? null
      : h(
          Text,
          { dimColor: true },
          state.step === 'review'
            ? 'Enter save · Esc back'
            : state.step === 'done'
              ? 'Esc close'
              : state.step === 'saving'
                ? 'Esc back'
                : state.error !== null && state.read === null
                  ? 'Enter try again · Esc back'
                  : '↑↓ select · type to filter · Enter choose · Esc back'
        )
  );
}
