// "Elsewhere": the persona may read a channel it cannot write in (a diary, an
// announcements channel), and a call or something worth a remark there has
// nowhere to go. This module is the pure core of answering or commenting in
// the main channel instead (the destination, the first usable id of
// `memory.mainChannelIds`): when a settle wait in the source is due, the ring
// of calls received there (answered, skipped by choice, or still unanswered),
// the per-channel seen mark that keeps the persona from commenting twice on
// the same content, the ordinary liveness rule a noticed comment found on a
// tick must pass (a count the writable channels' chooser can share), the
// audience comparison that keeps a narrower channel's content out of a wider
// one, the destination pick and the jump link of a message.
//
// No I/O, no discord.js: the clock is passed in, Discord objects are read by
// the callers and handed over as plain values (ids, timestamps, sets of ids,
// a usability check). Every function returns new values and never mutates
// its input, so the stored shapes (`state.json` `elsewherePings`,
// `elsewhereSeen`) only change where the caller assigns the result and marks
// the state dirty.

import { memberIdOf as idOf } from '../memory/recent.js';
import { mainChannelSet } from '../memory/index.js';
import { MINUTE_MS, DAY_MS } from '../time.js';

const SECOND_MS = 1000;
const LINK_BASE = 'https://discord.com/channels';

/**
 * Defaults of the `elsewhere` config block (config.json carries the same
 * values): the quiet time in the source before acting, the longest settle
 * wait, the ring size and the ring entry lifetime.
 */
export const ELSEWHERE_DEFAULTS = Object.freeze({
  settleSeconds: 90,
  settleMaxSeconds: 300,
  rememberPings: 20,
  pingMaxAgeDays: 7,
});

/**
 * Fallbacks of the two `spontaneous` liveness keys the noticed-comment rule
 * reads (config.json carries the same values), so a source qualifies exactly
 * as a writable channel does for `interject` in src/behavior/spontaneous.js.
 */
export const LIVENESS_DEFAULTS = Object.freeze({
  liveMinMessages: 4,
  liveWindowMinutes: 15,
});

/** A finite number >= 0 from `value`, else `fallback`. */
function nonNegativeOr(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** A finite number from `value`, else null. */
function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

/**
 * The `elsewhere` settings read from the live config, converted to
 * milliseconds, each falling back to `ELSEWHERE_DEFAULTS` when missing or not
 * a finite number >= 0. `rememberPings` 0 keeps no call; `pingMaxAgeDays` 0
 * means no age limit (the ring is then bounded by its size only).
 * @param {object} [config]  The live config.
 * @returns {{ settleMs: number, settleMaxMs: number, rememberPings: number, pingMaxAgeMs: number }}
 */
export function elsewhereSettings(config) {
  const e = config?.elsewhere ?? {};
  const d = ELSEWHERE_DEFAULTS;
  return {
    settleMs: nonNegativeOr(e.settleSeconds, d.settleSeconds) * SECOND_MS,
    settleMaxMs: nonNegativeOr(e.settleMaxSeconds, d.settleMaxSeconds) * SECOND_MS,
    rememberPings: Math.floor(nonNegativeOr(e.rememberPings, d.rememberPings)),
    pingMaxAgeMs: nonNegativeOr(e.pingMaxAgeDays, d.pingMaxAgeDays) * DAY_MS,
  };
}

/**
 * `features.elsewhere` (a missing key counts as on). On its own it does not
 * make the feature act: see `resolveDestination`.
 * @param {object} [config]  The live config.
 * @returns {boolean}
 */
export function elsewhereOn(config) {
  return config?.features?.elsewhere !== false;
}

// ---- settle ---------------------------------------------------------------------------

/**
 * When a settle wait in a source channel is due: `settleMs` after the last
 * message observed there, never later than `maxMs` after the first one (the
 * call or the noticed message that armed it). The wait is a timer of the
 * caller and holds no attention; a restart during it loses the wait (the
 * ring keeps the call, unanswered).
 * @param {{ firstAt: number, lastAt?: number, settleMs: number, maxMs: number }} times
 * @returns {number}  Epoch ms.
 */
export function settleDueAt({ firstAt, lastAt, settleMs, maxMs }) {
  const last = Number.isFinite(lastAt) ? lastAt : firstAt;
  return Math.min(last + settleMs, firstAt + maxMs);
}

// ---- the ring of calls ----------------------------------------------------------------

/**
 * One call to the persona received in a channel it cannot write in, as kept
 * in `state.json` `elsewherePings`: ids and a time only (no author, no text).
 * @typedef {object} RingPing
 * @property {string} messageId
 * @property {string} channelId
 * @property {number} ts               when the call was written (epoch ms)
 * @property {number|null} answeredAt  when a turn that showed it spoke (a reaction counts)
 * @property {number|null} skippedAt   when the persona chose to let it pass
 */

/** Whether a call written at `ts` is past `maxAgeMs` at `now`; a `maxAgeMs` that is not positive is no limit. */
function isExpired(ts, now, maxAgeMs) {
  return Number.isFinite(maxAgeMs) && maxAgeMs > 0 && now - ts > maxAgeMs;
}

/** The well-formed entries of a stored ring, each copied with its stamps normalised. */
function ringEntries(ring) {
  if (!Array.isArray(ring)) return [];
  const entries = [];
  for (const entry of ring) {
    if (!entry || typeof entry !== 'object') continue;
    const messageId = idOf(entry.messageId);
    const channelId = idOf(entry.channelId);
    if (!messageId || !channelId || !Number.isFinite(entry.ts)) continue;
    entries.push({
      messageId,
      channelId,
      ts: entry.ts,
      answeredAt: finiteOrNull(entry.answeredAt),
      skippedAt: finiteOrNull(entry.skippedAt),
    });
  }
  return entries;
}

/** Entries oldest first; equal times keep their stored order. */
function oldestFirst(entries) {
  return [...entries].sort((a, b) => a.ts - b.ts);
}

/**
 * Record a call in the ring. Expired entries are dropped, a message id
 * already present keeps its first record and its state, a new call starts
 * unanswered and unskipped, and the newest `cap` entries are kept (oldest
 * first). A malformed call or one already past `maxAgeMs` is not recorded.
 * Garbage in the stored ring is dropped, never thrown on.
 * @param {RingPing[]|unknown} ring  The stored ring (not mutated).
 * @param {{ messageId: string, channelId: string, ts: number }} ping
 * @param {{ cap: number, maxAgeMs: number, now: number }} opts  `elsewhereSettings`' `rememberPings` / `pingMaxAgeMs`.
 * @returns {RingPing[]}
 */
export function recordPing(ring, { messageId, channelId, ts }, { cap, maxAgeMs, now }) {
  const entries = ringEntries(ring).filter((entry) => !isExpired(entry.ts, now, maxAgeMs));
  const id = idOf(messageId);
  const channel = idOf(channelId);
  if (
    id &&
    channel &&
    Number.isFinite(ts) &&
    !isExpired(ts, now, maxAgeMs) &&
    !entries.some((entry) => entry.messageId === id)
  ) {
    entries.push({ messageId: id, channelId: channel, ts, answeredAt: null, skippedAt: null });
  }
  const keep = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 0;
  return keep === 0 ? [] : oldestFirst(entries).slice(-keep);
}

/**
 * Stamp a call answered (a turn that showed it spoke, a reaction alone
 * included; never in dry-run -- the caller's rule). An earlier stamp is kept.
 * An answer wins over an earlier skip (`pingStatus`).
 * @param {RingPing[]|unknown} ring  The stored ring (not mutated).
 * @param {string} messageId
 * @param {number} now
 * @returns {RingPing[]}
 */
export function markPingAnswered(ring, messageId, now) {
  const id = idOf(messageId);
  return ringEntries(ring).map((entry) =>
    entry.messageId === id && entry.answeredAt === null ? { ...entry, answeredAt: now } : entry
  );
}

/**
 * Stamp a call skipped: the persona was shown it and chose to let it pass,
 * so later pulls must not present it as waiting for an answer. An answered
 * call stays answered; an earlier skip stamp is kept. A call lost before any
 * turn saw it (a restart during the settle) is never stamped and stays
 * unanswered.
 * @param {RingPing[]|unknown} ring  The stored ring (not mutated).
 * @param {string} messageId
 * @param {number} now
 * @returns {RingPing[]}
 */
export function markPingSkipped(ring, messageId, now) {
  const id = idOf(messageId);
  return ringEntries(ring).map((entry) =>
    entry.messageId === id && entry.answeredAt === null && entry.skippedAt === null
      ? { ...entry, skippedAt: now }
      : entry
  );
}

/**
 * The state of one ring entry: `'answered'` once answered (even after a
 * skip), else `'skipped'` once skipped, else `'unanswered'`.
 * @param {RingPing|null|undefined} entry
 * @returns {'answered'|'skipped'|'unanswered'}
 */
export function pingStatus(entry) {
  if (Number.isFinite(entry?.answeredAt)) return 'answered';
  if (Number.isFinite(entry?.skippedAt)) return 'skipped';
  return 'unanswered';
}

/**
 * Stamp several calls of the ring at once, in order: `answered` through
 * `markPingAnswered`, `skipped` through `markPingSkipped` (an answered call is
 * never skipped, an answer wins over a skip, a stamp is never moved). A
 * message id the ring does not hold, a stamp of another status and garbage
 * are passed over. `marked` lists each stamp that changed its call's state,
 * with the call's channel and its state after it, so the caller logs those
 * and marks the state dirty only when there is one.
 * @param {RingPing[]|unknown} ring  The stored ring (not mutated).
 * @param {{ messageId: string, status: 'answered'|'skipped' }[]|unknown} stamps
 * @param {number} now
 * @returns {{ ring: RingPing[], marked: { messageId: string, channelId: string, status: 'answered'|'skipped' }[] }}
 */
export function stampPings(ring, stamps, now) {
  let entries = ringEntries(ring);
  const marked = [];
  for (const stamp of Array.isArray(stamps) ? stamps : []) {
    const mark = stamp?.status === 'answered' ? markPingAnswered : stamp?.status === 'skipped' ? markPingSkipped : null;
    const id = idOf(stamp?.messageId);
    const index = entries.findIndex((entry) => entry.messageId === id);
    if (!mark || index === -1) continue;
    const before = pingStatus(entries[index]);
    entries = mark(entries, id, now);
    const after = pingStatus(entries[index]);
    if (after !== before) marked.push({ messageId: id, channelId: entries[index].channelId, status: after });
  }
  return { ring: entries, marked };
}

/**
 * The ring's calls in one channel that are not past `maxAgeMs` at `now`,
 * oldest first (a `maxAgeMs` that is not positive is no limit).
 * @param {RingPing[]|unknown} ring
 * @param {string} channelId
 * @param {{ now: number, maxAgeMs: number }} opts
 * @returns {RingPing[]}
 */
export function pingsIn(ring, channelId, { now, maxAgeMs }) {
  const channel = idOf(channelId);
  return oldestFirst(
    ringEntries(ring).filter((entry) => entry.channelId === channel && !isExpired(entry.ts, now, maxAgeMs))
  );
}

// ---- seen marks -----------------------------------------------------------------------

/**
 * Move the seen mark of a source channel (`state.json` `elsewhereSeen`: the
 * time of the newest message of that channel a turn has shown the persona)
 * to `ts`, never backwards. A missing map starts empty, a garbage mark is
 * replaced, a non-finite `ts` changes nothing. The mark is not a limit: it
 * only keeps the persona from commenting twice on the same content.
 * @param {Record<string, number>|unknown} seen  The stored map (not mutated).
 * @param {string} channelId
 * @param {number} ts
 * @returns {Record<string, number>}
 */
export function markSeen(seen, channelId, ts) {
  const next = seen && typeof seen === 'object' && !Array.isArray(seen) ? { ...seen } : {};
  const channel = idOf(channelId);
  if (!channel || !Number.isFinite(ts)) return next;
  const current = finiteOrNull(next[channel]);
  if (current === null || ts > current) next[channel] = ts;
  return next;
}

/**
 * Whether a channel holds something its seen mark does not cover: its last
 * message (`lastActivity`, 0 for none) is newer than the mark. No mark counts
 * as nothing seen.
 * @param {number} lastTs
 * @param {number|null|undefined} seenTs
 * @returns {boolean}
 */
export function hasUnseen(lastTs, seenTs) {
  return Number.isFinite(lastTs) && lastTs > (Number.isFinite(seenTs) ? seenTs : 0);
}

// ---- the liveness of a noticed comment --------------------------------------------------

/** Whether a normalized message is a member's: neither the persona's own nor a bot's. */
function isMemberMessage(message) {
  return Boolean(message) && !message.self && !message.bot;
}

/**
 * The one liveness count: messages by members (neither the persona's own nor
 * a bot's) written inside the last `windowMinutes` before `now` (a message
 * exactly `windowMinutes` old counts) and after `sinceTs` (a missing or
 * non-finite `sinceTs` excludes nothing). The values are used as given, as
 * `chooseMode` in src/behavior/spontaneous.js does: a `windowMinutes` of 0
 * counts only messages written at `now`, a garbage one counts nothing. Kept
 * free of Discord so that chooser can count with it too (`sinceTs` omitted).
 * @param {object[]|unknown} messages  Normalized messages (`{ ts, self, bot }`), any order.
 * @param {{ now: number, windowMinutes: number, sinceTs?: number|null }} opts
 * @returns {number}
 */
export function liveMemberCount(messages, { now, windowMinutes, sinceTs }) {
  const windowStart = now - windowMinutes * MINUTE_MS;
  const since = Number.isFinite(sinceTs) ? sinceTs : -Infinity;
  let count = 0;
  for (const m of Array.isArray(messages) ? messages : []) {
    if (isMemberMessage(m) && m.ts >= windowStart && m.ts > since) count += 1;
  }
  return count;
}

/** The two liveness settings read as `chooseMode` reads them, falling back only when a key is missing. */
function livenessSettings(cfg) {
  return {
    need: cfg?.liveMinMessages ?? LIVENESS_DEFAULTS.liveMinMessages,
    windowMinutes: cfg?.liveWindowMinutes ?? LIVENESS_DEFAULTS.liveWindowMinutes,
  };
}

/**
 * The ordinary liveness rule of `interject` applied to a source the persona
 * cannot write in (no looser rule on the tick path): at least
 * `cfg.liveMinMessages` member messages inside the last
 * `cfg.liveWindowMinutes` (`liveMemberCount`), counted only after the seen
 * mark (no mark counts as nothing seen). The settings are read exactly as
 * `chooseMode` reads them; a missing key falls back to `LIVENESS_DEFAULTS`.
 * A `liveMinMessages` of 0 makes any source live, as it makes any writable
 * channel interject; the seen-mark rule of `chooseElsewhereMode` still
 * applies.
 * @param {object[]} messages  Normalized messages of the source (`{ ts, self, bot }`), any order.
 * @param {number} now
 * @param {number|null|undefined} seenTs
 * @param {{ liveMinMessages?: number, liveWindowMinutes?: number }} [cfg]  config.spontaneous
 * @returns {boolean}
 */
export function isSourceLive(messages, now, seenTs, cfg) {
  const { need, windowMinutes } = livenessSettings(cfg);
  return liveMemberCount(messages, { now, windowMinutes, sinceTs: seenTs }) >= need;
}

/**
 * A cheap necessary condition for `chooseElsewhereMode` on the tick path,
 * from the source's last message time alone (`lastActivity`, any author), so
 * a tick need not fetch a source that cannot pass: the last message is newer
 * than the seen mark and, when `liveMinMessages` is above 0, inside the live
 * window. A source whose new content went quiet longer than the window ago
 * stops being a candidate. It cannot tell members from bots: a source where
 * only bots post still passes it.
 * @param {number} lastTs
 * @param {number} now
 * @param {number|null|undefined} seenTs
 * @param {{ liveMinMessages?: number, liveWindowMinutes?: number }} [cfg]  config.spontaneous
 * @returns {boolean}
 */
export function mayBeLive(lastTs, now, seenTs, cfg) {
  if (!hasUnseen(lastTs, seenTs)) return false;
  const { need, windowMinutes } = livenessSettings(cfg);
  return need > 0 ? lastTs >= now - windowMinutes * MINUTE_MS : true;
}

/**
 * The mode chooser of a noticed turn (`runTurn`'s `chooseMode`, given the
 * pulled source's messages). On both paths a member must have written after
 * the seen mark (the persona never comments twice on the same content). On
 * the tick path (also the default for a missing or unknown `path`) the source
 * must pass `isSourceLive` as well. On the eavesdrop path the
 * `eavesdropChance` roll that armed the settle is the gate, so one new member
 * message is enough; a caller that wants the liveness rule on that path too
 * passes `'tick'`. Else null (`not-now`).
 * @param {object[]} messages
 * @param {number} now
 * @param {number|null|undefined} seenTs
 * @param {{ liveMinMessages?: number, liveWindowMinutes?: number }} [cfg]  config.spontaneous
 * @param {{ path?: 'tick'|'eavesdrop' }} [opts]
 * @returns {'elsewhere'|null}
 */
export function chooseElsewhereMode(messages, now, seenTs, cfg, { path } = {}) {
  if (liveMemberCount(messages, { now, windowMinutes: Infinity, sinceTs: seenTs }) === 0) return null;
  if (path === 'eavesdrop') return 'elsewhere';
  return isSourceLive(messages, now, seenTs, cfg) ? 'elsewhere' : null;
}

// ---- the audience rail ------------------------------------------------------------------

/**
 * Who can view one channel, read by the caller from Discord's permissions.
 * `@everyone`'s overwrite belongs to `everyone` and `roles`, never to
 * `roleAllow` / `roleDeny`.
 * @typedef {object} Audience
 * @property {boolean} everyone          @everyone can view it (its overwrite applied)
 * @property {Set<string>} roles         ids of the roles that can view it, each on its own (@everyone's and that
 *                                       role's overwrite applied; Administrator views everything)
 * @property {Set<string>} roleAllow     ids of the roles whose overwrite allows ViewChannel
 * @property {Set<string>} roleDeny      ids of the roles whose overwrite denies ViewChannel
 * @property {Set<string>} memberAllow   members with an overwrite allowing ViewChannel
 * @property {Set<string>} memberDeny    members with an overwrite denying ViewChannel
 * @property {Map<string, Set<string>>} [memberRoles]  for the members named by an overwrite, the ids of the roles
 *                                       they hold (from the member cache); a member missing from it is unknown
 */

/** Whether `value` has the Audience shape. */
function isAudience(value) {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    typeof value.everyone === 'boolean' &&
    value.roles instanceof Set &&
    value.roleAllow instanceof Set &&
    value.roleDeny instanceof Set &&
    value.memberAllow instanceof Set &&
    value.memberDeny instanceof Set
  );
}

/** Whether every item of `inner` is in `outer`. */
function isSubset(inner, outer) {
  for (const item of inner) if (!outer.has(item)) return false;
  return true;
}

/**
 * With a role denied on the source, whether no member can hold that role and
 * still view the destination without the source. Discord applies a member's
 * role overwrites together (every role deny, then every role allow), so a
 * member holding a role denied on the source and another role that views the
 * destination is hidden from the source unless one of their roles is allowed
 * there. Safe when either (a) @everyone cannot view the destination and every
 * role that can is explicitly allowed on the source (whoever reaches the
 * destination holds a role whose allow beats any role deny on the source), or
 * (b) the destination denies every role the source denies and allows no role
 * the source does not (whoever holds such a role reaches the destination only
 * through an allow that the source repeats). Otherwise blocks.
 */
function roleDeniesContained(dest, source) {
  if (dest.everyone === false && isSubset(dest.roles, source.roleAllow)) return true;
  return isSubset(source.roleDeny, dest.roleDeny) && isSubset(dest.roleAllow, source.roleAllow);
}

/**
 * Whether a member allowed by name on the destination provably views the
 * source: allowed by name there too; else, with his roles known, not denied
 * by name on the source, none of his roles denied there, and either the
 * source is viewable by @everyone or one of his roles views it. With his
 * roles unknown only the source's @everyone view with no role denied and no
 * deny of that member proves it (he may hold a denied role).
 * @param {string} memberId
 * @param {Audience} source
 * @param {Set<string>|undefined} [heldRoles]  the member's role ids, when known
 */
function memberViewsSource(memberId, source, heldRoles) {
  if (source.memberAllow.has(memberId)) return true;
  if (source.memberDeny.has(memberId)) return false;
  if (!(heldRoles instanceof Set)) return source.everyone && source.roleDeny.size === 0;
  for (const role of heldRoles) if (source.roleDeny.has(role)) return false;
  if (source.everyone) return true;
  for (const role of heldRoles) if (source.roleAllow.has(role) || source.roles.has(role)) return true;
  return false;
}

/**
 * Whether everyone who can view the destination can view the source, so the
 * source's content may enter a turn there. There is no shortcut for a source
 * @everyone can view: a role overwrite on the source may still hide it, so
 * every step runs on every pair. The check, in order: a source @everyone
 * cannot view never covers a destination @everyone can view; every role that
 * views the destination must view the source; a role denied on the source
 * must not reach the destination through a combination of roles
 * (`roleDeniesContained`); every member allowed by name on the destination
 * must provably view the source (`memberViewsSource`): allowed by name there
 * too, or proven by the source's @everyone view when the source denies no
 * role and does not deny that member; every member denied on the source must
 * be denied on the destination. So a source @everyone can view that denies no
 * role and no member covers every destination through the full check: each
 * role's view starts from its own and @everyone's base permissions, so every
 * role views such a source, and the member step accepts the destination's
 * allows by name. A member's roles prove his view of the source only
 * when the audience carries them (`memberRoles`, from the member cache);
 * otherwise the check holds for any set of roles a member may hold. It may block a safe
 * pair (a role with Administrator views every channel, but nothing in the
 * shape says which role has it); it never covers a pair where some
 * combination of roles and overwrites shows the destination and hides the
 * source. A missing or malformed audience never covers.
 * @param {Audience|null|undefined} dest
 * @param {Audience|null|undefined} source
 * @returns {boolean}
 */
export function audienceCovers(dest, source) {
  if (!isAudience(dest) || !isAudience(source)) return false;
  if (dest.everyone && !source.everyone) return false;
  if (!isSubset(dest.roles, source.roles)) return false;
  if (source.roleDeny.size > 0 && !roleDeniesContained(dest, source)) return false;
  for (const memberId of dest.memberAllow)
    if (!memberViewsSource(memberId, source, dest.memberRoles?.get?.(memberId))) return false;
  return isSubset(source.memberDeny, dest.memberDeny);
}

// ---- the destination ----------------------------------------------------------------------

/**
 * The first id of `memory.mainChannelIds` (normalised by `mainChannelSet`,
 * in list order) for which `isUsable(id)` holds, else null. Usable is the
 * caller's check (a known text channel of the guild, not a thread, the bot
 * can send there, not the source).
 * @param {unknown} mainChannelIds
 * @param {(id: string) => boolean} isUsable
 * @returns {string|null}
 */
export function pickDestinationId(mainChannelIds, isUsable) {
  if (typeof isUsable !== 'function') return null;
  for (const id of mainChannelSet(mainChannelIds)) {
    if (isUsable(id)) return id;
  }
  return null;
}

/**
 * Where a routed call or a noticed comment would be spoken, read from the
 * live config at the moment of use: `'off'` when `features.elsewhere` is
 * false, `'no-destination'` when no id of `memory.mainChannelIds` is usable
 * (the public default is an empty list, so the feature is inert until a main
 * channel is set). The reason is the kebab-case code logged as `route`.
 * @param {object} [config]  The live config.
 * @param {(id: string) => boolean} isUsable  See `pickDestinationId`.
 * @returns {{ destinationId: string, reason: null } | { destinationId: null, reason: 'off'|'no-destination' }}
 */
export function resolveDestination(config, isUsable) {
  if (!elsewhereOn(config)) return { destinationId: null, reason: 'off' };
  const destinationId = pickDestinationId(config?.memory?.mainChannelIds, isUsable);
  return destinationId ? { destinationId, reason: null } : { destinationId: null, reason: 'no-destination' };
}

// ---- the jump link ----------------------------------------------------------------------

/**
 * Discord's jump link to one message (a URL built by code, not wording; the
 * text around it comes from `labels.elsewhere.link`). Null when an id is
 * missing.
 * @param {string} guildId
 * @param {string} channelId
 * @param {string} messageId
 * @returns {string|null}
 */
export function messageLink(guildId, channelId, messageId) {
  const ids = [idOf(guildId), idOf(channelId), idOf(messageId)];
  if (ids.some((id) => id === null)) return null;
  return `${LINK_BASE}/${ids.join('/')}`;
}
