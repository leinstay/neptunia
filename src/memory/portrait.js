// Portraits refreshed by counters, not by a cue. A member's `character`/`style` (the portrait)
// is written by the warmup and rewritten only by src/memory/warmup.js#refreshPortrait; the
// stream analyzer's `portrait` cue that used to start a rewrite practically never comes, so
// code decides here instead. A member is due when `memory.portraitRefreshMessages` own messages
// were written since the last portrait (the per-member `messageCount` minus the
// `portraitMessageCount` stamp; a profile with no stamp counts every message, the rollout
// catch-up) AND `memory.portraitRefreshDays` passed since `portraitRefreshedAt`; a member with
// no portrait at all is due at `warmup.minMessages`. An old portrait is due by age too: refreshed
// more than `memory.portraitMaxAgeDays` ago with at least `memory.portraitMinMessages` own
// messages since. Any attempt that ended without a stored
// portrait (`portraitAttemptAt`) waits `memory.portraitRetryHours`, and a member silent for
// longer than `warmup.lookbackDays` has no lines in the history a refresh reads, so is never
// picked. `portraitDue`/`pickDuePortraits` are pure; `createPortraitScheduler` looks every
// `memory.portraitCheckMinutes` (switch `features.portraitRefresh`), stamps when each due member
// was first found due (`portraitDueAt`, cleared by a stored portrait) and hands the
// longest-waiting due members to `refreshPortrait` one after another (each one's stored profile re-checked
// right before its turn, so a member forgotten since the look is never started), sharing one
// history read per look, under the one daily cap (`memory.portraitRefreshPerDay`, counted in
// `PORTRAIT_SLOTS`) that the analyzer's cue and the owner's `/nep memory refresh` share. A look
// on a day the LLM's own request cap (`llm.maxRequestsPerDay`) is already used up ends before
// any history read. In two-stage mode (`portraitMode`) a member whose character text still waits
// for the voice model (a public `character` item in the guild's voice queue, `waitingPortraits`)
// is not picked: another stage A answer would only replace that item, so during a voice outage
// the member costs no request and no history read until the item is applied or dropped.

import { llmCountToday } from '../llm/openrouter.js';
import { log } from '../log.js';
import { DAY_MS, HOUR_MS, MINUTE_MS, dailyCounter, utcDay } from '../time.js';
import { errorNameOf } from './update.js';

/** The portrait refresh's daily counter in state.json (`state.portraitDay` / `portraitCount`):
 * every refresh that sends a request takes one slot, whoever started it (code, cue, owner). */
export const PORTRAIT_SLOTS = { dayKey: 'portraitDay', countKey: 'portraitCount' };

// The prompts a two-stage portrait refresh needs: its stage A (prompts/portrait.md), and the voice
// model's (prompts/memory-voice.md), without which the character item it queues is never worded.
const PORTRAIT_TWO_STAGE_PROMPTS = ['portrait', 'memory-voice'];

/** `llm.maxRequestsPerDay` when it is a finite number, else null (the client then refuses
 * every request itself, see src/llm/openrouter.js#dailyCapOf). */
function llmDailyCap(config) {
  const cap = config?.llm?.maxRequestsPerDay;
  return typeof cap === 'number' && Number.isFinite(cap) ? cap : null;
}

/**
 * Whether today's LLM requests already reached `llm.maxRequestsPerDay`, so a portrait request
 * would be refused: checked before a refresh reads any history. Read-only (a stored count of
 * another UTC day reads as 0 and is not rolled over here). A cap that is not a number is left to
 * the client's own rail, which refuses everything: false here.
 * @param {object} stateData  `store.state.data`.
 * @param {object} config     The live config.
 * @param {number} nowMs
 * @returns {boolean}
 */
export function llmCapReached(stateData, config, nowMs) {
  const cap = llmDailyCap(config);
  if (cap === null) return false;
  return llmCountToday(stateData, nowMs) >= cap;
}

/**
 * The portrait settings, read from the live config at the moment of use. Every fallback equals
 * config.json; a daily cap that is not a number counts as config.json's value.
 * @param {object} [config]  The live config.
 * @returns {{ messages: number, days: number, perDay: number, retryHours: number, checkMinutes: number,
 *   maxAgeDays: number, minMessages: number, firstMessages: number, lookbackDays: number }}
 *   `messages`: `memory.portraitRefreshMessages` (own messages since the last portrait, also the
 *   sample size); `days`: `memory.portraitRefreshDays`; `perDay`: `memory.portraitRefreshPerDay`;
 *   `retryHours`: `memory.portraitRetryHours`; `checkMinutes`: `memory.portraitCheckMinutes`;
 *   `maxAgeDays`: `memory.portraitMaxAgeDays` and `minMessages`: `memory.portraitMinMessages` (the
 *   age path: a portrait older than that many days with at least that many own messages since);
 *   `firstMessages`: `warmup.minMessages` (a first portrait, and the thinnest sample worth sending);
 *   `lookbackDays`: `warmup.lookbackDays` (how far back the history a refresh reads goes).
 */
export function portraitSettings(config) {
  const memory = config?.memory ?? {};
  const warmup = config?.warmup ?? {};
  return {
    messages: memory.portraitRefreshMessages ?? 300,
    days: memory.portraitRefreshDays ?? 3,
    perDay: Number.isFinite(memory.portraitRefreshPerDay) ? memory.portraitRefreshPerDay : 3,
    retryHours: memory.portraitRetryHours ?? 24,
    checkMinutes: memory.portraitCheckMinutes ?? 60,
    maxAgeDays: memory.portraitMaxAgeDays ?? 21,
    minMessages: memory.portraitMinMessages ?? 60,
    firstMessages: warmup.minMessages ?? 30,
    lookbackDays: warmup.lookbackDays ?? 60,
  };
}

/**
 * A stored ISO stamp (`portraitRefreshedAt`, `portraitAttemptAt`, `lastSeen`) in epoch
 * milliseconds; null when it is missing, cleared or unreadable (a hand-edited file).
 * @param {unknown} value
 * @returns {number|null}
 */
export function stampMs(value) {
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * A stored count (`messageCount`, `portraitMessageCount`) as the due rule reads it: a finite,
 * non-negative number, else 0 (a hand-edited file never makes a count negative or NaN).
 * @param {unknown} value
 * @returns {number}
 */
export function storedCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Whether `value` is a string with something in it: the one rule by which a portrait field and a
 * prompt count as present (src/memory/warmup.js uses it too).
 * @param {unknown} value
 * @returns {boolean}
 */
export function hasText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Which request a portrait refresh sends, read from the live config and prompts at the moment of
 * use. `two` (stage A, prompts/portrait.md on `models.helpers.extractor`, the character queued for the voice
 * model) only when `features.memoryTwoStage` is exactly true AND both PORTRAIT_TWO_STAGE_PROMPTS
 * are non-blank. Otherwise `single`, today's prompts/profile.md request that writes the portrait
 * itself: as always with the switch off; with it on (a prompt `missing`), on the voice model
 * (`voice: true`), since its answer words the character. Pure.
 * @param {object} [config]   The live config.
 * @param {object} [prompts]  The live prompts.
 * @returns {{ stage: 'single'|'two', voice: boolean, missing: string[] }}
 */
export function portraitMode(config, prompts) {
  if (config?.features?.memoryTwoStage !== true) return { stage: 'single', voice: false, missing: [] };
  const missing = PORTRAIT_TWO_STAGE_PROMPTS.filter((key) => !hasText(prompts?.[key]));
  return missing.length === 0 ? { stage: 'two', voice: false, missing } : { stage: 'single', voice: true, missing };
}

/**
 * Whether a voice queue item is a member's public `character` item: the brief a two-stage refresh
 * queued (src/memory/warmup.js#queueCharacter) that the voice model has not worded yet. Pure.
 * @param {unknown} item  One item of `store.getVoiceQueue(guildId)`.
 * @returns {boolean}
 */
export function isQueuedPortrait(item) {
  return item?.kind === 'character' && !item.layer && typeof item.userId === 'string' && item.userId !== '';
}

/**
 * The members whose character text waits for the voice model: those with a queued public
 * `character` item (`isQueuedPortrait`). While the refresh would ask stage A again, the scheduler
 * does not pick them and a non-forced refresh stands down (`voice-pending`). Pure; garbage is
 * skipped.
 * @param {unknown} queue  `store.getVoiceQueue(guildId)`.
 * @returns {Set<string>}  Member ids.
 */
export function waitingPortraits(queue) {
  return new Set((Array.isArray(queue) ? queue : []).filter(isQueuedPortrait).map((item) => item.userId));
}

/**
 * Whether one member's portrait is due for a refresh. Pure; garbage never throws and is never due.
 * @param {object} profile  A stored profile (`messageCount`, `character`, `style`, `lastSeen` and the
 *   stamps `portraitMessageCount`, `portraitRefreshedAt`, `portraitAttemptAt`).
 * @param {number} nowMs
 * @param {{ messages: number, days: number, retryHours: number, firstMessages: number, lookbackDays?: number,
 *   maxAgeDays?: number, minMessages?: number }} cfg  From `portraitSettings`; without `maxAgeDays` /
 *   `minMessages` the age path is off.
 * @returns {{ due: boolean, reason: 'due'|'aged'|'first'|'few'|'recent'|'retry-wait'|'quiet'|'none', own: number }}
 *   `own`: messages since the last portrait (`messageCount - portraitMessageCount`, never negative).
 *   `first`: due, no portrait stored yet (`messageCount >= firstMessages`, no day rule); `due`: due
 *   by the counters; `aged`: due by age (`portraitRefreshedAt` at least `maxAgeDays` ago and
 *   `own >= minMessages`; a portrait with no stamp never ages); `few`: not enough messages; `recent`: refreshed less than `days` ago;
 *   `retry-wait`: an attempt less than `retryHours` ago; `quiet`: not seen for longer than
 *   `lookbackDays`; `none`: not a profile.
 */
export function portraitDue(profile, nowMs, cfg) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return { due: false, reason: 'none', own: 0 };
  const count = storedCount(profile.messageCount);
  const own = Math.max(0, count - storedCount(profile.portraitMessageCount));
  const empty = !hasText(profile.character) && !hasText(profile.style);
  let aged = false;

  if (empty) {
    if (!(count >= cfg.firstMessages)) return { due: false, reason: 'few', own };
  } else {
    const refreshedAt = stampMs(profile.portraitRefreshedAt);
    const recent = refreshedAt !== null && !(nowMs - refreshedAt >= cfg.days * DAY_MS);
    const byCount = own >= cfg.messages && !recent;
    // The age path: an old portrait with modest new activity since.
    aged = !byCount && refreshedAt !== null && nowMs - refreshedAt >= cfg.maxAgeDays * DAY_MS && own >= cfg.minMessages;
    if (!byCount && !aged) return { due: false, reason: own >= cfg.messages ? 'recent' : 'few', own };
  }

  const attemptAt = stampMs(profile.portraitAttemptAt);
  if (attemptAt !== null && !(nowMs - attemptAt >= cfg.retryHours * HOUR_MS)) return { due: false, reason: 'retry-wait', own };

  const lastSeen = stampMs(profile.lastSeen);
  if (lastSeen !== null && cfg.lookbackDays > 0 && nowMs - lastSeen > cfg.lookbackDays * DAY_MS) {
    return { due: false, reason: 'quiet', own };
  }

  return { due: true, reason: empty ? 'first' : aged ? 'aged' : 'due', own };
}

/**
 * When a member was first found due (`portraitDueAt`, stamped by the scheduler's look), in epoch
 * milliseconds; null when missing, unreadable, or not later than `portraitRefreshedAt` (stale: a
 * portrait was stored since by a path that does not clear the stamp, the voice run's). Pure.
 * @param {object} profile  A stored profile.
 * @returns {number|null}
 */
export function dueSinceMs(profile) {
  const dueAt = stampMs(profile?.portraitDueAt);
  if (dueAt === null) return null;
  const refreshedAt = stampMs(profile?.portraitRefreshedAt);
  return refreshedAt !== null && dueAt <= refreshedAt ? null : dueAt;
}

/**
 * The members due for a portrait refresh, the longest waiting first (`dueSinceMs` ascending; none
 * yet counts as `nowMs`, so last), then the oldest portrait (`portraitRefreshedAt` ascending, none
 * first), then most own messages, then by id; at most `limit`. A member in `waiting` (`waitingPortraits`: a character text still
 * waits for the voice model) is never picked. Pure.
 * @param {object[]} profiles  Stored profiles (`store.listUserProfiles`); entries without an id are skipped.
 * @param {number} nowMs
 * @param {object} cfg  From `portraitSettings`.
 * @param {number} limit  A non-finite limit means no limit.
 * @param {{ waiting?: Set<string> }} [opts]
 * @returns {{ userId: string, own: number, reason: string }[]}
 */
export function pickDuePortraits(profiles, nowMs, cfg, limit, { waiting } = {}) {
  const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : Infinity;
  const due = [];
  for (const profile of Array.isArray(profiles) ? profiles : []) {
    if (!profile || typeof profile !== 'object' || profile.id === undefined || profile.id === null || profile.id === '') continue;
    if (waiting?.has(String(profile.id))) continue;
    const verdict = portraitDue(profile, nowMs, cfg);
    if (!verdict.due) continue;
    const waitedFrom = dueSinceMs(profile) ?? nowMs;
    const refreshedAt = stampMs(profile.portraitRefreshedAt) ?? -Infinity;
    due.push({ userId: String(profile.id), own: verdict.own, reason: verdict.reason, waitedFrom, refreshedAt });
  }
  const order = (x, y) => (x === y ? 0 : x < y ? -1 : 1);
  due.sort(
    (a, b) => order(a.waitedFrom, b.waitedFrom) || order(a.refreshedAt, b.refreshedAt) || b.own - a.own || a.userId.localeCompare(b.userId),
  );
  return due.slice(0, max).map(({ userId, own, reason }) => ({ userId, own, reason }));
}

/**
 * The scheduler that starts portrait refreshes by the counters above. `tick()` is cheap and meant
 * for a one-minute timer: it returns at once with the switch off (`features.memory` or
 * `features.portraitRefresh` false), while paused or warming up, without a guild, while its own
 * cycle is in flight, before `memory.portraitCheckMinutes` passed since its last look (kept in
 * memory), with no free daily slot, when today's LLM requests reached `llm.maxRequestsPerDay`
 * (`llmCapReached`), or on a UTC day a refresh already came back refused by that cap at the
 * cap's current value (a live raise lets the next look run). Otherwise it stamps `portraitDueAt`
 * (now) on every due member without a current one (`dueSinceMs`; one `store.updateUser` each, an
 * existing stamp is never moved) and refreshes the due
 * members in `pickDuePortraits` order (in two-stage mode, `portraitMode`, without the members
 * whose character text still waits for the voice model: the guild's voice queue is read once
 * per look), one at a time, until today's slots are taken (recounted
 * after each refresh, so the cue's and the owner's refreshes count too), passing one `crawl`
 * object to every call of the cycle so they share one history read. Right before each call the
 * member's stored profile is read again and `portraitDue` asked once more: one no longer due
 * (forgotten or wiped since the look, re-created by a new message, or refreshed meanwhile) is
 * counted as skipped and never started. A cycle ends early on a
 * `daily-cap`, `paused`, `warming-up` or `llm-error` outcome (a failed request says nothing good
 * about the next one), a thrown refresh, or the switch turned off. Logs `portrait: cycle` once
 * per cycle that found anyone due.
 * @param {object} deps
 * @param {object} deps.hot  Live config and prompts; read at the moment of use.
 * @param {object} deps.store  `state.data`, `state.markDirty()`, `listUserProfiles(guildId)`,
 *   `getUser(guildId, userId)`, `updateUser(guildId, userId, fields)` (the `portraitDueAt` stamp),
 *   `getVoiceQueue(guildId)` (read only in two-stage mode).
 * @param {(guildId: string, userId: string, reason: string, opts: { crawl: object }) =>
 *   Promise<{ ok: boolean, reason?: string, cap?: string }>} deps.refreshPortrait
 *   src/memory/warmup.js#createWarmup's `refreshPortrait`.
 * @param {() => boolean} [deps.isWarmingUp]
 * @param {() => (string|null)} deps.getGuildId
 * @param {() => number} [deps.now]
 * @returns {{ tick: () => Promise<{ ran: boolean, reason?: string, due?: number, started?: number,
 *   refreshed?: number, skipped?: number }> }}
 */
export function createPortraitScheduler({ hot, store, refreshPortrait, isWarmingUp = () => false, getGuildId, now = Date.now }) {
  let lastLookAt = null; // when the last look happened, in memory only: a restart looks at once
  let cycling = false;
  // A refresh refused by the LLM's daily request cap: `{ day, cap }`, the UTC day and the cap
  // then (null: not a number). A second guard next to llmCapReached, for a refusal the stored
  // count does not explain (a cap that is not a number); a cap raised since then lifts it.
  let llmRefused = null;

  const switchedOff = (config) => config?.features?.memory === false || config?.features?.portraitRefresh === false;

  /** Today's free portrait slots, rolling the counter over (and marking state dirty) on a new day. */
  function freeSlots(nowMs) {
    const { count, rolled } = dailyCounter(store.state.data, PORTRAIT_SLOTS, nowMs);
    if (rolled) store.state.markDirty();
    return portraitSettings(hot.config).perDay - count;
  }

  /** Whether a portrait request would be refused today by the LLM's daily request cap. */
  function llmCapped(nowMs) {
    if (llmCapReached(store.state.data, hot.config, nowMs)) return true;
    if (!llmRefused || llmRefused.day !== utcDay(nowMs)) return false;
    return (llmDailyCap(hot.config) ?? -Infinity) <= (llmRefused.cap ?? -Infinity);
  }

  async function tick() {
    if (switchedOff(hot.config)) return { ran: false, reason: 'off' };
    if (store.state.data.paused) return { ran: false, reason: 'paused' };
    if (isWarmingUp()) return { ran: false, reason: 'warming-up' };
    const guildId = getGuildId?.();
    if (!guildId) return { ran: false, reason: 'no-guild' };
    if (cycling) return { ran: false, reason: 'busy' };

    const nowMs = now();
    const settings = portraitSettings(hot.config);
    if (lastLookAt !== null && nowMs - lastLookAt < settings.checkMinutes * MINUTE_MS) return { ran: false, reason: 'not-yet' };
    lastLookAt = nowMs;
    if (freeSlots(nowMs) <= 0 || llmCapped(nowMs)) return { ran: false, reason: 'daily-cap' };

    let candidates;
    try {
      // A refresh in two-stage mode would ask stage A again and only replace the waiting item.
      const waiting = portraitMode(hot.config, hot.prompts).stage === 'two' ? waitingPortraits(store.getVoiceQueue(guildId)) : undefined;
      candidates = pickDuePortraits(store.listUserProfiles(guildId), nowMs, settings, Infinity, { waiting });
      // When each member was first found due, so the queue serves the longest waiting first.
      for (const { userId } of candidates) {
        const stored = store.getUser(guildId, userId);
        if (stored && dueSinceMs(stored) === null) store.updateUser(guildId, userId, { portraitDueAt: new Date(nowMs).toISOString() });
      }
    } catch (err) {
      log.warn('portrait: look failed', { guildId, reason: 'store-error', error: errorNameOf(err) });
      return { ran: false, reason: 'store-error' };
    }
    if (candidates.length === 0) return { ran: false, reason: 'none-due' };

    cycling = true;
    const counts = { due: candidates.length, started: 0, refreshed: 0, skipped: 0 };
    const crawl = {};
    try {
      for (const { userId } of candidates) {
        if (switchedOff(hot.config) || store.state.data.paused || freeSlots(now()) <= 0) break;
        let outcome;
        try {
          // The look can be minutes old by now (the crawl, the requests before this one): a
          // member forgotten or wiped since (perhaps re-created by one new message) or
          // refreshed meanwhile by the cue or the owner is no longer due and is not started.
          if (!portraitDue(store.getUser(guildId, userId), now(), portraitSettings(hot.config)).due) {
            counts.skipped += 1;
            continue;
          }
          counts.started += 1;
          outcome = await refreshPortrait(guildId, userId, '', { crawl });
        } catch (err) {
          counts.skipped += 1;
          log.warn('portrait: refresh failed', { guildId, userId, error: err });
          break;
        }
        if (outcome?.ok) counts.refreshed += 1;
        else counts.skipped += 1;
        const reason = outcome?.reason;
        if (reason === 'daily-cap') {
          if (outcome.cap === 'llm') llmRefused = { day: utcDay(now()), cap: llmDailyCap(hot.config) };
          break;
        }
        if (reason === 'paused' || reason === 'warming-up' || reason === 'llm-error') break;
      }
    } finally {
      cycling = false;
    }
    log.info('portrait: cycle', { guildId, ...counts });
    return { ran: true, ...counts };
  }

  return { tick };
}
