// Operations: `/nep status [detail]`: what the bot is doing now, read only. The reply is one
// card (`cmdStatusCard`, plain embed data: src/discord/commands.js wraps it for discord.js), the
// most important field first, for a phone; `detail` adds the long text form (`cmdStatus`) below
// it. A member (anyone not in `bot.owners`) gets the card without the memory and journal fields,
// and never the long form. Every field lists one item per line. The owner's card probes on every
// call: one minimal chat completion per distinct chat model and route (`labels.status.probe`,
// `llm.probeTimeoutMs`, never counted against `llm.maxRequestsPerDay` nor calibrated,
// `origin: 'status'`), one one-input embedding request for the embedding role, and one free
// GET of the drawing model's provider listing; a member's card only names the models. A role
// whose own key is unset is shown with the role it falls back to (`labels.status.fallback`).

import fs from 'node:fs/promises';
import { gifWatchesToday } from '../memory/gif-watch.js';
import { initiateCooldownUntil } from '../behavior/spontaneous.js';
import { RECALL_DAILY } from '../behavior/recall-run.js';
import { llmCountToday, resolveProvider } from '../llm/openrouter.js';
import { familyOf as imageFamilyOf, IMAGE_ROLE } from '../llm/images.js';
import { countToday, DAY_MS, HOUR_MS, MINUTE_MS } from '../time.js';
import { VOICE_DAILY } from '../memory/update.js';
import { VIDEO_DAILY } from '../memory/describe.js';
import { WEB_DAILY } from '../web/lookup.js';
import { PORTRAIT_SLOTS, portraitSettings } from '../memory/portrait.js';
import { clampChars, oneLine } from '../memory/clamp.js';
import { isOwnerId } from '../discord/access.js';
import { MODEL_ROLES, MODEL_ROLE_PATHS } from '../discord/commands.js';
import { EMBED_ROLE } from '../llm/embed.js';
import { isPlainObject } from '../config.js';
import { fill } from '../discord/format.js';
import { log } from '../log.js';
import { todayUtc, onOff, modelForRole } from './shared.js';
import { defineOp, perEnv } from './registry.js';

/** The card's field names, in order (the memory and journal ones are the owner's only). */
export const STATUS_FIELDS = Object.freeze(['state', 'connection', 'long tasks', 'models', 'today', 'memory', 'journal', 'uptime']);

/** The fields a member's card leaves out. */
const OWNER_FIELDS = new Set(['memory', 'journal']);

/** The roles the models field names after the voice, each only when its model differs. */
const OTHER_ROLES = Object.freeze(MODEL_ROLES.filter((role) => role !== 'voice'));

/** The role whose model a role takes while its own key is unset (src/ops/shared.js#modelForRole). */
const FALLBACK_ROLE = Object.freeze({ analyzer: 'voice', 'classifier.reason': 'classifier.text', 'classifier.text': 'classifier.media' });

/** The config value at a dotted path, or undefined. */
function valueAt(cfg, dotted) {
  return dotted.split('.').reduce((node, key) => (isPlainObject(node) ? node[key] : undefined), cfg);
}

/**
 * The role whose own key supplies `role`'s model now: `role` itself when its key is set, else
 * the end of its fallback chain (e.g. `classifier.reason` unset -> `classifier.text`), or null
 * when no key on the chain is set.
 * @param {string} role
 * @param {object|undefined} cfg  The whole live config.
 * @returns {string|null}
 */
function modelSourceRole(role, cfg) {
  let current = role;
  for (let hops = 0; hops < 4 && current; hops += 1) {
    const own = valueAt(cfg, MODEL_ROLE_PATHS[current] ?? '');
    if (typeof own === 'string' && own) return current;
    current = FALLBACK_ROLE[current];
  }
  return null;
}

/** `<role> <model>`, with `labels.status.fallback` (`{role}` = the role it falls back to) when
 * the model comes from another role's key; no marker without the label. */
function roleHead(role, model, cfg, labels) {
  const source = modelSourceRole(role, cfg);
  const template = labels?.status?.fallback;
  const marker = source && source !== role && typeof template === 'string' && template ? ` ${fill(template, { role: source })}` : '';
  return `${role} ${model}${marker}`;
}

/** The `classifier.byPurpose` overrides of the live config, one `byPurpose <purpose> <model>` line each. */
function byPurposeLines(cfg) {
  const byPurpose = cfg?.classifier?.byPurpose;
  if (!isPlainObject(byPurpose)) return [];
  return Object.entries(byPurpose)
    .filter(([, model]) => typeof model === 'string' && model)
    .map(([purpose, model]) => `byPurpose ${purpose} ${model}`);
}

/** `llm.probeTimeoutMs` when config.json lacks it (the same value). */
const PROBE_TIMEOUT_MS = 30000;

/** How much of a failed probe's error message the card keeps. */
const PROBE_ERROR_CHARS = 160;

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

/** One role's probe lines: `<head> · ok <ms> ms` with the provider and token counts (or an
 * embedding's dimensions) indented below, or `<head> · error: <message>` with the routing funnel
 * below; `head` is `<role> <model>` with its fallback marker (roleHead). */
function probeLines(head, outcome) {
  if (!outcome.ok) {
    const message = clampChars(oneLine(outcome.err?.message ?? outcome.err ?? 'error'), PROBE_ERROR_CHARS);
    const funnel = extractRoutingFunnel(outcome.err?.body);
    return funnel ? [`${head} · error: ${message}`, `  ${funnel}`] : [`${head} · error: ${message}`];
  }
  const detail = [];
  if (outcome.result?.provider) detail.push(`provider=${outcome.result.provider}`);
  const usage = outcome.result?.usage ?? {};
  if (usage.prompt_tokens != null || usage.completion_tokens != null) {
    detail.push(`tokens ${usage.prompt_tokens ?? '?'}/${usage.completion_tokens ?? '?'}`);
  }
  if (Number.isInteger(outcome.result?.dimensions)) detail.push(`dimensions=${outcome.result.dimensions}`);
  const line = `${head} · ok ${outcome.ms} ms`;
  return detail.length > 0 ? [line, `  ${detail.join(', ')}`] : [line];
}

/** `YYYY-MM-DD HH:MM UTC` for an epoch ms or an ISO string; `-` for anything else. */
function utcMinute(value) {
  const ms = typeof value === 'number' ? value : Date.parse(String(value ?? ''));
  if (!Number.isFinite(ms)) return '-';
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
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

const handlers = perEnv((env) => {
  const { hot, store, client, spontaneous, calibrator, getGuildId, isWarmingUp, warmup, images, archive, journal, emojiBackfill, gifBackfill, gifRecache, freshenIfPaused, imageModelLabel, llm, embedder, embedQueue } = env;

  /** The next spontaneous turn of `guildId` as an ISO time: src/behavior/spontaneous.js#status
   * keeps `{ [guildId]: epochMs }`. Null when there is none (or no scheduler). */
  function nextSpontaneousFor(guildId) {
    const ms = spontaneous?.status?.()?.[guildId];
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }

  function cmdStatus() {
    freshenIfPaused(); // read the freshest data/ even mid-pause
    const cfg = hot.config;
    const data = store.state.data ?? {};
    const dryRunOn = cfg?.features?.dryRun === true;
    const dryRunChannelId = cfg?.bot?.dryRunChannelId || '';
    const dryRunTarget = dryRunOn ? ` → log${dryRunChannelId ? ` + #${dryRunChannelId}` : ''}` : '';
    const lines = [
      `dry-run: ${onOff(dryRunOn)}${dryRunTarget}`,
      `model: ${cfg?.llm?.model ?? '-'}`,
      `calibration ratio: ${calibrator ? calibrator.ratio.toFixed(3) : '-'}`,
      `llm requests today: ${llmCountToday(data, Date.now())} / ${cfg?.llm?.maxRequestsPerDay ?? '-'} (day: ${todayUtc()})`,
      `paused: ${onOff(data.paused)}${data.paused ? ` (since ${data.pausedAt ?? '?'})` : ''}`,
      `warming up: ${onOff(isWarmingUp())}`,
    ];

    if (images) {
      const quota = images.quota({ userId: null });
      lines.push(`images today: ${quota.used}/${quota.cap ?? '-'}`, `image model: ${imageModelLabel(cfg)}`);
    }

    // GIF watches have their own daily cap (media.gif.maxPerDay), apart from the video one.
    const gifWatches = gifWatchesToday(data, cfg, todayUtc());
    lines.push(`gif watches today: ${gifWatches.used}/${gifWatches.cap}`);

    // Portraits share one daily cap (memory.portraitRefreshPerDay) between the analyzer and the owner.
    const portraitsToday = countToday(data, PORTRAIT_SLOTS, todayUtc());
    lines.push(`portraits refreshed today: ${portraitsToday}/${portraitSettings(cfg).perDay}`);

    if (warmup && typeof warmup.summary === 'function') {
      const summary = warmup.summary();
      lines.push(
        `warmup: channels=${summary.doneChannels} people=${summary.donePeople} server=${summary.doneServer ? 'done' : 'pending'} ` +
          `tokens=${summary.tokensUsed} requests=${summary.requests} aborted=${summary.aborted ?? 'no'}`,
      );
    }

    const guildId = getGuildId?.() ?? null;
    if (guildId) {
      const guildName = client?.guilds?.cache?.get(guildId)?.name;
      const label = guildName ? `${guildName} (${guildId})` : guildId;
      const profiles = store.countUsers(guildId);
      const buffer = store.getBuffer(guildId);
      const next = nextSpontaneousFor(guildId);
      lines.push(`guild: ${label} profiles=${profiles} buffer=${buffer.length} nextSpontaneous=${next ?? '-'}`);
      // The pause after a topic the persona started (spontaneous.initiateCooldownHours), only while it holds.
      const initiateUntil = initiateCooldownUntil(data, guildId, Date.now(), cfg?.spontaneous);
      if (initiateUntil !== null) lines.push(`initiate cooldown until ${new Date(initiateUntil).toISOString()}`);
      // The voice lines exist only while the two-stage analyzer is on (features.memoryTwoStage).
      if (cfg?.features?.memoryTwoStage === true) {
        const voiceCap = cfg?.memory?.voice?.maxPerDay;
        lines.push(
          `voice queue: ${store.getVoiceQueue(guildId).length}`,
          `voice requests today: ${countToday(data, VOICE_DAILY, todayUtc())}/${Number.isFinite(voiceCap) ? voiceCap : 100}`,
        );
      }
    } else {
      lines.push('guild: not resolved yet');
    }

    const privateChat = onOff(cfg?.features?.privateMessages === true);
    lines.push(guildId ? `private chat: ${privateChat} · ${store.listPrivate(guildId).length} private files` : `private chat: ${privateChat}`);

    const prompts = hot.prompts ?? {};
    const sources = hot.promptSources ?? {};
    for (const name of Object.keys(prompts)) {
      if (name === 'labels') {
        lines.push(`prompt labels: locale=${prompts.labels?.locale ?? '-'} source=${sources.labels ?? '-'}`);
        continue;
      }
      lines.push(`prompt ${name}: ${prompts[name].length} chars source=${sources[name] ?? '-'}`);
    }

    return lines.join('\n');
  }

  /** The state field: running, or paused with since when and by whom (`pausedBy`, when known). */
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

  /** The models field unprobed: the voice, then each other role (the drawing model last) whose model
   * differs from it, each with its fallback marker, then the per-purpose overrides. */
  function modelsValue(cfg) {
    const labels = hot.prompts?.labels;
    const voice = modelForRole('voice', cfg) ?? '-';
    const parts = [`voice ${voice}`];
    for (const role of OTHER_ROLES) {
      const model = modelForRole(role, cfg);
      if (model && model !== voice) parts.push(roleHead(role, model, cfg, labels));
    }
    const image = cfg?.image?.model;
    if (image && image !== voice) parts.push(`${IMAGE_ROLE} ${imageModelLabel(cfg)}`);
    parts.push(...byPurposeLines(cfg));
    return parts.join('\n');
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
      return `error: ${err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'network'}`;
    }
    if (listing.status === 404) return 'not listed (HTTP 404)';
    if (!listing.ok) return `error: HTTP ${listing.status}`;
    const modalities = listing.json?.data?.architecture?.output_modalities;
    if (!Array.isArray(modalities) || !modalities.includes('image')) return 'listed, but no image output';
    const endpoints = Array.isArray(listing.json.data.endpoints) ? listing.json.data.endpoints.length : 0;
    return `listed, image output, ${endpoints} endpoint(s), ${Date.now() - start} ms`;
  }

  /** The drawing model's line, or null when none is set; notes when drawing is switched off
   * (features.imageGeneration false; a missing key counts as on). */
  async function imageProbeLine(cfg, timeoutMs) {
    const model = cfg?.image?.model;
    if (!model) return null;
    const off = cfg?.features?.imageGeneration === false ? ' (features.imageGeneration is off)' : '';
    return `${IMAGE_ROLE} ${model} · ${await imageListing(model, timeoutMs)}${off}`;
  }

  /**
   * The owner's models field: every role's model, as resolved now, probed in parallel -- the chat
   * roles with one minimal chat completion, the embedding role with one embedding request of one
   * input -- then the per-purpose overrides (unprobed) and the drawing model's listing. Roles
   * sharing a model and a provider route share a probe (a role-specific `llm.providerByModel` key
   * routing one elsewhere makes it a probe of its own); each probe goes out as the first role that
   * needs it. Never counted against the daily cap, never calibrated, never writes under data/.
   * Logs `status: probed` with the counts.
   */
  async function probedModelsValue(cfg) {
    const timeoutMs = cfg?.llm?.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
    const labels = hot.prompts?.labels;
    const image = imageProbeLine(cfg, timeoutMs);
    const roleModel = new Map(MODEL_ROLES.map((role) => [role, modelForRole(role, cfg)]));
    // An embedding probe is another kind of request: never shared with a chat probe of the same model.
    const targetOf = (role) => {
      const model = roleModel.get(role);
      const route = resolveProvider(model, { byModel: cfg?.llm?.providerByModel, fallback: cfg?.llm?.provider, role });
      return `${role === EMBED_ROLE ? 'embed' : 'chat'}\n${model}\n${JSON.stringify(route ?? null)}`;
    };
    const promptText = labels?.status?.probe;
    const canEmbed = typeof embedder?.embed === 'function';
    const results = new Map();
    if (promptText) {
      const targets = new Map();
      for (const role of MODEL_ROLES) {
        const model = roleModel.get(role);
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
    const lines = MODEL_ROLES.flatMap((role) => {
      const model = roleModel.get(role);
      if (!model) return [`${role} · no model configured`];
      const head = roleHead(role, model, cfg, labels);
      if (!promptText) return [`${head} · skipped: label missing`];
      if (role === EMBED_ROLE && !canEmbed) return [`${head} · not checked (no embedding client)`];
      return probeLines(head, results.get(targetOf(role)));
    });
    lines.push(...byPurposeLines(cfg));
    const imageLine = await image;
    if (imageLine) lines.push(imageLine);
    return lines.join('\n');
  }

  /** The today field: every daily rail's used/cap, then when they reset. */
  function todayValue(cfg, data) {
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
    return `${parts.join('\n')}\nresets 00:00 UTC`;
  }

  /** When today's journal file was last written, or null (no journal, no file yet). */
  async function journalLastWrite(guildId) {
    if (typeof journal?.dayFile !== 'function') return null;
    try {
      const stat = await fs.stat(journal.dayFile(guildId, new Date().toISOString()));
      return stat.mtimeMs;
    } catch {
      return null;
    }
  }

  /** The meaning index line (`labels.status.index`: `{rows}` in the index, `{missing}` after the
   * last catch-up pass, `-` before one), only while features.meaningSearch and features.embedIndex
   * are both exactly true and the queue is wired; null otherwise, or when it cannot be read. */
  async function indexLine(guildId, cfg) {
    const template = hot.prompts?.labels?.status?.index;
    if (typeof template !== 'string' || !template || typeof embedQueue?.indexSummary !== 'function') return null;
    if (cfg?.features?.meaningSearch !== true || cfg?.features?.embedIndex !== true) return null;
    try {
      const { rows, missing } = await embedQueue.indexSummary(guildId);
      return fill(template, { rows, missing: missing ?? '-' });
    } catch (err) {
      log.warn('admin: index summary failed', { code: err?.code ?? null, guildId });
      return null;
    }
  }

  /** The memory field: profiles, buffer lines, the archive's pending queue, the journal's last
   * write, the meaning index. */
  async function memoryValue(guildId) {
    const last = await journalLastWrite(guildId);
    const index = await indexLine(guildId, hot.config);
    return [
      `profiles ${store.countUsers(guildId)}`,
      `buffer ${store.getBuffer(guildId).length} lines`,
      `archive pending ${archivePending(guildId)}`,
      `journal last write ${last === null ? 'none today' : utcMinute(last)}`,
      ...(index ? [index] : []),
    ].join('\n');
  }

  /** The journal field: whether the append store is stalled, and the archive's pending queue. */
  function journalValue(guildId) {
    const stalled = typeof journal?.stalled === 'function' && journal.stalled() === true;
    return `append store ${stalled ? 'STALLED' : 'ok'}\narchive pending ${archivePending(guildId)}`;
  }

  /**
   * The status card as plain embed data (`{ fields: [{ name, value, inline }] }`), the fields in
   * STATUS_FIELDS order, one item per line in each; `owner` false leaves out the memory and
   * journal fields and names the models without probing them. Reads the freshest data/ even
   * mid-pause.
   */
  async function cmdStatusCard({ owner }) {
    freshenIfPaused();
    const cfg = hot.config;
    const data = store.state.data ?? {};
    const guildId = getGuildId?.() ?? null;
    const unresolved = 'guild not resolved yet';
    const values = {
      state: stateValue(data),
      connection: connectionValue(),
      'long tasks': longTasksValue(guildId),
      // The owner's card probes every model (the old ping); a member's, or one without an llm client, names them.
      models: owner && typeof llm?.complete === 'function' ? await probedModelsValue(cfg) : modelsValue(cfg),
      today: todayValue(cfg, data),
      memory: owner && guildId ? await memoryValue(guildId) : unresolved,
      journal: owner && guildId ? journalValue(guildId) : unresolved,
      uptime: span(process.uptime() * 1000),
    };
    const fields = STATUS_FIELDS
      .filter((name) => owner || !OWNER_FIELDS.has(name))
      .map((name) => ({ name, value: fitField(values[name]), inline: false }));
    return { fields };
  }

  return { nextSpontaneousFor, cmdStatus, cmdStatusCard };
});

defineOp({
  name: 'status.show',
  rights: { kind: 'read' },
  run: async (args, ctx) => {
    const owner = isOwnerId(ctx.env.hot.config, ctx?.userId);
    const card = await handlers(ctx.env).cmdStatusCard({ owner });
    // The long form below the card is the owner's only: it names files, prompts and guild internals.
    const text = owner && args?.detail === true ? handlers(ctx.env).cmdStatus() : '';
    return { text, embeds: [card] };
  },
});
