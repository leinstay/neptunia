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
// one, the destination pick and the link of a message (the address the interface gave it).
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
import type { MessageUrlTemplate } from '../protocol/adapter.ts';
import { portIface, portMessageUrl } from '../interface/capabilities.ts';

const SECOND_MS = 1000;

/** The parts of the live config this module reads. */
type Config =
  | {
      elsewhere?: Partial<Record<'settleSeconds' | 'settleMaxSeconds' | 'rememberPings' | 'pingMaxAgeDays', unknown>>;
      features?: { elsewhere?: unknown };
      memory?: { mainChannelIds?: unknown };
    }
  | null
  | undefined;

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
function nonNegativeOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** A finite number from `value`, else null. */
function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The `elsewhere` settings read from the live config, converted to
 * milliseconds, each falling back to `ELSEWHERE_DEFAULTS` when missing or not
 * a finite number >= 0. `rememberPings` 0 keeps no call; `pingMaxAgeDays` 0
 * means no age limit (the ring is then bounded by its size only).
 */
export function elsewhereSettings(config?: Config): {
  settleMs: number;
  settleMaxMs: number;
  rememberPings: number;
  pingMaxAgeMs: number;
} {
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
 */
export function elsewhereOn(config?: Config): boolean {
  return config?.features?.elsewhere !== false;
}

// ---- settle ---------------------------------------------------------------------------

/**
 * When a settle wait in a source channel is due: `settleMs` after the last
 * message observed there, never later than `maxMs` after the first one (the
 * call or the noticed message that armed it). The wait is a timer of the
 * caller and holds no attention; a restart during it loses the wait (the
 * ring keeps the call, unanswered).
 * @returns Epoch ms.
 */
export function settleDueAt({
  firstAt,
  lastAt,
  settleMs,
  maxMs,
}: {
  firstAt: number;
  lastAt?: number;
  settleMs: number;
  maxMs: number;
}): number {
  const last = lastAt !== undefined && Number.isFinite(lastAt) ? lastAt : firstAt;
  return Math.min(last + settleMs, firstAt + maxMs);
}

// ---- the ring of calls ----------------------------------------------------------------

/**
 * One call to the persona received in a channel it cannot write in, as kept
 * in `state.json` `elsewherePings`: ids and a time only (no author, no text).
 * `ts` is when the call was written (epoch ms), `answeredAt` when a turn that showed it spoke (a reaction counts),
 * `skippedAt` when the persona chose to let it pass.
 */
export type RingPing = {
  messageId: string;
  channelId: string;
  ts: number;
  answeredAt: number | null;
  skippedAt: number | null;
};

/** Whether a call written at `ts` is past `maxAgeMs` at `now`; a `maxAgeMs` that is not positive is no limit. */
function isExpired(ts: number, now: number, maxAgeMs: number): boolean {
  return Number.isFinite(maxAgeMs) && maxAgeMs > 0 && now - ts > maxAgeMs;
}

/** The well-formed entries of a stored ring, each copied with its stamps normalised. */
function ringEntries(ring: unknown): Array<RingPing> {
  if (!Array.isArray(ring)) return [];
  const entries: Array<RingPing> = [];
  for (const entry of ring as Array<Record<string, unknown>>) {
    if (!entry || typeof entry !== 'object') continue;
    const messageId = idOf(entry.messageId);
    const channelId = idOf(entry.channelId);
    if (!messageId || !channelId || typeof entry.ts !== 'number' || !Number.isFinite(entry.ts)) continue;
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
function oldestFirst(entries: ReadonlyArray<RingPing>): Array<RingPing> {
  return [...entries].sort((a, b) => a.ts - b.ts);
}

/**
 * Record a call in the ring. Expired entries are dropped, a message id
 * already present keeps its first record and its state, a new call starts
 * unanswered and unskipped, and the newest `cap` entries are kept (oldest
 * first). A malformed call or one already past `maxAgeMs` is not recorded.
 * Garbage in the stored ring is dropped, never thrown on.
 * `opts` are `elsewhereSettings`' `rememberPings` (`cap`) and `pingMaxAgeMs` (`maxAgeMs`). The stored ring is not mutated.
 */
export function recordPing(
  ring: unknown,
  { messageId, channelId, ts }: { messageId: string; channelId: string; ts: number },
  { cap, maxAgeMs, now }: { cap: number; maxAgeMs: number; now: number }
): Array<RingPing> {
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
 * The stored ring is not mutated.
 */
export function markPingAnswered(ring: unknown, messageId: string, now: number): Array<RingPing> {
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
 * The stored ring is not mutated.
 */
export function markPingSkipped(ring: unknown, messageId: string, now: number): Array<RingPing> {
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
 */
export function pingStatus(
  entry: Pick<RingPing, 'answeredAt' | 'skippedAt'> | null | undefined
): 'answered' | 'skipped' | 'unanswered' {
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
 * The stored ring is not mutated; `stamps` are `{ messageId, status: 'answered'|'skipped' }`, anything else is passed over.
 */
export function stampPings(
  ring: unknown,
  stamps: unknown,
  now: number
): {
  ring: Array<RingPing>;
  marked: Array<{ messageId: string; channelId: string; status: 'answered' | 'skipped' | 'unanswered' }>;
} {
  let entries = ringEntries(ring);
  const marked: Array<{ messageId: string; channelId: string; status: 'answered' | 'skipped' | 'unanswered' }> = [];
  for (const stamp of (Array.isArray(stamps) ? stamps : []) as Array<{
    messageId?: unknown;
    status?: unknown;
  } | null>) {
    const mark = stamp?.status === 'answered' ? markPingAnswered : stamp?.status === 'skipped' ? markPingSkipped : null;
    const id = idOf(stamp?.messageId);
    const index = entries.findIndex((entry) => entry.messageId === id);
    const found = entries[index];
    if (!mark || id === null || found === undefined) continue;
    const before = pingStatus(found);
    entries = mark(entries, id, now);
    const after = pingStatus(entries[index]);
    if (after !== before) marked.push({ messageId: id, channelId: found.channelId, status: after });
  }
  return { ring: entries, marked };
}

/**
 * The ring's calls in one channel that are not past `maxAgeMs` at `now`,
 * oldest first (a `maxAgeMs` that is not positive is no limit).
 */
export function pingsIn(
  ring: unknown,
  channelId: string,
  { now, maxAgeMs }: { now: number; maxAgeMs: number }
): Array<RingPing> {
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
 * The stored map is not mutated.
 */
export function markSeen(seen: unknown, channelId: string, ts: number): Record<string, number> {
  const next: Record<string, number> =
    seen && typeof seen === 'object' && !Array.isArray(seen) ? { ...(seen as Record<string, number>) } : {};
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
 */
export function hasUnseen(lastTs: number, seenTs: number | null | undefined): boolean {
  return Number.isFinite(lastTs) && lastTs > (typeof seenTs === 'number' && Number.isFinite(seenTs) ? seenTs : 0);
}

// ---- the liveness of a noticed comment --------------------------------------------------

/** Whether a normalized message is a member's: neither the persona's own nor a bot's. */
type LiveMessage = { ts: number; self?: boolean; bot?: boolean };

function isMemberMessage(message: LiveMessage | null | undefined): message is LiveMessage {
  return message !== null && message !== undefined && !message.self && !message.bot;
}

/**
 * The one liveness count: messages by members (neither the persona's own nor
 * a bot's) written inside the last `windowMinutes` before `now` (a message
 * exactly `windowMinutes` old counts) and after `sinceTs` (a missing or
 * non-finite `sinceTs` excludes nothing). The values are used as given, as
 * `chooseMode` in src/behavior/spontaneous.js does: a `windowMinutes` of 0
 * counts only messages written at `now`, a garbage one counts nothing. Kept
 * free of Discord so that chooser can count with it too (`sinceTs` omitted).
 * `messages` are normalized messages (`{ ts, self, bot }`), any order.
 */
export function liveMemberCount(
  messages: unknown,
  { now, windowMinutes, sinceTs }: { now: number; windowMinutes: number; sinceTs?: number | null }
): number {
  const windowStart = now - windowMinutes * MINUTE_MS;
  const since = typeof sinceTs === 'number' && Number.isFinite(sinceTs) ? sinceTs : -Infinity;
  let count = 0;
  for (const m of (Array.isArray(messages) ? messages : []) as Array<LiveMessage | null>) {
    if (isMemberMessage(m) && m.ts >= windowStart && m.ts > since) count += 1;
  }
  return count;
}

/** The two liveness settings read as `chooseMode` reads them, falling back only when a key is missing. */
type LivenessConfig = { liveMinMessages?: number; liveWindowMinutes?: number };

function livenessSettings(cfg: LivenessConfig | undefined): { need: number; windowMinutes: number } {
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
 * `messages` are the source's normalized messages (`{ ts, self, bot }`), any order; `cfg` is config.spontaneous.
 */
export function isSourceLive(
  messages: ReadonlyArray<LiveMessage>,
  now: number,
  seenTs: number | null | undefined,
  cfg?: LivenessConfig
): boolean {
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
 * `cfg` is config.spontaneous.
 */
export function mayBeLive(
  lastTs: number,
  now: number,
  seenTs: number | null | undefined,
  cfg?: LivenessConfig
): boolean {
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
 * `cfg` is config.spontaneous.
 */
export function chooseElsewhereMode(
  messages: ReadonlyArray<LiveMessage>,
  now: number,
  seenTs: number | null | undefined,
  cfg?: LivenessConfig,
  { path }: { path?: 'tick' | 'eavesdrop' } = {}
): 'elsewhere' | null {
  if (liveMemberCount(messages, { now, windowMinutes: Infinity, sinceTs: seenTs }) === 0) return null;
  if (path === 'eavesdrop') return 'elsewhere';
  return isSourceLive(messages, now, seenTs, cfg) ? 'elsewhere' : null;
}

// ---- the audience rail ------------------------------------------------------------------

/**
 * Who can view one channel, read by the caller from Discord's permissions.
 * `@everyone`'s overwrite belongs to `everyone` and `roles`, never to
 * `roleAllow` / `roleDeny`. `everyone`: @everyone can view it (its overwrite applied). `roles`: ids of the roles that
 * can view it, each on its own (@everyone's and that role's overwrite applied; Administrator views everything).
 * `roleAllow`, `roleDeny`: ids of the roles whose overwrite allows or denies ViewChannel. `memberAllow`, `memberDeny`:
 * members with an overwrite allowing or denying ViewChannel. `memberRoles` (optional): for the members named by an
 * overwrite, the ids of the roles they hold (from the member cache); a member missing from it is unknown.
 */
export type Audience = {
  everyone: boolean;
  roles: Set<string>;
  roleAllow: Set<string>;
  roleDeny: Set<string>;
  memberAllow: Set<string>;
  memberDeny: Set<string>;
  memberRoles?: Map<string, Set<string>>;
};

/** Whether `value` has the Audience shape. */
function isAudience(value: unknown): value is Audience {
  const audience = value as Partial<Audience> | null | undefined;
  return (
    audience !== null &&
    audience !== undefined &&
    typeof audience === 'object' &&
    typeof audience.everyone === 'boolean' &&
    audience.roles instanceof Set &&
    audience.roleAllow instanceof Set &&
    audience.roleDeny instanceof Set &&
    audience.memberAllow instanceof Set &&
    audience.memberDeny instanceof Set
  );
}

/** Whether every item of `inner` is in `outer`. */
function isSubset(inner: Iterable<string>, outer: ReadonlySet<string>): boolean {
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
function roleDeniesContained(dest: Audience, source: Audience): boolean {
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
 * `heldRoles` is the member's role ids, when known.
 */
function memberViewsSource(memberId: string, source: Audience, heldRoles?: Set<string>): boolean {
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
 */
export function audienceCovers(dest: unknown, source: unknown): boolean {
  if (!isAudience(dest) || !isAudience(source)) return false;
  if (dest.everyone && !source.everyone) return false;
  if (!isSubset(dest.roles, source.roles)) return false;
  if (source.roleDeny.size > 0 && !roleDeniesContained(dest, source)) return false;
  for (const memberId of dest.memberAllow)
    if (!memberViewsSource(memberId, source, dest.memberRoles?.get(memberId))) return false;
  return isSubset(source.memberDeny, dest.memberDeny);
}

// ---- the destination ----------------------------------------------------------------------

/**
 * The first id of `memory.mainChannelIds` (normalised by `mainChannelSet`,
 * in list order) for which `isUsable(id)` holds, else null. Usable is the
 * caller's check (a known text channel of the guild, not a thread, the bot
 * can send there, not the source).
 */
export function pickDestinationId(mainChannelIds: unknown, isUsable: (id: string) => boolean): string | null {
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
 * `isUsable` is `pickDestinationId`'s.
 */
export function resolveDestination(
  config: Config,
  isUsable: (id: string) => boolean
): { destinationId: string; reason: null } | { destinationId: null; reason: 'off' | 'no-destination' } {
  if (!elsewhereOn(config)) return { destinationId: null, reason: 'off' };
  const destinationId = pickDestinationId(config?.memory?.mainChannelIds, isUsable);
  return destinationId ? { destinationId, reason: null } : { destinationId: null, reason: 'no-destination' };
}

// ---- the link of a message ----------------------------------------------------------------

/** A message as the interface named it: where it is, and `url`, its address on the platform when it has one. */
export type MessageReference = { iface: string; conversationId: string; messageId: string; url?: string | null };

/**
 * The reference of a message with the address the interface's template gives it (`url` null when the interface
 * declared no template, or an id is missing). A message of no community (`communityId` null) is a private chat.
 */
export function messageReference(
  iface: string,
  template: MessageUrlTemplate | null | undefined,
  { communityId, conversationId, messageId }: { communityId: unknown; conversationId: unknown; messageId: unknown }
): MessageReference {
  const ids = [idOf(conversationId), idOf(messageId)];
  const community = communityId === null ? null : idOf(communityId);
  let url: string | null = null;
  if (template && ids[0] && ids[1] && (communityId === null || community !== null)) {
    url = (communityId === null ? template.direct : template.community)
      .replaceAll('{community}', community ?? '')
      .replaceAll('{conversation}', ids[0])
      .replaceAll('{message}', ids[1]);
  }
  return { iface, conversationId: ids[0] ?? '', messageId: ids[1] ?? '', url };
}

/**
 * The link to one message: the address the interface put on its reference (a URL given by the interface, not
 * wording; the text around it comes from `labels.elsewhere.link`). Null when the reference has none or an id is
 * missing.
 */
export function messageLink(ref: MessageReference | null | undefined): string | null {
  if (!ref || idOf(ref.conversationId) === null || idOf(ref.messageId) === null) return null;
  return typeof ref.url === 'string' && ref.url !== '' ? ref.url : null;
}

/**
 * The link to a message of a conversation in the address form of `port` (its `capabilities().messageUrl`), null when
 * the port gives none. A message of no community (`communityId` null) is in a private chat.
 */
export function messageLinkOf(
  port: unknown,
  communityId: unknown,
  conversationId: unknown,
  messageId: unknown
): string | null {
  return messageLink(
    messageReference(portIface(port), portMessageUrl(port), { communityId, conversationId, messageId })
  );
}

/** A message a post may link to: the channel it is in and its id. */
export type LinkTarget = { channelId: string; messageId: string };

/**
 * The jump links (`messageLink`) of one turn's posts -- its messages, then the GIF, then the picture -- asked in
 * posting order; act and dryAct share the rule, so a rehearsal shows the links a real turn posts. A post answering a
 * pulled line (`pulledId`) links to that line; on a turn about another channel the first post links to `sourceTarget`
 * when it answers none. One line is linked at most once per turn: a second answer to it carries no link. `linkOf`
 * gives the link of a message of a channel, `pulledIds` maps every pulled line to its channel.
 * @returns The next post's link, or null.
 */
export function createLinker({
  linkOf,
  pulledIds,
  sourceTarget,
}: {
  linkOf: (channelId: string | undefined, messageId: string) => string | null;
  pulledIds: ReadonlyMap<string, string>;
  sourceTarget: LinkTarget | null;
}): (pulledId: string | null) => string | null {
  const linked = new Set<string>();
  let first = true;
  return (pulledId) => {
    const target = pulledId ? { channelId: pulledIds.get(pulledId), messageId: pulledId } : first ? sourceTarget : null;
    first = false;
    if (!target || linked.has(target.messageId)) return null;
    linked.add(target.messageId);
    return linkOf(target.channelId, target.messageId);
  };
}
