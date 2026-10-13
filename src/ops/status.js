// Operations: `/nep status [detail]`: what the bot is doing now, read only. The reply is one
// card (`cmdStatusCard`, plain embed data: src/discord/commands.js wraps it for discord.js), the
// most important field first, for a phone; `detail` adds the long text form (`cmdStatus`) below
// it. A member (anyone not in `bot.owners`) gets the card without the memory and journal fields,
// and never the long form. Nothing here probes a provider: every value is what the bot already
// holds.

import fs from 'node:fs/promises';
import { gifWatchesToday } from '../memory/gif-watch.js';
import { initiateCooldownUntil } from '../behavior/spontaneous.js';
import { RECALL_DAILY } from '../behavior/recall-run.js';
import { llmCountToday } from '../llm/openrouter.js';
import { countToday, DAY_MS, HOUR_MS, MINUTE_MS } from '../time.js';
import { VOICE_DAILY } from '../memory/update.js';
import { VIDEO_DAILY } from '../memory/describe.js';
import { WEB_DAILY } from '../web/lookup.js';
import { PORTRAIT_SLOTS, portraitSettings } from '../memory/portrait.js';
import { isOwnerId } from '../discord/access.js';
import { todayUtc, onOff, modelForRole } from './shared.js';
import { defineOp, perEnv } from './registry.js';

/** The card's field names, in order (the memory and journal ones are the owner's only). */
export const STATUS_FIELDS = Object.freeze(['state', 'connection', 'long tasks', 'models', 'today', 'memory', 'journal', 'uptime']);

/** The fields a member's card leaves out. */
const OWNER_FIELDS = new Set(['memory', 'journal']);

/** The roles the models field names after the voice, each only when its model differs. */
const OTHER_ROLES = Object.freeze(['analyzer', 'classifier.text', 'classifier.media', 'classifier.video']);

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
  const { hot, store, client, spontaneous, calibrator, getGuildId, isWarmingUp, warmup, images, archive, journal, emojiBackfill, gifBackfill, gifRecache, freshenIfPaused, imageModelLabel } = env;

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
    return `gateway ${latency} · last reconnect ${last ? utcMinute(last) : 'none'}`;
  }

  /** What the archive's pending queue holds for `guildId` (0 without an archive or a guild). */
  function archivePending(guildId) {
    const pending = guildId ? archive?.stats?.(guildId)?.pending : 0;
    return Number.isFinite(pending) ? pending : 0;
  }

  /** The long-tasks field: a warmup, the history backfills and the GIF recache running, and what
   * the archive drain still holds; `none` when nothing runs. */
  function longTasksValue(guildId) {
    const parts = [];
    if (isWarmingUp()) parts.push('warmup running');
    const running = [
      [emojiBackfill, 'emoji backfill'],
      [gifBackfill, 'GIF backfill'],
      [gifRecache, 'GIF recache'],
    ].filter(([job]) => job?.isRunning?.() === true).map(([, name]) => name);
    if (running.length > 0) parts.push(`${running.join(', ')} running`);
    const pending = archivePending(guildId);
    if (pending > 0) parts.push(`archive drain: ${pending} pending`);
    return parts.length > 0 ? parts.join(' · ') : 'none';
  }

  /** The models field: the voice, then each other role (the drawing model last) whose model differs from it. */
  function modelsValue(cfg) {
    const voice = modelForRole('voice', cfg) ?? '-';
    const parts = [`voice ${voice}`];
    for (const role of OTHER_ROLES) {
      const model = modelForRole(role, cfg);
      if (model && model !== voice) parts.push(`${role} ${model}`);
    }
    const image = cfg?.image?.model;
    if (image && image !== voice) parts.push(`image ${imageModelLabel(cfg)}`);
    return parts.join(' · ');
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
    return `${parts.join(' · ')}\nresets 00:00 UTC`;
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

  /** The memory field: profiles, buffer lines, the archive's pending queue, the journal's last write. */
  async function memoryValue(guildId) {
    const last = await journalLastWrite(guildId);
    return [
      `profiles ${store.countUsers(guildId)}`,
      `buffer ${store.getBuffer(guildId).length} lines`,
      `archive pending ${archivePending(guildId)}`,
      `journal last write ${last === null ? 'none today' : utcMinute(last)}`,
    ].join(' · ');
  }

  /** The journal field: whether the append store is stalled, and the archive's pending queue. */
  function journalValue(guildId) {
    const stalled = typeof journal?.stalled === 'function' && journal.stalled() === true;
    return `append store ${stalled ? 'STALLED' : 'ok'} · archive pending ${archivePending(guildId)}`;
  }

  /**
   * The status card as plain embed data (`{ fields: [{ name, value, inline }] }`), the fields in
   * STATUS_FIELDS order; `owner` false leaves out the memory and journal fields. Reads the
   * freshest data/ even mid-pause.
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
      models: modelsValue(cfg),
      today: todayValue(cfg, data),
      memory: owner && guildId ? await memoryValue(guildId) : unresolved,
      journal: owner && guildId ? journalValue(guildId) : unresolved,
      uptime: span(process.uptime() * 1000),
    };
    const fields = STATUS_FIELDS
      .filter((name) => owner || !OWNER_FIELDS.has(name))
      .map((name) => ({ name, value: values[name], inline: false }));
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
