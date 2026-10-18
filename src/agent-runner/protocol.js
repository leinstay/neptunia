// The JSON-lines protocol between the bot (the core) and an agent runner, one
// object per line over the runner's Unix socket. The core asks (`run`,
// `cancel`, `ping`); the runner answers with `progress` events while a task
// works and exactly one `end` per task. This module only validates what comes
// in and shapes what goes out: no I/O, so a malformed line from either side is
// refused here before anything acts on it. The task id ends up in a file path
// (`<outDir>/<id>/`), so it is restricted to a safe character set. A `run` may
// carry the task's secrets (the model key, the proxy, the search key: every key
// lives in the core, the runner cannot read the bot's .env); a refusal names
// only its code, never a value, and nothing here logs a message. A `run` may
// also carry the deployment's shared preamble (the core reads it from its
// private prompt layer; the runner never reads that layer itself).

import { isPlainObject } from '../config.js';
import { SCOPES } from './policy.js';

/** The operations the core may send. */
export const OPS = Object.freeze(['run', 'cancel', 'ping']);
/** The events the runner sends. */
export const EVENTS = Object.freeze(['progress', 'end', 'pong', 'error']);
/** The final states of a task, as an `end` event carries them. */
export const RESULT_STATUSES = Object.freeze(['done', 'failed', 'cancelled']);
/** The limit keys a `run` may carry (each a positive finite number). */
export const LIMIT_KEYS = Object.freeze(['steps', 'usd', 'seconds', 'toolResultChars', 'maxDownloadBytes']);

/** A task id: letters, digits, `_` and `-`, 1..64 characters. */
export const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** The longest goal a `run` may carry (characters). */
export const MAX_GOAL_CHARS = 4000;
/** The longest `context` a `run` may carry, as JSON (characters). */
export const MAX_CONTEXT_CHARS = 20_000;
/** The longest shared preamble a `run` may carry, trimmed (characters). */
export const MAX_PREAMBLE_CHARS = 8000;
/** The longest line either side reads (characters). */
export const MAX_LINE_CHARS = 1_000_000;
/** The most lines a `run`'s `context.recent` keeps (the latest; the earlier ones are dropped). */
export const MAX_RECENT_ENTRIES = 20;
/** The longest author or text of one `context.recent` line (characters). */
export const RECENT_CHARS = 200;
/** The most ids one `ping` may ask about. */
export const MAX_PING_IDS = 100;
const MAX_NOTE_CHARS = 200;
/** The most withheld paths a result lists (each cut to MAX_NOTE_CHARS). */
const MAX_WITHHELD = 50;
const MAX_NAME_CHARS = 64;
/** The secrets a `run` may carry: `openrouterKey` always, `proxy` and `searchKey` when set. */
export const SECRET_KEYS = Object.freeze(['openrouterKey', 'proxy', 'searchKey']);
/** The longest secret value (characters). */
const MAX_SECRET_CHARS = 2048;

/** Whether `value` is a positive finite number. */
function isPositive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** Whether `value` is a non-negative finite number (a price in USD per million tokens). */
function isPrice(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Whether `value` may be a secret: a non-empty string without whitespace, at most MAX_SECRET_CHARS. */
function isSecret(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_SECRET_CHARS && !/\s/.test(value);
}

/**
 * The http form of a proxy URL for HTTPS_PROXY / HTTP_PROXY: a `socks5h://` URL becomes the
 * `http://` one with the same credentials, host and port (the residential proxy serves both on
 * one port), an `http://` or `https://` URL stays as it is; anything else, or a blank value, is
 * null. Pure; never logs the URL (it may carry credentials).
 * @param {unknown} url
 * @returns {string|null}
 */
export function httpProxyForm(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return url.trim();
  if (parsed.protocol !== 'socks5h:' || !parsed.hostname || !parsed.port) return null;
  const auth = parsed.username ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ''}@` : '';
  return `http://${auth}${parsed.host}`;
}

/** `{ ok: false, error }`. */
function refuse(error) {
  return { ok: false, error };
}

function validateRun(msg) {
  if (typeof msg.goal !== 'string' || !msg.goal.trim()) return refuse('bad-goal');
  if (msg.goal.length > MAX_GOAL_CHARS) return refuse('goal-too-long');
  const out = { op: 'run', id: msg.id, goal: msg.goal.trim(), context: {} };
  if (msg.context !== undefined) {
    if (!isPlainObject(msg.context)) return refuse('bad-context');
    if (JSON.stringify(msg.context).length > MAX_CONTEXT_CHARS) return refuse('context-too-long');
    if (msg.context.scope !== undefined && !SCOPES.includes(msg.context.scope)) return refuse('bad-scope');
    out.context = msg.context;
    if (msg.context.recent !== undefined) {
      const recent = msg.context.recent;
      if (!Array.isArray(recent) || !recent.every((line) => isPlainObject(line) && typeof line.author === 'string' && typeof line.text === 'string')) return refuse('bad-recent');
      out.context = {
        ...msg.context,
        recent: recent.slice(-MAX_RECENT_ENTRIES).map((line) => ({ author: line.author.slice(0, RECENT_CHARS), text: line.text.slice(0, RECENT_CHARS) })),
      };
    }
  }
  if (msg.limits !== undefined) {
    if (!isPlainObject(msg.limits)) return refuse('bad-limits');
    const limits = {};
    for (const [key, value] of Object.entries(msg.limits)) {
      if (!LIMIT_KEYS.includes(key) || !isPositive(value)) return refuse('bad-limits');
      limits[key] = value;
    }
    out.limits = limits;
  }
  if (msg.tools !== undefined) {
    if (!Array.isArray(msg.tools) || !msg.tools.length) return refuse('bad-tools');
    if (!msg.tools.every((name) => typeof name === 'string' && name && name.length <= MAX_NAME_CHARS)) return refuse('bad-tools');
    out.tools = [...new Set(msg.tools)];
  }
  if (msg.model !== undefined) {
    if (typeof msg.model !== 'string' || !/^[\w.:/-]{1,128}$/.test(msg.model)) return refuse('bad-model');
    out.model = msg.model;
  }
  if (msg.cost !== undefined) {
    if (!isPlainObject(msg.cost) || !isPrice(msg.cost.input) || !isPrice(msg.cost.output)) return refuse('bad-cost');
    out.cost = { input: msg.cost.input, output: msg.cost.output };
  }
  if (msg.searchProvider !== undefined) {
    if (typeof msg.searchProvider !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(msg.searchProvider)) return refuse('bad-search-provider');
    out.searchProvider = msg.searchProvider;
  }
  if (msg.secrets !== undefined) {
    // Only the code on a refusal: a secret never travels back in an error.
    const s = msg.secrets;
    if (!isPlainObject(s) || !isSecret(s.openrouterKey)) return refuse('bad-secrets');
    if (!Object.keys(s).every((key) => SECRET_KEYS.includes(key))) return refuse('bad-secrets');
    const secrets = { openrouterKey: s.openrouterKey };
    for (const key of ['proxy', 'searchKey']) {
      if (s[key] === undefined) continue;
      if (!isSecret(s[key])) return refuse('bad-secrets');
      secrets[key] = s[key];
    }
    out.secrets = secrets;
  }
  if (msg.preamble !== undefined) {
    // Only the code on a refusal, like every field: the text never travels back in an error.
    if (typeof msg.preamble !== 'string') return refuse('bad-preamble');
    const preamble = msg.preamble.trim();
    if (preamble.length > MAX_PREAMBLE_CHARS) return refuse('preamble-too-long');
    if (preamble) out.preamble = preamble;
  }
  return { ok: true, message: out };
}

/**
 * Validate one decoded message from the core. `run` needs an id, a non-empty
 * goal (at most MAX_GOAL_CHARS), and may carry `context` (a plain object,
 * at most MAX_CONTEXT_CHARS as JSON, whose `scope` is one of SCOPES when
 * present and whose `recent`, when present, is a list of `{ author, text }`
 * strings: the latest MAX_RECENT_ENTRIES kept, each cut to RECENT_CHARS, any
 * other key of a line dropped; a malformed one refuses `bad-recent`), `limits` (only LIMIT_KEYS, each a positive number), `tools` (a
 * non-empty list of names), `model` (an OpenCode model id), `cost`
 * (`{ input, output }` in USD per million tokens), `searchProvider` (an
 * OpenCode web search provider id) and `secrets` (`{ openrouterKey, proxy?,
 * searchKey? }`, each a non-empty string without whitespace, no other key;
 * `proxy` in the http form, see httpProxyForm) and `preamble` (the deployment's
 * shared text put before the agent's prompt: a string, trimmed, at most
 * MAX_PREAMBLE_CHARS, else `bad-preamble` / `preamble-too-long`; a blank one
 * is dropped). A refusal carries its code
 * only, never a value of the message. `cancel` needs an id. `ping` may carry `ids` (task ids
 * the core still waits for). Unknown top-level keys are ignored.
 * @param {unknown} msg
 * @returns {{ ok: true, message: object } | { ok: false, error: string }}
 */
export function validateRequest(msg) {
  if (!isPlainObject(msg)) return refuse('not-an-object');
  if (!OPS.includes(msg.op)) return refuse('bad-op');
  if (msg.op === 'ping') {
    if (msg.ids === undefined) return { ok: true, message: { op: 'ping', ids: [] } };
    if (!Array.isArray(msg.ids) || msg.ids.length > MAX_PING_IDS || !msg.ids.every((id) => typeof id === 'string' && TASK_ID.test(id))) {
      return refuse('bad-ids');
    }
    return { ok: true, message: { op: 'ping', ids: [...new Set(msg.ids)] } };
  }
  if (typeof msg.id !== 'string' || !TASK_ID.test(msg.id)) return refuse('bad-id');
  if (msg.op === 'cancel') return { ok: true, message: { op: 'cancel', id: msg.id } };
  return validateRun(msg);
}

/**
 * Decode and validate one line from the core.
 * @param {string} line
 * @returns {{ ok: true, message: object } | { ok: false, error: string, id?: string }}
 */
export function parseRequestLine(line) {
  const text = String(line ?? '');
  if (text.length > MAX_LINE_CHARS) return refuse('line-too-long');
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return refuse('bad-json');
  }
  const checked = validateRequest(msg);
  if (!checked.ok && isPlainObject(msg) && typeof msg.id === 'string' && TASK_ID.test(msg.id)) {
    return { ...checked, id: msg.id };
  }
  return checked;
}

/**
 * One object as a protocol line (JSON + newline).
 * @param {object} obj
 * @returns {string}
 */
export function encodeLine(obj) {
  return `${JSON.stringify(obj)}\n`;
}

/** A finite non-negative number, else 0. */
function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * A `progress` event: `{ id, event: 'progress', step, tool, note }`; `tool`
 * is null for a step without a tool call, `note` is cut to 200 characters.
 * @param {{ id: string, step: number, tool?: string|null, note?: string }} fields
 * @returns {object}
 */
export function progressEvent({ id, step, tool = null, note = '' }) {
  return {
    id,
    event: 'progress',
    step: count(step),
    tool: typeof tool === 'string' && tool ? tool : null,
    note: String(note ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE_CHARS),
  };
}

/** A result in its protocol shape: `{ text, sources: [url], files: [{ path, name, contentType, bytes }] }`,
 * plus `withheld: [path]` (the withheld paths the agent reached for in a filtered scope, at most
 * MAX_WITHHELD) when any, and `filesDropped: [{ name, reason }]` (`withheld` | `secret`: the files
 * the runner did not deliver, src/agent-runner/opencode.js; at most MAX_WITHHELD) when any. */
export function normalizeResult(result) {
  const r = isPlainObject(result) ? result : {};
  const sources = Array.isArray(r.sources) ? [...new Set(r.sources.filter((url) => typeof url === 'string' && url))] : [];
  const files = Array.isArray(r.files)
    ? r.files.filter((f) => isPlainObject(f) && typeof f.path === 'string').map((f) => ({
      path: f.path,
      name: typeof f.name === 'string' ? f.name : '',
      contentType: typeof f.contentType === 'string' ? f.contentType : '',
      bytes: count(f.bytes),
    }))
    : [];
  const out = { text: typeof r.text === 'string' ? r.text : '', sources, files };
  const withheld = Array.isArray(r.withheld) ? [...new Set(r.withheld.filter((p) => typeof p === 'string' && p).map((p) => p.slice(0, MAX_NOTE_CHARS)))].slice(0, MAX_WITHHELD) : [];
  if (withheld.length > 0) out.withheld = withheld;
  const dropped = Array.isArray(r.filesDropped)
    ? r.filesDropped.filter((d) => isPlainObject(d) && (d.reason === 'withheld' || d.reason === 'secret'))
      .map((d) => ({ name: String(d.name ?? '').slice(0, MAX_NOTE_CHARS), reason: d.reason })).slice(0, MAX_WITHHELD)
    : [];
  if (dropped.length > 0) out.filesDropped = dropped;
  return out;
}

/** A usage in its protocol shape: `{ input, output, usd, steps, seconds }` plus `costUnknown` when above 0. */
export function normalizeUsage(usage) {
  const u = isPlainObject(usage) ? usage : {};
  const out = { input: count(u.input), output: count(u.output), usd: count(u.usd), steps: count(u.steps), seconds: count(u.seconds) };
  if (count(u.costUnknown) > 0) out.costUnknown = count(u.costUnknown);
  return out;
}

/**
 * The one `end` event of a task. A status outside RESULT_STATUSES becomes
 * `failed`; `error` (a kebab-case code) is present only when given.
 * @param {{ id: string, status: string, result?: object, usage?: object, error?: string }} fields
 * @returns {object}
 */
export function endEvent({ id, status, result, usage, error }) {
  const event = {
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
 * @param {string} id
 * @returns {object}
 */
export function restartedEvent(id) {
  return endEvent({ id, status: 'failed', error: 'restarted' });
}

/**
 * A `pong`: the profile, whether a task is running and how many wait.
 * @param {{ profile: string, busy: boolean, queued: number }} fields
 * @returns {object}
 */
export function pongEvent({ profile, busy, queued }) {
  return { event: 'pong', profile: String(profile ?? ''), busy: busy === true, queued: count(queued) };
}

/**
 * An `error` event for a line that could not be taken (`id` when the line
 * named a valid one).
 * @param {string} error
 * @param {string} [id]
 * @returns {object}
 */
export function errorEvent(error, id) {
  return id ? { id, event: 'error', error } : { event: 'error', error };
}
