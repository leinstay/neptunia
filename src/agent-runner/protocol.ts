// The JSON-lines protocol between the bot (the core) and an agent runner, one
// object per line over the runner's Unix socket. The core asks (`run`,
// `cancel`, `ping`); the runner answers exactly one `end` per task. This
// module only validates what comes in and shapes what goes out: no I/O, so a malformed line from either side is
// refused here before anything acts on it. The task id ends up in a file path
// (`<outDir>/<id>/`), so it is restricted to a safe character set. A `run` may
// carry the task's secrets (the model key, the proxy, the search key: every key
// lives in the core, the runner cannot read the core's key store); a refusal names
// only its code, never a value, and nothing here logs a message. A `run` may
// also carry the deployment's shared preamble (the core reads it from its
// private prompt layer; the runner never reads that layer itself). A `run` may carry the task's route, the backend,
// model, effort and mode the core decided from keys.json at dispatch, because the runner's unit may hide that file.

import { isPlainObject } from '../config.ts';
import { objOf, scalarText } from '../tools/types.ts';
import { LISTED_EFFORT_LEVELS } from '../llm/roles.ts';
import type { EffortLevel } from '../llm/roles.ts';
import { AGENT_MODES } from '../subharness/control.ts';
import type { AgentMode } from '../subharness/control.ts';
import { SCOPES } from './policy.ts';
import { BACKEND_NAMES } from './profiles.ts';
import type { BackendName } from './profiles.ts';

type Rec = Record<string, unknown>;
/** `isPlainObject`, as a guard. */
const isRec = (value: unknown): value is Rec => isPlainObject(value);

/** The context of a `run`: its `scope`, its latest `recent` lines, and whatever else the core sends. */
export type RunContext = { scope?: unknown; recent?: Array<{ author: string; text: string }>; [key: string]: unknown };

/** The secrets a `run` carries: at least one of them. */
export type RunSecrets = { openrouterKey?: string; proxy?: string; searchKey?: string };

/** The path the core decided for a task: the backend, model, effort and mode it runs in. Null model and effort mean the backend's own default. */
export type TaskRoute = {
  backend: BackendName;
  model: string | null;
  effort: EffortLevel | null;
  mode: AgentMode;
  /** The OpenRouter provider an opencode run is pinned to; absent runs at any provider. */
  provider?: string;
};

/** A validated `run`. */
export type RunRequest = {
  op: 'run';
  id: string;
  /** the agent of the unit that works the task */
  agent: string;
  goal: string;
  context: RunContext;
  limits?: Record<string, number>;
  searchProvider?: string;
  secrets?: RunSecrets;
  preamble?: string;
  route?: TaskRoute;
};

/** A validated request from the core. */
export type Request = RunRequest | { op: 'cancel'; id: string } | { op: 'ping'; ids: Array<string> };

/** What the validators answer. */
type Checked = { ok: true; message: Request } | { ok: false; error: string; id?: string };

/** What the runner's task engine takes: the validated `run` and the way to stop and follow it. */
export type RunnerTask = Omit<RunRequest, 'op' | 'limits' | 'searchProvider'> & {
  limits?: Record<string, unknown>;
  searchProvider?: string | null;
  signal: AbortSignal;
};

/** What the task engine gives back. */
export type RunOutcome = {
  status: string;
  result?: { text?: string; [key: string]: unknown };
  usage?: unknown;
  error?: string;
};

/** A result in its protocol shape. */
export type TaskResult = {
  text: string;
  sources: Array<string>;
  files: Array<{ path: string; name: string; contentType: string; bytes: number }>;
  filesDropped?: Array<{ name: string; reason: 'secret' }>;
  /** the web searches of the run that failed (OpenCode's `websearch`), a positive whole number when any */
  searchFailures?: number;
};

/** A usage in its protocol shape. */
export type TaskUsage = {
  input: number;
  output: number;
  usd: number;
  steps: number;
  seconds: number;
};

/** The operations the core may send. */
export const OPS = Object.freeze(['run', 'cancel', 'ping']);

/** The final states of a task, as an `end` event carries them. */
export const RESULT_STATUSES = Object.freeze(['done', 'failed', 'cancelled']);
/** The limit keys a `run` may carry (each a positive finite number). */
export const LIMIT_KEYS = Object.freeze(['steps', 'seconds', 'toolResultChars', 'maxDownloadBytes']);

/** A task id: letters, digits, `_` and `-`, 1..64 characters. */
export const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** The longest goal a `run` may carry (characters). */
export const MAX_GOAL_CHARS = 4000;
/**
 * The longest `context` a `run` may carry, as JSON (characters). It holds the most the core itself puts there: six
 * recent lines whole, each a platform message of at most 2,000 characters, and 8,000 characters of memory lines.
 */
export const MAX_CONTEXT_CHARS = 24_000;
/** The longest line either side reads (characters). */
export const MAX_LINE_CHARS = 1_000_000;
/** The most lines a `run`'s `context.recent` keeps (the latest; the earlier ones are dropped). */
export const MAX_RECENT_ENTRIES = 20;
/** The most ids one `ping` may ask about. */
export const MAX_PING_IDS = 100;
const MAX_NOTE_CHARS = 200;
/** The most dropped files a result lists (each name cut to MAX_NOTE_CHARS). */
const MAX_DROPPED = 50;
/** The secrets a `run` may carry, each when set: a run with a claude or codex route carries no `openrouterKey`. */
export const SECRET_KEYS = Object.freeze(['openrouterKey', 'proxy', 'searchKey']);
/** The longest secret value (characters). */
const MAX_SECRET_CHARS = 2048;

/** Whether `value` is a positive finite number. */
function isPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** The keys every route has; a route may also carry `provider`, and no other key. */
const ROUTE_KEYS = Object.freeze(['backend', 'effort', 'mode', 'model']);
/** The longest provider slug a route may carry (characters). */
const MAX_PROVIDER_CHARS = 64;

/** Whether `value` is an OpenRouter provider slug: lower case letters, digits and hyphens, starting with a letter or a digit. */
export function isProviderSlug(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_PROVIDER_CHARS && /^[a-z0-9][a-z0-9-]*$/.test(value);
}
/** The longest model name a route may carry (characters). */
const MAX_ROUTE_MODEL_CHARS = 128;

/** Whether `value` is the model of a route: null, or a name without whitespace that does not read as a flag. */
function isRouteModel(value: unknown): value is string | null {
  if (value === null) return true;
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ROUTE_MODEL_CHARS &&
    !/\s/.test(value) &&
    !value.startsWith('-')
  );
}

/** The route as a validated value, or null when it is not the four keys (and `provider` when pinned) with valid values. */
export function parseRoute(value: unknown): TaskRoute | null {
  if (!isRec(value)) return null;
  const keys = Object.keys(value).sort();
  const pinned = Object.hasOwn(value, 'provider');
  const expected = pinned ? [...ROUTE_KEYS, 'provider'].sort() : ROUTE_KEYS;
  if (keys.length !== expected.length || !keys.every((key, at) => key === expected[at])) return null;
  const { backend, model, effort, mode, provider } = value;
  const knownBackend = BACKEND_NAMES.find((name) => name === backend);
  const knownMode = AGENT_MODES.find((one) => one === mode);
  if (knownBackend === undefined || knownMode === undefined || !isRouteModel(model)) return null;
  if (pinned && (!isProviderSlug(provider) || knownBackend !== 'opencode' || model === null)) return null;
  const pin = pinned ? { provider: provider as string } : {};
  if (effort === null) return { backend: knownBackend, model, effort: null, mode: knownMode, ...pin };
  const knownEffort = LISTED_EFFORT_LEVELS.find((level) => level === effort);
  return knownEffort === undefined
    ? null
    : { backend: knownBackend, model, effort: knownEffort, mode: knownMode, ...pin };
}

/** Whether `value` may be a secret: a non-empty string without whitespace, at most MAX_SECRET_CHARS. */
function isSecret(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_SECRET_CHARS && !/\s/.test(value);
}

/** The http form of a proxy URL, `proxy` of the secrets (src/net/proxy.ts). */
export { httpProxyForm } from '../net/proxy.ts';

/** An agent's name as a run names it: the name of its folder. */
const AGENT_PATTERN = /^[a-z][a-z0-9-]*$/;

/** `{ ok: false, error }`. */
function refuse(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

/** `run` with its agent checked and kept, then its route when the line has one. */
function withAgentAndRoute(run: RunRequest, msg: Rec): Checked {
  if (typeof msg.agent !== 'string' || !AGENT_PATTERN.test(msg.agent)) return refuse('bad-agent');
  const named: RunRequest = { ...run, agent: msg.agent };
  return msg.route === undefined ? { ok: true, message: named } : withRoute(named, msg.route);
}

/** `run` with its route checked and kept. Only the code on a refusal: a value of the route never travels back in an error. */
function withRoute(run: RunRequest, value: unknown): Checked {
  const route = parseRoute(value);
  return route === null ? refuse('bad-route') : { ok: true, message: { ...run, route } };
}

function validateRun(msg: Rec, id: string): Checked {
  if (typeof msg.goal !== 'string' || !msg.goal.trim()) return refuse('bad-goal');
  if (msg.goal.length > MAX_GOAL_CHARS) return refuse('goal-too-long');
  // The agent is checked after the rest of the line (withAgentAndRoute).
  const out: RunRequest = { op: 'run', id, agent: '', goal: msg.goal.trim(), context: {} };
  if (msg.context !== undefined) {
    if (!isRec(msg.context)) return refuse('bad-context');
    const context = msg.context;
    if (JSON.stringify(context).length > MAX_CONTEXT_CHARS) return refuse('context-too-long');
    if (context.scope !== undefined && !SCOPES.some((scope) => scope === context.scope)) return refuse('bad-scope');
    out.context = context;
    if (context.recent !== undefined) {
      const recent: unknown = context.recent;
      if (
        !Array.isArray(recent) ||
        !recent.every((line) => isRec(line) && typeof line.author === 'string' && typeof line.text === 'string')
      )
        return refuse('bad-recent');
      out.context = {
        ...context,
        recent: recent.slice(-MAX_RECENT_ENTRIES).map((line: { author: string; text: string }) => ({
          author: line.author,
          text: line.text,
        })),
      };
    }
  }
  if (msg.limits !== undefined) {
    if (!isRec(msg.limits)) return refuse('bad-limits');
    const limits: Record<string, number> = {};
    for (const [key, value] of Object.entries(msg.limits)) {
      if (!LIMIT_KEYS.includes(key) || !isPositive(value)) return refuse('bad-limits');
      limits[key] = value;
    }
    out.limits = limits;
  }
  if (msg.searchProvider !== undefined) {
    if (typeof msg.searchProvider !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(msg.searchProvider))
      return refuse('bad-search-provider');
    out.searchProvider = msg.searchProvider;
  }
  if (msg.secrets !== undefined) {
    // Only the code on a refusal: a secret never travels back in an error.
    const s = msg.secrets;
    if (!isRec(s) || Object.keys(s).length === 0) return refuse('bad-secrets');
    if (!Object.keys(s).every((key) => SECRET_KEYS.includes(key))) return refuse('bad-secrets');
    const secrets: RunSecrets = {};
    for (const key of ['openrouterKey', 'proxy', 'searchKey'] as const) {
      const value = s[key];
      if (value === undefined) continue;
      if (!isSecret(value)) return refuse('bad-secrets');
      secrets[key] = value;
    }
    out.secrets = secrets;
  }
  if (msg.preamble !== undefined) {
    // Only the code on a refusal, like every field: the text never travels back in an error.
    if (typeof msg.preamble !== 'string') return refuse('bad-preamble');
    const preamble = msg.preamble.trim();
    if (preamble) out.preamble = preamble;
  }
  return { ok: true, message: out };
}

/**
 * Validate one decoded message from the core. `run` needs an id, a non-empty
 * goal (at most MAX_GOAL_CHARS), and may carry `context` (a plain object,
 * at most MAX_CONTEXT_CHARS as JSON, whose `scope` is one of SCOPES when
 * present and whose `recent`, when present, is a list of `{ author, text }`
 * strings: the latest MAX_RECENT_ENTRIES kept whole, any
 * other key of a line dropped; a malformed one refuses `bad-recent`), `limits` (only LIMIT_KEYS, each a positive number), `searchProvider` (an
 * OpenCode web search provider id) and `secrets` (`{ openrouterKey?, proxy?,
 * searchKey? }`, at least one, each a non-empty string without whitespace, no other key;
 * `proxy` in the http form, see httpProxyForm) and `preamble` (the deployment's
 * shared text that opens the agent's system instructions: a string of any
 * length, trimmed, else `bad-preamble`; a blank one is dropped) and `route` (`{ backend, model, effort, mode }` and `provider` when pinned, see parseRoute, else `bad-route`). A refusal carries its code
 * only, never a value of the message. `cancel` needs an id. `ping` may carry `ids` (task ids
 * the core still waits for). Unknown top-level keys are ignored.
 */
export function validateRequest(msg: unknown): Checked {
  if (!isRec(msg)) return refuse('not-an-object');
  if (!OPS.some((op) => op === msg.op)) return refuse('bad-op');
  if (msg.op === 'ping') {
    if (msg.ids === undefined) return { ok: true, message: { op: 'ping', ids: [] } };
    const ids: unknown = msg.ids;
    if (
      !Array.isArray(ids) ||
      ids.length > MAX_PING_IDS ||
      !ids.every((id): id is string => typeof id === 'string' && TASK_ID.test(id))
    ) {
      return refuse('bad-ids');
    }
    return { ok: true, message: { op: 'ping', ids: [...new Set(ids)] } };
  }
  if (typeof msg.id !== 'string' || !TASK_ID.test(msg.id)) return refuse('bad-id');
  if (msg.op === 'cancel') return { ok: true, message: { op: 'cancel', id: msg.id } };
  const checked = validateRun(msg, msg.id);
  return checked.ok ? withAgentAndRoute(checked.message as RunRequest, msg) : checked;
}

/** Decode and validate one line from the core. */
export function parseRequestLine(line: string): Checked {
  const text = String(line ?? '');
  if (text.length > MAX_LINE_CHARS) return refuse('line-too-long');
  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    return refuse('bad-json');
  }
  const checked = validateRequest(msg);
  if (!checked.ok && isRec(msg) && typeof msg.id === 'string' && TASK_ID.test(msg.id)) {
    return { ...checked, id: msg.id };
  }
  return checked;
}

/** One object as a protocol line (JSON + newline). */
export function encodeLine(obj: object): string {
  return `${JSON.stringify(obj)}\n`;
}

/** A finite non-negative number, else 0. */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** A result in its protocol shape: `{ text, sources: [url], files: [{ path, name, contentType, bytes }] }`,
 * plus `filesDropped: [{ name, reason }]` (reason `secret`: the files the runner did not deliver,
 * src/agent-runner/opencode.ts; at most MAX_DROPPED) when any, and `searchFailures` (the
 * count of the run's failed web searches) when it is a positive whole number. */
export function normalizeResult(result: unknown): TaskResult {
  const r = objOf(result);
  const sources: Array<string> = Array.isArray(r.sources)
    ? [...new Set((r.sources as Array<unknown>).filter((url): url is string => typeof url === 'string' && url !== ''))]
    : [];
  const files: TaskResult['files'] = Array.isArray(r.files)
    ? (r.files as Array<unknown>)
        .map((entry) => objOf(entry))
        .filter((f): f is Rec & { path: string } => typeof f.path === 'string')
        .map((f) => ({
          path: f.path,
          name: typeof f.name === 'string' ? f.name : '',
          contentType: typeof f.contentType === 'string' ? f.contentType : '',
          bytes: count(f.bytes),
        }))
    : [];
  const out: TaskResult = { text: typeof r.text === 'string' ? r.text : '', sources, files };
  const dropped: Array<{ name: string; reason: 'secret' }> = Array.isArray(r.filesDropped)
    ? (r.filesDropped as Array<unknown>)
        .map((entry) => objOf(entry))
        .flatMap((d): Array<{ name: string; reason: 'secret' }> =>
          d.reason === 'secret' ? [{ name: scalarText(d.name ?? '').slice(0, MAX_NOTE_CHARS), reason: 'secret' }] : []
        )
        .slice(0, MAX_DROPPED)
    : [];
  if (dropped.length > 0) out.filesDropped = dropped;
  if (Number.isSafeInteger(r.searchFailures) && Number(r.searchFailures) > 0)
    out.searchFailures = Number(r.searchFailures);
  return out;
}

/** A usage in its protocol shape: `{ input, output, usd, steps, seconds }`. */
export function normalizeUsage(usage: unknown): TaskUsage {
  const u = objOf(usage);
  const out: TaskUsage = {
    input: count(u.input),
    output: count(u.output),
    usd: count(u.usd),
    steps: count(u.steps),
    seconds: count(u.seconds),
  };
  return out;
}

/**
 * The one `end` event of a task. A status outside RESULT_STATUSES becomes
 * `failed`; `error` (a kebab-case code) is present only when given.
 */
export function endEvent({
  id,
  status,
  result,
  usage,
  error,
}: {
  id: string;
  status: string;
  result?: unknown;
  usage?: unknown;
  error?: string;
}): { id: string; event: 'end'; status: string; result: TaskResult; usage: TaskUsage; error?: string } {
  const event: { id: string; event: 'end'; status: string; result: TaskResult; usage: TaskUsage; error?: string } = {
    id,
    event: 'end',
    status: RESULT_STATUSES.includes(status) ? status : 'failed',
    result: normalizeResult(result),
    usage: normalizeUsage(usage),
  };
  if (typeof error === 'string' && error) event.error = error;
  return event;
}

/**
 * The `end` of a task id the runner does not know (it restarted, or the id
 * never reached it): `failed`, `restarted`.
 */
export function restartedEvent(id: string): object {
  return endEvent({ id, status: 'failed', error: 'restarted' });
}

/** A `pong`: the unit, whether a task is running and how many wait. */
export function pongEvent({ unit, busy, queued }: { unit: string; busy: boolean; queued: number }): object {
  return { event: 'pong', unit: String(unit ?? ''), busy: busy === true, queued: count(queued) };
}

/**
 * An `error` event for a line that could not be taken (`id` when the line
 * named a valid one).
 */
export function errorEvent(error: string, id?: string): object {
  return id ? { id, event: 'error', error } : { event: 'error', error };
}
