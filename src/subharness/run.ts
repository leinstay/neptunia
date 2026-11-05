// The one seam every agent run goes through: errands (scout and server), development and the watcher. It reads
// keys.json at the moment of the run, as Hermes' approval guard reads its mode on each check
// (hermes_cli/approval_mode.py), so "subharness disable" and "subharness mode" act on the next run without a restart.
//
// An agent runs through the backend `subharness.uses` names for it, else through the first connected one. A run is
// refused with `subharness-off` while no backend is connected, when the named backend is not connected, or when
// opencode is on a key that has left the store, with `bad-route` for a route that is not one, and with `not-installed` while the backend is not in `<private>/subharness/<backend>/` (src/subharness/place.ts),
// whose binary every run starts with that folder's home in its environment. Otherwise the agent's mode (src/subharness/control.ts) becomes the backend's sandbox, and the child gets a
// PATH on which `sudo` refuses unless the mode is `sudo`: a stand-in named `sudo` in a folder of its own comes first.
// OpenCode gets one extra key as OPENROUTER_API_KEY and nothing else key-like: the one it was enabled with, or with a
// route the one the task brought (`routeKey`, a run without it fails `route-no-key`); codex and claude bring their own
// login and get no key. A run with a `route` (src/agent-runner/protocol.ts#TaskRoute) is the runner's: the core decided
// the backend, model, effort and mode when it dispatched the task, because a runner unit may hide keys.json. Such a
// run uses exactly the route and never opens keys.json. A run in `full` or `sudo` writes one log line before it starts, with
// the agent and the mode and never the brief, so the log shows who worked without a sandbox. A claude whose `--help` lists
// `--session-id` gets a fresh one on each run, and src/subharness/sessions.ts maps it to the agent and the run, so the
// watcher can tell whose transcript it reads. A map that cannot be written is a gap on the result, never a stopped run.
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
import { hasExtraKey, readKeys } from '../keys/file.ts';
import { helpOfInstalled, isInstalled } from './place.ts';
import { recordSession } from './sessions.ts';

/** One agent run. */
export type AgentRun = {
  /** The agent's name: scout, server, dev or watcher; any other runs in `read`. */
  agent: string;
  brief: string;
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
  /** the path the core decided; with it the run reads nothing from keys.json */
  route?: TaskRoute;
  /** the key an opencode route spends; it comes with the task and is never read from keys.json */
  routeKey?: string;
  /** more of the child's environment; the PATH with its refusing `sudo` and the key the engine sets win over it */
  env?: Readonly<Record<string, string>>;
  /** what the session map ties this run to: the task or the inspection */
  runId?: string;
};

/** What `runAgent` takes besides the run. */
export type RunDeps = {
  /** where keys.json is */
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
  '#!/bin/sh\necho "sudo: refused, this agent runs without sudo (the owner sets it: subharness mode)" >&2\nexit 1\n';

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

/** The environment of the child: its PATH (a refusing `sudo` first unless the mode is `sudo`) and the key OpenCode gets. */
function envOf(deps: RunDeps, mode: AgentMode, keyValue: string | null): Record<string, string> {
  const host = deps.hostEnv ?? process.env;
  const env: Record<string, string> = {};
  if (mode === 'sudo') {
    if (host.PATH !== undefined) env.PATH = host.PATH;
  } else {
    ensureStandIn(deps.denyDir);
    env.PATH = host.PATH === undefined || host.PATH === '' ? deps.denyDir : `${deps.denyDir}:${host.PATH}`;
  }
  if (keyValue !== null) env.OPENROUTER_API_KEY = keyValue;
  return env;
}

/** opencode has no step flag: its agent's `steps` comes in through its inline config. */
function opencodeSteps(maxSteps: number): Record<string, string> {
  return { OPENCODE_CONFIG_CONTENT: JSON.stringify({ agent: { build: { steps: maxSteps } } }) };
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
};

/** The path of a run from keys.json, or the refusal. */
function pathFromStore(run: AgentRun, deps: RunDeps): Path | BackendResult {
  let store;
  try {
    store = readKeys(deps.privateDir);
  } catch (err) {
    log.warn('subharness: keys.json unreadable, the run is refused', {
      agent: run.agent,
      reason: (err as Error).message,
    });
    return off();
  }
  const { key, models, efforts } = store.subharness;
  const name = backendOfAgent(store.subharness, run.agent);
  if (name === null) return off();
  if (name === 'opencode' && (key === null || !hasExtraKey(store, key))) return off();
  return {
    name,
    mode: modeOf(store.subharness.modes, run.agent),
    model: Object.hasOwn(models, run.agent) ? (models[run.agent] ?? null) : null,
    effort: Object.hasOwn(efforts, run.agent) ? (efforts[run.agent] ?? null) : null,
    keyValue: name === 'opencode' && key !== null ? (store.extra[key] ?? '') : null,
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
    log.warn('subharness: the session map could not be written', { agent: run.agent, code: (error as Error).name });
    return false;
  }
}

/**
 * Runs one agent through its backend, in the mode the owner gave it. With a route the path is the route's and
 * keys.json stays closed; without one it resolves `subharness-off` while keys.json connects no backend for the agent.
 */
export async function runAgent(run: AgentRun, deps: RunDeps): Promise<BackendResult> {
  const settled = run.route === undefined ? pathFromStore(run, deps) : pathFromRoute(run, run.route);
  if ('ok' in settled) return settled;
  const { name, mode, model, effort, keyValue } = settled;
  const env = { ...run.env, ...envOf(deps, mode, keyValue) };
  if (mode === 'full' || mode === 'sudo') log.info('subharness: run without a sandbox', { agent: run.agent, mode });
  const options: BackendRunOptions = {
    cwd: run.cwd,
    timeoutMs: run.timeoutMs,
    sandbox: sandboxOfMode(mode),
    env: name === 'opencode' && run.maxSteps !== undefined ? { ...env, ...opencodeSteps(run.maxSteps) } : env,
    ...(model === null ? {} : { model }),
    ...(effort === null ? {} : { effort }),
    ...(run.maxSteps === undefined ? {} : { maxSteps: run.maxSteps }),
    ...(run.maxOutputTokens === undefined ? {} : { maxOutputTokens: run.maxOutputTokens }),
    ...(run.search === undefined ? {} : { search: run.search }),
    ...(run.tools === undefined ? {} : { tools: run.tools }),
    ...(run.images === undefined ? {} : { images: run.images }),
    ...(run.signal === undefined ? {} : { signal: run.signal }),
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
