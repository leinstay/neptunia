// The owner's settings of the subharness roles: the source, model and effort each agent runs on, and the mode of each
// unit, which every agent of the unit runs in.
// A source is a backend that is installed and logged in (src/subharness/sources.ts); it has no switch of its own, and its
// account commands are src/subharness/account.ts. Everything is stored under `models.agents` of config.json
// (src/subharness/routing.ts) and read again at each use, so a change needs no restart. The shape follows the approval mode of Hermes (hermes_cli/approval_mode.py): a
// tuple of modes, a frozen result with `ok`, `changed` and a message, no argument inspects, and the one write of each
// change is in this file. No result, log line or status text carries a key value, only a key's name.

import type { BackendResult } from '../agent-runner/backend.ts';
import { isProviderSlug } from '../agent-runner/protocol.ts';
import type { TaskRoute } from '../agent-runner/protocol.ts';
import { BACKEND_NAMES, UNITS, agentNames, isAgentName, profileOf } from '../agent-runner/profiles.ts';
import type { BackendName, UnitName } from '../agent-runner/profiles.ts';
import { EFFORT_LEVELS, isListedEffort } from '../llm/roles.ts';
import type { EffortLevel } from '../llm/roles.ts';
import { readRouting, updateRouting } from './routing.ts';
import type { Routing } from './routing.ts';
import { readKeys } from '../keys/file.ts';
import { BACKEND_EFFORTS } from './models.ts';
import { modelOfBackend } from './place.ts';
import { routeName, routeNamesText } from './route-names.ts';
import { checkedSelection } from './selection.ts';
import { sourceState } from './sources.ts';
import type { SourceState } from './sources.ts';

/** What an agent may do, from the narrowest: see run.ts#sandboxOfMode for the sandbox each maps to. */
export const AGENT_MODES = ['read', 'write', 'full', 'sudo'] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

/** The model roles that have no subharness path: their requests run on the direct path alone. */
export const DIRECT_ONLY_ROLES = ['analyzer', 'embedding', 'vision', 'video', 'speech', 'drawing'] as const;

/** The mode of a unit the owner has not set. Nobody starts without a sandbox. */
const DEFAULT_MODES: Readonly<Record<UnitName, AgentMode>> = {
  server: 'read',
  scout: 'write',
  code: 'write',
};

/** The effort word that drops the stored level, so the agent runs at its model's default. */
const DEFAULT_EFFORT = 'default';

/** How long the reply check of codex or claude may run (ms). */
export const REPLY_CHECK_MS = 120_000;

/** The outcome of one change: `code` is `ok` on success, else why it was refused. */
export type SubharnessResult = { ok: boolean; code: string; changed: boolean; message: string };

/** What the owner sees: every source as it stands, the name of opencode's key and every unit's mode. */
export type SubharnessView = {
  sources: Array<SourceState>;
  key: string | null;
  modes: Record<UnitName, AgentMode>;
};

/** What a model selection takes: the checks of src/subharness/selection.ts and the unit hook of a mode change. */
export type EnableDeps = {
  privateDir: string;
  /** One minimal run of codex or claude, `effort` passed as BackendRunOptions.effort; resolves, never rejects. */
  runBackend(name: 'codex' | 'claude', brief: string, model?: string, effort?: EffortLevel): Promise<BackendResult>;
  fetch: typeof fetch;
  baseUrl?: string;
  /**
   * Called after a mode changed: puts the new mode into the unit's systemd unit (src/setup/mode-unit.ts). It answers
   * a line for the owner, or null when nothing was rendered.
   */
  applyMode?(unit: UnitName, mode: AgentMode): Promise<string | null>;
};

const done = (message: string, changed = true): SubharnessResult => ({ ok: true, code: 'ok', changed, message });
const refused = (code: string, message: string): SubharnessResult => ({ ok: false, code, changed: false, message });

const isMode = (value: unknown): value is AgentMode => AGENT_MODES.some((mode) => mode === value);
const isUnit = (value: unknown): value is UnitName => UNITS.some((unit) => unit === value);

/** The mode of `unit` among the stored `modes`: the stored one when it is a mode, else the unit's default. */
export function modeOf(modes: Readonly<Record<string, string>>, unit: UnitName): AgentMode {
  const stored = Object.hasOwn(modes, unit) ? modes[unit] : undefined;
  return isMode(stored) ? stored : DEFAULT_MODES[unit];
}

/** The subharness as config.json and the installed sources hold it now. Runs each CLI's status command, no model. */
export async function subharnessView(privateDir: string): Promise<SubharnessView> {
  const stored = readRouting(privateDir).subharness;
  const modes = Object.fromEntries(UNITS.map((unit) => [unit, modeOf(stored.modes, unit)])) as Record<
    UnitName,
    AgentMode
  >;
  const sources = await Promise.all(BACKEND_NAMES.map((backend) => sourceState(privateDir, backend)));
  return { sources, key: stored.key, modes };
}

/** The refusal of a name that is no agent: its own code for a model role that runs on the direct path alone. */
function notAnAgent(name: string): SubharnessResult {
  if (DIRECT_ONLY_ROLES.some((role) => role === name))
    return refused('no-subharness-path', `${name} has no subharness path; its requests run on the direct path alone`);
  return refused('unknown-agent', `${name} is no agent; use ${agentNames().join(', ')}`);
}

/** What a stored route of `agent` is, for telling whether it moved while a check ran. */
const routeText = (store: Routing, agent: string): string => {
  const { uses, models, efforts, providers } = store.subharness;
  return JSON.stringify([uses[agent] ?? null, models[agent] ?? null, efforts[agent] ?? null, providers[agent] ?? null]);
};

/** The refusal of a provider that is no slug, or null. */
function badProvider(provider: string | undefined): SubharnessResult | null {
  if (provider === undefined || isProviderSlug(provider)) return null;
  return refused('bad-provider', 'a provider is lower case letters, digits and hyphens, as in amazon-bedrock');
}

/** The refusal of a provider asked of a backend other than opencode, or null. */
function providerUnsupported(provider: string | undefined, backend: BackendName): SubharnessResult | null {
  if (provider === undefined || backend === 'opencode') return null;
  return refused(
    'provider-unsupported',
    `${routeName(backend)} has no provider control; only ${routeName('opencode')} takes --provider`
  );
}

/** The stored providers with `agent`'s entry replaced by `provider`, or dropped when there is none. */
function pinnedTo(
  stored: Readonly<Record<string, string>>,
  agent: string,
  provider: string | undefined
): Record<string, string> {
  const others = Object.fromEntries(Object.entries(stored).filter(([role]) => role !== agent));
  return provider === undefined ? others : { ...others, [agent]: provider };
}

/**
 * Sets the source, the model and the effort of one agent in one write, after one reply from that model at that effort
 * through that source. `via` absent keeps the source in force. An effort that is not given stays while the source stays,
 * and goes with a source that changes, because no reply checked it there, and `default` drops it. A level past
 * EFFORT_LEVELS is taken only from a backend whose help lists it. The key of opencode is the stored one. A `provider`
 * pins an opencode agent to that OpenRouter provider alone, with no fallback, and the check goes out through it too;
 * claude and codex refuse it as `provider-unsupported`. A selection with no `provider` drops the one stored for the agent,
 * as a move to claude or codex does, because no reply checked it on the new model.
 */
export async function setAgentModel(
  deps: EnableDeps,
  agent: string,
  typed: string,
  effort?: string,
  via?: string,
  provider?: string
): Promise<SubharnessResult> {
  if (!isAgentName(agent)) return notAnAgent(agent);
  const badSlug = badProvider(provider);
  if (badSlug !== null) return badSlug;
  const level = effort === DEFAULT_EFFORT ? undefined : effort;
  const noEffort = (word: string, levels: ReadonlyArray<EffortLevel> = EFFORT_LEVELS): SubharnessResult =>
    refused('unknown-effort', `${word} is no effort here; use ${levels.join(', ')}`);
  if (level !== undefined && !isListedEffort(level)) return noEffort(level);
  const store = readRouting(deps.privateDir);
  const current = backendOfAgent(store.subharness, agent);
  const backend = via === undefined ? current : BACKEND_NAMES.find((one) => one === via);
  if (backend === undefined)
    return refused('unknown-backend', `${via ?? ''} is no backend; use ${routeNamesText(BACKEND_NAMES)}`);
  const takes: ReadonlyArray<EffortLevel> = backend === null ? EFFORT_LEVELS : BACKEND_EFFORTS[backend];
  if (level !== undefined && !takes.includes(level)) return noEffort(level, takes);
  if (backend === null)
    return refused('subharness-off', `${agent} has no source yet: /model set ${agent} <model> --via <route>`);
  const unsupported = providerUnsupported(provider, backend);
  if (unsupported !== null) return unsupported;
  const { key } = store.subharness;
  const value = key === null ? '' : (readKeys(deps.privateDir).keys[key] ?? '');
  const model = modelOfBackend(backend, typed);
  return checkedSelection(
    deps,
    {
      claim: agent,
      backend,
      keyValue: value,
      model,
      ...(level === undefined ? {} : { effort: level }),
      ...(provider === undefined ? {} : { provider }),
    },
    () => routeText(readRouting(deps.privateDir), agent),
    () => {
      updateRouting(deps.privateDir, (fresh) => {
        const { efforts, uses } = fresh.subharness;
        const kept =
          backend === uses[agent] && effort !== DEFAULT_EFFORT
            ? efforts
            : Object.fromEntries(Object.entries(efforts).filter(([role]) => role !== agent));
        return {
          ...fresh,
          subharness: {
            ...fresh.subharness,
            providers: pinnedTo(fresh.subharness.providers, agent, provider),
            uses: { ...fresh.subharness.uses, [agent]: backend },
            models: { ...fresh.subharness.models, [agent]: model },
            efforts: level === undefined ? kept : { ...kept, [agent]: level },
          },
        };
      });
      const at = level === undefined ? '' : ` at ${level} effort`;
      const pin = provider === undefined ? '' : `, pinned to ${provider} alone`;
      return done(`${agent} runs through ${routeName(backend)} on ${model}${at}${pin} from its next run`);
    }
  );
}

/** The backend `agent` runs through: the one `uses` names for it, null when it names none. */
export function backendOfAgent(
  stored: Readonly<{ uses: Readonly<Record<string, BackendName>> }>,
  agent: string
): BackendName | null {
  return Object.hasOwn(stored.uses, agent) ? (stored.uses[agent] ?? null) : null;
}

/**
 * The path the core puts inside a task for `agent`: the backend it runs through, its model and effort (null where the
 * owner set none), the mode of its unit and the provider it is pinned to (absent where none), as config.json holds them now. Null while the agent has no source; a source that is
 * gone from the machine fails the run with `not-installed`, where a runner can see it. Throws when config.json cannot be
 * read.
 */
export function routeOfAgent(privateDir: string, agent: string): TaskRoute | null {
  const stored = readRouting(privateDir).subharness;
  const backend = backendOfAgent(stored, agent);
  const unit = profileOf(agent)?.unit;
  if (backend === null || unit === undefined) return null;
  return {
    backend,
    model: Object.hasOwn(stored.models, agent) ? (stored.models[agent] ?? null) : null,
    effort: Object.hasOwn(stored.efforts, agent) ? (stored.efforts[agent] ?? null) : null,
    mode: modeOf(stored.modes, unit),
    ...(Object.hasOwn(stored.providers, agent) ? { provider: stored.providers[agent] ?? '' } : {}),
  };
}

/** Sets the mode of one unit, or with no `mode` reports the current one and writes nothing. */
export function setUnitMode(
  privateDir: string,
  unit: string,
  mode?: string
): Promise<SubharnessResult & { mode: AgentMode | null }> {
  if (!isUnit(unit))
    return Promise.resolve({
      ...refused('unknown-unit', `${unit} is no unit; use ${UNITS.join(', ')}`),
      mode: null,
    });
  const current = modeOf(readRouting(privateDir).subharness.modes, unit);
  if (mode === undefined) return Promise.resolve({ ...done(`${unit} runs in ${current}`, false), mode: current });
  if (!isMode(mode))
    return Promise.resolve({
      ...refused('unknown-mode', `${mode} is no mode; use ${AGENT_MODES.join(', ')}`),
      mode: null,
    });
  if (mode === current) return Promise.resolve({ ...done(`${unit} runs in ${mode} already`, false), mode });
  updateRouting(privateDir, (store) => ({
    ...store,
    subharness: { ...store.subharness, modes: { ...store.subharness.modes, [unit]: mode } },
  }));
  return Promise.resolve({ ...done(`${unit} runs in ${mode} from its next run`), mode });
}

/** The line of one source: whether it can run, its key's name for opencode, and who enforces `read` and `write` under it. */
function sourceLine(view: SubharnessView, state: SourceState): string {
  const name = state.backend;
  const key = name === 'opencode' && view.key !== null ? `, key ${view.key}` : '';
  if (state.code === 'not-installed') return `  ${name}: not installed`;
  if (state.code === 'not-logged-in') return `  ${name}: installed, not logged in${key}`;
  const held =
    name === 'codex'
      ? 'read and write enforced by its sandbox and by the unit'
      : 'read and write held by the systemd unit alone, no sandbox flags';
  return `  ${name}: logged in${key}: ${held}`;
}

/** The path of one agent: the backend it runs through (null when it names none), its model, its effort and its pinned provider. */
export type AgentPath = {
  agent: string;
  unit: UnitName;
  backend: BackendName | null;
  model: string | null;
  effort: EffortLevel | null;
  provider?: string;
};

/** Each agent's path as config.json holds it now. */
export function agentPaths(privateDir: string): Array<AgentPath> {
  const stored = readRouting(privateDir).subharness;
  return agentNames().flatMap((agent) => {
    const unit = profileOf(agent)?.unit;
    return unit === undefined ? [] : [{ agent, unit, ...pathOf(stored, agent) }];
  });
}

/** The backend, model, effort and pinned provider of `agent` as `stored` holds them. */
function pathOf(stored: Routing['subharness'], agent: string): Omit<AgentPath, 'agent' | 'unit'> {
  return {
    backend: backendOfAgent(stored, agent),
    model: stored.models[agent] ?? null,
    effort: stored.efforts[agent] ?? null,
    ...(Object.hasOwn(stored.providers, agent) ? { provider: stored.providers[agent] ?? '' } : {}),
  };
}

/**
 * The status the owner reads: every source as it stands, with its key's name, then every agent with its mode, its source,
 * its model, its effort and its provider where one is pinned. A source that cannot run stays on the row of the agent that chose it, marked unavailable. No
 * key value.
 */
export function statusText(view: SubharnessView, paths: ReadonlyArray<AgentPath>): string {
  const rows = paths.map((path) => {
    const state = view.sources.find((one) => one.backend === path.backend);
    const mark = state === undefined || state.available ? '' : '  unavailable';
    const model = path.model ?? 'default';
    const effort = path.effort ?? 'default';
    const pin = path.provider === undefined ? '' : `  provider ${path.provider}`;
    return `  ${path.agent}  ${path.unit} ${view.modes[path.unit]}  ${path.backend === null ? 'none' : routeName(path.backend)}${mark}  model ${model}  effort ${effort}${pin}`;
  });
  return ['subharness:', ...view.sources.map((state) => sourceLine(view, state)), 'modes:', ...rows].join('\n');
}
