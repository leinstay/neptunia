// Operations: `/nep status [field]`: what the bot is doing now, read only. The reply is one
// card (`cmdStatusCard`, plain embed data: interfaces/discord/commands.js wraps it for discord.js), the
// most important field first, for a phone; `field` keeps only that field and computes nothing
// for the others. A member (anyone not in `bot.owners`) gets the card without the storage line,
// the keys, costs, memory and speed fields. Every field lists one item per line; the state field ends
// with the gateway and the uptime. The core comes first (`models.base`, `keys.base`, `costs.base`),
// then the agents (`models.agents`, `costs.agents`). The models sit in two fields, one line per role, `<role> · <model> ...`:
// `models.base` (voice, analyzer, reasoner, extractor, vision, video, embedding) and `models.agents` (web, server,
// thinker, dev, writer, which are never probed: an OpenCode worker runs them, not the bot; then drawing). The owner's card probes on every call: one minimal chat completion per
// distinct chat model and route (`labels.status.probe`, `llm.probeTimeoutMs`, never counted
// against `llm.maxRequestsPerDay` nor calibrated, `origin: 'status'`), one one-input embedding
// request for the embedding role, and one free GET of the drawing model's provider listing; a
// member's card only names the models. Each role shows its own model (never another role's), and
// each base role's line is followed by the `models.base.byPurpose` overrides of its purposes. The memory field (the coverage of every kind of
// memory) is computed at most once a minute: directory listings and the record's month indexes,
// never its day files. The speed field reads src/ops/metrics.js (the last 24 h), then today's
// missed-answer figures from the journal (src/behavior/missed.js). The `keys.base`
// field reads the limit of each API key of the core (one free GET per key; the errand agents' key
// is left out: their spend is `costs.agents`) and the rolling 7/30-day sums per key; `costs.base`
// reads today's per-role accumulator (src/ops/usage.js); `costs.agents` the errand records' spend
// per agent (src/errands/costs.js through the guild's task store) and the development agents'
// (thinker, dev, writer) from the ledger (src/errands/ledger.js#costs, with the thinker's last-wave
// context), those three shown with no runs when the ledger does not answer.

import fs from 'node:fs/promises';
import path from 'node:path';
import { RECALL_DAILY } from '../behavior/recall-run.js';
import { keyHashOf, llmCountToday, resolveProvider } from '../llm/openrouter.js';
import { familyOf as imageFamilyOf, IMAGE_ROLE } from '../llm/images.js';
import { countToday, DAY_MS, HOUR_MS, MINUTE_MS, utcDay, utcMinute } from '../time.js';
import { VIDEO_DAILY, ARCHIVE_EVENTS } from '../memory/index.js';
import { WEB_DAILY } from '../web/lookup.js';
import { clampChars, oneLine } from '../memory/clamp.js';
import { isOwnerId } from './grants.js';
import { MODEL_ROLES, STATUS_FIELDS } from './catalog.js';
import { OPENCODE_ROLES, PURPOSE_ROLES, roleModel } from '../llm/roles.js';
import { EMBED_ROLE } from '../llm/embed.js';
import { plannerOn } from '../behavior/planner.js';
import { missedCounts, missedStatusLine } from '../behavior/missed.js';
import { SPEED_METRICS } from './metrics.js';
import { activitySums, agentCostsLines, keyCostsLines, roleCostsLines, readAccount, readActivity } from './usage.js';
import { PROFILES } from '../agent-runner/profiles.js';
import { LEDGER_AGENTS } from '../errands/ledger.js';
import { isPlainObject } from '../config.js';
import { log } from '../log.js';
import { modelForRole } from './shared.js';
import { defineOp, perEnv } from './registry.js';

/** The card's field names, in order (src/ops/catalog.js#STATUS_FIELDS, the `field` option's choices). */
export { STATUS_FIELDS };

/** The fields a member's card leaves out. */
const OWNER_FIELDS = new Set(['keys.base', 'costs.base', 'costs.agents', 'memory', 'speed']);

/** The model roles of the errand agents (src/agent-runner/profiles.js): a key only they use is
 * the agents' key, which `keys.base` leaves out. */
const ERRAND_ROLES = new Set(Object.values(PROFILES).map((profile) => profile.modelRole));

/**
 * The `models.base` field's groups, in order: one line per role, then the
 * `models.base.byPurpose` overrides of the purposes that go out on those roles
 * (src/llm/roles.js#PURPOSE_ROLES; a purpose it does not list follows the analyzer).
 */
const MODEL_GROUPS = Object.freeze([
  { name: 'voice', roles: ['voice'] },
  { name: 'analyzer', roles: ['analyzer'], unlistedPurposes: true },
  { name: 'reasoner', roles: ['reasoner'] },
  { name: 'extractor', roles: ['extractor'] },
  { name: 'vision', roles: ['vision'] },
  { name: 'video', roles: ['video'] },
  { name: 'embedding', roles: [EMBED_ROLE] },
]);

/** `<role> · <model>`: each role shows its own model, never another role's. */
function roleHead(role, model) {
  return `${role} · ${model}`;
}

/** An OpenCode agent role's line: its model, never probed (an OpenCode worker runs it, not the bot). */
function agentLine(role, cfg, probed) {
  const head = roleHead(role, roleModel(cfg, role) ?? 'no model configured');
  return probed ? `${head} · not probed (runs on OpenCode)` : head;
}

/** The `models.base.byPurpose` overrides of the live config whose purpose goes out on one of `roles`
 * (with `unlisted`, also those of a purpose PURPOSE_ROLES does not list), one
 * `byPurpose <purpose> · <model>` line each. */
function byPurposeLines(cfg, roles, unlisted) {
  const byPurpose = cfg?.models?.base?.byPurpose;
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

/** The `models.agents` field: each OpenCode role's `agentLine` (probed or not as `probed` says),
 * then the drawing role's line `imageLine` (left out when null). */
function agentModels(cfg, imageLine, probed = false) {
  const lines = OPENCODE_ROLES.map((role) => agentLine(role, cfg, probed));
  if (imageLine) lines.push(imageLine);
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

const MONTH_DIR_RE = /^\d{4}-\d{2}$/;
const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The names in `dir`, sorted; [] when it does not exist. */
async function listDir(dir) {
  try {
    return (await fs.readdir(dir)).sort();
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return [];
    throw err;
  }
}

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
  const { hot, store, client, getGuildId, images, archive, journal, record, metrics, lookup, usage, errands, emojiBackfill, gifBackfill, gifRecache, freshenIfPaused, imageModelLabel, llm, embedder, embedQueue } = env;
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

  /** When the journal was last written (today's day file, else yesterday's: the first hour after
   * midnight), as epoch ms, or null (no journal, no file). */
  async function journalLastWrite(guildId, nowMs) {
    if (typeof journal?.dayFile !== 'function') return null;
    let last = null;
    for (const at of [nowMs, nowMs - DAY_MS]) {
      try {
        const stat = await fs.stat(journal.dayFile(guildId, new Date(at).toISOString()));
        if (last === null || stat.mtimeMs > last) last = stat.mtimeMs;
      } catch {
        // no file that day
      }
    }
    return last;
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

  /** The `models.base` field unprobed (a member's card): every role's own model. */
  function modelsValue(cfg) {
    return groupedModels(cfg, (role) => roleHead(role, modelForRole(role, cfg) ?? 'no model configured'));
  }

  /** The `models.agents` field unprobed (a member's card): every agent role's own model, the drawing model last. */
  function agentsValue(cfg) {
    const image = roleHead(IMAGE_ROLE, roleModel(cfg, 'drawing') ? imageModelLabel(cfg) : 'no model configured');
    return agentModels(cfg, image);
  }

  /** The owner's `models.agents` field: the OpenCode roles unprobed, the drawing model's listing
   * read (one free GET). */
  async function probedAgentsValue(cfg) {
    const timeoutMs = cfg?.llm?.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
    return agentModels(cfg, await imageProbeLine(cfg, timeoutMs), true);
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
   * input -- one line per role in MODEL_GROUPS order, the per-purpose overrides (unprobed)
   * after their role. Roles
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
      const model = modelOf.get(role);
      if (!model) return roleHead(role, 'no model configured');
      const head = roleHead(role, model);
      if (!promptText) return `${head} · skipped: label missing`;
      if (role === EMBED_ROLE && !canEmbed) return `${head} · not checked (no embedding client)`;
      return probeLine(head, results.get(targetOf(role)));
    };
    return groupedModels(cfg, lineOf);
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
   * here) but the errand agents' (a key whose roles are all ERRAND_ROLES: no line, no read), free GETs in parallel (`llm.keyInfo`; `llm.probeTimeoutMs`, never counted against
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
    // The errand agents' key is not the core's: their spend is the costs.agents field.
    const agentsOnly = (group) => group.roles.length > 0 && group.roles.every((role) => ERRAND_ROLES.has(role));
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

  /** The owner's `costs.agents` field (src/ops/usage.js#agentCostsLines): each OpenCode agent's
   * runs, tokens and estimated dollars today and over the last 7 and 30 days, the errand agents
   * from the guild's task store (src/errands/store.js#costs; none without the errands or a guild),
   * thinker, dev and writer from the ledger (src/errands/ledger.js#costs, which replaces the
   * records' figures for those three; the thinker's last wave adds its context line). An agent
   * with no figures shows no runs: a ledger that is not configured, refuses, fails or does not
   * answer in time never fails the field. `-` when the labels give no line. */
  async function agentCostsValue(guildId) {
    const tasks = guildId && typeof errands?.store === 'function' ? errands.store(guildId) : null;
    const totals = { ...(typeof tasks?.costs === 'function' ? tasks.costs(OPENCODE_ROLES) : {}) };
    let ledgerTotals = null;
    try {
      ledgerTotals = typeof errands?.ledger?.costs === 'function' ? await errands.ledger.costs() : null;
    } catch (err) {
      log.warn('status: ledger costs failed', { error: err });
    }
    for (const agent of LEDGER_AGENTS) {
      if (ledgerTotals?.[agent]) totals[agent] = ledgerTotals[agent];
      else delete totals[agent];
    }
    // The OpenCode agents in order, then any other agent the records name.
    const agents = [...new Set([...OPENCODE_ROLES, ...Object.keys(totals)])];
    const lines = agentCostsLines({ agents, totals, labels: hot.prompts?.labels });
    return lines.length > 0 ? lines.join('\n') : '-';
  }

  /** The record line: its messages (the distinct ids of the month indexes), its first day to
   * today, and the share of those days with a day file. Reads directory listings and one
   * `ids.json` per month, never a day file. */
  async function recordLine(guildId, today) {
    if (typeof record?.dayFile !== 'function') return 'record: not available';
    // The guild record's root: the parent of a month directory (src/memory/record.js's layout).
    const base = path.dirname(path.dirname(record.dayFile(guildId, '2000-01-01T00:00:00.000Z')));
    const ids = new Set();
    let days = 0;
    let first = null;
    for (const month of (await listDir(base)).filter((name) => MONTH_DIR_RE.test(name))) {
      for (const name of await listDir(path.join(base, month))) {
        const day = name.match(DAY_FILE_RE)?.[1];
        if (!day) continue;
        days += 1;
        if (first === null || day < first) first = day;
      }
      let keys = null;
      try {
        keys = JSON.parse(await fs.readFile(path.join(base, month, 'ids.json'), 'utf8'));
      } catch {
        // no index for the month yet: its messages are not counted
      }
      if (Array.isArray(keys)) {
        for (const key of keys) if (typeof key === 'string' && key.includes(':')) ids.add(key.slice(0, key.lastIndexOf(':')));
      }
    }
    if (first === null) return `record: ${ids.size} messages`;
    const since = Math.max(1, daysBetween(first, today));
    return `record: ${ids.size} messages · ${first}..${today} · ${percent(days, since)} of days have lines`;
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
    ].join('\n');
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
  async function cmdStatusCard({ owner, field = null }) {
    freshenIfPaused();
    const cfg = hot.config;
    const data = store.state.data ?? {};
    const guildId = getGuildId?.() ?? null;
    const unresolved = 'guild not resolved yet';
    const visible = STATUS_FIELDS.filter((name) => owner || !OWNER_FIELDS.has(name));
    const shown = visible.includes(field) ? [field] : visible;
    // Each field's work, run only for the fields shown, all at once: the account reads go out
    // alongside the model probes.
    const compute = {
      // The state, then the gateway connection, then the uptime.
      state: async () => [stateValue(data), owner ? await storageLine(guildId, cfg) : null, connectionValue(), `uptime ${span(process.uptime() * 1000)}`].filter(Boolean).join('\n'),
      tasks: () => longTasksValue(guildId),
      // The owner's card probes every model (the old ping); a member's, or one without an llm client, names them.
      'models.base': () => (owner && typeof llm?.complete === 'function' ? probedModelsValue(cfg) : modelsValue(cfg)),
      'keys.base': () => keyCostsValue(cfg),
      'costs.base': () => roleCostsValue(),
      'models.agents': () => (owner && typeof llm?.complete === 'function' ? probedAgentsValue(cfg) : agentsValue(cfg)),
      'costs.agents': () => agentCostsValue(guildId),
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
    const card = await handlers(ctx.env).cmdStatusCard({ owner, field });
    return { text: '', embeds: [card] };
  },
});
