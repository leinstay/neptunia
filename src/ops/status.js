// Operations: `/nep status [field]`: what the bot is doing now, read only. The reply is one
// card (`cmdStatusCard`, plain embed data: interfaces/discord/commands.js wraps it for discord.js), the
// most important field first, for a phone; `field` keeps only that field and computes nothing
// for the others. A member (anyone not in `bot.owners`) gets the card without the storage line,
// the keys, costs, memory and speed fields. Every field lists one item per line; the state field ends
// with the gateway and the uptime. The card keeps three groups, matching the model config: the base
// (`models.base`, `keys.base`, `costs.base`: her core and organs), the errands (`models.errands`,
// `costs.errands`: the delegated agents) and the development agents (`models.development`,
// `costs.development`: outside her). The models sit in three fields, one line per role, `<role> · <model> ...`:
// `models.base` (core, memory, then the helpers analyzer, vision, video, embedding, speech, then drawing),
// `models.errands` (scout, server) and `models.development` (thinker, dev), which an OpenCode worker runs,
// so they are never probed. The owner's card probes on every call: one minimal chat completion per
// distinct chat model and route (`labels.status.probe`, `llm.probeTimeoutMs`, never counted
// against `llm.maxRequestsPerDay` nor calibrated, `origin: 'status'`), one one-input embedding
// request for the embedding role, and one free GET of the drawing model's provider listing; a
// member's card only names the models. Each role shows its own model (never another role's), and
// each base role's line is followed by the `models.byPurpose` overrides of its purposes. The memory field (the coverage of every kind of
// memory) is computed at most once a minute: directory listings and the record's month indexes,
// never its day files. The speed field reads src/ops/metrics.js (the last 24 h), then today's
// missed-answer figures from the journal (src/behavior/missed.js). The `keys.base`
// field reads the limit of each API key of the core (one free GET per key; the errand agents' key
// is left out: their spend is `costs.errands`) and the rolling 7/30-day sums per key; `costs.base`
// reads today's per-role accumulator (src/ops/usage.js, drawing's row included); `costs.errands` the errand records' spend
// per agent (src/errands/costs.js through the guild's task store); `costs.development` the development agents'
// (thinker, dev) from the ledger (src/errands/ledger.js#costs, with the thinker's last-wave
// context), both shown with no runs when the ledger does not answer. The owner's `inner`
// field (only while features.innerLife is on) is the inner life's own status (src/behavior/inner.js#status,
// the data `/nep task inner status` reads): its mode and switch, the day's turns, chains, dollars, public
// posts, the next wake, the last turn and the open intentions; its words are `labels.status.inner`.

import { RECALL_DAILY } from '../behavior/recall-run.js';
import { keyHashOf, llmCountToday, resolveProvider } from '../llm/openrouter.js';
import { familyOf as imageFamilyOf, IMAGE_ROLE } from '../llm/images.js';
import { SPEECH_ROLE } from '../speech/synth.js';
import { countToday, DAY_MS, HOUR_MS, MINUTE_MS, utcDay, utcMinute } from '../time.js';
import { VIDEO_DAILY, ARCHIVE_EVENTS } from '../memory/index.js';
import { WEB_DAILY } from '../web/lookup.js';
import { clampChars, oneLine } from '../memory/clamp.js';
import { isOwnerId } from './grants.js';
import { MODEL_ROLES, STATUS_FIELDS, STATUS_PARTS } from './catalog.js';
import { CORE_ROLE, DEVELOPMENT_ROLES, ERRAND_ROLES, MEMORY_ROLE, PURPOSE_ROLES, roleModel } from '../llm/roles.js';
import { EMBED_ROLE } from '../llm/embed.js';
import { plannerOn } from '../behavior/planner.js';
import { missedCounts, missedStatusLine } from '../behavior/missed.js';
import { SPEED_METRICS } from './metrics.js';
import { activitySums, agentCostsLines, keyCostsLines, roleCostsLines, readAccount, readActivity } from './usage.js';
import { PROFILES } from '../agent-runner/profiles.js';
import { isPlainObject } from '../config.js';
import { fill } from '../format.js';
import { innerOn } from '../behavior/inner.js';
import { log } from '../log.js';
import { modelForRole } from './shared.js';
import { defineOp, perEnv } from './registry.js';

/** The card's field names, in order (src/ops/catalog.js#STATUS_FIELDS, the `field` option's choices). */
export { STATUS_FIELDS };

/**
 * The card's fields each part of her `status.show part=` call shows, in card order (STATUS_PARTS; `all` is the whole
 * card). `features` is no card field: the switches of `features` in the live config, one per line (featuresValue).
 */
export const PART_FIELDS = Object.freeze({
  overview: ['state', 'limits'],
  limits: ['limits', 'costs.base'],
  models: ['models.base', 'models.errands', 'models.development'],
  memory: ['memory'],
  inner: ['inner'],
  errands: ['tasks', 'costs.errands', 'costs.development'],
  features: ['features'],
  all: null,
});

/** The fields a member's card leaves out. */
const OWNER_FIELDS = new Set(['keys.base', 'costs.base', 'costs.errands', 'costs.development', 'inner', 'memory', 'speed']);

/** The model roles of the errand agents (src/agent-runner/profiles.js) and `drawing`, which shares
 * their key: a key only they use is the errands' key, which `keys.base` leaves out. */
const ERRAND_KEY_ROLES = new Set([...Object.values(PROFILES).map((profile) => profile.modelRole), 'drawing']);

/**
 * The `models.base` field's groups before drawing, in order: one line per role, then the
 * `models.byPurpose` overrides of the purposes that go out on those roles
 * (src/llm/roles.js#PURPOSE_ROLES; a purpose it does not list follows the analyzer).
 */
const MODEL_GROUPS = Object.freeze([
  { name: 'core', roles: [CORE_ROLE] },
  { name: 'memory', roles: [MEMORY_ROLE] },
  { name: 'analyzer', roles: ['analyzer'], unlistedPurposes: true },
  { name: 'vision', roles: ['vision'] },
  { name: 'video', roles: ['video'] },
  { name: 'embedding', roles: [EMBED_ROLE] },
  { name: 'speech', roles: [SPEECH_ROLE] },
]);

/** The time of `ts` for the inner field (UTC, minutes). */
function innerStamp(ts) {
  return Number.isFinite(ts) ? `${new Date(ts).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '-';
}

/** A label that is a non-empty string, filled; null otherwise (the line is left out). */
function labelLine(template, values) {
  return typeof template === 'string' && template ? fill(template, values) : null;
}

/**
 * The `inner` field's lines from the inner life's status `s` (src/behavior/inner.js#status), words
 * from `labels.status.inner`; `tokens` (`{ prompt, cached, completion }`, the core role's today from
 * the usage accumulator) adds the tokens line.
 */
export function innerLines(s, labels, { tokens = null } = {}) {
  const L = labels?.status?.inner;
  if (!isPlainObject(L)) return [];
  const state = s.stopped ? labelLine(L.stopped, { at: innerStamp(s.stoppedAt) }) : labelLine(L.running, {});
  const kinds = isPlainObject(L.nextKinds) ? L.nextKinds : {};
  const intentions = s.intentions;
  return [
    labelLine(L.modeLine, { mode: s.mode, state: state ?? '' }),
    s.turnsToday != null ? labelLine(L.turnsLine, { used: s.turnsToday, chains: s.chains ?? 0 }) : null,
    s.turnsToday != null ? labelLine(L.usdLine, { spent: (s.spentUsd ?? 0).toFixed(2) }) : null,
    s.next ? labelLine(L.nextLine, { at: innerStamp(s.next.at), kind: kinds[s.next.kind] ?? s.next.kind }) : labelLine(L.nextNone, {}),
    s.heartbeat === undefined ? null : s.heartbeat ? (Number.isFinite(s.heartbeat.nextAt) ? labelLine(L.heartbeatLine, { at: innerStamp(s.heartbeat.nextAt) }) : null) : labelLine(L.heartbeatOff, {}),
    s.lastTurn ? labelLine(L.lastLine, { outcome: s.lastTurn.outcome ?? L.outcomeUnknown ?? '-', at: innerStamp(s.lastTurn.at) }) : labelLine(L.lastNone, {}),
    s.lastError ? labelLine(L.lastErrorLine, { code: s.lastError.code, at: innerStamp(s.lastError.at) }) : null,
    intentions ? labelLine(L.intentionsLine, intentions) : null,
    s.attention ? labelLine(L.attentionLine, s.attention) : null,
    tokens ? labelLine(L.tokensLine, { prompt: tokens.prompt ?? 0, cached: tokens.cached ?? 0, completion: tokens.completion ?? 0 }) : null,
  ].filter(Boolean);
}

/**
 * The memory database's line of the memory field from the service's status `s`, words from `labels.status.memoryDb`:
 * `unavailable` (the database not open), else `ok` with `{rows}` and `{files}` (the units it holds). Null when
 * the label is missing or blank.
 */
export function memoryDbStatusLine(s, labels) {
  const L = labels?.status?.memoryDb;
  if (!isPlainObject(L) || !isPlainObject(s)) return null;
  if (!s.open) return labelLine(L.unavailable, {});
  return labelLine(L.ok, { rows: s.rows ?? 0, files: s.files ?? 0 });
}

/** `<role> · <model>`: each role shows its own model, never another role's. */
function roleHead(role, model) {
  return `${role} · ${model}`;
}

/** An OpenCode agent role's line: its model (an OpenCode worker runs it, so it is never probed). */
function agentLine(role, cfg) {
  return roleHead(role, roleModel(cfg, role) ?? 'no model configured');
}

/** The `models.errands` or `models.development` field: each role's `agentLine`. */
function agentModels(cfg, roles) {
  return roles.map((role) => agentLine(role, cfg)).join('\n');
}

/** The `models.byPurpose` overrides of the live config whose purpose goes out on one of `roles`
 * (with `unlisted`, also those of a purpose PURPOSE_ROLES does not list), one
 * `byPurpose <purpose> · <model>` line each. */
function byPurposeLines(cfg, roles, unlisted) {
  const byPurpose = cfg?.models?.byPurpose;
  if (!isPlainObject(byPurpose)) return [];
  return Object.entries(byPurpose)
    .filter(([, model]) => typeof model === 'string' && model)
    .filter(([purpose]) => (Object.hasOwn(PURPOSE_ROLES, purpose) ? roles.includes(PURPOSE_ROLES[purpose]) : unlisted === true))
    .map(([purpose, model]) => `byPurpose ${purpose} · ${model}`);
}

/** The `models.base` field: `lineOf(role)` per role, each group's per-purpose overrides after its role. */
function groupedModels(cfg, lineOf) {
  const lines = [];
  for (const group of MODEL_GROUPS) {
    for (const role of group.roles) lines.push(lineOf(role));
    lines.push(...byPurposeLines(cfg, group.roles, group.unlistedPurposes));
  }
  return lines.join('\n');
}

/** `llm.probeTimeoutMs` when config.json lacks it (the same value). */
const PROBE_TIMEOUT_MS = 30000;

/** How much of a failed probe's error message the card keeps. */
const PROBE_ERROR_CHARS = 100;

/** Discord's cap on one embed field's value. */
const FIELD_MAX_CHARS = 1024;

/** `value` within Discord's field cap, cut after its last whole line that fits. */
function fitField(value) {
  if (value.length <= FIELD_MAX_CHARS) return value;
  const cut = value.slice(0, FIELD_MAX_CHARS);
  const end = cut.lastIndexOf('\n');
  return end > 0 ? cut.slice(0, end) : cut;
}

/** `entry.step`/`.name`/`.stage`, or `'step'` when a routing-funnel entry names itself none of those. */
function funnelStepName(entry) {
  return entry?.step ?? entry?.name ?? entry?.stage ?? 'step';
}

/** `entry.endpoint_count` (OpenRouter's key) first, then a few other plausible spellings. */
function funnelEndpointCount(entry) {
  return entry?.endpoint_count ?? entry?.endpoints ?? entry?.count ?? entry?.remaining ?? entry?.endpointCount;
}

function describeFunnelStep(entry) {
  const count = funnelEndpointCount(entry);
  return count == null ? funnelStepName(entry) : `${funnelStepName(entry)} -> ${count} endpoints`;
}

/**
 * The last `routing_funnel` step out of an OpenRouter error body (`error.metadata.routing_funnel`
 * first), with the step that first hit 0 endpoints when that is an earlier one: what tells wrong
 * provider keys apart from an outage. Null for a body that is not JSON or carries no funnel.
 */
function extractRoutingFunnel(rawBody) {
  if (!rawBody) return null;
  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const funnel = parsed?.error?.metadata?.routing_funnel ?? parsed?.routing_funnel ?? parsed?.error?.routing_funnel;
  if (!Array.isArray(funnel) || funnel.length === 0) return null;
  const last = funnel[funnel.length - 1];
  if (!last || typeof last !== 'object') return null;
  const firstZero = funnel.find((entry) => funnelEndpointCount(entry) === 0);
  const lastLine = `funnel: ${describeFunnelStep(last)}`;
  return firstZero && firstZero !== last ? `${lastLine} (first hit 0 at ${describeFunnelStep(firstZero)})` : lastLine;
}

/** One role's probe line: `<head> · <provider> · ok <ms> ms` (`-` when the answer names no
 * provider, as an embedding's does not), or `<head> · failed: <short reason>` with the routing
 * funnel in brackets when the error body has one; `head` is `<role> · <model>` (roleHead). */
function probeLine(head, outcome) {
  if (!outcome.ok) {
    const message = clampChars(oneLine(outcome.err?.message ?? outcome.err ?? 'error'), PROBE_ERROR_CHARS);
    const funnel = extractRoutingFunnel(outcome.err?.body);
    return `${head} · failed: ${message}${funnel ? ` (${funnel})` : ''}`;
  }
  return `${head} · ${outcome.result?.provider || '-'} · ok ${outcome.ms} ms`;
}

/** `used/cap`, the cap `-` when it is not a number. */
function usedOf(used, cap) {
  return `${used}/${Number.isFinite(cap) ? cap : '-'}`;
}

/** `3d 4h 12m`, `4h 12m` or `12m` for a span in ms. */
function span(ms) {
  const safe = Math.max(0, ms);
  const days = Math.floor(safe / DAY_MS);
  const hours = Math.floor((safe % DAY_MS) / HOUR_MS);
  const minutes = Math.floor((safe % HOUR_MS) / MINUTE_MS);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** How long the memory field's coverage is reused before it is computed again. */
const COVERAGE_CACHE_MS = MINUTE_MS;

/** `embed.catchUpHours` when config.json lacks it (the same value). */
const CATCH_UP_HOURS = 72;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The days from `from` to `to` (both `YYYY-MM-DD`), both counted. */
function daysBetween(from, to) {
  return Math.floor((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY_MS) + 1;
}

/** `part` of `whole` as a whole percent, `-` of nothing. */
function percent(part, whole) {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '-';
}

/** A duration for the speed field: `N ms` below a second, else `N.N s`. */
function duration(ms) {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** The length of a list, 0 for anything else. */
function countOf(list) {
  return Array.isArray(list) ? list.length : 0;
}

/** `<name>: <count> · <oldest>..<newest>`: the oldest of `starts` to the newest of `ends` (epoch
 * ms, the non-numbers skipped), the count alone when there is no time. */
function datedLine(name, count, starts, ends) {
  const from = starts.filter((ms) => Number.isFinite(ms));
  const to = ends.filter((ms) => Number.isFinite(ms));
  if (from.length === 0 || to.length === 0) return `${name}: ${count}`;
  return `${name}: ${count} · ${utcDay(Math.min(...from))}..${utcDay(Math.max(...to))}`;
}

const handlers = perEnv((env) => {
  const { hot, store, client, getGuildId, images, archive, journal, record, metrics, lookup, usage, errands, emojiBackfill, gifBackfill, gifRecache, freshenIfPaused, imageModelLabel, llm, embedder, embedQueue, memoryDb } = env;
  // The card's clock (the coverage cache, the storage line): the environment's, else the wall clock.
  const clock = typeof env.now === 'function' ? env.now : Date.now;
  // guildId -> { at, value }: the memory field, reused for COVERAGE_CACHE_MS.
  const coverageCache = new Map();

  /** The state field: running, or paused with since when and by whom (`pausedBy`, when known);
   * the owner's card adds the storage line (storageLine). */
  function stateValue(data) {
    if (!data.paused) return 'running';
    const by = typeof data.pausedBy === 'string' && data.pausedBy ? ` by <@${data.pausedBy}>` : '';
    return `paused since ${utcMinute(data.pausedAt)}${by}`;
  }

  /** The connection field: the gateway's latency (`client.ws.ping`) and its last reconnect. */
  function connectionValue() {
    const ping = client?.ws?.ping;
    const latency = Number.isFinite(ping) && ping >= 0 ? `${Math.round(ping)} ms` : '-';
    const last = env.connection?.lastReconnectAt;
    return `gateway ${latency}\nlast reconnect ${last ? utcMinute(last) : 'none'}`;
  }

  /** What the archive's pending queue holds for `guildId` (0 without an archive or a guild). */
  function archivePending(guildId) {
    const pending = guildId ? archive?.stats?.(guildId)?.pending : 0;
    return Number.isFinite(pending) ? pending : 0;
  }

  /** The long-tasks field: the history backfills and the GIF recache running, and what the archive
   * drain still holds; `none` when nothing runs. */
  function longTasksValue(guildId) {
    const parts = [];
    for (const [job, name] of [
      [emojiBackfill, 'emoji backfill'],
      [gifBackfill, 'GIF backfill'],
      [gifRecache, 'GIF recache'],
    ]) {
      if (job?.isRunning?.() === true) parts.push(`${name} running`);
    }
    const pending = archivePending(guildId);
    if (pending > 0) parts.push(`archive drain: ${pending} pending`);
    return parts.length > 0 ? parts.join('\n') : 'none';
  }

  /** When the journal was last written (today's lines, else yesterday's: the first hour after midnight), as epoch ms,
   * or null (no journal, nothing written): the journal's own `stats`. */
  async function journalLastWrite(guildId, nowMs) {
    if (typeof journal?.stats !== 'function') return null;
    return (await journal.stats(guildId, { now: nowMs }))?.lastWriteMs ?? null;
  }

  /**
   * The owner's storage line under the state: `storage ok`, or `storage: <problem>; ...` -- the
   * journal's append store stalled, archive copies waiting (the count), the journal not written
   * for over an hour while turns happen (features.journal exactly true, read now; a reply posted
   * in the last hour per the metrics; nothing is judged without them).
   */
  async function storageLine(guildId, cfg) {
    const problems = [];
    if (typeof journal?.stalled === 'function' && journal.stalled() === true) problems.push('append store stalled');
    const pending = archivePending(guildId);
    if (pending > 0) problems.push(`${pending} archive copies pending`);
    const nowMs = clock();
    if (guildId && cfg?.features?.journal === true && typeof metrics?.summary === 'function' && metrics.summary('reply', 1).n > 0) {
      const last = await journalLastWrite(guildId, nowMs);
      if (last === null) problems.push('journal not written today while turns happen');
      else if (nowMs - last > HOUR_MS) problems.push(`journal not written since ${utcMinute(last)} while turns happen`);
    }
    return problems.length > 0 ? `storage: ${problems.join('; ')}` : 'storage ok';
  }

  /** The `models.base` field unprobed (a member's card): every role's own model, the drawing model last. */
  function modelsValue(cfg) {
    const image = roleHead(IMAGE_ROLE, roleModel(cfg, 'drawing') ? imageModelLabel(cfg) : 'no model configured');
    return [groupedModels(cfg, (role) => roleHead(role, modelForRole(role, cfg) ?? 'no model configured')), image].join('\n');
  }

  /** The embedding role's probe: one embedding request of one input (the probe label), never
   * counted against the daily cap. Never rejects. */
  async function embedProbe(cfg, promptText, timeoutMs) {
    const start = Date.now();
    try {
      const [vector] = await embedder.embed([promptText], { config: cfg, purpose: 'probe', origin: 'status', countAgainstDailyCap: false, timeoutMs });
      return { ok: true, ms: Date.now() - start, result: { dimensions: vector?.length } };
    } catch (err) {
      return { ok: false, ms: Date.now() - start, err };
    }
  }

  /** The drawing model's state from the provider's public listing: one free GET, no generation,
   * no cap counted, no state written. Never rejects. */
  async function imageListing(model, timeoutMs) {
    if (!(images?.familyOf ?? imageFamilyOf)(model)) return 'unsupported family';
    if (typeof llm?.modelEndpoints !== 'function') return 'not checked (the llm client has no listing)';
    const start = Date.now();
    let listing;
    try {
      listing = await llm.modelEndpoints(model, { timeoutMs });
    } catch (err) {
      return `failed: ${err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'network'}`;
    }
    if (listing.status === 404) return 'not listed (HTTP 404)';
    if (!listing.ok) return `failed: HTTP ${listing.status}`;
    const modalities = listing.json?.data?.architecture?.output_modalities;
    if (!Array.isArray(modalities) || !modalities.includes('image')) return 'listed, but no image output';
    const endpoints = Array.isArray(listing.json.data.endpoints) ? listing.json.data.endpoints.length : 0;
    return `listed, image output, ${endpoints} endpoint(s), ${Date.now() - start} ms`;
  }

  /** The drawing model's line (`drawing · no model configured` when none is set); notes when
   * drawing is switched off (features.imageGeneration false; a missing key counts as on). */
  async function imageProbeLine(cfg, timeoutMs) {
    const model = roleModel(cfg, 'drawing');
    if (!model) return roleHead(IMAGE_ROLE, 'no model configured');
    const off = cfg?.features?.imageGeneration === false ? ' (features.imageGeneration is off)' : '';
    return `${roleHead(IMAGE_ROLE, model)} · ${await imageListing(model, timeoutMs)}${off}`;
  }

  /**
   * The owner's `models.base` field: every base role's model, as resolved now, probed in parallel -- the chat
   * roles with one minimal chat completion, the embedding role with one embedding request of one
   * input, the drawing model with one free listing read -- one line per role in MODEL_GROUPS order, the
   * per-purpose overrides (unprobed) after their role, the drawing line last. The memory role is named, never probed. Roles
   * sharing a model and a provider route share a probe (a role-specific `llm.providerByModel` key
   * routing one elsewhere makes it a probe of its own); each probe goes out as the first role that
   * needs it. Never counted against the daily cap, never calibrated, never writes under data/.
   * Logs `status: probed` with the counts.
   */
  async function probedModelsValue(cfg) {
    const timeoutMs = cfg?.llm?.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
    const labels = hot.prompts?.labels;
    const modelOf = new Map(MODEL_ROLES.map((role) => [role, modelForRole(role, cfg)]));
    // An embedding probe is another kind of request: never shared with a chat probe of the same model.
    const targetOf = (role) => {
      const model = modelOf.get(role);
      const route = resolveProvider(model, { byModel: cfg?.llm?.providerByModel, fallback: cfg?.llm?.provider, role });
      return `${role === EMBED_ROLE ? 'embed' : 'chat'}\n${model}\n${JSON.stringify(route ?? null)}`;
    };
    const promptText = labels?.status?.probe;
    const canEmbed = typeof embedder?.embed === 'function';
    const results = new Map();
    if (promptText) {
      const targets = new Map();
      for (const role of MODEL_ROLES) {
        const model = modelOf.get(role);
        if (role === EMBED_ROLE && !canEmbed) continue;
        // The speech role has no chat completion behind it: its model is shown, never probed.
        if (role === SPEECH_ROLE) continue;
        if (model && !targets.has(targetOf(role))) targets.set(targetOf(role), { model, role });
      }
      await Promise.all(
        [...targets].map(async ([target, { model, role }]) => {
          if (role === EMBED_ROLE) {
            results.set(target, await embedProbe(cfg, promptText, timeoutMs));
            return;
          }
          const start = Date.now();
          try {
            const result = await llm.complete([{ role: 'user', content: promptText }], {
              model,
              role,
              maxOutputTokens: 16,
              countAgainstDailyCap: false,
              skipCalibration: true,
              timeoutMs,
              origin: 'status',
            });
            results.set(target, { ok: true, ms: Date.now() - start, result });
          } catch (err) {
            results.set(target, { ok: false, ms: Date.now() - start, err });
          }
        }),
      );
    }
    const outcomes = [...results.values()];
    log.info('status: probed', {
      requests: outcomes.length,
      ok: outcomes.filter((outcome) => outcome.ok).length,
      failed: outcomes.filter((outcome) => !outcome.ok).length,
      reason: promptText ? null : 'no-label',
    });
    const lineOf = (role) => {
      const model = modelOf.has(role) ? modelOf.get(role) : modelForRole(role, cfg);
      if (!model) return roleHead(role, 'no model configured');
      const head = roleHead(role, model);
      if (!promptText) return `${head} · skipped: label missing`;
      if (role === EMBED_ROLE && !canEmbed) return `${head} · not checked (no embedding client)`;
      if (role === SPEECH_ROLE) return `${head} · not checked (speech)`;
      if (role === MEMORY_ROLE) return `${head} · not checked (memory)`;
      return probeLine(head, results.get(targetOf(role)));
    };
    return [groupedModels(cfg, lineOf), await imageProbeLine(cfg, timeoutMs)].join('\n');
  }

  /** The limits field: every daily rail's used/cap, the web search engine, then when they reset. */
  function limitsValue(cfg, data) {
    const nowMs = Date.now();
    const parts = [`requests ${usedOf(llmCountToday(data, nowMs), cfg?.llm?.maxRequestsPerDay)}`];
    if (images) {
      const quota = images.quota({ userId: null });
      parts.push(`images ${usedOf(quota.used, quota.cap)}`);
    }
    parts.push(
      `videos ${usedOf(countToday(data, VIDEO_DAILY, nowMs), cfg?.media?.video?.maxPerDay)}`,
      `recall ${usedOf(countToday(data, RECALL_DAILY, nowMs), cfg?.recall?.maxPerDay)}`,
      `lookups ${usedOf(countToday(data, WEB_DAILY, nowMs), cfg?.web?.maxPerDay)}`,
    );
    // The web search engine, one word: the chosen engine (web.search.engine) when a search can
    // run (features.webLookup on, web.search.enabled not false, the engine ready), else `off`.
    if (typeof lookup?.searchEngine === 'function') {
      const on = cfg?.features?.webLookup === true && cfg?.web?.search?.enabled !== false && lookup.hasSearch();
      parts.push(`search: ${on ? lookup.searchEngine() : 'off'}`);
    }
    return `${parts.join('\n')}\nresets 00:00 UTC`;
  }

  /**
   * The owner's `keys.base` field (src/ops/usage.js#keyCostsLines, every word from
   * `labels.status.costs`): the main API key's limit and spend, the simulator key's and those of
   * each extra key `llm.keyByRole` puts in use (`llm.roleKeys`, read by role, never holding a key
   * here) but the errand agents' (a key whose roles are all ERRAND_KEY_ROLES: no line, no read), free GETs in parallel (`llm.keyInfo`; `llm.probeTimeoutMs`, never counted against
   * `llm.maxRequestsPerDay`), with the rolling 7- and 30-day sums of each key's roles from the
   * usage accumulator. With the management key (OPENROUTER_MANAGEMENT_KEY, `env.managementKey`,
   * used for these GETs only) each key's activity is read alongside (`llm.activity` by its hash,
   * one GET per key) and its last 7 and 30 days come from there instead; a failed activity read
   * falls back. An extra key that is the simulator key itself (a role `llm.keyByRole` puts on
   * OPENROUTER_SIM_KEY, compared by hash) gets no line of its own: the simulator line is its line.
   * Logs `status: account read` with the outcomes' codes. `-` when the labels give no line.
   */
  async function keyCostsValue(cfg) {
    const timeoutMs = cfg?.llm?.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
    const readKey = readAccount(typeof llm?.keyInfo === 'function' ? () => llm.keyInfo({ timeoutMs }) : null);
    const simKey = typeof env.simKey === 'string' && env.simKey ? env.simKey : null;
    // The simulator key is used for this one read only, never for a model request.
    const readSim = simKey && typeof llm?.keyInfo === 'function' ? readAccount(() => llm.keyInfo({ timeoutMs, apiKey: simKey })) : null;
    const allGroups = typeof llm?.roleKeys === 'function' && typeof llm?.keyInfo === 'function' ? llm.roleKeys() : [];
    // The errand agents' key is not the core's: their spend is the costs.errands field.
    const agentsOnly = (group) => group.roles.length > 0 && group.roles.every((role) => ERRAND_KEY_ROLES.has(role));
    const agentRoles = allGroups.filter(agentsOnly).flatMap((group) => group.roles);
    const keyGroups = allGroups.filter((group) => !agentsOnly(group));
    // A role on the simulator key is shown on the simulator line, never on a line of its own.
    const simHash = simKey && typeof llm?.keyHash === 'function' ? keyHashOf(simKey) : null;
    const onSim = (group) => simHash !== null && llm.keyHash({ role: group.roles[0] }) === simHash;
    const groups = keyGroups.filter((group) => !onSim(group));
    const simRoles = keyGroups.filter(onSim).flatMap((group) => group.roles);
    const readRoleKeys = Promise.all(groups.map((group) => readAccount(() => llm.keyInfo({ timeoutMs, role: group.roles[0] }))));
    // The management key reads each key's activity by its hash, for these GETs only; never logged.
    const managementKey = typeof env.managementKey === 'string' && env.managementKey ? env.managementKey : null;
    const canActivity = managementKey && typeof llm?.activity === 'function' && typeof llm?.keyHash === 'function';
    const readActivityOf = (hashOf) => (canActivity ? readActivity(() => llm.activity({ apiKey: managementKey, keyHash: hashOf(), timeoutMs })) : null);
    const activityReads = Promise.all([
      readActivityOf(() => llm.keyHash()),
      simKey ? readActivityOf(() => keyHashOf(simKey)) : null,
      ...groups.map((group) => readActivityOf(() => llm.keyHash({ role: group.roles[0] }))),
    ]);
    const [key, sim, roleReads, [mainActivity, simActivity, ...roleActivity]] = await Promise.all([readKey, readSim, readRoleKeys, activityReads]);
    const activityRead = [mainActivity, simActivity, ...roleActivity].filter(Boolean);
    log.info('status: account read', {
      key: key.ok ? 'ok' : key.reason,
      simKey: sim ? (sim.ok ? 'ok' : sim.reason) : 'not-set',
      roleKeys: roleReads.length,
      roleKeysOk: roleReads.filter((outcome) => outcome.ok).length,
      activity: canActivity ? activityRead.length : 'not-set',
      activityOk: activityRead.filter((outcome) => outcome.ok).length,
      status: key.status ?? null,
    });
    const today = utcDay(clock());
    const sumsOf = (outcome) => (outcome?.ok ? activitySums(outcome.data, today) : null);
    // Rolling sums per key: an extra key over its own roles, the main key over every other role.
    const sums = typeof usage?.sumDays === 'function';
    const windowsOf = (filter) => (sums ? { last7: usage.sumDays(7, filter), last30: usage.sumDays(30, filter) } : null);
    const taken = [...groups.flatMap((group) => group.roles), ...simRoles, ...agentRoles];
    const roleKeys = groups.map((group, i) => ({ roles: group.roles, key: roleReads[i], activity: sumsOf(roleActivity[i]), windows: windowsOf({ only: group.roles }) }));
    const lines = keyCostsLines({
      key,
      activity: sumsOf(mainActivity),
      sim,
      simActivity: sumsOf(simActivity),
      labels: hot.prompts?.labels,
      windows: windowsOf({ except: taken }),
      roleKeys,
    });
    return lines.length > 0 ? lines.join('\n') : '-';
  }

  /** The owner's `costs.base` field (src/ops/usage.js#roleCostsLines): today's requests
   * per role from the usage accumulator; `-` when the labels give no line. */
  function roleCostsValue() {
    const rows = typeof usage?.byRole === 'function' ? usage.byRole() : [];
    const lines = roleCostsLines({ rows, labels: hot.prompts?.labels });
    return lines.length > 0 ? lines.join('\n') : '-';
  }

  /** The owner's `costs.errands` field (src/ops/usage.js#agentCostsLines): each errand agent's
   * runs, tokens and estimated dollars today and over the last 7 and 30 days, from the guild's
   * task store (src/errands/store.js#costs; none without the errands or a guild). An agent with
   * no figures shows no runs. `-` when the labels give no line. */
  function errandCostsValue(guildId) {
    const tasks = guildId && typeof errands?.store === 'function' ? errands.store(guildId) : null;
    const totals = typeof tasks?.costs === 'function' ? tasks.costs(ERRAND_ROLES) : {};
    const lines = agentCostsLines({ agents: ERRAND_ROLES, totals, labels: hot.prompts?.labels });
    return lines.length > 0 ? lines.join('\n') : '-';
  }

  /** The owner's `costs.development` field (src/ops/usage.js#agentCostsLines): thinker and dev
   * from the ledger (src/errands/ledger.js#costs; the thinker's last wave adds its context
   * line). An agent with no figures shows no runs: a ledger that is not configured, refuses, fails
   * or does not answer in time never fails the field. `-` when the labels give no line. */
  async function developmentCostsValue() {
    let ledgerTotals = null;
    try {
      ledgerTotals = typeof errands?.ledger?.costs === 'function' ? await errands.ledger.costs() : null;
    } catch (err) {
      log.warn('status: ledger costs failed', { error: err });
    }
    const totals = Object.fromEntries(DEVELOPMENT_ROLES.filter((agent) => ledgerTotals?.[agent]).map((agent) => [agent, ledgerTotals[agent]]));
    const lines = agentCostsLines({ agents: DEVELOPMENT_ROLES, totals, labels: hot.prompts?.labels });
    return lines.length > 0 ? lines.join('\n') : '-';
  }

  /** The owner's `inner` field: the inner life's status (the same data as `/nep task inner status`); `-` without it. */
  function innerValue(guildId) {
    if (typeof env.inner?.status !== 'function') return '-';
    // The core role's tokens today (prompt, cached, completion), from the same accumulator costs.base reads.
    const row = typeof usage?.byRole === 'function' ? usage.byRole().find((entry) => entry.role === CORE_ROLE) : null;
    const tokens = row ? { prompt: row.promptTokens, cached: row.cachedTokens, completion: row.completionTokens } : null;
    const lines = innerLines(env.inner.status(guildId ?? undefined), hot.prompts?.labels, { tokens });
    return lines.length > 0 ? lines.join('\n') : '-';
  }

  /** The record line: its messages (the distinct message ids), its first day to today, and the share of those days
   * with lines: the record's own `stats`. */
  async function recordLine(guildId, today) {
    if (typeof record?.stats !== 'function') return 'record: not available';
    const { messages, days, first } = await record.stats(guildId);
    if (first === null) return `record: ${messages} messages`;
    const since = Math.max(1, daysBetween(first, today));
    return `record: ${messages} messages · ${first}..${today} · ${percent(days, since)} of days have lines`;
  }

  /** The meaning index line: `off` unless features.meaningSearch and features.embedIndex are both
   * exactly true; else its rows (the guild's and every private layer's), the share of the record
   * messages of the last `embed.catchUpHours` it holds and the day of the oldest one missing. */
  async function indexLine(guildId, cfg) {
    if (cfg?.features?.meaningSearch !== true || cfg?.features?.embedIndex !== true) return 'index: off';
    if (typeof embedQueue?.indexSummary !== 'function') return 'index: not available';
    const { rows } = await embedQueue.indexSummary(guildId);
    const parts = [`index: ${rows} rows`];
    if (typeof embedQueue.coverage === 'function') {
      const configured = cfg?.embed?.catchUpHours;
      const hours = typeof configured === 'number' && Number.isFinite(configured) && configured > 0 ? configured : CATCH_UP_HOURS;
      const found = await embedQueue.coverage(guildId, { hours });
      parts.push(`${percent(found.indexed, found.messages)} of record messages indexed (last ${hours} h)`);
      parts.push(found.oldestMissing ? `oldest missing ${String(found.oldestMissing).slice(0, 10)}` : 'none missing');
    }
    return parts.join(' · ');
  }

  /** The archive line: its entries by event (ARCHIVE_EVENTS order), and the days the oldest and
   * the newest of them were observed. */
  async function archiveLine(guildId) {
    if (typeof archive?.iterate !== 'function') return 'archive: not available';
    const byEvent = new Map();
    let entries = 0;
    let oldest = null;
    let newest = null;
    for await (const entry of archive.iterate(guildId)) {
      entries += 1;
      const event = typeof entry?.event === 'string' ? entry.event : 'other';
      byEvent.set(event, (byEvent.get(event) ?? 0) + 1);
      const day = String(entry?.observedAt?.date ?? '').slice(0, 10);
      if (!DAY_RE.test(day)) continue;
      if (oldest === null || day < oldest) oldest = day;
      if (newest === null || day > newest) newest = day;
    }
    const order = (event) => (ARCHIVE_EVENTS.includes(event) ? ARCHIVE_EVENTS.indexOf(event) : ARCHIVE_EVENTS.length);
    const kinds = [...byEvent].sort(([a], [b]) => order(a) - order(b)).map(([event, count]) => `${event} ${count}`);
    const parts = [`archive: ${entries} entries`];
    if (kinds.length > 0) parts.push(kinds.join(', '));
    if (oldest) parts.push(`observed ${oldest}..${newest}`);
    return parts.join(' · ');
  }

  /** The profiles line: their count, the share with a portrait (`character`), their episodes
   * (total and per profile), details, aliases and real names set. */
  function profilesLine(guildId) {
    const profiles = store.listUserProfiles(guildId) ?? [];
    let portraits = 0;
    let episodes = 0;
    let details = 0;
    let aliases = 0;
    let realNames = 0;
    for (const profile of profiles) {
      if (typeof profile?.character === 'string' && profile.character.trim()) portraits += 1;
      episodes += countOf(profile?.episodes);
      details += countOf(profile?.details);
      aliases += countOf(profile?.aliases);
      if (typeof profile?.realName?.name === 'string' && profile.realName.name) realNames += 1;
    }
    const n = profiles.length;
    const perProfile = n > 0 ? Math.round((episodes / n) * 10) / 10 : 0;
    return [
      `profiles: ${n}`,
      `${percent(portraits, n)} with a portrait`,
      `${episodes} episodes (${perProfile} per profile)`,
      `${details} details`,
      `${aliases} aliases`,
      `${realNames} real names set`,
    ].join(' · ');
  }

  /** The server notes line: lore entries, lessons (`learned`), self facts and in-jokes. */
  function serverNotesLine(guildId) {
    const guild = store.getGuild(guildId) ?? {};
    return `server notes: ${countOf(store.getLore(guildId))} lore entries · ${countOf(guild.learned)} lessons · ${countOf(guild.self)} self facts · ${countOf(guild.injokes)} in-jokes`;
  }

  /** The channels line: the channels with notes (a purpose, topics or a tone) of those seen. */
  function channelsLine(guildId) {
    const channels = store.listChannels(guildId) ?? [];
    const noted = channels.filter((channel) => ['purpose', 'topics', 'tone'].some((key) => typeof channel?.[key] === 'string' && channel[key].trim())).length;
    return `channels: ${noted} with notes / ${channels.length} seen (${percent(noted, channels.length)})`;
  }

  /** The recent lines (from the oldest `at` to the newest) and the participation fragments (from
   * the first message of the oldest to the last message of the newest). */
  function recentLine(guildId) {
    const lines = store.getRecent?.(guildId)?.lines ?? [];
    const at = lines.map((line) => line?.at);
    return datedLine('recent lines', lines.length, at, at);
  }

  function participationLine(guildId) {
    const episodes = store.getParticipation?.(guildId)?.episodes ?? [];
    return datedLine('participation fragments', episodes.length, episodes.map((episode) => episode?.startAt), episodes.map((episode) => episode?.lastAt));
  }

  /** One coverage line through `compute`; `<name>: unreadable` (and a warn with the code) when it throws. */
  async function safeLine(name, compute) {
    try {
      return await compute();
    } catch (err) {
      log.warn('status: coverage failed', { name, code: err?.code ?? null });
      return `${name}: unreadable`;
    }
  }

  /** The features part: each `features` switch of the live config that is a plain true or false, `<name> on|off`, sorted by name. */
  function featuresValue(cfg) {
    const features = isPlainObject(cfg?.features) ? cfg.features : {};
    const lines = Object.keys(features).filter((name) => typeof features[name] === 'boolean').sort().map((name) => `${name} ${features[name] ? 'on' : 'off'}`);
    return lines.length > 0 ? lines.join('\n') : '-';
  }

  /** The memory database's one line (words from `labels.status.memoryDb`; a missing or blank label leaves the line out). */
  function memoryDbLine() {
    if (typeof memoryDb?.status !== 'function') return null;
    return memoryDbStatusLine(memoryDb.status(), hot.prompts?.labels);
  }

  /** The memory field (the coverage of every kind of memory), one line per kind. */
  async function computeMemory(guildId) {
    const cfg = hot.config;
    const today = utcDay(clock());
    return [
      await safeLine('record', () => recordLine(guildId, today)),
      await safeLine('index', () => indexLine(guildId, cfg)),
      await safeLine('archive', () => archiveLine(guildId)),
      await safeLine('profiles', () => profilesLine(guildId)),
      await safeLine('server notes', () => serverNotesLine(guildId)),
      await safeLine('channels', () => channelsLine(guildId)),
      await safeLine('recent lines', () => recentLine(guildId)),
      await safeLine('participation fragments', () => participationLine(guildId)),
      memoryDbLine(),
    ].filter(Boolean).join('\n');
  }

  /** The guild's memory field, computed at most once per COVERAGE_CACHE_MS (the cached text in between). */
  async function memoryValue(guildId) {
    // The chat window is read live (a config edit shows at once), ahead of the cached coverage.
    const size = hot.config?.context?.channelMessages;
    const windowLine = Number.isFinite(size) ? `chat window: last ${size} messages in the active channel` : null;
    const withWindow = (value) => [windowLine, value].filter(Boolean).join('\n');
    const cached = coverageCache.get(guildId);
    if (cached && clock() - cached.at < COVERAGE_CACHE_MS) return withWindow(cached.value);
    const value = await computeMemory(guildId);
    coverageCache.set(guildId, { at: clock(), value });
    return withWindow(value);
  }

  /** The speed field: each metric's median and mean over the last 24 h with the sample count in
   * brackets, `-` without a sample; the planner only while features.turnPlanner is on. */
  function speedValue(cfg) {
    if (typeof metrics?.summary !== 'function') return 'not available';
    return SPEED_METRICS.filter((name) => name !== 'planner' || plannerOn(cfg))
      .map((name) => {
        const { n, median, mean } = metrics.summary(name, 24);
        return n > 0 ? `${name}: median ${duration(median)} · mean ${duration(mean)} (${n})` : `${name}: -`;
      })
      .join('\n');
  }

  /**
   * The speed field's last line: today's missed-answer figures from the journal's `answer`
   * records (src/behavior/missed.js#missedCounts). Null -- no line -- without a journal that
   * reads, without a guild, or with features.journal off; `missed: unreadable` when the read fails.
   */
  async function missedLine(guildId, cfg) {
    if (!guildId || typeof journal?.read !== 'function' || cfg.features?.journal !== true) return null;
    try {
      const records = await journal.read(guildId, { day: utcDay(clock()), kind: 'answer', n: Number.MAX_SAFE_INTEGER });
      return missedStatusLine(missedCounts(records));
    } catch (err) {
      log.warn('status: missed unread', { code: err?.code ?? null });
      return 'missed: unreadable';
    }
  }

  /**
   * The status card as plain embed data (`{ fields: [{ name, value, inline }] }`), the fields in
   * STATUS_FIELDS order, one item per line in each, a field with no line `-`; `owner` false leaves
   * out the keys, costs, memory and speed fields and the storage line (and sends no account read), and
   * names the models without probing them. With `field` (one of STATUS_FIELDS this caller may see)
   * the card holds that field alone and only its work runs (no probe, no account read, no
   * coverage for another field); any other `field` gives the whole card. Reads the freshest data/
   * even mid-pause.
   */
  async function cmdStatusCard({ owner, field = null, part = null }) {
    freshenIfPaused();
    const cfg = hot.config;
    const data = store.state.data ?? {};
    const guildId = getGuildId?.() ?? null;
    const unresolved = 'guild not resolved yet';
    const visible = STATUS_FIELDS.filter((name) => (owner || !OWNER_FIELDS.has(name)) && (name !== 'inner' || innerOn(cfg)));
    // Her own call may ask for a part (PART_FIELDS): the fields it holds that she may see, models named and never probed.
    const partFields = typeof part === 'string' && Object.hasOwn(PART_FIELDS, part) && part !== 'all' ? PART_FIELDS[part] : null;
    const probe = partFields === null && part !== 'all';
    const shown = partFields ? partFields.filter((name) => name === 'features' || visible.includes(name)) : visible.includes(field) ? [field] : visible;
    if (partFields && shown.length === 0) return { fields: [{ name: part, value: '-', inline: false }] };
    // Each field's work, run only for the fields shown, all at once: the account reads go out
    // alongside the model probes.
    const compute = {
      // The state, then the gateway connection, then the uptime.
      state: async () => [stateValue(data), owner ? await storageLine(guildId, cfg) : null, connectionValue(), `uptime ${span(process.uptime() * 1000)}`].filter(Boolean).join('\n'),
      tasks: () => longTasksValue(guildId),
      // The owner's card probes every model (the old ping); a member's, or one without an llm client, names them.
      features: () => featuresValue(cfg),
      'models.base': () => (owner && probe && typeof llm?.complete === 'function' ? probedModelsValue(cfg) : modelsValue(cfg)),
      'keys.base': () => keyCostsValue(cfg),
      'costs.base': () => roleCostsValue(),
      'models.errands': () => agentModels(cfg, ERRAND_ROLES),
      'costs.errands': () => errandCostsValue(guildId),
      'models.development': () => agentModels(cfg, DEVELOPMENT_ROLES),
      'costs.development': () => developmentCostsValue(),
      inner: () => innerValue(guildId),
      limits: () => limitsValue(cfg, data),
      memory: () => (guildId ? memoryValue(guildId) : unresolved),
      speed: async () => [speedValue(cfg), await missedLine(guildId, cfg)].filter(Boolean).join('\n'),
    };
    const values = await Promise.all(shown.map((name) => compute[name]()));
    const fields = shown.map((name, i) => ({ name, value: fitField(values[i] || '-'), inline: false }));
    return { fields };
  }

  return { cmdStatusCard };
});

defineOp({
  name: 'status.show',
  rights: { kind: 'read' },
  run: async (args, ctx) => {
    const owner = isOwnerId(ctx.env.hot.config, ctx?.userId);
    const field = typeof args?.field === 'string' ? args.field : null;
    // Her own call without a part gets the short overview; the owner's command without a field, the whole card.
    const asked = typeof args?.part === 'string' && STATUS_PARTS.includes(args.part) ? args.part : null;
    const part = asked ?? (ctx?.actor === 'persona' && !field ? 'overview' : null);
    const card = await handlers(ctx.env).cmdStatusCard({ owner, field, part });
    return { text: '', embeds: [card] };
  },
});
