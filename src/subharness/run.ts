// The one seam every agent run goes through: errands (scout and server), development and the watcher. It reads
// keys.json at the moment of the run, as Hermes' approval guard reads its mode on each check
// (hermes_cli/approval_mode.py), so "subharness disable" and "subharness mode" act on the next run without a restart.
//
// An agent runs through the backend `subharness.uses` names for it, else through the first connected one. A run is
// refused with `subharness-off` while no backend is connected, when the named backend is not connected, or when
// opencode is on a key that has left the store, and with `not-installed` while the backend is not in `<private>/subharness/<backend>/` (src/subharness/place.ts),
// whose binary every run starts with that folder's home in its environment. Otherwise the agent's mode (src/subharness/control.ts) becomes the backend's sandbox, and the child gets a
// PATH on which `sudo` refuses unless the mode is `sudo`: a stand-in named `sudo` in a folder of its own comes first.
// OpenCode gets the one extra key it was enabled with as OPENROUTER_API_KEY and nothing else key-like; codex and
// claude bring their own login and get no key. A run in `full` or `sudo` writes one log line before it starts, with
// the agent and the mode and never the brief, so the log shows who worked without a sandbox.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInstalledBackend } from '../agent-runner/backend.ts';
import type { Backend, BackendResult, BackendRunOptions } from '../agent-runner/backend.ts';
import type { BackendName } from '../agent-runner/profiles.ts';
import { log } from '../log.ts';
import { backendOfAgent, modeOf } from './control.ts';
import type { AgentMode } from './control.ts';
import { hasExtraKey, readKeys } from '../keys/file.ts';

/** One agent run. */
export type AgentRun = {
  /** The agent's name: scout, server, dev or watcher; any other runs in `read`. */
  agent: string;
  brief: string;
  cwd: string;
  timeoutMs: number;
  /** codex: live web search */
  search?: boolean;
  /** codex: pictures handed to the agent */
  images?: ReadonlyArray<string>;
  signal?: AbortSignal;
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

/** Runs one agent through its backend, in the mode the owner gave it. Resolves with `subharness-off` while it has none. */
export async function runAgent(run: AgentRun, deps: RunDeps): Promise<BackendResult> {
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
  const { key, models } = store.subharness;
  const name = backendOfAgent(store.subharness, run.agent);
  if (name === null) return off();
  if (name === 'opencode' && (key === null || !hasExtraKey(store, key))) return off();
  const mode = modeOf(store.subharness.modes, run.agent);
  const keyValue = name === 'opencode' && key !== null ? (store.extra[key] ?? '') : null;
  const env = envOf(deps, mode, keyValue);
  if (mode === 'full' || mode === 'sudo') log.info('subharness: run without a sandbox', { agent: run.agent, mode });
  const options: BackendRunOptions = {
    cwd: run.cwd,
    timeoutMs: run.timeoutMs,
    sandbox: sandboxOfMode(mode),
    env,
    ...(Object.hasOwn(models, run.agent) ? { model: models[run.agent] } : {}),
    ...(run.search === undefined ? {} : { search: run.search }),
    ...(run.images === undefined ? {} : { images: run.images }),
    ...(run.signal === undefined ? {} : { signal: run.signal }),
  };
  const backend = deps.backendFactory?.(name) ?? createInstalledBackend(name, deps.privateDir);
  return backend.run(run.brief, options);
}
