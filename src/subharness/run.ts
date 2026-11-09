// The one seam every agent run goes through: errands (scout and server), development and the watcher. It reads the
// agent's route from config.json (src/subharness/routing.ts) at the moment of the run, as Hermes' approval guard reads its mode on each check
// (hermes_cli/approval_mode.py), so a logout and "agent mode" act on the next run without a restart.
//
// An agent runs through the backend `models.agents.via` names for it. A run is refused with `subharness-off` while it
// names none, or when opencode is on a key that has left the store, with `bad-route` for a route that is not one, and with `not-installed` while the backend is not in `<private>/subharness/<backend>/` (src/subharness/place.ts),
// whose binary every run starts with that folder's home in its environment. Otherwise the agent's mode (src/subharness/control.ts) becomes the backend's sandbox, and the child gets a
// PATH on which `sudo` refuses unless the mode is `sudo`: a stand-in named `sudo` in a folder of its own comes first.
// OpenCode gets one named key as OPENROUTER_API_KEY and nothing else key-like: the one it logged in with, or with a
// route the one the task brought (`routeKey`, a run without it fails `route-no-key`); codex and claude bring their own
// login and get no key. An opencode run that searches with exa gets `OPENCODE_ENABLE_EXA=1` and, when the task brought
// the stored Exa key (`searchKey`), that key as `EXA_API_KEY`. A run with a `route` (src/agent-runner/protocol.ts#TaskRoute) is the runner's: the core decided
// the backend, model, effort, mode and provider when it dispatched the task, because a runner unit may hide the private
// folder. Such a run uses exactly the route and opens neither config.json nor keys.json. A run in `full` or `sudo` writes one log line before it starts, with
// the agent and the mode and never the brief, so the log shows who worked without a sandbox. A claude whose `--help` lists
// `--session-id` gets a fresh one on each run, and src/subharness/sessions.ts maps it to the agent and the run, so the
// watcher can tell whose transcript it reads. The child reaches the network through the engine proxy the caller decided
// (`proxy`, src/net/proxy.ts#proxyEnvOf): every proxy variable in the http form, or none at all on the direct path,
// whatever the caller's `env` or the host held. A map that cannot be written is a gap on the result, never a stopped run.
// A step or output cap asked of a backend with no control for it (`backendLimits`: codex) is a gap too, so nobody reads
// the cap as enforced where only the timeout ends a run.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backendLimits, createInstalledBackend } from '../agent-runner/backend.ts';
import type { Backend, BackendResult, BackendRunOptions } from '../agent-runner/backend.ts';
import type { BackendName } from '../agent-runner/profiles.ts';
import { parseRoute } from '../agent-runner/protocol.ts';
import type { TaskRoute } from '../agent-runner/protocol.ts';
import { log } from '../log.ts';
import { backendOfAgent, modeOf } from './control.ts';
import type { AgentMode } from './control.ts';
import type { EffortLevel } from '../llm/roles.ts';
import { opencodeKey, readRouting } from './routing.ts';
import { helpOfInstalled, isInstalled, modelOfBackend } from './place.ts';
import { recordSession } from './sessions.ts';
import { PROXY_ENV_NAMES, proxyEnvOf } from '../net/proxy.ts';

/** One agent run. */
export type AgentRun = {
  /** The agent's name: scout, server, dev or watcher; any other runs in `read`. */
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
  /** codex: live web search */
  search?: boolean;
  /** The profile's OpenCode tool names; claude turns them into its own tool list. Absent for an agent with no profile tools. */
  tools?: ReadonlyArray<string>;
  /** codex: pictures handed to the agent */
  images?: ReadonlyArray<string>;
  signal?: AbortSignal;
  /** the path the core decided; with it the run reads nothing from the private folder */
  route?: TaskRoute;
  /** the key an opencode route spends; it comes with the task and is never read from keys.json */
  routeKey?: string;
  /** more of the child's environment; the PATH with its refusing `sudo`, the key and the proxy the engine sets win over it */
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
  /** the folder that holds the `sudo` stand-in; created at the first run that needs it */
  denyDir: string;
  /** the environment whose PATH the child inherits; `process.env` by default */
  hostEnv?: Record<string, string | undefined>;
  /** a test's fake backends */
  backendFactory?: (name: BackendName) => Backend;
};

/** The folder of the `sudo` stand-in by default: one per user, in the temporary folder of the process. */
export function defaultDenyDir(): string {
  return path.join(os.tmpdir(), `neptunia-nosudo-${process.getuid?.() ?? 'user'}`);
}

/** The sandbox a backend gets for `mode`: `none` for the modes without one. */
export function sandboxOfMode(mode: AgentMode): 'read-only' | 'workspace-write' | 'none' {
  if (mode === 'read') return 'read-only';
  if (mode === 'write') return 'workspace-write';
  return 'none';
}

/** The gap on a run whose session id reached no map. */
export const SESSION_MAP_GAP = 'session-map-write-failed';
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

const SUDO_STAND_IN =
  '#!/bin/sh\necho "sudo: refused, this agent runs without sudo (the owner sets it: agent mode)" >&2\nexit 1\n';

/** Writes the `sudo` stand-in into `dir` when it is missing or different. */
function ensureStandIn(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'sudo');
  let current = '';
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch {
    // not there yet
  }
  if (current !== SUDO_STAND_IN) fs.writeFileSync(file, SUDO_STAND_IN, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
}

const off = (): BackendResult => ({ ok: false, text: '', exitCode: null, error: 'subharness-off' });

/** The environment of the child: its PATH (a refusing `sudo` first unless the mode is `sudo`) and its key. */
function envOf(deps: RunDeps, mode: AgentMode, keyValue: string | null): Record<string, string> {
  const host = deps.hostEnv ?? process.env;
  const env: Record<string, string> = {};
  const hostPath = host.PATH === undefined || host.PATH === '' ? [] : [host.PATH];
  if (mode === 'sudo') {
    if (host.PATH !== undefined) env.PATH = hostPath.join(':');
  } else {
    ensureStandIn(deps.denyDir);
    env.PATH = [deps.denyDir, ...hostPath].join(':');
  }
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
  if (name === null) return off();
  if (name === 'opencode' && opencode === null) return off();
  return {
    name,
    mode: modeOf(sub.modes, run.agent),
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

/** The session id a run of `name` starts with: a claude whose help lists the flag gets one, anything else none. */
async function sessionIdOf(name: BackendName, deps: RunDeps): Promise<string | undefined> {
  if (name !== 'claude' || !isInstalled(deps.privateDir, name)) return undefined;
  try {
    return /(?:^|\s)--session-id\b/.test(await helpOfInstalled(deps.privateDir, name)) ? randomUUID() : undefined;
  } catch {
    return undefined;
  }
}

/** The run on the session map; false when the map could not be written. */
function mapped(run: AgentRun, deps: RunDeps, name: BackendName, sessionId: string): boolean {
  try {
    recordSession(deps.privateDir, {
      sessionId,
      agent: run.agent,
      backend: name,
      runId: run.runId ?? null,
      at: Date.now(),
    });
    return true;
  } catch (error) {
    log.warn('subharness: the session map could not be written', {
      agent: run.agent,
      code: (error as NodeJS.ErrnoException).code ?? (error as Error).name,
    });
    return false;
  }
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
  const env = runEnvOf(run, envOf(deps, mode, keyValue));
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
    ...(run.search === undefined ? {} : { search: run.search }),
    ...(run.tools === undefined ? {} : { tools: run.tools }),
    ...(run.images === undefined ? {} : { images: run.images }),
    ...(run.signal === undefined ? {} : { signal: run.signal }),
    ...(run.system === undefined ? {} : { system: run.system }),
  };
  const backend = deps.backendFactory?.(name) ?? createInstalledBackend(name, deps.privateDir);
  const sessionId = await sessionIdOf(name, deps);
  const gaps = limitGaps(name, run);
  if (gaps.length > 0)
    log.info('subharness: a cap has no control on this backend', { agent: run.agent, backend: name, gaps });
  if (sessionId === undefined) return withGaps(await backend.run(run.brief, options), gaps);
  const onMap = mapped(run, deps, name, sessionId);
  const done = await backend.run(run.brief, { ...options, sessionId });
  return withGaps({ ...done, sessionId }, onMap ? gaps : [SESSION_MAP_GAP, ...gaps]);
}
