// OpenRouter chat-completions client on the built-in fetch. Owns the two hard
// safety rails of the project: no request above the token cap ever leaves the
// process, and no more than `llm.maxRequestsPerDay` requests are made per day
// (a spammed mention must not burn the owner's balance).
//
// Deliberate exception: `complete(messages, { countAgainstDailyCap: false })`
// skips the daily-request counter and is never refused by it. Its callers
// each have a budget or a trigger of their own, so none of them can burn
// through the day's request cap of the chat:
// - the memory warmup (src/memory/warmup.js), a long-running seeding job
//   under its own token budget (`warmup.maxTokens`);
// - the operations tools (tools/replay.mjs through src/behavior/sandbox.js),
//   run by hand behind their own spend gate, never by the bot.
// Every other request counts: the reply and every helper before it, the
// analyzer, the voice model, a portrait refresh. The per-request token cap
// (`TokenLimitError`) always applies, with no exception.
//
// The same module holds the read-only side of that counter (`capLeft`,
// `llmCountToday`), the reason code of a rail refusal (`railReason`) and the
// one spelling of an in-turn helper request (`helperRequestOptions`), whose
// requests on the roles `llm.hedge` lists are hedged: a second attempt after a
// short wait, the first answer taken (see `complete`).
//
// It is also the one place the prompt-cache marker is put on a request (see
// `withCacheMarker`): after the estimate, so the rails never see it.

import { createHash } from 'node:crypto';
import { estimateMessages, estimateTools } from './tokens.js';
import { safetyMarginOf } from './budget.js';
import { isPlainObject } from '../config.js';
import { HOUR_MS, MINUTE_MS, bumpDaily, countToday, dailyCounter } from '../time.js';
import { log } from '../log.js';
import { roleModel } from './roles.js';

// ---- transport shared with the images client (src/llm/images.js) ----------

/** HTTP statuses worth a retry: timeouts, rate limits and gateway errors. */
export const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Resolve after `ms` milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The wait before retry number `attempt` (1-based): 1.5 s, then doubling.
 * @param {number} attempt
 * @returns {number}
 */
export function backoffMs(attempt) {
  return 1500 * 2 ** (attempt - 1);
}

/**
 * The headers of an OpenRouter POST: the bearer key, a JSON body and the
 * neutral app title (never a character name).
 * @param {string} apiKey
 * @returns {Record<string, string>}
 */
export function openRouterHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'X-Title': 'neptunia-bot',
  };
}

/**
 * `${baseUrl}/${path}`, tolerating trailing slashes on `baseUrl` and leading
 * ones on `path`.
 * @param {string} baseUrl
 * @param {string} path  E.g. `chat/completions`, `images`.
 * @returns {string}
 */
export function apiUrl(baseUrl, path) {
  return `${String(baseUrl).replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`;
}

/** The only environment variable names `llm.keyByRole` may point at: a config typo never sends another secret to OpenRouter. */
export const ROLE_KEY_NAME = /^OPENROUTER_[A-Z0-9_]+$/;

/**
 * A key variable read in place of another while the named one is unset: `OPENROUTER_CORE_KEY`
 * (the core's key, the role's name since 2026-10) falls back to `OPENROUTER_VOICE_KEY` (its name
 * while the role was `voice`), so a deployment whose `.env` still holds the old variable keeps
 * its key. One step, never chained.
 */
export const ROLE_KEY_FALLBACKS = Object.freeze({ OPENROUTER_CORE_KEY: 'OPENROUTER_VOICE_KEY' });

/**
 * The roles that never go out on the main key: an unset or blank variable gives an empty key (`roleApiKey`), and a
 * request of such a role is refused before it is sent (`complete` throws `ROLE_KEY_MISSING`). Her memory session
 * (`memory`) spends its own key or nothing.
 */
export const STRICT_KEY_ROLES = Object.freeze(['memory']);

// The `llm.keyByRole` entries already reported as unusable in this process (by name).
const warnedRoleKeys = new Set();

/**
 * The OpenRouter key a request of `role` goes out on: the variable `llm.keyByRole[role]` names
 * (read from `env`, the parsed `.env`) when the name matches `ROLE_KEY_NAME` and the variable is
 * set and not blank, else the variable `ROLE_KEY_FALLBACKS` names for it when that one is set,
 * else `mainKey`. The map is read from `config` at the moment of use. A mapped
 * role that falls back logs `llm: role key missing` (role, name) once per name per process; a
 * name that is not a variable name is logged as null (it may be a pasted key). Never logs a value.
 * The one place a request's key is chosen (chat completions, embeddings, the status card's reads).
 * @param {object} config
 * @param {Record<string, string|undefined>|null|undefined} env
 * @param {unknown} role  The request's `options.role`.
 * @param {string} mainKey  `OPENROUTER_API_KEY`.
 * @returns {string}
 */
export function roleApiKey(config, env, role, mainKey) {
  const map = config?.llm?.keyByRole;
  const strict = typeof role === 'string' && STRICT_KEY_ROLES.includes(role);
  if (typeof role !== 'string' || !role || !isPlainObject(map) || !Object.hasOwn(map, role)) return strict ? '' : mainKey;
  const name = map[role];
  const valid = typeof name === 'string' && ROLE_KEY_NAME.test(name);
  const value = valid && env ? env[name] : undefined;
  if (typeof value === 'string' && value.trim()) return value;
  const fallback = valid && env && Object.hasOwn(ROLE_KEY_FALLBACKS, name) ? env[ROLE_KEY_FALLBACKS[name]] : undefined;
  if (typeof fallback === 'string' && fallback.trim()) return fallback;
  const seen = valid ? name : `bad:${String(name)}`;
  if (!warnedRoleKeys.has(seen)) {
    warnedRoleKeys.add(seen);
    log.warn('llm: role key missing', { role, name: valid ? name : null });
  }
  return strict ? '' : mainKey;
}

/**
 * The SHA-256 hex digest of an API key: how OpenRouter's activity endpoint names a key
 * (`api_key_hash`), so the status card can ask for one key's spend without holding it.
 * @param {string} key
 * @returns {string}
 */
export function keyHashOf(key) {
  return createHash('sha256').update(String(key)).digest('hex');
}

/**
 * The extra keys `llm.keyByRole` puts in use, one entry per distinct key other than `mainKey`
 * (a role whose key falls back, or names the main key's value, stays on the main key), with the
 * roles on it sorted by name, in the order the map first names each key. For the status card.
 * @param {object} config
 * @param {Record<string, string|undefined>|null|undefined} env
 * @param {string} mainKey
 * @returns {Array<{ roles: string[], apiKey: string }>}
 */
export function roleKeyGroups(config, env, mainKey) {
  const map = config?.llm?.keyByRole;
  if (!isPlainObject(map)) return [];
  const groups = new Map();
  for (const role of Object.keys(map)) {
    const apiKey = roleApiKey(config, env, role, mainKey);
    if (apiKey === mainKey || !apiKey) continue;
    if (!groups.has(apiKey)) groups.set(apiKey, []);
    groups.get(apiKey).push(role);
  }
  return [...groups].map(([apiKey, roles]) => ({ roles: roles.sort(), apiKey }));
}

/**
 * The state.json fields of the daily request counter: `complete()` counts every
 * request in them, unless it is sent with `countAgainstDailyCap: false`.
 */
export const LLM_DAILY = Object.freeze({ dayKey: 'llmDay', countKey: 'llmCount' });

/**
 * The requests counted against `llm.maxRequestsPerDay` today, read only: the
 * stored count when it was stamped for the UTC day of `nowMs`, else 0 (the
 * count of yesterday reads as 0 from 00:00 UTC on, before the first request
 * of the day rolls the pair over). Never writes. For the readers outside
 * the client: a status line, a check before work a refusal would waste.
 * @param {object|null|undefined} stateData  `store.state.data`.
 * @param {number} nowMs
 * @returns {number}
 */
export function llmCountToday(stateData, nowMs) {
  return countToday(stateData, LLM_DAILY, nowMs);
}

/**
 * Count one request against `llm.maxRequestsPerDay` on the shared counter (`LLM_DAILY` in
 * `state.data`), or refuse it: a `DailyCapError` (`key`, `used`, `cap`) when today's count has
 * reached the cap, nothing counted. A cap that is not a finite number refuses everything
 * (`dailyCapOf`). The one copy of the rail, for the chat client and the embedding client
 * (src/llm/embed.js), so both spend from the same count of the day.
 * @param {{ data: object, markDirty: () => void }} state  Persistent state.
 * @param {unknown} configured  `llm.maxRequestsPerDay`, read by the caller at the moment of use.
 * @param {number} nowMs
 */
export function countLlmRequest(state, configured, nowMs) {
  const cap = dailyCapOf(configured, 'llm.maxRequestsPerDay');
  const { count } = dailyCounter(state.data, LLM_DAILY, nowMs);
  if (count >= cap) {
    const err = new DailyCapError(`daily LLM request cap reached (${cap})`);
    throw Object.assign(err, { key: 'llm.maxRequestsPerDay', used: count, cap });
  }
  bumpDaily(state.data, LLM_DAILY, nowMs);
  state.markDirty();
}

/** `llm.helperTimeoutMs` when it is missing: config.json's value. */
const HELPER_TIMEOUT_MS_FALLBACK = 30000;

/**
 * The options of one in-turn helper request -- a short call made on the way to
 * a reply (the `analyzer` passes: address, re-watch, search,
 * link read, search summary; the picture describer) -- so every helper is
 * spelled the same way: counted against `llm.maxRequestsPerDay`, never fed to
 * the calibration (a short or a vision prompt says nothing about the text
 * ratio), and cut at `llm.helperTimeoutMs` per attempt instead of the
 * turn-length `llm.timeoutMs`: while a helper is out it holds the persona's
 * one attention. `countAgainstDailyCap` and `skipCalibration` are not the
 * caller's to set. The model is not part of the set: the caller adds its own
 * (`{ model, ...helperRequestOptions(config, { ... }) }`). The set carries the
 * helper mark `helper: true` (never sent): only a marked request on a role
 * `llm.hedge.roles` lists is hedged by `complete` (see `hedgeSettings`), so the
 * memory wording, the memory extractor, the describers never are; the
 * reply only through an explicit `options.hedge` (see `complete`).
 * Pure; `config` is the live config read at the moment of use.
 * @param {object|null|undefined} config  The whole live config.
 * @param {object} [request]
 * @param {string} [request.role]             The subprocess, e.g. `analyzer` (see `complete`).
 * @param {number} [request.maxOutputTokens]  Undefined leaves `llm.maxOutputTokens` in charge.
 * @param {string} [request.purpose]          What the request is for, a kebab-case code for the
 *   `llm: usage` line (`address`, `rewatch`, `lookup`, `read-link`, `search-summary`, `route-channel`,
 *   `describe`); never sent.
 * @param {AbortSignal} [request.signal]      The caller's own abort signal, if it has one.
 * @param {number} [request.timeoutMs]        A helper with a clock of its own; else
 *   `llm.helperTimeoutMs`, else 30000 (config.json's value).
 * @param {boolean} [request.long]            True for a helper whose answer is a summary of several
 *   hundred tokens (recall, link read, search summary): hedged, its whole call is limited by
 *   `llm.hedge.longTimeoutMs` instead of `llm.hedge.timeoutMs`. Only `true` puts `long: true` in the
 *   set (never sent); anything else leaves the key out.
 * @returns {{ role: string|undefined, maxOutputTokens: number|undefined, countAgainstDailyCap: true,
 *   skipCalibration: true, timeoutMs: number, purpose: string|undefined, signal: AbortSignal|undefined, helper: true,
 *   long?: true }}
 */
export function helperRequestOptions(config, { role, maxOutputTokens, purpose, signal, timeoutMs, long } = {}) {
  return {
    role,
    maxOutputTokens,
    countAgainstDailyCap: true,
    skipCalibration: true,
    timeoutMs: timeoutMs ?? config?.llm?.helperTimeoutMs ?? HELPER_TIMEOUT_MS_FALLBACK,
    purpose,
    signal,
    helper: true,
    ...(long === true ? { long: true } : {}),
  };
}

/** `llm.hedge`, key by key, when the group is there but a key is missing or invalid: config.json's values. */
const HEDGE_FALLBACK = Object.freeze({ roles: Object.freeze(['analyzer']), afterMs: 2500, timeoutMs: 8000, longTimeoutMs: 20000 });

/**
 * The hedge settings of the live config, or null when `llm.hedge` is not an object (no hedge at
 * all, every request as without it). Inside the group a key that is missing or invalid reads as
 * config.json's: `roles` (the `options.role` values whose helper requests are hedged, each read
 * through `currentRoleName`; not an array -> `['analyzer']`), `afterMs` (how long the first attempt is given before a second one is
 * sent; a finite number >= 0, 0 = no hedge; else 2500), `timeoutMs` (the limit of the whole
 * hedged call, both attempts included; a finite number > 0, else 8000) and `longTimeoutMs` (the
 * same limit for a helper marked `long`, whose answer is a summary of several hundred tokens; a
 * finite number > 0, else 20000). Exists because the tail of a tiny request belongs to the
 * provider: one slow classifier must not hold a whole turn.
 * Pure; `config` is the whole live config read at the moment of use.
 * @param {unknown} config
 * @returns {{ roles: unknown[], afterMs: number, timeoutMs: number, longTimeoutMs: number }|null}
 */
export function hedgeSettings(config) {
  const group = config?.llm?.hedge;
  if (!isPlainObject(group)) return null;
  const finite = (value) => typeof value === 'number' && Number.isFinite(value);
  const limit = (value, fallback) => (finite(value) && value > 0 ? value : fallback);
  return {
    roles: Array.isArray(group.roles) ? group.roles.map(currentRoleName) : [...HEDGE_FALLBACK.roles],
    afterMs: finite(group.afterMs) && group.afterMs >= 0 ? group.afterMs : HEDGE_FALLBACK.afterMs,
    timeoutMs: limit(group.timeoutMs, HEDGE_FALLBACK.timeoutMs),
    longTimeoutMs: limit(group.longTimeoutMs, HEDGE_FALLBACK.longTimeoutMs),
  };
}

// The hedge of one request, or null to send it as ever. An explicit `options.hedge` (a plain
// object whose `afterMs` and `timeoutMs` are finite numbers above 0; never sent) wins, whatever
// the request: the reply of a turn with a bar carries one (`pace.replyHedgeMs`). Else only a
// helper's set (`options.helper === true`, from `helperRequestOptions`) on a role
// `llm.hedge.roles` lists, with `afterMs` above 0. `timeoutMs` is the limit of this call:
// `longTimeoutMs` for a set marked `long`.
function hedgeOf(config, options) {
  const explicit = options.hedge;
  const positive = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;
  if (isPlainObject(explicit) && positive(explicit.afterMs) && positive(explicit.timeoutMs)) {
    return { afterMs: explicit.afterMs, timeoutMs: explicit.timeoutMs };
  }
  if (options.helper !== true || typeof options.role !== 'string') return null;
  const hedge = hedgeSettings(config);
  if (!hedge || hedge.afterMs <= 0 || !hedge.roles.includes(options.role)) return null;
  return { afterMs: hedge.afterMs, timeoutMs: options.long === true ? hedge.longTimeoutMs : hedge.timeoutMs };
}

/**
 * Video tokens per second when `media.video.tokensPerSecond` is unset or
 * invalid: config.json's value (the rate of a statically sampled clip). The
 * media describer (src/memory/describe.js) sizes its clips with the same one.
 */
export const VIDEO_TOKENS_PER_SECOND_FALLBACK = 120;

export class TokenLimitError extends Error {}
export class DailyCapError extends Error {}

/**
 * An answered request that OpenRouter served from its own capacity (`usage.is_byok === false`)
 * on a route marked `byok: true`: the operator set that route to their own provider accounts,
 * so such an answer is a routing mistake that spent OpenRouter credits. Thrown after the answer
 * arrived, never retried (it was billed already); the caller's ordinary error path runs.
 * Message: `not byok: <model> via <provider>`.
 */
export class NotByokError extends Error {}

/**
 * Throws a `NotByokError` when the request's route is marked `byok: true` (exactly) and the
 * answer's usage says `is_byok: false`, after a `llm: not byok` warn line with `fields` (the usage
 * line's own fields: counts, ids and codes, never prompt or answer text). Exists because BYOK is a
 * property of a route: the operator runs some models on their own provider accounts and others,
 * knowingly, on OpenRouter's capacity. No route, a route without `byok` or with any other value,
 * and a missing or non-boolean `is_byok` all pass: an answer without a usage block is not a
 * violation. The one check, shared by the chat client, the embeddings client (src/llm/embed.js)
 * and the image client (src/llm/images.js).
 * @param {object|undefined} route  The request's resolved route (what `resolveProvider` returned).
 * @param {object} usage            The answer's `usage` object (`{}` when absent).
 * @param {object} fields           The fields of the request's `llm: usage` line.
 */
export function assertByok(route, usage, fields) {
  if (route?.byok !== true || usage?.is_byok !== false) return;
  log.warn('llm: not byok', fields);
  throw new NotByokError(`not byok: ${fields.model ?? 'unknown model'} via ${fields.provider ?? 'unknown provider'}`);
}

/**
 * The reason code of a request that was refused or failed, as callers log
 * and report it: `daily-cap` for a `DailyCapError`, `token-limit` for a
 * `TokenLimitError` (the two rails, refused before anything was sent),
 * `fallback` for anything else (an HTTP error, a network failure, a timeout).
 * The one mapping, so a refusal by the daily cap is never logged as a failed
 * request. A caller whose codes name "anything else" differently passes its own.
 * @param {unknown} err
 * @param {string} [fallback]
 * @returns {string}
 */
export function railReason(err, fallback = 'llm-error') {
  if (err instanceof DailyCapError) return 'daily-cap';
  if (err instanceof TokenLimitError) return 'token-limit';
  return fallback;
}

/** The cap keys already reported as not a number (one warn line per key and process). */
const reportedCaps = new Set();

/**
 * One rule for every daily rail (this client's requests, src/llm/images.js's
 * pictures, src/web/lookup.js's reads and searches): a cap that is not a
 * finite number -- missing, null, a string, Infinity -- counts as 0, so the
 * rail refuses everything (fail closed) instead of spending without a limit.
 * The first such cap of each `key` in a process logs
 * `llm: daily cap is not a number, refusing` with the key; later calls stay quiet.
 * @param {unknown} value  The configured cap, read by the caller at the moment of use.
 * @param {string} key     Its config path, e.g. `llm.maxRequestsPerDay`.
 * @returns {number}
 */
export function dailyCapOf(value, key) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!reportedCaps.has(key)) {
    reportedCaps.add(key);
    log.warn('llm: daily cap is not a number, refusing', { key });
  }
  return 0;
}

/**
 * The `llm.complete` options that name the persona's reply (src/behavior/turn.js, and its replay
 * in src/behavior/sandbox.js): role `core`, the one role on `models.core`, purpose `reply`. Spread
 * into a request's own options, never mutated.
 */
export const REPLY_REQUEST = Object.freeze({ role: 'core', purpose: 'reply' });

/**
 * The `llm.complete` options that name a request wording memory in the persona's voice (the
 * two-stage analyzer's voice run, its single-stage fallback, the warmup's and the portrait
 * refresh's wording requests): role `core` on `models.core` like the reply, purpose
 * `memory-voice`, and `cache: false`, so the prompt-cache marker stays on the reply only (a
 * cache write costs more than a plain prompt, and this system text is not the reply's).
 * Spread into a request's own options, never mutated.
 */
export const MEMORY_VOICE_REQUEST = Object.freeze({ role: 'core', purpose: 'memory-voice', cache: false });

/**
 * The former role names a deployment's config may still carry, each with the role it is read as:
 * `voice` and, before it, `talk`, the former names of `core` (the model that speaks as the
 * persona), and `reasoner`, the helper role merged into `analyzer` (2026-10).
 */
const RETIRED_ROLES = new Map([
  ['talk', 'core'],
  ['voice', 'core'],
  ['reasoner', 'analyzer'],
]);
/** The retired role names already reported in this process. */
const retiredRolesReported = new Set();

/**
 * A role name as written in a deployment's config, read under today's names: `voice` and
 * `talk`, the former names of the role `core`, are `core`; `reasoner`, merged into `analyzer`, is
 * `analyzer`; anything else is returned as it is. The one reader of the old names, used by the
 * three places a config may still carry them -- the role suffix of an `llm.providerByModel` key
 * (`matchRoute`), `llm.cache.roles` (`cacheTtlFor`) and `llm.hedge.roles` (`hedgeSettings`) -- so
 * an existing deployment keeps routing, caching and hedging those requests as before. The first
 * old name seen in a process logs `config: role <old> is now <new>` once; later ones stay quiet.
 * Requests never carry an old name: a request's own `options.role` is never read through this.
 * @param {unknown} role
 * @returns {unknown}
 */
export function currentRoleName(role) {
  if (typeof role !== 'string' || !RETIRED_ROLES.has(role)) return role;
  const use = RETIRED_ROLES.get(role);
  if (!retiredRolesReported.has(role)) {
    retiredRolesReported.add(role);
    log.warn(`config: role ${role} is now ${use}`, { role, use });
  }
  return use;
}

/**
 * One `llm.providerByModel` key split into its model prefix and its role:
 * `"<prefix>@<role>"` applies to that role only, a key without `@` to any
 * role (`role: null`). Split at the last `@`; model ids carry none.
 * @param {string} key
 * @returns {{ prefix: string, role: string|null }}
 */
export function parseRouteKey(key) {
  const at = key.lastIndexOf('@');
  if (at === -1) return { prefix: key, role: null };
  return { prefix: key.slice(0, at), role: key.slice(at + 1) };
}

/**
 * The `byModel` entry that routes `model` for `role`, or null: among the keys
 * for exactly this role, the longest case-sensitive prefix of `model` (an
 * exact id is simply the longest prefix); when none matches, the same among
 * the role-less keys. A role-specific key beats a role-less one whatever their
 * lengths; a role never takes another role's keys. A non-string or empty `role` matches
 * role-less keys only. A key's
 * role is read through `currentRoleName` (`"<prefix>@talk"` is a key for the
 * role `core`, and its entry's `role` says `voice`, the role's former name); `role` itself is taken as given.
 * Non-object entries and maps are ignored.
 * @param {unknown} model
 * @param {unknown} byModel
 * @param {unknown} [role]
 * @returns {{ key: string, prefix: string, role: string|null, value: object }|null}
 */
export function matchRoute(model, byModel, role) {
  if (typeof model !== 'string' || !isPlainObject(byModel)) return null;
  const wanted = typeof role === 'string' && role ? role : null;
  let bestRole = null;
  let bestAny = null;
  for (const [key, value] of Object.entries(byModel)) {
    if (!isPlainObject(value)) continue;
    const parsed = parseRouteKey(key);
    if (!model.startsWith(parsed.prefix)) continue;
    const keyRole = parsed.role === null ? null : currentRoleName(parsed.role);
    const entry = { key, prefix: parsed.prefix, role: keyRole, value };
    if (keyRole === null) {
      if (bestAny === null || parsed.prefix.length > bestAny.prefix.length) bestAny = entry;
    } else if (wanted !== null && keyRole === wanted) {
      if (bestRole === null || parsed.prefix.length > bestRole.prefix.length) bestRole = entry;
    }
  }
  return bestRole ?? bestAny;
}

/**
 * The OpenRouter provider routing for one request, or undefined to send none.
 * Precedence: a plain-object `override` (a caller pinning its own route), then
 * the `byModel` entry chosen by `matchRoute` for `model` and `role` (the
 * longest matching prefix among the keys for this role, else among the
 * role-less keys), then a plain-object `fallback`. Non-object entries, maps
 * and values are ignored. Exists because a provider restriction (e.g. `only`)
 * must differ per model family -- and per subprocess using the model -- when
 * the owner's own provider keys are used: one routing object cannot fit every
 * request. The chosen object is returned as is, never copied or mutated.
 * @param {unknown} model
 * @param {{ override?: unknown, byModel?: unknown, fallback?: unknown, role?: unknown }} [sources]
 * @returns {object|undefined}
 */
export function resolveProvider(model, { override, byModel, fallback, role } = {}) {
  if (isPlainObject(override)) return override;
  const route = matchRoute(model, byModel, role);
  if (route) return route.value;
  return isPlainObject(fallback) ? fallback : undefined;
}

/**
 * The request body's `provider` object for a resolved route: the route without its `byok` key,
 * the engine's own mark (see `assertByok`), never OpenRouter's. A route without the key is
 * returned as is; one with it is copied, never mutated. Undefined stays undefined. The one place
 * a route becomes a body, used by the chat, embeddings and image clients.
 * @param {object|undefined} route  What `resolveProvider` returned.
 * @returns {object|undefined}
 */
export function providerBodyOf(route) {
  if (!isPlainObject(route) || !Object.hasOwn(route, 'byok')) return route;
  const { byok: _byok, ...body } = route;
  return body;
}

const numberOrNull = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const stringOrNull = (value) => (typeof value === 'string' && value ? value : null);
// A token count read from a usage object: a finite positive number, else 0.
const countOrZero = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);

// ---- prompt caching ----------------------------------------------------------
// Every reply re-sends the same system message, and tokens read from a provider's prompt cache
// cost a fraction of fresh input (and, on some providers, nothing against the account's quota of
// the day). `complete()` is the one policy point: it puts a cache marker on the system message
// (and on the user text parts a builder tagged with a neutral `cacheSegment`: the reply's stable
// prefix and its profiles, see `withCacheMarker`)
// for the roles `llm.cache.roles` lists, on the model families `llm.cache.models` lists, while
// `features.promptCache` is on, AFTER the token estimate was taken, so the 50k rail and the
// calibration see exactly what they saw without it. The model gate exists because the engine is
// generic: a route that does not take `cache_control` parts could refuse every marked request, so
// a model outside the list is sent exactly as without caching, whatever the role.

/** The part field OpenRouter reads a cache breakpoint from. */
const CACHE_CONTROL = 'cache_control';
/** The neutral part field a request builder tags a cacheable text part with (src/behavior/prompt.js); never sent. */
const CACHE_SEGMENT = 'cacheSegment';
/** Breakpoints a provider accepts per request; markers past the first four are dropped. */
const MAX_CACHE_MARKERS = 4;
/** `llm.cache.roles` when it is not an array: config.json's value. */
const DEFAULT_CACHE_ROLES = Object.freeze(['core']);
/** `llm.cache.models` when it is not an array: the one family whose `cache_control` the marker follows. */
const DEFAULT_CACHE_MODELS = Object.freeze(['anthropic/']);

/**
 * The cache TTL to mark one request with, or null for no marker. `force === false` -> null;
 * `force === true` -> the TTL whatever the switch, the role list and the model list say (one
 * call that must be cached, e.g. a probe); anything else -> null unless
 * `config.features.promptCache === true` (missing = off), `role` is in `config.llm.cache.roles`
 * (each read through `currentRoleName`; not an array -> `['core']`) and `model` starts with one of the strings in
 * `config.llm.cache.models` (case-sensitive, like `llm.providerByModel`; not an array ->
 * `['anthropic/']`; a model that is not a string matches none).
 * The TTL is `'5m'` when `config.llm.cache.ttl` is exactly `'5m'`, else `'1h'` (config.json's).
 * Pure; the caller passes the live config read at the moment of use.
 * @param {unknown} config  The whole live config.
 * @param {unknown} role    The request's `options.role`.
 * @param {unknown} model   The model id the request is sent to (`body.model`).
 * @param {unknown} [force] The request's `options.cache`.
 * @returns {'1h'|'5m'|null}
 */
export function cacheTtlFor(config, role, model, force) {
  if (force === false) return null;
  const cache = config?.llm?.cache;
  const ttl = cache?.ttl === '5m' ? '5m' : '1h';
  if (force === true) return ttl;
  if (config?.features?.promptCache !== true) return null;
  const roles = Array.isArray(cache?.roles) ? cache.roles : DEFAULT_CACHE_ROLES;
  if (typeof role !== 'string' || !roles.some((listed) => currentRoleName(listed) === role)) return null;
  const models = Array.isArray(cache?.models) ? cache.models : DEFAULT_CACHE_MODELS;
  const listed = typeof model === 'string' && models.some((prefix) => typeof prefix === 'string' && model.startsWith(prefix));
  return listed ? ttl : null;
}

/**
 * The configured cache TTL (`config.llm.cache.ttl`, the rule of `cacheTtlFor`) in milliseconds:
 * five minutes for `'5m'`, else one hour. The length of the time bucket over which the reply's
 * stable part holds what memory changes (src/behavior/prompt.js#freezePerBucket), so a memory
 * batch rewrites the cached prefix at most once per TTL. Pure; the caller passes the live config.
 * @param {unknown} config  The whole live config.
 * @returns {number}
 */
export function cacheTtlMs(config) {
  return config?.llm?.cache?.ttl === '5m' ? 5 * MINUTE_MS : HOUR_MS;
}

/**
 * The TTL of the profiles segment's marker (`cacheSegment: 'profiles'`, see `withCacheMarker`):
 * `config.llm.cache.profilesTtl` -- `'5m'` as it is, `null` or `false` -> null (no marker on that
 * part), anything else (missing included) `'1h'`, config.json's value. Pure; the caller passes
 * the live config read at the moment of use.
 * @param {unknown} config  The whole live config.
 * @returns {'1h'|'5m'|null}
 */
export function profilesTtlFor(config) {
  const value = config?.llm?.cache?.profilesTtl;
  if (value === null || value === false) return null;
  return value === '5m' ? '5m' : '1h';
}

// The marker of one TTL, a fresh object per call: `5m` is the provider's default (no `ttl` key),
// `1h` names itself. Anything else is no marker.
function cacheMarkerFor(ttl) {
  if (ttl === '1h') return { type: 'ephemeral', ttl: '1h' };
  if (ttl === '5m') return { type: 'ephemeral' };
  return null;
}

// The index of the last text part with a non-empty text in a content array, or -1.
function lastTextPart(content) {
  return content.findLastIndex((part) => isPlainObject(part) && part.type === 'text' && typeof part.text === 'string' && part.text !== '');
}

/**
 * The tool calls of an answer's message (`choices[0].message.tool_calls`) as
 * `[{ id, name, arguments, parsed, parseError }]`: `arguments` the raw string the model wrote
 * (as sent, '' when absent), `parsed` its JSON object (null when it is not a JSON object --
 * empty arguments read as `{}`), `parseError` the parse failure's message or null. An entry
 * that is not an object with a function is skipped. [] when there are none.
 * @param {unknown} calls
 * @returns {{ id: string|null, name: string, arguments: string, parsed: object|null, parseError: string|null }[]}
 */
export function toolCallsOf(calls) {
  if (!Array.isArray(calls)) return [];
  const out = [];
  for (const call of calls) {
    if (!isPlainObject(call) || !isPlainObject(call.function)) continue;
    const raw = call.function.arguments;
    const text = typeof raw === 'string' ? raw : raw === undefined || raw === null ? '' : JSON.stringify(raw);
    let parsed = null;
    let parseError = null;
    if (text.trim() === '') parsed = {};
    else {
      try {
        const value = JSON.parse(text);
        if (isPlainObject(value)) parsed = value;
        else parseError = 'arguments are not a JSON object';
      } catch (err) {
        parseError = err.message;
      }
    }
    out.push({
      id: typeof call.id === 'string' ? call.id : null,
      name: typeof call.function.name === 'string' ? call.function.name : '',
      arguments: text,
      parsed,
      parseError,
    });
  }
  return out;
}

/**
 * `messages` as they are sent under the cache policy: a new array, the input never mutated (a
 * message or part that needs no change is passed on as the same object, and with nothing to
 * change the very same array comes back, so the body serialises exactly as without this step).
 * With a TTL (`'1h'` / `'5m'`): the first `system` message carries the marker on its end -- a
 * non-empty string content becomes one text part `{ type: 'text', text, cache_control }`, an
 * array content gets it on its last non-empty text part -- and every `cache_control` a builder
 * already placed on any part takes the same marker; only the first four markers in message order
 * survive, the rest are removed. A part a builder tagged with `cacheSegment` (the reply's user
 * message, src/behavior/prompt.js#buildRequest) gets a marker too: `'stable'` the request's
 * `ttl`, `'profiles'` `profilesTtl` (from `profilesTtlFor`; null -> none), never longer than a
 * `'5m'` `ttl` (a longer TTL must not follow a shorter one); any other value none. The
 * `cacheSegment` field itself is removed from every part in every case, so it never reaches the
 * provider. A request with more than two messages (a turn's appended steps) also gets a `5m` marker
 * on the last part of its last message when fewer than four are placed (the latest tool message, or the
 * note's text part). Without a system message (or with an empty one) no marker is added to it. With
 * anything else (null): every `cache_control` and every `cacheSegment` on any part is removed and
 * nothing else changes (a string system content stays a string).
 * @param {object[]} messages  The caller's chat-completions messages.
 * @param {'1h'|'5m'|null} ttl From `cacheTtlFor`.
 * @param {'1h'|'5m'|null} [profilesTtl] From `profilesTtlFor`; omitted -> no profiles marker.
 * @returns {object[]}
 */
export function withCacheMarker(messages, ttl, profilesTtl = null) {
  if (!Array.isArray(messages)) return messages;
  const marker = cacheMarkerFor(ttl);
  const segmentMarkers = {
    stable: marker,
    profiles: marker ? cacheMarkerFor(ttl === '5m' && profilesTtl ? '5m' : profilesTtl) : null,
  };
  const systemAt = marker ? messages.findIndex((message) => isPlainObject(message) && message.role === 'system') : -1;
  let kept = 0;
  // One part on its way out: the request's marker when it is the system breakpoint or already
  // carried one, its segment's marker when it is tagged with one, while fewer than four are
  // placed; otherwise without any `cache_control`. Never with a `cacheSegment`.
  const settle = (part, breakpoint) => {
    const placed = Object.hasOwn(part, CACHE_CONTROL);
    const tagged = Object.hasOwn(part, CACHE_SEGMENT);
    const segmentMarker = tagged && Object.hasOwn(segmentMarkers, part[CACHE_SEGMENT]) ? segmentMarkers[part[CACHE_SEGMENT]] : null;
    const wanted = marker && (placed || breakpoint) ? marker : segmentMarker;
    const { [CACHE_CONTROL]: _removed, [CACHE_SEGMENT]: _segment, ...rest } = part;
    if (wanted && kept < MAX_CACHE_MARKERS) {
      kept += 1;
      return { ...rest, [CACHE_CONTROL]: { ...wanted } };
    }
    return placed || tagged ? rest : part;
  };
  const sent = messages.map((message, index) => {
    if (!isPlainObject(message)) return message;
    const { content } = message;
    if (index === systemAt && typeof content === 'string') {
      if (content === '' || kept >= MAX_CACHE_MARKERS) return message;
      return { ...message, content: [settle({ type: 'text', text: content }, true)] };
    }
    if (!Array.isArray(content)) return message;
    const breakpoint = index === systemAt ? lastTextPart(content) : -1;
    const parts = content.map((part, at) => (isPlainObject(part) ? settle(part, at === breakpoint) : part));
    return parts.some((part, at) => part !== content[at]) ? { ...message, content: parts } : message;
  });
  // A turn that appended steps to its first two messages (src/behavior/tool-step.js#appendStep): the
  // last part of the appended prefix -- the latest tool message, or the note's text part -- carries a
  // fourth marker, so the next step reads everything before it from the cache. Always the short TTL
  // (a longer one must not follow a shorter one, and a turn's steps follow each other within minutes).
  const tail = marker && messages.length > 2 && kept < MAX_CACHE_MARKERS ? tailMarked(sent, cacheMarkerFor('5m')) : sent;
  return tail.some((message, index) => message !== messages[index]) ? tail : messages;
}

/**
 * `sent` (the messages as `withCacheMarker` settled them) with `tailMarker` on the last part of the
 * last message: a string content (a tool message) becomes one text part carrying it, an array gets it
 * on its last non-empty text part unless that part carries a marker already. `sent` itself is not changed.
 */
function tailMarked(sent, tailMarker) {
  const at = sent.length - 1;
  const last = sent[at];
  if (!isPlainObject(last) || last.role === 'system') return sent;
  let content = null;
  if (typeof last.content === 'string') {
    if (last.content !== '') content = [{ type: 'text', text: last.content, [CACHE_CONTROL]: { ...tailMarker } }];
  } else if (Array.isArray(last.content)) {
    const part = lastTextPart(last.content);
    if (part !== -1 && !Object.hasOwn(last.content[part], CACHE_CONTROL)) {
      content = last.content.map((item, i) => (i === part ? { ...item, [CACHE_CONTROL]: { ...tailMarker } } : item));
    }
  }
  if (content === null) return sent;
  const out = [...sent];
  out[at] = { ...last, content };
  return out;
}

// Whether any part of `messages` carries a `cache_control` (what was actually sent).
function hasCacheMarker(messages) {
  return Array.isArray(messages) && messages.some(
    (message) => Array.isArray(message?.content) && message.content.some((part) => isPlainObject(part) && Object.hasOwn(part, CACHE_CONTROL)),
  );
}

/**
 * The provider's count of the WHOLE prompt of one answered request -- the cached and the
 * cache-written parts included -- or null when the usage reports none. What the calibration and
 * the over-cap warning are fed: if they saw only the uncached part, the ratio would sink toward
 * its floor and the 50k rail would under-estimate. `config.llm.cache.promptIncludesCached`
 * (missing = true, config.json's) says how the marked route reports it, set by the owner from a
 * probe and never guessed per response: true -> `usage.prompt_tokens` as reported (OpenRouter's
 * normalised usage counts cached and written tokens inside it); false -> for a request that was
 * sent with a cache marker (`marked === true`, the route the probe measured), `prompt_tokens` plus
 * `prompt_tokens_details.cached_tokens` plus `prompt_tokens_details.cache_write_tokens` (a detail
 * that is not a positive count adds nothing). An unmarked request always counts `prompt_tokens`
 * as reported: a provider that caches on its own already counts those tokens inside it.
 * `prompt_tokens` must be a finite number >= 0; a total that is not positive is null.
 * @param {unknown} usage   The response's `usage` object.
 * @param {unknown} config  The whole live config.
 * @param {unknown} marked  Whether the sent request carried a cache marker (only `true` counts).
 * @returns {number|null}
 */
export function fullPromptTokens(usage, config, marked) {
  const prompt = usage?.prompt_tokens;
  if (typeof prompt !== 'number' || !Number.isFinite(prompt) || prompt < 0) return null;
  let total = prompt;
  if (marked === true && config?.llm?.cache?.promptIncludesCached === false) {
    total += countOrZero(usage.prompt_tokens_details?.cached_tokens) + countOrZero(usage.prompt_tokens_details?.cache_write_tokens);
  }
  return total > 0 ? total : null;
}

// The `cache` code of one `llm: usage` line: `off` when the request carried no marker; else what
// the provider reports doing with the marked prefix -- `read` when any prompt tokens came from
// the cache (a read wins over a write in the same answer: the cache paid off), `write` when
// tokens were only written to it, `none` when neither (a prefix under the provider's minimum, or
// a marker dropped on the way).
function cacheCode(marked, usage) {
  if (!marked) return 'off';
  if (countOrZero(usage?.prompt_tokens_details?.cached_tokens) > 0) return 'read';
  if (countOrZero(usage?.prompt_tokens_details?.cache_write_tokens) > 0) return 'write';
  return 'none';
}

// The fields of one `llm: usage` line, so a day's spend can be split by role and, inside a
// role, by what the request was for: who asked (`role`, `model`; `purpose` = the caller's
// `options.purpose`, which tells apart the helpers that share one role; `origin` = the caller's
// `options.origin`, e.g. `replay` for a request that is not live chat traffic), who served it
// (`provider`, `id`), what it cost, read from OpenRouter's `usage` and its detail objects, what
// the prompt cache did (`cache`, see `cacheCode`; `marked` = the sent request carried a marker)
// and how long it took (`ms`: whole milliseconds on the client's clock from the start of the
// first attempt to the answer, retried attempts and their backoff included; never negative,
// null when the clock gave no number). Numbers, booleans, ids and codes only -- an absent value
// or one of another type is null -- so the line never carries text of a prompt or an answer.
function usageLogFields(json, usage, model, options, marked, elapsedMs) {
  return {
    role: stringOrNull(options.role),
    purpose: stringOrNull(options.purpose),
    origin: stringOrNull(options.origin),
    model: stringOrNull(model),
    provider: stringOrNull(json.provider),
    promptTokens: numberOrNull(usage.prompt_tokens),
    completionTokens: numberOrNull(usage.completion_tokens),
    reasoningTokens: numberOrNull(usage.completion_tokens_details?.reasoning_tokens),
    cachedTokens: numberOrNull(usage.prompt_tokens_details?.cached_tokens),
    cacheWriteTokens: numberOrNull(usage.prompt_tokens_details?.cache_write_tokens),
    cache: cacheCode(marked, usage),
    cost: numberOrNull(usage.cost),
    upstreamCost: numberOrNull(usage.cost_details?.upstream_inference_cost),
    byok: typeof usage.is_byok === 'boolean' ? usage.is_byok : null,
    id: stringOrNull(json.id),
    ms: Number.isFinite(elapsedMs) ? Math.max(0, Math.round(elapsedMs)) : null,
  };
}

// The `error.metadata.limit_source` of a limit hit on the provider account behind the route
// (the owner's own key with that provider), as opposed to one of OpenRouter's own limits.
const UPSTREAM_ACCOUNT = 'upstream_provider_account';
// The provider's own text (`error.metadata.raw`) for a quota of the day, then for a short-window
// throttle. Protocol data, matched here and never logged: a reworded text falls to `unknown`.
// The day is checked first, so a text naming both ("too many requests per day") is `daily`.
const DAILY_LIMIT = /per\s*day|daily/i;
const RATE_LIMIT = /per\s*minute|too many requests|too many tokens/i;

// What an error body says about the limit that was hit -- the one parser of it, behind
// `providerLimitOf`: `limitSource` and `provider` from a JSON body's `error.metadata`
// (`limit_source`, `provider_name`), each only when it is a non-empty string.
// `kind` only for a 429 on the provider account: `daily` or `rate` by the raw text, `unknown`
// when it is absent or matches neither. No body, a body that is not JSON or one of another shape
// gives all three null. Never the body itself -- it may echo the request.
function bodyLimit(status, rawBody) {
  const limit = { limitSource: null, provider: null, kind: null };
  if (typeof rawBody !== 'string') return limit;
  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return limit;
  }
  const metadata = parsed?.error?.metadata;
  if (!isPlainObject(metadata)) return limit;
  limit.limitSource = stringOrNull(metadata.limit_source);
  limit.provider = stringOrNull(metadata.provider_name);
  if (status === 429 && limit.limitSource === UPSTREAM_ACCOUNT) {
    const raw = stringOrNull(metadata.raw) ?? '';
    limit.kind = DAILY_LIMIT.test(raw) ? 'daily' : RATE_LIMIT.test(raw) ? 'rate' : 'unknown';
  }
  return limit;
}

/**
 * Which limit a failed request hit, read from the error `complete()` throws for a non-ok answer
 * (`statusCode`, `body`): null when `err` carries no numeric `statusCode` (a rail refusal, a
 * network failure, a timeout). `limitSource` / `provider` come from the JSON body's
 * `error.metadata` (null when absent); `kind` is set only for a 429 whose `limit_source` is
 * `upstream_provider_account` -- `'daily'` when the provider's raw text names a quota of the day
 * (it comes back in minutes, not within the retry backoff), `'rate'` when it names a
 * short-window throttle, `'unknown'` otherwise -- and null for every other status and for
 * OpenRouter's own 429.
 * Codes and names only: the provider's raw text is matched, never returned.
 * @param {unknown} err
 * @returns {{ status: number, limitSource: string|null, provider: string|null, kind: 'daily'|'rate'|'unknown'|null }|null}
 */
export function providerLimitOf(err) {
  const status = err?.statusCode;
  if (!Number.isInteger(status)) return null;
  return { status, ...bodyLimit(status, err.body) };
}

/**
 * The short code of a failed model call, for the turn result's `reason`, the journal and the
 * status card: `provider-limit` (any 429: a quota of the day or a throttle), `provider-error`
 * (another HTTP status, or a network failure), `timeout` (a timed-out or aborted attempt), else
 * `error` (a rail refusal or any other exception). Only the status, the error name and the
 * message shape are read, never the provider's text.
 * @param {unknown} err
 * @returns {'provider-limit'|'provider-error'|'timeout'|'error'}
 */
export function errorCodeOf(err) {
  const status = err?.statusCode;
  if (Number.isInteger(status)) return status === 429 ? 'provider-limit' : 'provider-error';
  if (err instanceof TokenLimitError || err instanceof DailyCapError || err instanceof NotByokError) return 'error';
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError' || /timed out/i.test(String(err?.message ?? ''))) return 'timeout';
  if (err instanceof TypeError && /fetch failed|network/i.test(String(err.message ?? ''))) return 'provider-error';
  return 'error';
}

// The `llm: retry` fields of a retried error: `limitSource`, `provider` and `kind`, each only
// when `providerLimitOf` found it (nothing for an error without an HTTP status).
function retryLimitFields(err) {
  const limit = providerLimitOf(err);
  if (!limit) return {};
  const { limitSource, provider, kind } = limit;
  const fields = {};
  if (limitSource) fields.limitSource = limitSource;
  if (provider) fields.provider = provider;
  if (kind) fields.kind = kind;
  return fields;
}

// The error of a non-ok answer: the status on `.statusCode`, the full (untrimmed) body on `.body`
// for a caller that needs more than the 500-char message allows -- e.g. `/nep ping` picking
// OpenRouter's `routing_funnel` diagnostic out of a "No endpoints found" error.
async function httpErrorOf(response) {
  const rawBody = await response.text();
  const error = new Error(`OpenRouter HTTP ${response.status}: ${rawBody.slice(0, 500)}`);
  error.statusCode = response.status;
  error.body = rawBody;
  return error;
}

// The parsed body of a 200. A 200 may be billed, so what goes wrong from here is thrown and never
// retried: a `json.error` body, or a body that is not JSON.
async function answerJsonOf(response) {
  const json = await response.json();
  if (json.error) throw new Error(`OpenRouter error: ${JSON.stringify(json.error).slice(0, 500)}`);
  return json;
}

// The error of a 200 whose first choice failed at the provider (a plain-object `choices[0].error`,
// or `finish_reason: 'error'`), else null: the provider's message (else the finish reason), its
// numeric `code` on `.statusCode` (else undefined), `error.metadata.error_type` on `.errorType`
// and `native_finish_reason` on `.nativeFinishReason` (null when absent).
function choiceErrorOf(json) {
  const choice = json?.choices?.[0];
  const detail = isPlainObject(choice?.error) ? choice.error : null;
  if (!detail && choice?.finish_reason !== 'error') return null;
  const message = typeof detail?.message === 'string' && detail.message ? detail.message : String(choice.finish_reason ?? 'error');
  const error = new Error(message);
  error.statusCode = typeof detail?.code === 'number' ? detail.code : undefined;
  error.errorType = detail?.metadata?.error_type ?? null;
  error.nativeFinishReason = choice.native_finish_reason ?? null;
  return error;
}

// One attempt of a hedged call, never rejecting (a loser's late failure is no unhandled
// rejection): `{ json }` for an answer, else `{ err, answered, retryable }` -- `answered` when the
// provider sent a status (an HTTP error, or an error after a 200), `retryable` when the ordinary
// loop would retry it (a network failure, a timed-out attempt, a status in RETRY_STATUS).
async function hedgeAttempt(send, signal) {
  let response;
  try {
    response = await send(signal);
    if (!response.ok) throw await httpErrorOf(response);
  } catch (err) {
    const status = err?.statusCode;
    return { err, answered: Number.isInteger(status), retryable: !status || RETRY_STATUS.has(status) };
  }
  try {
    return { json: await answerJsonOf(response) };
  } catch (err) {
    return { err, answered: true, retryable: false };
  }
}

// The error a failed hedged call throws: the first of the highest rank -- a rail refusal (3) over
// an error the provider answered with (2) over a network failure or a timeout (1).
function mostInformative(failures) {
  return failures.reduce((best, failure) => (failure.rank > best.rank ? failure : best)).err;
}

// The error of a hedged call cut at its limit (`llm.hedge.timeoutMs` or `longTimeoutMs`).
function hedgeTimeoutError(ms) {
  return Object.assign(new Error(`hedged request timed out after ${ms} ms`), { name: 'TimeoutError' });
}

/**
 * @param {object} deps
 * @param {string} deps.apiKey           `OPENROUTER_API_KEY`: every role `llm.keyByRole` does not map elsewhere.
 * @param {Record<string, string|undefined>} [deps.env]  The parsed `.env` the role keys are looked up in (`roleApiKey`).
 * @param {() => object} deps.getConfig   Returns the live config (hot-reloaded).
 * @param {object} deps.calibrator        From createCalibrator().
 * @param {object} deps.state             Persistent state with `llmDay` / `llmCount` fields.
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {() => number} [deps.now]       Clock in ms, for the day rollover and a request's logged duration.
 * @param {(fn: () => void, ms: number) => unknown} [deps.setTimer]  The hedge's timers (`setTimeout`).
 * @param {(handle: unknown) => void} [deps.clearTimer]              Their cancel (`clearTimeout`).
 * @returns {{ complete: Function, modelEndpoints: Function, keyInfo: Function, credits: Function, activity: Function, keyHash: Function, roleKeys: () => Array<{ roles: string[] }>, capLeft: (nowMs?: number) => number }}
 */
export function createLlm({
  apiKey,
  env = {},
  getConfig,
  calibrator,
  state,
  fetchImpl = fetch,
  now = Date.now,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle),
}) {
  /**
   * The requests `llm.maxRequestsPerDay` still allows today, read only: the cap, read now,
   * minus `llmCountToday` (the stored count of another UTC day reads as 0, so the whole cap is
   * back at 00:00 UTC), never below 0. `state.data` is never touched and nothing is logged:
   * the pair is rolled over by the next counted request. Infinity while the cap is not a finite
   * number -- that misconfiguration is `complete()`'s own to refuse and report (`dailyCapOf`),
   * not a reader's to answer for. For a helper that would otherwise download, reserve or cache
   * something before `complete()` refuses it: `capLeft() <= 0` means the next counted request
   * throws a `DailyCapError`. Only a look: a request sent in between can take the last slot.
   * @param {number} [nowMs]  Defaults to the client's clock.
   * @returns {number}
   */
  function capLeft(nowMs = now()) {
    const cap = getConfig().llm?.maxRequestsPerDay;
    if (typeof cap !== 'number' || !Number.isFinite(cap)) return Infinity;
    return Math.max(0, cap - llmCountToday(state.data, nowMs));
  }

  function countRequest(configured) {
    countLlmRequest(state, configured, now());
  }

  // The one `llm: provider limit` line of a provider's quota of the day, thrown without a retry.
  function logProviderLimit(options, model, limit) {
    log.warn('llm: provider limit', {
      role: stringOrNull(options.role),
      model: stringOrNull(model),
      status: limit.status,
      limitSource: limit.limitSource,
      provider: limit.provider,
      kind: limit.kind,
      retried: false,
    });
  }

  /**
   * One hedged call (see `complete`): attempt 1 now; attempt 2, the same body, at `hedge.afterMs`
   * -- or at once when attempt 1 fails first with a retryable error (the hedge is the call's
   * retry) -- unless the daily cap has no room for it. The first answer wins and the attempt
   * still out is aborted. A failure while the other attempt is out waits for it; a non-retryable
   * failure of attempt 1 alone and a provider's quota of the day are thrown at once. At
   * `hedge.timeoutMs` from the start everything is aborted. The caller's `options.signal` aborts
   * both. Never retried past its two attempts. Resolves with the winning JSON body.
   * @param {(signal: AbortSignal) => Promise<Response>} send  One POST of the request body.
   * @param {{ hedge: { afterMs: number, timeoutMs: number }, options: object, model: unknown, attemptTimeoutMs: number }} call
   * @returns {Promise<{ json: object, attempt: number, hedged: boolean }>}
   */
  function hedgedCall(send, { hedge, options, model, attemptTimeoutMs }) {
    return new Promise((resolve, reject) => {
      const attempts = []; // { controller, done }, in the order sent
      const failures = []; // { err, rank }, in the order they came
      const timers = [];
      let settled = false;
      let secondTried = false;
      const running = () => attempts.filter((attempt) => !attempt.done).length;

      // Settle once: timers cleared, the caller's signal left, every attempt still out (never the winner) aborted.
      const close = (winner) => {
        settled = true;
        for (const timer of timers) clearTimer(timer);
        options.signal?.removeEventListener('abort', onAbort);
        attempts.forEach((attempt, index) => {
          if (index + 1 !== winner && !attempt.done) attempt.controller.abort();
        });
      };
      const fail = (err) => {
        if (settled) return;
        close(0);
        reject(err);
      };
      function onAbort() {
        fail(options.signal.reason ?? new Error('request aborted'));
      }

      const settle = (number, outcome) => {
        if (settled) return;
        if (outcome.json) {
          close(number);
          resolve({ json: outcome.json, attempt: number, hedged: attempts.length > 1 });
          return;
        }
        const { err } = outcome;
        // A provider's quota of the day comes back in minutes: never hedged around.
        const limit = providerLimitOf(err);
        if (limit?.kind === 'daily') {
          logProviderLimit(options, model, limit);
          fail(err);
          return;
        }
        failures.push({ err, rank: outcome.answered ? 2 : 1 });
        if (running() > 0) return;
        if (!secondTried) {
          if (!outcome.retryable) {
            fail(err); // attempt 1 alone, answered for good: the result, as without a hedge
            return;
          }
          second();
          if (running() > 0) return;
        }
        fail(mostInformative(failures));
      };

      const launch = () => {
        const controller = new AbortController();
        const attempt = { controller, done: false };
        attempts.push(attempt);
        const number = attempts.length;
        const signals = [controller.signal, AbortSignal.timeout(attemptTimeoutMs)];
        if (options.signal) signals.push(options.signal);
        hedgeAttempt(send, AbortSignal.any(signals)).then((outcome) => {
          attempt.done = true;
          settle(number, outcome);
        });
      };

      // The second attempt, tried once: counted like the first; with no room left under the
      // daily cap it is never sent, and the refusal is kept as the call's most telling failure.
      const second = () => {
        if (settled || secondTried) return;
        secondTried = true;
        if (options.countAgainstDailyCap !== false) {
          try {
            countRequest(getConfig().llm?.maxRequestsPerDay);
          } catch (err) {
            failures.push({ err, rank: 3 });
            return;
          }
        }
        log.info('llm: hedge', {
          role: stringOrNull(options.role),
          purpose: stringOrNull(options.purpose),
          model: stringOrNull(model),
          afterMs: hedge.afterMs,
        });
        launch();
      };

      const startTimer = (fn, ms) => {
        const handle = setTimer(fn, ms);
        handle?.unref?.();
        timers.push(handle);
      };

      options.signal?.addEventListener('abort', onAbort, { once: true });
      launch();
      if (hedge.afterMs < hedge.timeoutMs) startTimer(second, hedge.afterMs);
      startTimer(() => {
        // The cut itself comes first among the failures of its rank: a timeout, not a network error.
        failures.unshift({ err: hedgeTimeoutError(hedge.timeoutMs), rank: 1 });
        fail(mostInformative(failures));
      }, hedge.timeoutMs);
    });
  }

  /**
   * Send one chat completion. Returns `{ text, usage, estimated, finishReason, provider, promptTokens }`.
   * `promptTokens` is the provider's count of the whole prompt, its cached part included
   * (`fullPromptTokens` with whether this request carried a cache marker), or null when the
   * usage reports none -- the count a caller's own token budget should add up, since a raw
   * `usage.prompt_tokens` may leave the cached part out (`llm.cache.promptIncludesCached` false).
   * `finishReason` is the provider's `choices[0].finish_reason` verbatim
   * (e.g. `'stop'`, `'length'`), or `undefined` when the provider omitted it —
   * callers use it to tell a cut-off completion (`'length'`) from a genuinely
   * bad answer. `provider` is OpenRouter's name for the upstream provider that
   * served the request (`json.provider`), or `undefined` when the response omits it.
   * `options.tools` -- native tool definitions (OpenAI format, src/skills/tools-json.js); a non-empty
   * array is sent as `tools` with `tool_choice` = `options.toolChoice` (default 'auto') and, when
   * boolean, `parallel_tool_calls` = `options.parallelToolCalls`; the estimate and the token cap
   * count them. Only then the result carries `toolCalls` (`toolCallsOf`), beside `text`. `messages`
   * may hold an assistant message with `tool_calls` (content may be null) and `role: 'tool'`
   * messages (`tool_call_id`, `content`), sent as given. Without `tools` nothing changes.
   * `options.model` / `options.maxOutputTokens` / `options.temperature`
   * override the config defaults (`models.core`, `llm.maxOutputTokens`, `llm.temperature`).
   *
   * Retries (`llm.retries`): a network failure, a timed-out attempt and an
   * HTTP status in `RETRY_STATUS` are retried after `backoffMs`, each retried
   * attempt logged as `llm: retry` (`attempt` 1-based, `status` or null,
   * `name`, plus `limitSource` / `provider` when the error body is JSON naming
   * them in `error.metadata`, and `kind` when `providerLimitOf` finds one); the
   * last one is thrown. One exception: a 429 whose body names the provider
   * account's quota of the day (kind `daily`) is thrown after that one attempt
   * (same `statusCode`, `body` and message) and logged once as
   * `llm: provider limit` (role, model, status, limitSource, provider, kind,
   * `retried: false`; codes only, never the provider's text). Once a 200 was received
   * (the request may be billed) nothing is retried: a `json.error` body or an
   * unparsable body is thrown as it is, and so is an error the provider put
   * in the first choice (`choices[0].error`, or `finish_reason: 'error'`):
   * an Error with the provider's message, its numeric code on `statusCode`,
   * `errorType` (`error.metadata.error_type`) and `nativeFinishReason`,
   * logged once as `llm: provider error` (role, purpose, model, status,
   * errorType, nativeFinishReason, ms) with no `llm: usage` line.
   * Every other answered request logs one `llm: usage` line (role, purpose, origin,
   * model, provider, token counts, the prompt cache's `cache` code -- `read` |
   * `write` | `none`, or `off` when no marker was sent --, cost, BYOK flag,
   * response id, and `ms`, the time from the start of the first attempt to the
   * answer; null where the response or the caller omits a value), whatever its
   * role -- see `usageLogFields`.
   * Hedged calls (`llm.hedge`, see `hedgeSettings`): a request carrying the
   * helper mark (`options.helper === true`, set by `helperRequestOptions` only;
   * never sent) whose `options.role` is listed in `llm.hedge.roles`, while
   * `llm.hedge.afterMs` is above 0, never enters the retry loop above: attempt 1
   * is sent; one answering before `afterMs` (a success or a non-retryable error)
   * is the result as ever; at `afterMs` -- or at once when attempt 1 fails first
   * with a retryable error -- attempt 2 is sent with the same body (logged once as
   * `llm: hedge` with role, purpose, model, afterMs) and the first success wins,
   * the other attempt aborted. A failure while the other attempt is out waits
   * for it; when both fail the most telling error is thrown (a rail refusal over
   * an error the provider answered with over a network failure or a timeout). At
   * `llm.hedge.timeoutMs` from the start (`llm.hedge.longTimeoutMs` for a set
   * marked `options.long === true`, also never sent) both are aborted and a
   * `TimeoutError` is thrown. A provider's quota of the day is thrown at once, as above. Rails: the
   * token cap is checked once; attempt 2 is counted against
   * `llm.maxRequestsPerDay` when it is sent and is never sent without room under
   * it. The winner's usage line adds `hedged` (whether attempt 2 was sent) and
   * `attempt` (1 or 2, the winner); `ms` still runs from attempt 1's start.
   * `options.timeoutMs` still cuts each attempt on its own.
   * `options.hedge` — an explicit hedge for this one call, `{ afterMs, timeoutMs }` (both finite
   * numbers above 0; never sent): any request carrying one is hedged as above, with attempt 2
   * at its `afterMs` and the whole call cut at its `timeoutMs`, whatever its role and with or
   * without the helper mark or an `llm.hedge` group; the rails, the counting of attempt 2 and
   * the cache marker (the same body twice) are as above. Anything else leaves the helper rule
   * in charge. Exists for the reply of a turn with a bar (`pace.replyHedgeMs`): a provider stall
   * must not let a direct call pass its bar unanswered.
   * `options.purpose` — what the request is for, a kebab-case code (`reply`,
   * `memory-voice`, `address`, `rewatch`, `lookup`, `read-link`,
   * `search-summary`, `describe`, ...): the requests that share one role are told
   * apart by it in the journal (the reply and the memory wording both go out as
   * role `core`).
   * `options.origin` — where the request comes from when it is not live chat
   * traffic (e.g. `replay`), so a day's count can leave it out. Both are
   * logged on the usage line only: never sent in the request body, never
   * used for routing.
   * The calibrator is fed, and the over-cap warning
   * (`llm: provider counted more prompt tokens than the cap`) compares, the
   * provider's count of the whole prompt, its cached part included
   * (`promptTokens` above: `fullPromptTokens`, by `llm.cache.promptIncludesCached`
   * for a marked request).
   * `options.cache` — the prompt-cache marker for this one call: `true` forces
   * it (whatever the model), `false` forbids it, anything else leaves the policy
   * in charge (a marker only while `features.promptCache` is true, `options.role`
   * is listed in `llm.cache.roles` and the request's model starts with a prefix
   * listed in `llm.cache.models`; see `cacheTtlFor`). The memory wording passes
   * `false` (`MEMORY_VOICE_REQUEST`): it shares the reply's role `core`, not its
   * system text, so only the reply is marked. The marker (TTL
   * `llm.cache.ttl`) is placed on the system message by `withCacheMarker` after
   * the estimate and the token cap check, which always see the caller's
   * `messages` as given; so are the markers of the user parts tagged with a
   * `cacheSegment` (`'stable'`: `llm.cache.ttl`, `'profiles'`:
   * `llm.cache.profilesTtl`, see `profilesTtlFor`), and the tag is never sent.
   * `options.timeoutMs` overrides `llm.timeoutMs` for the request's abort
   * signal — the analyzer (a large batch, a long JSON answer) and the media
   * describer need more room than a chat reply's default.
   * `options.countAgainstDailyCap` (default true) — `false` skips the daily
   * request counter and is never refused by it: passed by the memory warmup
   * and the operations tools only (see the header comment for why each is exempt).
   * `options.maxRequestTokens` — overrides `cfg.maxRequestTokens` for this one call's pre-flight
   * cap check only (the global rail stays in force for every caller that omits it). Exists for
   * the memory warmup (src/memory/warmup.js), whose requests are fitted under a much larger,
   * separately-budgeted cap (`warmup.maxRequestTokens`) than a live chat/analyzer request.
   * `options.skipCalibration` (default false) — never feeds the provider's prompt
   * count into the calibrator. For every request whose provider-counted prompt
   * tokens say nothing about the text ratio the other requests are checked
   * against: a picture or video describe (the vision
   * model counts media its own way), the short classifier passes.
   * `options.signal` — an external `AbortSignal` (e.g. an `AbortController`'s)
   * that cancels the in-flight HTTP request the moment it aborts, on top of
   * the per-attempt timeout signal (`options.timeoutMs`/`cfg.timeoutMs`) —
   * both combined with `AbortSignal.any`. Once `options.signal` is aborted,
   * a caught error is rethrown immediately with NO retry (an external abort
   * is deliberate, not a transient failure worth retrying). Exists for the
   * memory warmup's stop (src/memory/warmup.js, Ctrl+C in tools/warmup.mjs): the
   * request already counted by the provider cannot be un-billed, but no
   * further retry/tokens are spent past the moment of the abort.
   * `options.provider` — OpenRouter provider routing for this one call; a plain
   * object REPLACES the configured routing (`llm.providerByModel`, then
   * `llm.provider`; see `resolveProvider`); any other value leaves the
   * configured routing in charge. Exists for the video describer, which pins
   * the provider that can fetch a public video URL.
   * `options.role` — which subprocess makes the request (`core`, `analyzer`,
   * `extractor`, `vision`, `video`; the roles of src/llm/roles.js and
   * `/nep model`), so a `"<prefix>@<role>"` key of
   * `llm.providerByModel` can route it; never sent. A call without a role
   * matches only role-less keys.
   * `options.reasoning` — OpenRouter's reasoning settings for this one call
   * (e.g. `{ enabled: false }`); a plain object is sent verbatim as
   * `body.reasoning`, anything else omits the field. Used by the video
   * describer (`media.video.reasoning`), whose model otherwise spends the
   * output budget on reasoning, and by the two-stage analyzer's stage A and
   * the warmup's neutral route (`memory.reasoning`).
   * `options.plugins` — OpenRouter's plugins for this one call (e.g. `[{ id: 'web', engine:
   *   'exa', max_results: 5 }]`); a non-empty array is sent verbatim as `body.plugins`,
   *   anything else omits the field. Used by the web lookup's `openrouter` engine
   *   (src/web/lookup.js), whose one request searches and summarizes; the answer then carries the
   *   message's annotations (`annotations`, only when OpenRouter returned some).
   * `options.videoSeconds` — seconds of video the request carries. A finite,
   * non-negative value adds `ceil(videoSeconds * tokensPerSecond)` to the raw
   * estimate before calibration, because `estimateMessages` cannot size a
   * `video_url` part on its own; the token cap then applies to the sum.
   * `tokensPerSecond` is `options.videoTokensPerSecond` when that is a finite
   * positive number, else `media.video.tokensPerSecond` (`VIDEO_TOKENS_PER_SECOND_FALLBACK`,
   * 120 per second, when unset; the rate of a statically sampled clip). The override exists for
   * the video describer's public-URL requests in agentic processing, where the
   * provider does not count the video as prompt tokens and the per-second cost
   * is far lower (`media.video.directUrlTokensPerSecond`).
   * `options.limits` — a collector (src/llm/limits.js#createLimits; never sent) told the limits
   * this answered request hit: `estimate-off` (`where`: the purpose, else the role, else
   * `request`; `lost`: the tokens over the estimate; `detail`: `estimate->actual`) when the
   * provider counted the whole prompt above the estimate by more than `1 - llm.safetyMargin` of
   * it (the room the margin leaves), and `output-cap` (`where: 'completion'`) when the
   * completion reached the request's `max_tokens`.
   */
  /**
   * The limits one answered request hit, told to `limits` (`options.limits`, see `complete`).
   * The margin is read now (src/llm/budget.js#safetyMarginOf).
   */
  function reportLimits(limits, { where, estimated, promptTokens, completion, maxTokens }) {
    const margin = safetyMarginOf(getConfig());
    if (Number.isFinite(promptTokens) && Number.isFinite(estimated) && estimated > 0 && promptTokens - estimated > estimated * (1 - margin)) {
      limits.add({ kind: 'estimate-off', where, lost: promptTokens - estimated, detail: `${estimated}->${promptTokens}` });
    }
    if (Number.isFinite(completion) && Number.isFinite(maxTokens) && maxTokens > 0 && completion >= maxTokens) {
      limits.add({ kind: 'output-cap', where: 'completion', lost: null });
    }
  }

  async function complete(messages, options = {}) {
    const cfg = getConfig().llm;
    const tokensPerImage = getConfig().context?.vision?.tokensPerImage;
    const tools = Array.isArray(options.tools) && options.tools.length ? options.tools : null;
    // The tools are counted apart (src/llm/tokens.js#estimateTools): added to the calibrated estimate, never fed to the calibrator.
    const toolsTokens = tools ? estimateTools(tools) : 0;
    let raw = estimateMessages(messages, tokensPerImage);
    if (typeof options.videoSeconds === 'number' && Number.isFinite(options.videoSeconds) && options.videoSeconds >= 0) {
      const override = options.videoTokensPerSecond;
      const tokensPerSecond =
        typeof override === 'number' && Number.isFinite(override) && override > 0
          ? override
          : (getConfig().media?.video?.tokensPerSecond ?? VIDEO_TOKENS_PER_SECOND_FALLBACK);
      raw += Math.ceil(options.videoSeconds * tokensPerSecond);
    }
    const estimated = calibrator.apply(raw) + toolsTokens;
    const requestTokenCap = Number.isFinite(options.maxRequestTokens) ? options.maxRequestTokens : cfg.maxRequestTokens;
    if (estimated > requestTokenCap) {
      const err = new TokenLimitError(`request estimated at ${estimated} tokens, cap is ${requestTokenCap}`);
      throw Object.assign(err, { key: 'llm.maxRequestTokens', used: estimated, cap: requestTokenCap });
    }
    if (options.countAgainstDailyCap !== false) {
      countRequest(cfg.maxRequestsPerDay);
    }

    // No model of its own: the core's model (`models.core`, or a `models.byPurpose` entry for the purpose).
    const model = options.model ?? roleModel(getConfig(), 'core', options.purpose);
    const body = {
      model,
      // The cache marker goes on only now: `raw` above was estimated from the caller's own
      // messages, and a marker is a JSON field, not prompt text.
      messages: withCacheMarker(messages, cacheTtlFor(getConfig(), options.role, model, options.cache), profilesTtlFor(getConfig())),
      temperature: options.temperature ?? cfg.temperature,
      max_tokens: options.maxOutputTokens ?? cfg.maxOutputTokens,
    };
    // What was actually sent: the usage of a marked request is read by the route the probe measured.
    const marked = hasCacheMarker(body.messages);
    // OpenRouter's provider routing (e.g. `{ ignore: [...] }`, `{ only: [...] }`), sent
    // verbatim and read fresh on every call so it is hot-reloadable: a plain-object
    // `options.provider`, else the `llm.providerByModel` entry for this request's model
    // and `options.role` (see `matchRoute`), else `llm.provider`. When none applies the
    // field is omitted -- OpenRouter then picks providers itself. The route's own `byok`
    // mark stays out of the body (`providerBodyOf`) and is checked on the answer (`assertByok`).
    const provider = resolveProvider(body.model, {
      override: options.provider,
      byModel: cfg.providerByModel,
      fallback: cfg.provider,
      role: options.role,
    });
    if (provider) body.provider = providerBodyOf(provider);
    if (isPlainObject(options.reasoning)) body.reasoning = options.reasoning;
    // Native tool calling, only when asked for: the definitions, the choice ('auto' unless given) and
    // whether the model may call several at once (sent only when given).
    if (tools) {
      body.tools = tools;
      body.tool_choice = options.toolChoice ?? 'auto';
      if (typeof options.parallelToolCalls === 'boolean') body.parallel_tool_calls = options.parallelToolCalls;
    }
    if (Array.isArray(options.plugins) && options.plugins.length) body.plugins = options.plugins;
    // `options.purpose` and `options.origin` are for the usage line only: never put on `body`.

    // The key of this request's role (`llm.keyByRole`, read now), else the main key.
    const requestKey = roleApiKey(getConfig(), env, options.role, apiKey);
    if (!requestKey) throw Object.assign(new Error('llm: no key for this role'), { code: 'ROLE_KEY_MISSING', name: 'RoleKeyMissingError' });
    // One POST of this body, under the attempt's own signal.
    const send = (signal) => fetchImpl(apiUrl(cfg.baseUrl, 'chat/completions'), {
      method: 'POST',
      headers: openRouterHeaders(requestKey),
      body: JSON.stringify(body),
      signal,
    });
    // The start of the first attempt: the logged duration covers the retries and their backoff.
    const startedAt = now();
    // The answered request, once: calibration, the over-cap warning and the usage line (`extra`
    // fields appended to it).
    const answer = (json, extra) => {
      // A provider can fail inside a 200 (e.g. a context-length refusal): thrown, never read as an
      // empty answer, never retried (it is deterministic), no usage line and no calibration.
      const choiceError = choiceErrorOf(json);
      if (choiceError) {
        log.warn('llm: provider error', {
          role: options.role ?? null,
          purpose: options.purpose ?? null,
          model: body.model,
          status: choiceError.statusCode ?? null,
          errorType: choiceError.errorType,
          nativeFinishReason: choiceError.nativeFinishReason,
          ms: now() - startedAt,
        });
        throw choiceError;
      }
      const text = json.choices?.[0]?.message?.content ?? '';
      // The message's `url_citation` annotations (OpenRouter's web plugin); only a non-empty array is passed on.
      const annotations = json.choices?.[0]?.message?.annotations;
      const usage = json.usage ?? {};
      const finishReason = json.choices?.[0]?.finish_reason ?? undefined;
      // The whole prompt as the provider counted it, its cached part included (see fullPromptTokens).
      const promptTokens = fullPromptTokens(usage, getConfig(), marked);
      if (options.skipCalibration !== true && promptTokens !== null) calibrator.observe(raw, promptTokens - toolsTokens);
      if (promptTokens !== null && promptTokens > requestTokenCap) {
        log.warn('llm: provider counted more prompt tokens than the cap', { usage, estimated });
      }
      const usageFields = { ...usageLogFields(json, usage, body.model, options, marked, now() - startedAt), ...extra };
      log.info('llm: usage', usageFields);
      if (options.limits) reportLimits(options.limits, { where: options.purpose ?? options.role ?? 'request', estimated, promptTokens, completion: usage.completion_tokens, maxTokens: body.max_tokens });
      // `answer` runs once the retry loop or the hedge has returned, so a refused answer is never
      // re-sent: it was billed already, and the caller's ordinary error path takes it from here.
      assertByok(provider, usage, usageFields);
      // `json.provider` is OpenRouter's own name for whichever upstream provider
      // actually served the request (undefined when the response omits it) --
      // surfaced so `/nep ping` can report it without a second request shape.
      return {
        text: typeof text === 'string' ? text : '', usage, estimated, finishReason, provider: json.provider, promptTokens,
        ...(Array.isArray(annotations) && annotations.length ? { annotations } : {}),
        ...(tools ? { toolCalls: toolCallsOf(json.choices?.[0]?.message?.tool_calls) } : {}),
      };
    };

    // A helper request on a hedged role, or a request with an explicit hedge: two attempts at most,
    // never the retry loop below.
    const hedge = hedgeOf(getConfig(), options);
    if (hedge) {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error('request aborted');
      const won = await hedgedCall(send, { hedge, options, model: body.model, attemptTimeoutMs: options.timeoutMs ?? cfg.timeoutMs });
      return answer(won.json, { hedged: won.hedged, attempt: won.attempt });
    }

    let lastError;
    for (let attempt = 0; attempt <= cfg.retries; attempt += 1) {
      if (attempt > 0) {
        // `attempt` is also the 1-based number of the attempt that failed and is retried now.
        log.warn('llm: retry', {
          attempt,
          status: lastError?.statusCode ?? null,
          name: lastError?.name ?? null,
          ...retryLimitFields(lastError),
        });
        await sleep(backoffMs(attempt));
      }
      if (options.signal?.aborted) throw lastError ?? options.signal.reason ?? new Error('request aborted');
      let response;
      let notRetried = null; // an HTTP error thrown below that the catch must pass on, never retry
      try {
        const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? cfg.timeoutMs);
        const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
        response = await send(signal);

        if (!response.ok) {
          const error = await httpErrorOf(response);
          if (!RETRY_STATUS.has(response.status)) throw error;
          // A provider's quota of the day: it comes back in minutes, not within the seconds of
          // `backoffMs`, so a retry only holds the caller (the persona's one attention).
          const limit = providerLimitOf(error);
          if (limit.kind === 'daily') {
            logProviderLimit(options, body.model, limit);
            notRetried = error;
            throw error;
          }
          lastError = error;
          continue;
        }
      } catch (err) {
        if (err === notRetried) throw err;
        if (options.signal?.aborted) throw err; // a deliberate external abort is never retried
        if (err.statusCode && !RETRY_STATUS.has(err.statusCode)) throw err;
        lastError = err; // a network failure or a timed-out attempt: retried
        continue;
      }

      // A 200 was received (and may be billed): whatever goes wrong from here is thrown, never retried.
      return answer(await answerJsonOf(response));
    }
    throw lastError;
  }

  /**
   * One GET of OpenRouter's public endpoint listing of `model`
   * (`<llm.baseUrl>/models/<model>/endpoints`; the model id's slash is a path
   * separator): `{ ok, status, json }`, `json` being the parsed body of a 2xx
   * answer (null when it is not JSON, or on any other status). Free: never
   * counted against `llm.maxRequestsPerDay`, never calibrated, never retried.
   * A network failure or the `timeoutMs` abort (default `llm.timeoutMs`)
   * throws as fetch throws it. For `/nep ping image`, which checks the drawing
   * model without generating a picture.
   * @param {string} model
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<{ ok: boolean, status: number, json: object|null }>}
   */
  async function modelEndpoints(model, { timeoutMs } = {}) {
    return getFree(`models/${model}/endpoints`, { timeoutMs });
  }

  /**
   * One free, read-only GET of `<llm.baseUrl>/<endpoint>`: `{ ok, status, json }`, `json` being
   * the parsed body of a 2xx answer (null when it is not JSON, or on any other status). Never
   * counted against `llm.maxRequestsPerDay`, never calibrated, never retried, nothing logged. A
   * network failure or the `timeoutMs` abort (default `llm.timeoutMs`) throws as fetch throws it.
   * `apiKey` replaces the client's key for this GET; else `role` reads that role's key (`roleApiKey`).
   */
  async function getFree(endpoint, { timeoutMs, apiKey: keyOverride, role } = {}) {
    const cfg = getConfig().llm;
    const key = keyOverride || (role ? roleApiKey(getConfig(), env, role, apiKey) : apiKey);
    const response = await fetchImpl(apiUrl(cfg.baseUrl, endpoint), {
      method: 'GET',
      headers: openRouterHeaders(key),
      signal: AbortSignal.timeout(timeoutMs ?? cfg.timeoutMs),
    });
    const json = response.ok
      ? await Promise.resolve()
          .then(() => response.json())
          .catch(() => null)
      : null;
    return { ok: response.ok, status: response.status, json };
  }

  /**
   * The API key's own record (`<llm.baseUrl>/key`: its limit, reset, budgets and usage), one free
   * GET (see `getFree`). For the costs field of the owner's `/nep status` card. `apiKey` reads
   * another key's record (the simulator key's), `role` the record of the key that role goes out on
   * (`llm.keyByRole`), for this one GET only.
   * @param {{ timeoutMs?: number, apiKey?: string, role?: string }} [options]
   * @returns {Promise<{ ok: boolean, status: number, json: object|null }>}
   */
  const keyInfo = (options) => getFree('key', options);

  /**
   * The account's credits (`<llm.baseUrl>/credits`: bought and used), one free GET (see
   * `getFree`). For the costs field of the owner's `/nep status` card.
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<{ ok: boolean, status: number, json: object|null }>}
   */
  const credits = (options) => getFree('credits', options);

  /**
   * The extra keys `llm.keyByRole` puts in use now (`roleKeyGroups`), each as the roles on it --
   * never the key itself. The status card reads each one's record with `keyInfo({ role })`.
   * @returns {Array<{ roles: string[] }>}
   */
  const roleKeys = () => roleKeyGroups(getConfig(), env, apiKey).map(({ roles }) => ({ roles }));

  /**
   * One key's daily spend over the last 30 completed UTC days (`<llm.baseUrl>/activity`, one row
   * per day, model and endpoint), one free GET (see `getFree`) made with `apiKey` -- the
   * management key, for this one GET only -- for the key whose hash is `keyHash` (`keyHashOf`).
   * For the costs field of the owner's `/nep status` card.
   * @param {{ apiKey: string, keyHash: string, timeoutMs?: number }} options
   * @returns {Promise<{ ok: boolean, status: number, json: object|null }>}
   */
  const activity = ({ apiKey: managementKey, keyHash: hash, timeoutMs } = {}) =>
    getFree(`activity?api_key_hash=${encodeURIComponent(String(hash))}`, { timeoutMs, apiKey: managementKey });

  /**
   * The hash (`keyHashOf`) of the key `role` goes out on (`roleApiKey`), or of the main key
   * without one: what `activity` asks about, never the key itself.
   * @param {{ role?: string }} [options]
   * @returns {string}
   */
  const keyHash = ({ role } = {}) => keyHashOf(role ? roleApiKey(getConfig(), env, role, apiKey) : apiKey);

  return { complete, modelEndpoints, keyInfo, credits, activity, keyHash, roleKeys, capLeft };
}
