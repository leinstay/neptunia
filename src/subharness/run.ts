// The one seam every agent run goes through: the errands of scout and server. It reads the
// agent's route from config.json (src/subharness/routing.ts) at the moment of the run, as Hermes' approval guard reads its mode on each check
// (hermes_cli/approval_mode.py), so a logout and "agent mode" act on the next run without a restart.
//
// An agent runs through the backend `models.agents.via` names for it. A run is refused with `subharness-off` while it
// names none, or when opencode is on a key that has left the store, with `bad-route` for a route that is not one, and with `not-installed` while the backend is not in `<private>/subharness/<backend>/` (src/subharness/place.ts),
// whose binary every run starts with that folder's home in its environment. Otherwise the agent's mode (src/subharness/control.ts) becomes the backend's sandbox. The child gets the host's PATH
// in every mode: the unit stops `sudo` in `read`, `write` and `full`, and the mode `sudo` lifts that (src/setup/units.ts).
// OpenCode gets one named key as OPENROUTER_API_KEY and nothing else key-like: the one it logged in with, or with a
// route the one the task brought (`routeKey`, a run without it fails `route-no-key`); codex and claude bring their own
// login and get no key. An opencode run that searches with exa gets `OPENCODE_ENABLE_EXA=1` and, when the task brought
// the stored Exa key (`searchKey`), that key as `EXA_API_KEY`. A run with a `route` (src/agent-runner/protocol.ts#TaskRoute) is the runner's: the core decided
// the backend, model, effort, mode and provider when it dispatched the task, because a runner unit may hide the private
// folder. Such a run uses exactly the route and opens neither config.json nor keys.json. A run in `full` or `sudo` writes one log line before it starts, with
// the agent and the mode and never the brief, so the log shows who worked without a sandbox. The child reaches the
// network through the engine proxy the caller decided (`proxy`, src/net/proxy.ts#proxyEnvOf): every proxy variable in
// the http form, or none at all on the direct path, whatever the caller's `env` or the host held. A step or output cap asked of a backend with no control for it (`backendLimits`: codex) is a gap too, so nobody reads
// the cap as enforced where only the timeout ends a run.

import { backendLimits, createInstalledBackend } from '../agent-runner/backend.ts';
import type { Backend, BackendResult, BackendRunOptions } from '../agent-runner/backend.ts';
import { profileOf } from '../agent-runner/profiles.ts';
import type { BackendName } from '../agent-runner/profiles.ts';
import { parseRoute } from '../agent-runner/protocol.ts';
import type { TaskRoute } from '../agent-runner/protocol.ts';
import { log } from '../log.ts';
import { backendOfAgent, modeOf } from './control.ts';
import type { AgentMode } from './control.ts';
import type { EffortLevel } from '../llm/roles.ts';
import { opencodeKey, readRouting } from './routing.ts';
import { modelOfBackend } from './place.ts';
import { PROXY_ENV_NAMES, proxyEnvOf } from '../net/proxy.ts';

/** One agent run. */
export type AgentRun = {
  /** The agent's name: scout or server; any other runs in `read`. */
  agent: string;
  /** the prompt text: the task alone */
  brief: string;
  /** the system instructions, which replace the backend's own (see `BackendRunOptions.system`); any length */
  system?: string;
  cwd: string;
  timeoutMs: number;
  /** The most model steps the run may take, where the backend has a control for it. */
  maxSteps?: number;
  /** The most output tokens per model answer, where the backend has a control for it. */
  maxOutputTokens?: number;
  /** codex: pictures handed to the agent */
  images?: ReadonlyArray<string>;
  signal?: AbortSignal;
  /** the path the core decided; with it the run reads nothing from the private folder */
  route?: TaskRoute;
  /** the key an opencode route spends; it comes with the task and is never read from keys.json */
  routeKey?: string;
  /** more of the child's environment; the PATH, the key and the proxy the engine sets win over it */
  env?: Readonly<Record<string, string>>;
  /** the engine proxy in force for this run; absent or null, the child gets no proxy variable */
  proxy?: string | null;
  /** the search provider of the run; `exa` switches OpenCode's own `websearch` on (Exa's free endpoint, no key) */
  searchProvider?: string | null;
  /** the Exa key of the run, the child's `EXA_API_KEY` on an opencode run whose search provider is `exa`, else unused */
  searchKey?: string;
  /** what the session map ties this run to: the task or the inspection */
  runId?: string;
};

/** What `runAgent` takes besides the run. */
export type RunDeps = {
  /** where config.json and keys.json are */
  privateDir: string;
  /** the environment whose PATH the child inherits; `process.env` by default */
  hostEnv?: Record<string, string | undefined>;
  /** a test's fake backends */
  backendFactory?: (name: BackendName) => Backend;
};

/** The sandbox a backend gets for `mode`: `none` for the modes without one. */
export function sandboxOfMode(mode: AgentMode): 'read-only' | 'workspace-write' | 'none' {
  if (mode === 'read') return 'read-only';
  if (mode === 'write') return 'workspace-write';
  return 'none';
}

/** The gap on a run that asked for a step cap its backend cannot enforce. */
const STEP_LIMIT_GAP = 'step-limit-not-enforced';
/** The gap on a run that asked for an output cap its backend cannot enforce. */
const OUTPUT_LIMIT_GAP = 'output-limit-not-enforced';

/** The caps `run` asked for that the backend `name` has no control for. */
function limitGaps(name: BackendName, run: AgentRun): Array<string> {
  const limits = backendLimits(name);
  return [
    ...(run.maxSteps !== undefined && !limits.steps.enforced ? [STEP_LIMIT_GAP] : []),
    ...(run.maxOutputTokens !== undefined && !limits.output.enforced ? [OUTPUT_LIMIT_GAP] : []),
  ];
}

/** `result` with `gaps` added, unchanged when there are none. */
const withGaps = (result: BackendResult, gaps: ReadonlyArray<string>): BackendResult =>
  gaps.length === 0 ? result : { ...result, gaps: [...(result.gaps ?? []), ...gaps] };

const off = (): BackendResult => ({ ok: false, text: '', exitCode: null, error: 'subharness-off' });

/** The environment of the child: the host's PATH and its key. */
function envOf(deps: RunDeps, keyValue: string | null): Record<string, string> {
  const host = deps.hostEnv ?? process.env;
  const env: Record<string, string> = {};
  if (host.PATH !== undefined) env.PATH = host.PATH;
  if (keyValue !== null) env.OPENROUTER_API_KEY = keyValue;
  return env;
}

/** The child's environment: the caller's without any proxy variable, then the engine's, then the run's proxy. */
function runEnvOf(run: AgentRun, engine: Record<string, string>): Record<string, string> {
  const given = Object.entries(run.env ?? {}).filter(([name]) => !PROXY_ENV_NAMES.includes(name));
  return { ...Object.fromEntries(given), ...engine, ...proxyEnvOf(run.proxy ?? null) };
}

/** The search variables of an opencode run that searches with exa: the switch, and the Exa key when the task brought one. */
function searchEnvOf(name: BackendName, run: AgentRun): Record<string, string> {
  if (name !== 'opencode' || run.searchProvider !== 'exa') return {};
  return run.searchKey === undefined || run.searchKey === ''
    ? { OPENCODE_ENABLE_EXA: '1' }
    : { OPENCODE_ENABLE_EXA: '1', EXA_API_KEY: run.searchKey };
}

/** The refusal of a run that cannot start, with the code and no child. */
const refusedRun = (error: 'bad-route' | 'route-no-key'): BackendResult => ({
  ok: false,
  text: '',
  exitCode: null,
  error,
});

/** What a run starts with once its path is settled. */
type Path = {
  name: BackendName;
  mode: AgentMode;
  model: string | null;
  effort: EffortLevel | null;
  keyValue: string | null;
  provider?: string;
};

/** The option that pins a run to a provider, empty where there is no pin. */
const pinOf = (provider: string | undefined): { provider?: string } => (provider === undefined ? {} : { provider });

/** The path of a run from config.json and, for opencode, its key from keys.json, or the refusal. */
function pathFromStore(run: AgentRun, deps: RunDeps): Path | BackendResult {
  let sub;
  let opencode;
  try {
    sub = readRouting(deps.privateDir).subharness;
    opencode = opencodeKey(deps.privateDir);
  } catch (err) {
    log.warn('subharness: config.json or keys.json unreadable, the run is refused', {
      agent: run.agent,
      reason: (err as Error).name,
    });
    return off();
  }
  const { models, efforts, providers } = sub;
  const name = backendOfAgent(sub, run.agent);
  const unit = profileOf(run.agent)?.unit;
  if (name === null || unit === undefined) return off();
  if (name === 'opencode' && opencode === null) return off();
  return {
    name,
    mode: modeOf(sub.modes, unit),
    model: Object.hasOwn(models, run.agent) ? (models[run.agent] ?? null) : null,
    effort: Object.hasOwn(efforts, run.agent) ? (efforts[run.agent] ?? null) : null,
    keyValue: name === 'opencode' ? (opencode?.value ?? '') : null,
    ...(Object.hasOwn(providers, run.agent) ? { provider: providers[run.agent] ?? '' } : {}),
  };
}

/** The path of a run from the route the task carried, or the refusal. */
function pathFromRoute(run: AgentRun, route: unknown): Path | BackendResult {
  const checked = parseRoute(route);
  if (checked === null) return refusedRun('bad-route');
  if (checked.backend !== 'opencode') return { ...checked, name: checked.backend, keyValue: null };
  if (run.routeKey === undefined || run.routeKey === '') return refusedRun('route-no-key');
  return { ...checked, name: checked.backend, keyValue: run.routeKey };
}

/**
 * Runs one agent through its backend, in the mode the owner gave it. With a route the path is the route's and
 * the private folder stays closed; without one it resolves `subharness-off` while config.json names no backend for the
 * agent.
 */
export async function runAgent(run: AgentRun, deps: RunDeps): Promise<BackendResult> {
  const settled = run.route === undefined ? pathFromStore(run, deps) : pathFromRoute(run, run.route);
  if ('ok' in settled) return settled;
  const { name, mode, model, effort, keyValue, provider } = settled;
  const env = runEnvOf(run, envOf(deps, keyValue));
  Object.assign(env, searchEnvOf(name, run));
  if (mode === 'full' || mode === 'sudo') log.info('subharness: run without a sandbox', { agent: run.agent, mode });
  const options: BackendRunOptions = {
    cwd: run.cwd,
    timeoutMs: run.timeoutMs,
    sandbox: sandboxOfMode(mode),
    env,
    ...(model === null ? {} : { model: modelOfBackend(name, model) }),
    ...(effort === null ? {} : { effort }),
    ...pinOf(provider),
    ...(run.maxSteps === undefined ? {} : { maxSteps: run.maxSteps }),
    ...(run.maxOutputTokens === undefined ? {} : { maxOutputTokens: run.maxOutputTokens }),
    ...(run.images === undefined ? {} : { images: run.images }),
    ...(run.signal === undefined ? {} : { signal: run.signal }),
    ...(run.system === undefined ? {} : { system: run.system }),
  };
  const backend = deps.backendFactory?.(name) ?? createInstalledBackend(name, deps.privateDir);
  const gaps = limitGaps(name, run);
  if (gaps.length > 0)
    log.info('subharness: a cap has no control on this backend', { agent: run.agent, backend: name, gaps });
  return withGaps(await backend.run(run.brief, options), gaps);
}
