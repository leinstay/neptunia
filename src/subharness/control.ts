// The owner's switch of the subharness: which backends are connected, the key opencode runs on, and the mode of each
// agent. Enable adds one backend to the list after its check, disable removes one; an agent runs through the backend
// `subharness.uses` names for it, else through the first connected one (src/subharness/run.ts).
// Everything is stored in keys.json (src/keys/file.ts) and read again at each use, so a change needs no
// restart. The shape follows the approval mode of Hermes (hermes_cli/approval_mode.py): a tuple of modes, a frozen
// result with `ok`, `changed` and a message, no argument inspects, and the one write of each change is in this file.
// Enabling checks the backend installed in the private layer (src/subharness/place.ts) first and stores nothing when
// the check fails. No result, log line or status text carries a key value, only a key's name.

import type { BackendResult } from '../agent-runner/backend.ts';
import { BACKEND_NAMES } from '../agent-runner/profiles.ts';
import type { BackendName } from '../agent-runner/profiles.ts';
import { log } from '../log.ts';
import { hasExtraKey, readKeys, writeKeys } from '../keys/file.ts';
import { checkModel } from './models.ts';
import { subharnessPlace } from './place.ts';

/** What an agent may do, from the narrowest: see run.ts#sandboxOfMode for the sandbox each maps to. */
export const AGENT_MODES = ['read', 'write', 'full', 'sudo'] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

/** The agents that have a mode: the two errand agents, the development agents and the watcher. */
export const SUBHARNESS_AGENTS = ['scout', 'server', 'dev', 'watcher'] as const;
export type SubharnessAgent = (typeof SUBHARNESS_AGENTS)[number];

/** The mode of an agent the owner has not set. Nobody starts without a sandbox. */
export const DEFAULT_MODES: Readonly<Record<SubharnessAgent, AgentMode>> = {
  scout: 'write',
  server: 'read',
  dev: 'write',
  watcher: 'read',
};

/** The mode of an agent the table does not list. */
export const FALLBACK_MODE: AgentMode = 'read';

/** The endpoint of OpenRouter, where a key's `/auth/key` answers. */
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

/** How long the key check waits for the provider (ms). */
const KEY_CHECK_MS = 15_000;

/** How long the reply check of codex or claude may run (ms). */
export const REPLY_CHECK_MS = 120_000;

/** The one-word brief of the reply check. */
const CHECK_BRIEF = 'Reply with the single word ok.';

/** The outcome of one change: `code` is `ok` on success, else why it was refused. */
export type SubharnessResult = { ok: boolean; code: string; changed: boolean; message: string };

/** What the owner sees: the connected backends, the name of opencode's key and every agent's mode. */
export type SubharnessView = {
  backends: Array<BackendName>;
  key: string | null;
  modes: Record<SubharnessAgent, AgentMode>;
};

/** What `enableSubharness` takes. */
export type EnableDeps = {
  privateDir: string;
  /** One minimal run of codex or claude; resolves, never rejects. */
  runBackend(name: 'codex' | 'claude', brief: string, model?: string): Promise<BackendResult>;
  fetch: typeof fetch;
  baseUrl?: string;
  /**
   * Whether a backend is in its folder of the private layer (src/subharness/place.ts#isInstalled); the core passes it,
   * and opencode, whose check runs no binary, is refused `not-installed` when it answers false. codex and claude learn
   * it from `runBackend`.
   */
  isInstalled?(name: BackendName): boolean;
  /**
   * True in the core: `/subharness enable` then asks which model each agent runs on (src/subharness/enable-dialog.ts)
   * before it stores anything. Absent, enable stores the backend alone and the agents run on its default model.
   */
  asksModels?: boolean;
  /**
   * Called after a mode changed: puts the new mode into the agent's systemd unit (src/setup/mode-unit.ts). It answers
   * a line for the owner, or null when the agent has no unit.
   */
  applyMode?(agent: SubharnessAgent, mode: AgentMode): Promise<string | null>;
};

const done = (message: string, changed = true): SubharnessResult => ({ ok: true, code: 'ok', changed, message });
const refused = (code: string, message: string): SubharnessResult => ({ ok: false, code, changed: false, message });

const isMode = (value: unknown): value is AgentMode => AGENT_MODES.some((mode) => mode === value);
const isAgent = (value: unknown): value is SubharnessAgent => SUBHARNESS_AGENTS.some((agent) => agent === value);

/** The mode of `agent` among the stored `modes`: the stored one when it is a mode, else the agent's default, else `read`. */
export function modeOf(modes: Readonly<Record<string, string>>, agent: string): AgentMode {
  const stored = Object.hasOwn(modes, agent) ? modes[agent] : undefined;
  if (isMode(stored)) return stored;
  return isAgent(agent) ? DEFAULT_MODES[agent] : FALLBACK_MODE;
}

/** The subharness as keys.json holds it now. */
export function subharnessView(privateDir: string): Promise<SubharnessView> {
  const stored = readKeys(privateDir).subharness;
  const modes = Object.fromEntries(SUBHARNESS_AGENTS.map((agent) => [agent, modeOf(stored.modes, agent)])) as Record<
    SubharnessAgent,
    AgentMode
  >;
  const key = stored.backends.includes('opencode') ? stored.key : null;
  return Promise.resolve({ backends: stored.backends, key, modes });
}

/** The key check of opencode: the named extra key answers `/auth/key`. */
async function checkKey(deps: EnableDeps, value: string): Promise<SubharnessResult | null> {
  const base = (deps.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  let status: number;
  try {
    const response = await deps.fetch(`${base}/auth/key`, {
      headers: { Authorization: `Bearer ${value}` },
      signal: AbortSignal.timeout(KEY_CHECK_MS),
    });
    status = response.status;
  } catch {
    log.warn('subharness: key check unreachable');
    return refused('key-unreachable', 'the provider did not answer the key check; nothing was changed');
  }
  if (status >= 200 && status < 300) return null;
  log.warn('subharness: key check rejected', { status });
  return refused('key-rejected', `the provider refused that key (HTTP ${status}); nothing was changed`);
}

/** The refusal of a backend that is not in its folder of the private layer (src/subharness/place.ts). */
const notInstalled = (privateDir: string, name: BackendName): SubharnessResult =>
  refused(
    'not-installed',
    `${name} is not installed in ${subharnessPlace(privateDir, name).dir}: run neptunia setup subharness ${name}; nothing was changed`
  );

/** The reply check of codex or claude: the binary runs and answers one brief. */
async function checkReply(deps: EnableDeps, name: 'codex' | 'claude'): Promise<SubharnessResult | null> {
  const outcome = await deps.runBackend(name, CHECK_BRIEF);
  if (outcome.ok && outcome.text.trim() !== '') return null;
  if (outcome.error === 'not-installed') return notInstalled(deps.privateDir, name);
  if (outcome.error === 'backend-missing')
    return refused('binary-missing', `${name} is not on the PATH of the core; nothing was changed`);
  log.warn('subharness: reply check failed', {
    backend: name,
    error: outcome.error ?? null,
    exitCode: outcome.exitCode,
  });
  return refused('no-reply', `${name} runs but gave no reply (is it logged in?); nothing was changed`);
}

/** The model each agent runs on, by agent; an agent that is not in the map runs on the backend's default. */
export function agentModels(privateDir: string): Readonly<Record<string, string>> {
  return readKeys(privateDir).subharness.models;
}

/** What passes the check of an enable: the backend and the value of the key it runs on (empty for codex and claude). */
export type Checked = { name: BackendName; key: string | null; keyValue: string };

/**
 * The check of an enable, which stores nothing: the binary and one reply for `codex` and `claude`, the named extra key
 * answering `/auth/key` for `opencode`, which needs `key` and is the only backend that takes one. Resolves with a
 * refusal, with an ok result when that backend is on already, or with what passed.
 */
export async function checkEnable(
  deps: EnableDeps,
  backend: string,
  key?: string
): Promise<SubharnessResult | Checked> {
  const name = BACKEND_NAMES.find((known) => known === backend);
  if (name === undefined)
    return refused('unknown-backend', `${backend} is no backend; use ${BACKEND_NAMES.join(', ')}`);
  if (name === 'opencode' && key === undefined)
    return refused('key-needed', 'opencode needs an extra key: add --key <name>');
  if (name !== 'opencode' && key !== undefined)
    return refused('key-not-allowed', `${name} brings its own login and takes no key`);
  const store = readKeys(deps.privateDir);
  if (name === 'opencode' && (key === undefined || !hasExtraKey(store, key)))
    return refused('key-unknown', `${key ?? ''} is no extra key; an extra key is added with keys extra`);
  const now = store.subharness;
  if (now.backends.includes(name) && (name !== 'opencode' || now.key === key))
    return done(`${name} is connected already`, false);
  const keyValue = key === undefined ? '' : (store.extra[key] ?? '');
  if (name === 'opencode' && deps.isInstalled?.(name) === false) return notInstalled(deps.privateDir, name);
  const failed = name === 'opencode' ? await checkKey(deps, keyValue) : await checkReply(deps, name);
  return failed ?? { name, key: key ?? null, keyValue };
}

/**
 * Adds the backend of `checked` to the list, with its key's name for opencode, and stores the models. The backends
 * connected before stay. The store is read again, the check took a while.
 */
export function commitEnable(
  privateDir: string,
  checked: Checked,
  models: Readonly<Record<string, string>>
): SubharnessResult {
  const fresh = readKeys(privateDir);
  const { backends } = fresh.subharness;
  writeKeys(privateDir, {
    ...fresh,
    subharness: {
      ...fresh.subharness,
      backends: backends.includes(checked.name) ? backends : [...backends, checked.name],
      key: checked.name === 'opencode' ? checked.key : fresh.subharness.key,
      models: { ...fresh.subharness.models, ...models },
    },
  });
  return done(
    checked.key === null ? `${checked.name} is connected` : `${checked.name} is connected, key ${checked.key}`
  );
}

/** Connects `backend` after `checkEnable`'s check; a failed check stores nothing and keeps the backends connected before. */
export async function enableSubharness(
  deps: EnableDeps,
  backend: string,
  key?: string,
  models: Readonly<Record<string, string>> = {}
): Promise<SubharnessResult> {
  const checked = await checkEnable(deps, backend, key);
  return 'ok' in checked ? checked : commitEnable(deps.privateDir, checked, models);
}

/** Sets the model of one agent after one reply from it. The subharness must be on; the key of opencode is the stored one. */
export async function setAgentModel(deps: EnableDeps, agent: string, model: string): Promise<SubharnessResult> {
  if (!isAgent(agent)) return refused('unknown-agent', `${agent} is no agent; use ${SUBHARNESS_AGENTS.join(', ')}`);
  const store = readKeys(deps.privateDir);
  const { key } = store.subharness;
  const backend = backendOfAgent(store.subharness, agent);
  if (backend === null) return refused('subharness-off', `no backend is connected for ${agent}: subharness enable`);
  const value = key === null ? '' : (store.extra[key] ?? '');
  const failed = await checkModel(deps, backend, value, model);
  if (failed !== null) return { ...failed, message: `${failed.message}; nothing was changed` };
  const fresh = readKeys(deps.privateDir);
  writeKeys(deps.privateDir, {
    ...fresh,
    subharness: { ...fresh.subharness, models: { ...fresh.subharness.models, [agent]: model } },
  });
  return done(`${agent} runs on ${model} from its next run`);
}

/**
 * The backend `agent` runs through: the one `uses` names for it when that one is connected, the first connected one
 * when it names none, null when the named one is not connected or nothing is.
 */
export function backendOfAgent(
  stored: Readonly<{ backends: ReadonlyArray<BackendName>; uses: Readonly<Record<string, BackendName>> }>,
  agent: string
): BackendName | null {
  const named = Object.hasOwn(stored.uses, agent) ? stored.uses[agent] : undefined;
  if (named !== undefined) return stored.backends.includes(named) ? named : null;
  return stored.backends[0] ?? null;
}

/** Disconnects one backend; removing opencode clears its key, removing the last one turns the subharness off. The modes stay. */
export function disableSubharness(privateDir: string, backend: string): Promise<SubharnessResult> {
  const name = BACKEND_NAMES.find((known) => known === backend);
  if (name === undefined)
    return Promise.resolve(refused('unknown-backend', `${backend} is no backend; use ${BACKEND_NAMES.join(', ')}`));
  const store = readKeys(privateDir);
  if (!store.subharness.backends.includes(name)) return Promise.resolve(done(`${name} is not connected`, false));
  const backends = store.subharness.backends.filter((one) => one !== name);
  const key = name === 'opencode' ? null : store.subharness.key;
  writeKeys(privateDir, { ...store, subharness: { ...store.subharness, backends, key } });
  return Promise.resolve(
    done(
      backends.length === 0
        ? `${name} is disconnected; the subharness is off and every agent task is refused until a backend is connected`
        : `${name} is disconnected; ${backends.join(', ')} stays connected`
    )
  );
}

/** Sets the mode of one agent, or with no `mode` reports the current one and writes nothing. */
export function setAgentMode(
  privateDir: string,
  agent: string,
  mode?: string
): Promise<SubharnessResult & { mode: AgentMode | null }> {
  if (!isAgent(agent))
    return Promise.resolve({
      ...refused('unknown-agent', `${agent} is no agent; use ${SUBHARNESS_AGENTS.join(', ')}`),
      mode: null,
    });
  const store = readKeys(privateDir);
  const current = modeOf(store.subharness.modes, agent);
  if (mode === undefined) return Promise.resolve({ ...done(`${agent} runs in ${current}`, false), mode: current });
  if (!isMode(mode))
    return Promise.resolve({
      ...refused('unknown-mode', `${mode} is no mode; use ${AGENT_MODES.join(', ')}`),
      mode: null,
    });
  if (mode === current) return Promise.resolve({ ...done(`${agent} runs in ${mode} already`, false), mode });
  const modes = { ...store.subharness.modes, [agent]: mode };
  writeKeys(privateDir, { ...store, subharness: { ...store.subharness, modes } });
  return Promise.resolve({ ...done(`${agent} runs in ${mode} from its next run`), mode });
}

/** The line of one connected backend: its key's name for opencode, and who enforces `read` and `write` under it. */
function backendLine(view: SubharnessView, name: BackendName): string {
  const key = name === 'opencode' && view.key !== null ? `, key ${view.key}` : '';
  const held =
    name === 'codex'
      ? 'read and write enforced by its sandbox and by the unit'
      : 'read and write held by the systemd unit alone, no sandbox flags';
  return `  ${name}${key}: ${held}`;
}

/** The status the owner reads: every connected backend with its key's name, every agent with its mode. No key value. */
export function statusText(view: SubharnessView, models: Readonly<Record<string, string>> = {}): string {
  const head =
    view.backends.length === 0
      ? ['subharness: off (every agent task is refused until: subharness enable codex|claude|opencode)']
      : ['subharness:', ...view.backends.map((name) => backendLine(view, name))];
  const rows = SUBHARNESS_AGENTS.map(
    (agent) => `  ${agent}  ${view.modes[agent]}${Object.hasOwn(models, agent) ? `  model ${models[agent]}` : ''}`
  );
  return [...head, 'modes:', ...rows].join('\n');
}
