// Operations: `/nep status`: what the bot is doing now, read only.
// The handler bodies moved here from src/admin.js unchanged; each `run` calls one of them with
// the operation's `ctx` as the command context.

import { gifWatchesToday } from '../memory/gif-watch.js';
import { initiateCooldownUntil } from '../behavior/spontaneous.js';
import { llmCountToday } from '../llm/openrouter.js';
import { countToday } from '../time.js';
import { VOICE_DAILY } from '../memory/update.js';
import { PORTRAIT_SLOTS, portraitSettings } from '../memory/portrait.js';
import { todayUtc, onOff } from './shared.js';
import { defineOp, perEnv } from './registry.js';

const handlers = perEnv((env) => {
  const { hot, store, client, spontaneous, calibrator, getGuildId, isWarmingUp, warmup, images, freshenIfPaused, imageModelLabel } = env;

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

  return { nextSpontaneousFor, cmdStatus };
});

defineOp({
  name: 'status.show',
  rights: { kind: 'read' },
  run: (args, ctx) => handlers(ctx.env).cmdStatus(),
});
