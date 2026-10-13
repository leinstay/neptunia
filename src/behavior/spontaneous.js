// The persona does not only answer when called: at chaotic, unpredictable
// intervals it either cuts into a conversation that is clearly alive right
// now ('interject') or starts a topic itself in a channel that has gone
// quiet ('initiate'). It can also eavesdrop on a single fresh message and
// jump in a few seconds/minutes later, as if it had just noticed it. A line
// the room classifier of src/discord/events.js found put to everyone present
// (spontaneous.roomQuestionChance) is scheduled the same way without the
// roll, the turn about that line (its focus). A topic the persona started and
// posted is followed by a pause (spontaneous.initiateCooldownHours, kept in
// state.json) in which it starts no other; interjecting is not affected.
//
// A channel the persona can read but not write in (a read-only channel) is a
// candidate too, with the main channel as its destination
// (features.elsewhere): with unseen, settled, live messages there, a tick may
// run a noticed comment about it in the destination, and an eavesdrop hit
// there (noticeElsewhere) lets src/discord/events.js arm a settle wait that
// ends in runNoticed. The ordinary rails apply, every one checked on the
// destination; the per-source seen mark keeps one content from being
// commented twice. There is no counter of its own.
//
// Pure decision functions (delay, active hours, mode, channel pick) take an
// injected `rng`/`now` and are unit-tested directly. The factory below is the
// only place that touches discord.js, the schedule on disk and the turn
// runner.

import { localHour } from '../discord/format.js';
import { readableChannels, canSend, lastActivity, channelAllowed, isWritableChannel } from '../discord/collect.js';
import { routeFor } from './turn.js';
import { chooseElsewhereMode, elsewhereSettings, hasUnseen, mayBeLive } from './elsewhere.js';
import { between } from './random.js';
import { log } from '../log.js';
import { MINUTE_MS, HOUR_MS, DAY_MS } from '../time.js';

const REWAKE_MINUTES = [10, 40]; // how soon to try again after a turn found "nothing to say" / no channel

/**
 * Time until the next spontaneous check, in ms. Usually a long, log-uniform
 * gap (so short waits are common and very long ones still happen); sometimes
 * a short "burst" gap, as if the persona got caught up in something.
 * @param {object} cfg  config.spontaneous
 * @param {() => number} rng
 */
export function nextDelayMs(cfg, rng) {
  if (rng() < cfg.burstChance) {
    return between(cfg.burstMinutes, rng) * MINUTE_MS;
  }
  const [min, max] = [cfg.minIntervalMinutes, cfg.maxIntervalMinutes];
  const logMin = Math.log(min);
  const logMax = Math.log(max);
  const minutes = Math.exp(logMin + rng() * (logMax - logMin));
  return minutes * MINUTE_MS;
}

/**
 * Whether `hour` (0-23, local time) falls inside `activeHours = { from, to }`.
 * The window may wrap over midnight (from 10 to 3 means active 10:00-02:59).
 * `from === to` means always active.
 */
export function isActiveHour(hour, activeHours) {
  const { from, to } = activeHours;
  if (from === to) return true;
  if (from < to) return hour >= from && hour < to;
  return hour >= from || hour < to;
}

/**
 * 0 when `now` already falls in an active hour; otherwise the ms until the
 * next `from` hour (found by stepping minute by minute through `localHour`,
 * which is simple and cheap since this only runs when the persona is
 * asleep), plus a random 0-90 minutes so it does not wake up on the dot.
 */
export function msUntilActive(now, timezone, activeHours, rng) {
  const hour = localHour(now, timezone);
  if (isActiveHour(hour, activeHours)) return 0;

  let t = now;
  let steps = 0;
  const maxSteps = 2 * (24 * 60); // two days of minutes, generous safety cap
  while (localHour(t, timezone) !== activeHours.from && steps < maxSteps) {
    t += MINUTE_MS;
    steps += 1;
  }
  return t - now + between([0, 90], rng) * MINUTE_MS;
}

/**
 * Decide what a spontaneous turn should do, from the same normalized history
 * a real turn sees (oldest first, `{ ts, self, bot, authorId }`), in order:
 * an empty history, or a silence of at least `cfg.deadAfterMinutes` since the
 * last message (whoever wrote it, the persona included), rolls
 * `cfg.initiateChance` for 'initiate'; otherwise a last message of the
 * persona's own means null (it never interjects on itself); otherwise at least
 * `cfg.liveMinMessages` messages from other members (not the persona, not bots)
 * within `cfg.liveWindowMinutes` means 'interject'; otherwise null. With
 * `initiateAllowed: false` (an initiate cooldown, see initiateCooldownUntil)
 * the empty or dead channel is null without a roll.
 * @param {object[]} history
 * @param {number} now
 * @param {object} cfg  config.spontaneous
 * @param {() => number} rng
 * @param {{ initiateAllowed?: boolean }} [options]
 * @returns {'interject'|'initiate'|null}
 */
export function chooseMode(history, now, cfg, rng, { initiateAllowed = true } = {}) {
  if (initiateChanceDue(history, now, cfg)) {
    if (!initiateAllowed) return null;
    return rng() < cfg.initiateChance ? 'initiate' : null;
  }

  const last = history[history.length - 1];

  if (last.self) return null; // the persona never interjects on its own last line

  const windowStart = now - cfg.liveWindowMinutes * MINUTE_MS;
  const liveCount = history.filter((m) => m.ts >= windowStart && !m.self && !m.bot).length;
  if (liveCount >= cfg.liveMinMessages) return 'interject';

  return null;
}

/**
 * Whether chooseMode would roll `cfg.initiateChance` on `history`: the
 * channel is empty, or its last message is at least `cfg.deadAfterMinutes` old.
 * @param {object[]} history
 * @param {number} now
 * @param {object} cfg  config.spontaneous
 * @returns {boolean}
 */
function initiateChanceDue(history, now, cfg) {
  if (history.length === 0) return true;
  return now - history[history.length - 1].ts >= cfg.deadAfterMinutes * MINUTE_MS;
}

// Only when spontaneous.initiateCooldownHours is missing (config.json always has it).
const INITIATE_COOLDOWN_FALLBACK = [24, 48];

/**
 * The `[min, max]` hours of the pause after an initiate the persona posted
 * (`spontaneous.initiateCooldownHours`, or [24, 48], config.json's value, when
 * it is missing), or null when there is none: not an array of two finite
 * numbers, or a max that is not positive ([0, 0] switches it off).
 * @param {object} cfg  config.spontaneous
 * @returns {[number, number]|null}
 */
function initiateCooldownRange(cfg) {
  const range = cfg?.initiateCooldownHours ?? INITIATE_COOLDOWN_FALLBACK;
  if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isFinite)) return null;
  return range[1] > 0 ? range : null;
}

/**
 * When the initiate cooldown of `guildId` ends (epoch ms, state.json
 * `spontaneousInitiateUntil[guildId]`), or null when none holds at `now`: no
 * stored end, an end already reached, or the cooldown switched off in `cfg`
 * (read now, so switching it off lifts a running one). While it holds the
 * persona starts no topic of its own (chooseMode never says 'initiate');
 * interjecting, a room question, a noticed comment and a forced
 * `/nep initiate` are not affected.
 * @param {object} data  store.state.data
 * @param {string} guildId
 * @param {number} now
 * @param {object} cfg  config.spontaneous
 * @returns {number|null}
 */
export function initiateCooldownUntil(data, guildId, now, cfg) {
  if (!initiateCooldownRange(cfg)) return null;
  const until = data?.spontaneousInitiateUntil?.[guildId];
  return Number.isFinite(until) && now < until ? until : null;
}

/**
 * The chooser of a room turn (a line put to everyone present, picked up
 * unprompted): 'interject' while the line `focusId` is still in `history`
 * (oldest first, `{ id, self }`) with no line of the persona's own after it,
 * else null. Liveness does not apply: a question in a quiet channel must be
 * pickable.
 * @param {object[]} history
 * @param {string} focusId
 * @returns {'interject'|null}
 */
export function chooseRoomMode(history, focusId) {
  const at = history.findIndex((m) => m.id === focusId);
  if (at === -1) return null;
  return history.slice(at + 1).some((m) => m.self) ? null : 'interject';
}

// Only when spontaneous.roomQuestionChance is missing (config.json always has it).
const ROOM_QUESTION_CHANCE_FALLBACK = 0.04;

/**
 * The chance a line that failed the eavesdrop roll is shown to the room
 * classifier (src/discord/events.js): `spontaneous.roomQuestionChance`, or
 * 0.04 (config.json's value) when it is missing. 0 turns the room path off.
 * @param {object} config  The live config, read by the caller now.
 * @returns {number}
 */
export function roomQuestionChance(config) {
  return config?.spontaneous?.roomQuestionChance ?? ROOM_QUESTION_CHANCE_FALLBACK;
}

/**
 * Whether `channel`'s last message is older than `cfg.maxChannelSilenceHours`
 * -- such a channel is never a candidate for a spontaneous turn (interject or
 * initiate) started on the persona's own initiative. A `maxChannelSilenceHours`
 * that is not a positive number means no limit. A direct ping in a dead
 * channel is still answered: this only concerns the persona starting on its own.
 * @param {object} channel
 * @param {number} now
 * @param {{ maxChannelSilenceHours?: number }} cfg  config.spontaneous
 * @returns {boolean}
 */
export function isChannelDead(channel, now, cfg) {
  const maxHours = cfg.maxChannelSilenceHours;
  if (!(typeof maxHours === 'number' && maxHours > 0)) return false;
  return now - lastActivity(channel) > maxHours * HOUR_MS;
}

/**
 * Whether somebody is around on the server: some entry of `channels`
 * (`[{ lastActivity, ownPostAt? }]`, epoch ms) saw a message within the last
 * `cfg.someoneAroundMinutes`. A tick starts a turn of the persona's own only
 * when this holds; a direct call never asks. `lastActivity` comes from the
 * snowflake of the channel's last message (src/discord/collect.js#lastActivity),
 * so it cannot tell who wrote it: a member's message and another bot's both
 * count. `ownPostAt` (the persona's last post there, turns.lastPostAt, kept in
 * memory only) is the one author-aware hint: a channel whose newest message is
 * not newer than it ends on the persona's own post and does not count, so its
 * own unanswered lines never keep the server "alive". After a restart that hint
 * is gone and the persona's own last post counts like anyone's until a member
 * writes. A `someoneAroundMinutes` that is not a positive number means no gate.
 * @param {{ lastActivity: number, ownPostAt?: number }[]} channels
 * @param {number} now
 * @param {{ someoneAroundMinutes?: number }} cfg  config.spontaneous
 * @returns {boolean}
 */
export function someoneAround(channels, now, cfg) {
  const minutes = cfg.someoneAroundMinutes;
  if (!(typeof minutes === 'number' && minutes > 0)) return true;
  const since = now - minutes * MINUTE_MS;
  return channels.some(({ lastActivity: last, ownPostAt = 0 }) => last > 0 && last > ownPostAt && last >= since);
}

/**
 * Pick a channel to speak in, favouring recent activity without always
 * picking the same one. `candidates = [{ channel, lastActivity }]`.
 */
export function pickChannel(candidates, now, rng) {
  if (candidates.length === 0) return null;

  const activeRecently = candidates.filter((c) => now - c.lastActivity < DAY_MS);
  if (activeRecently.length === 0) {
    return candidates[Math.floor(rng() * candidates.length)].channel;
  }

  if (rng() < 0.7) {
    return activeRecently.reduce((a, b) => (b.lastActivity > a.lastActivity ? b : a)).channel;
  }
  return activeRecently[Math.floor(rng() * activeRecently.length)].channel;
}

/** Whether `prompts.elsewhere` (the task of a noticed comment) is a non-empty text. */
function hasElsewherePrompt(prompts) {
  const text = prompts?.elsewhere;
  return typeof text === 'string' && text.trim() !== '';
}

/**
 * Wire the pure decisions above to discord.js, the persisted schedule and the
 * turn runner.
 * @param {object} params
 * @param {import('../hot.js').createHot extends (...args: any) => infer R ? R : never} params.hot
 * @param {ReturnType<import('../memory/store.js').createStore>} params.store
 * @param {import('discord.js').Client} params.client
 * @param {ReturnType<import('./turn.js').createTurnRunner>} params.turns
 * @param {() => string | null} params.getGuildId  the single guild this instance serves, or null before it resolves
 * @param {() => boolean} [params.isWarmingUp]  true while the memory warmup runner
 *   (src/memory/warmup.js) is in flight: no tick and no eavesdrop scheduling happens.
 *   Default: never warming up.
 * @param {() => number} [params.rng]
 * @param {() => number} [params.now]
 */
export function createSpontaneous({
  hot,
  store,
  client,
  turns,
  getGuildId,
  isWarmingUp = () => false,
  rng = Math.random,
  now = Date.now,
}) {
  const running = new Set(); // guildIds with a spontaneous turn in flight
  const eavesdropTimers = new Set();

  /**
   * Why the persona may not speak unprompted in `dest` (the channel the words
   * go to) now, or null when it may: `channel` (not allowed by bot.channels,
   * or not in a non-empty spontaneous.channels), `cannot-send`, `gap` (its
   * own last post there is younger than spontaneous.minGapMinutes) or `busy`
   * (a turn runs there or, with one attention, anywhere). A writable channel
   * is its own destination; a read-only source speaks in the main channel.
   */
  function destinationBlock(dest, config, cfg, t) {
    if (!channelAllowed(dest, config.bot)) return 'channel';
    if (!canSend(dest)) return 'cannot-send';
    if (cfg.channels.length > 0 && !cfg.channels.includes(dest.id)) return 'channel';
    if (t - turns.lastPostAt(dest.id) < cfg.minGapMinutes * MINUTE_MS) return 'gap';
    // One attention (mention.oneAtATime, default on): while a turn is
    // running anywhere, a spontaneous tick or an eavesdrop must treat every
    // channel as unavailable, not just the one already busy -- runTurn
    // enforces the same rail itself, this just avoids attempting it.
    const oneAtATime = config.mention?.oneAtATime !== false;
    if (turns.isBusy(dest.id) || (oneAtATime && turns.isAnyBusy())) return 'busy';
    return null;
  }

  /**
   * Whether the persona may speak unprompted in `channel` now: one it may
   * write in (src/discord/collect.js#isWritableChannel: readable, never the
   * dry-run mirror, the bot can send) and destinationBlock finds nothing.
   */
  function passesFilters(channel, config, cfg, t) {
    return isWritableChannel(channel, config.bot ?? {}) && destinationBlock(channel, config, cfg, t) === null;
  }

  /** The seen mark of a source (state.json `elsewhereSeen`), read now; null without one. */
  function seenOf(sourceId) {
    const mark = store.state.data.elsewhereSeen?.[sourceId];
    return Number.isFinite(mark) ? mark : null;
  }

  /**
   * Where a noticed comment on `source` would be spoken now, every rail of
   * the words checked on that destination: `{ destination, reason: null }`,
   * or `{ destination: null, reason }`: `channel` (the source is not allowed
   * or the bot can send there), routeFor's codes (`off`, `no-destination`,
   * `audience`), `no-prompt` (prompts.elsewhere missing or empty) or
   * destinationBlock's codes for the destination.
   */
  function noticedRoute(source, config, cfg, t) {
    if (!channelAllowed(source, config.bot) || canSend(source)) return { destination: null, reason: 'channel' };
    const route = routeFor(source, config);
    if (!route.destination) return route;
    if (!hasElsewherePrompt(hot.prompts)) return { destination: null, reason: 'no-prompt' };
    const blocked = destinationBlock(route.destination, config, cfg, t);
    return blocked ? { destination: null, reason: blocked } : route;
  }

  /**
   * A read-only source on the tick path: its destination when it is a
   * candidate, else null. Its last message must be newer than its seen mark
   * and, with spontaneous.liveMinMessages above 0, inside the live window
   * (mayBeLive: the ordinary liveness, the member count is the chooser's),
   * and at least elsewhere.settleSeconds old (the burst settled); then
   * noticedRoute.
   */
  function sourceDestination(source, config, cfg, t) {
    const last = lastActivity(source);
    if (!mayBeLive(last, t, seenOf(source.id), cfg)) return null;
    if (t - last < elsewhereSettings(config).settleMs) return null;
    return noticedRoute(source, config, cfg, t).destination;
  }

  /**
   * Every channel a tick may pick: `{ channel, lastActivity, destination }`.
   * A writable channel is its own destination; a read-only source (only
   * with features.elsewhere on and a non-empty prompts.elsewhere) carries
   * the main channel and `noticed: true`. A dead channel is never one.
   */
  function channelCandidates(guild, config, cfg, t) {
    const candidates = [];
    for (const channel of readableChannels(guild, config.bot)) {
      if (isChannelDead(channel, t, cfg)) continue;
      if (canSend(channel)) {
        if (passesFilters(channel, config, cfg, t)) candidates.push({ channel, lastActivity: lastActivity(channel), destination: channel });
        continue;
      }
      const destination = sourceDestination(channel, config, cfg, t);
      if (destination) candidates.push({ channel, lastActivity: lastActivity(channel), destination, noticed: true });
    }
    return candidates;
  }

  /** Every channel the persona can read as someoneAround's input: its last message and the persona's last post there. */
  function presence(guild, config) {
    return readableChannels(guild, config.bot).map((channel) => ({
      lastActivity: lastActivity(channel),
      ownPostAt: turns.lastPostAt(channel.id),
    }));
  }

  /**
   * The ordinary chooser of `guildId`, the initiate cooldown read when it
   * runs: a chance to initiate it holds back logs `spontaneous: initiate on cooldown`.
   */
  function makeChooseMode(cfg, guildId) {
    return (history, ts) => {
      const until = initiateCooldownUntil(store.state.data, guildId, ts, cfg);
      if (until !== null && initiateChanceDue(history, ts, cfg)) {
        log.info('spontaneous: initiate on cooldown', { guildId, until });
      }
      return chooseMode(history, ts, cfg, rng, { initiateAllowed: until === null });
    };
  }

  /**
   * After a turn the ordinary chooser ran: an initiate the persona posted
   * (`spoke`, mode 'initiate', not a send that reached nobody; a dry-run
   * rehearsal counts) starts the cooldown, drawn from
   * spontaneous.initiateCooldownHours (read now) and kept in state.json
   * `spontaneousInitiateUntil[guildId]`. Anything else changes nothing.
   */
  function noteTurn(guildId, result) {
    if (result?.outcome !== 'spoke' || result.mode !== 'initiate' || result.delivered === false) return;
    const range = initiateCooldownRange(hot.config.spontaneous);
    if (!range) return;
    const until = now() + Math.max(0, between(range, rng)) * HOUR_MS;
    (store.state.data.spontaneousInitiateUntil ??= {})[guildId] = until;
    store.state.markDirty();
    log.info('spontaneous: initiate cooldown', { guildId, until });
  }

  /**
   * The chooser of a noticed turn on `sourceId`: the source as runTurn
   * pulled it, its seen mark read when the chooser runs, chooseElsewhereMode
   * on `path` (`tick`: the ordinary liveness; `eavesdrop`: the roll was the
   * gate). A source that was not pulled is `not-now`.
   */
  function makeChooseNoticed(sourceId, cfg, path) {
    return (history, ts, context) => {
      const pulled = context?.pulled?.find?.((entry) => entry.channelId === sourceId);
      if (!pulled) return null;
      return chooseElsewhereMode(pulled.messages, ts, seenOf(sourceId), cfg, { path });
    };
  }

  /** runTurn's arguments of a noticed comment on `source`, spoken in `destination`. */
  function noticedTurn(source, destination, cfg, path) {
    return {
      channel: destination,
      source: { channelId: source.id, reason: 'noticed' },
      mode: 'auto',
      chooseMode: makeChooseNoticed(source.id, cfg, path),
    };
  }

  async function tick() {
    // /nep pause: the owner is editing data/ by hand -- no spontaneous
    // activity, and nothing here (not even the schedule) may become dirty.
    if (store.state.data.paused) return;
    // A memory warmup run is in flight: the persona stays mute, same as a pause.
    if (isWarmingUp()) return;

    const config = hot.config;
    const cfg = config.spontaneous;
    if (config.features?.spontaneous === false) return;

    const guildId = getGuildId();
    if (!guildId) return; // not resolved yet — nothing to do
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;
    if (running.has(guildId)) return;

    const schedule = (store.state.data.spontaneous ??= {});
    const t = now();

    if (schedule[guildId] === undefined) {
      schedule[guildId] = t + nextDelayMs(cfg, rng);
      store.state.markDirty();
      return;
    }
    if (t < schedule[guildId]) return;

    const hour = localHour(t, config.bot.timezone);
    if (!isActiveHour(hour, cfg.activeHours)) {
      schedule[guildId] = t + msUntilActive(t, config.bot.timezone, cfg.activeHours, rng);
      store.state.markDirty();
      log.info('spontaneous: outside active hours, sleeping', { guildId, wakeAt: schedule[guildId] });
      return;
    }

    const candidates = channelCandidates(guild, config, cfg, t);
    // Presence is server-wide: every channel the persona can read counts, not
    // only the candidates (the one it just spoke in is held back by minGapMinutes).
    if (candidates.length > 0 && !someoneAround(presence(guild, config), t, cfg)) {
      schedule[guildId] = t + between(REWAKE_MINUTES, rng) * MINUTE_MS;
      store.state.markDirty();
      log.info('spontaneous: skipped', { guildId, reason: 'nobody-around', candidates: candidates.length });
      return;
    }
    const channel = pickChannel(candidates, t, rng);

    if (!channel) {
      schedule[guildId] = t + between(REWAKE_MINUTES, rng) * MINUTE_MS;
      store.state.markDirty();
      log.info('spontaneous: no eligible channel', { guildId });
      return;
    }

    // Reschedule before awaiting the turn, so a slow turn cannot double-fire.
    schedule[guildId] = t + nextDelayMs(cfg, rng);
    store.state.markDirty();

    // A read-only source speaks in its destination, about itself (a noticed comment).
    const picked = candidates.find((candidate) => candidate.channel === channel);
    const noticed = picked?.noticed === true;
    const turnChannel = noticed ? picked.destination : channel;
    const source = noticed ? channel.id : null;

    running.add(guildId);
    log.info('spontaneous: firing a turn', { guildId, channel: turnChannel.id, source });
    try {
      const result = await turns.runTurn(
        noticed ? noticedTurn(channel, turnChannel, cfg, 'tick') : { channel, mode: 'auto', chooseMode: makeChooseMode(cfg, guildId) },
      );
      log.info('spontaneous: turn finished', { guildId, channel: turnChannel.id, source, outcome: result.outcome });
      noteTurn(guildId, result);
      if (result.outcome === 'not-now') {
        schedule[guildId] = now() + between(REWAKE_MINUTES, rng) * MINUTE_MS;
        store.state.markDirty();
      }
    } catch (err) {
      log.error('spontaneous: turn failed', { guildId, error: err });
    } finally {
      running.delete(guildId);
    }
  }

  /**
   * Whether an eavesdrop may happen now, `config` read by the caller now:
   * not warming up, both switches on (eavesdropping is a form of spontaneous
   * speech) and inside active hours. A pause is checked by runTurn itself.
   */
  function eavesdropAllowed(config, t) {
    return eavesdropBlock(config, t) === null;
  }

  /** Why eavesdropAllowed says no: `warmup`, `off` (a switch) or `asleep` (outside active hours); null when it says yes. */
  function eavesdropBlock(config, t) {
    if (isWarmingUp()) return 'warmup';
    const features = config.features ?? {};
    if (features.spontaneous === false || features.eavesdrop === false) return 'off';
    return isActiveHour(localHour(t, config.bot.timezone), config.spontaneous.activeHours) ? null : 'asleep';
  }

  /**
   * The eavesdrop rails of `channel`, `config` read by the caller now: not
   * paused (`/nep pause`), eavesdropAllowed, a channel of the served guild
   * and passesFilters (writable -- readable, not the dry-run mirror, allowed,
   * canSend --, spontaneous.channels, minGapMinutes, one attention).
   */
  function eavesdropRails(channel, config, t) {
    // /nep pause: no eavesdrop scheduling while paused.
    if (store.state.data.paused) return false;
    // A memory warmup run, a switch off or the persona asleep: no eavesdrop scheduling.
    if (!eavesdropAllowed(config, t)) return false;
    if (channel.guild?.id !== getGuildId()) return false;
    return passesFilters(channel, config, config.spontaneous, t);
  }

  /**
   * Whether an eavesdrop on `channel` could be scheduled now, the roll
   * aside: the rails onMessage checks before its roll, read from the live
   * config now, as one boolean. src/discord/events.js asks it before paying
   * for a room classifier call. Rolls nothing, schedules nothing.
   * @param {object} channel  A discord.js guild channel.
   * @returns {boolean}
   */
  function eavesdropReady(channel) {
    return eavesdropRails(channel, hot.config, now());
  }

  /**
   * Eavesdrop on a freshly observed message and maybe jump in after a delay
   * (spontaneous.eavesdropDelayMs): the rails (eavesdropRails), a member's
   * message, then one roll of spontaneous.eavesdropChance. With `room` (the
   * room classifier said the line is put to everyone present) there is no
   * roll: the turn carries the line as its `focus` and the room chooser
   * (chooseRoomMode) instead of the ordinary one.
   * @param {object} channel  The discord.js channel the message was written in.
   * @param {object} normalized
   * @param {{ room?: boolean }} [options]
   * @returns {boolean}  Whether a turn was scheduled.
   */
  function onMessage(channel, normalized, { room = false } = {}) {
    const config = hot.config;
    const cfg = config.spontaneous;
    const t = now();
    if (normalized.self || normalized.bot) return false;
    if (!eavesdropRails(channel, config, t)) return false;
    if (!room && rng() >= cfg.eavesdropChance) return false;

    const delay = between(cfg.eavesdropDelayMs, rng);
    const timer = setTimeout(() => {
      eavesdropTimers.delete(timer);
      // Up to eavesdropDelayMs later: the same checks again, on the config read now.
      const current = hot.config;
      if (!eavesdropAllowed(current, now())) return;
      const guildId = channel.guild.id;
      const turn = room
        ? { channel, mode: 'auto', chooseMode: (history) => chooseRoomMode(history, normalized.id), focus: normalized }
        : { channel, mode: 'auto', chooseMode: makeChooseMode(current.spontaneous, guildId) };
      turns
        .runTurn(turn)
        .then((result) => noteTurn(guildId, result))
        .catch((err) => log.error('spontaneous: eavesdrop turn failed', { channel: channel.id, error: err }));
    }, delay);
    timer.unref?.();
    eavesdropTimers.add(timer);
    return true;
  }

  /**
   * The eavesdrop roll for a fresh message in a read-only channel: true when
   * a noticed comment on `channel` may follow, so the caller
   * (src/discord/events.js) arms a settle wait that ends in runNoticed. The
   * same rails as any eavesdrop (not paused, eavesdropAllowed, a member's
   * message of the served guild), the route to a destination that passes
   * every rail of unprompted words (noticedRoute), then one roll of
   * spontaneous.eavesdropChance. A hit logs `spontaneous: noticed`.
   * Schedules nothing itself.
   * @param {object} channel  The discord.js channel the message was written in.
   * @param {object} normalized
   * @returns {boolean}
   */
  function noticeElsewhere(channel, normalized) {
    if (store.state.data.paused) return false;
    const config = hot.config;
    const cfg = config.spontaneous;
    const t = now();
    if (!eavesdropAllowed(config, t)) return false;
    if (normalized.self || normalized.bot) return false;
    if (channel.guild?.id !== getGuildId()) return false;
    const { destination } = noticedRoute(channel, config, cfg, t);
    if (!destination) return false;
    if (rng() >= cfg.eavesdropChance) return false;
    log.info('spontaneous: noticed', { source: channel.id, destination: destination.id });
    return true;
  }

  /**
   * Run the noticed comment on `source` an eavesdrop hit led to, once its
   * settle wait is over. Every rail is read again now, as noticeElsewhere
   * read it (the destination resolved now), and the source must still hold
   * something newer than its seen mark; then the turn runs in the
   * destination with `source` (`reason: 'noticed'`) and the eavesdrop
   * chooser (one new member message after the mark is enough). The tick
   * schedule is left as it is. Never rejects.
   * @param {object} source  The discord.js channel the persona read.
   * @returns {Promise<{ outcome: string, reason?: string }>}  A rail that refused gives `not-now`
   *   (`paused` while paused) with its code in `reason`: `paused`, `warmup`, `off`, `asleep`, `channel`,
   *   `no-destination`, `audience`, `no-prompt`, `cannot-send`, `gap`, `busy` or `seen`. Otherwise the
   *   turn's own result.
   */
  async function runNoticed(source) {
    if (store.state.data.paused) return { outcome: 'paused', reason: 'paused' };
    const config = hot.config;
    const cfg = config.spontaneous;
    const t = now();
    const refuse = (reason) => ({ outcome: 'not-now', reason });
    const blocked = eavesdropBlock(config, t);
    if (blocked) return refuse(blocked);
    const guildId = getGuildId();
    if (!guildId || source.guild?.id !== guildId) return refuse('channel');
    const { destination, reason } = noticedRoute(source, config, cfg, t);
    if (!destination) return refuse(reason);
    if (!hasUnseen(lastActivity(source), seenOf(source.id))) return refuse('seen');

    log.info('spontaneous: firing a turn', { guildId, channel: destination.id, source: source.id });
    try {
      const result = await turns.runTurn(noticedTurn(source, destination, cfg, 'eavesdrop'));
      log.info('spontaneous: turn finished', { guildId, channel: destination.id, source: source.id, outcome: result?.outcome });
      return result ?? { outcome: 'error' };
    } catch (err) {
      log.error('spontaneous: turn failed', { guildId, source: source.id, error: err });
      return { outcome: 'error' };
    }
  }

  /** Force a turn right now, bypassing the schedule (owner command: `/nep interject`, `/nep initiate`). */
  function force(channel, mode) {
    return turns.runTurn({ channel, mode, forced: true });
  }

  function status() {
    return { ...(store.state.data.spontaneous ?? {}) };
  }

  function stop() {
    for (const timer of eavesdropTimers) clearTimeout(timer);
    eavesdropTimers.clear();
  }

  return { tick, onMessage, eavesdropReady, noticeElsewhere, runNoticed, force, status, stop };
}
