// "Elsewhere": the persona may read a channel it cannot write in (a selfreflection, an
// announcements channel), and a call there has nowhere to go. This module is the pure core of answering in
// an explicit destination instead: when a settle wait in the source is due, the ring
// of calls received there (answered, skipped by choice, or still unanswered),
// the per-channel seen mark of the pulled blocks, the audience comparison that keeps a narrower channel's content out of a wider
// one, the destination pick and the link of a message (the address the interface gave it).
//
// No I/O, no platform SDK: the clock is passed in, platform objects are read by
// the callers and handed over as plain values (ids, timestamps, sets of ids,
// a usability check). Every function returns new values and never mutates
// its input, so the stored shapes (`state.json` `elsewherePings`,
// `elsewhereSeen`) only change where the caller assigns the result and marks
// the state dirty.

import { accountIdOf as idOf } from '../memory/recent.ts';
import { DAY_MS } from '../time.ts';
import type { MessageUrlTemplate } from '../protocol/adapter.ts';
import { portIface, portMessageUrl } from '../interface/capabilities.ts';

const SECOND_MS = 1000;

/** The parts of the live config this module reads. */
type Config = ({} & Record<string, unknown>) | null | undefined;

/**
 * The elsewhere measures, production values of the config cut of 2026-10-31: the quiet time in the source before acting, the longest settle
 * wait, the ring size and the ring entry lifetime.
 */
export const ELSEWHERE_DEFAULTS = Object.freeze({
  settleSeconds: 90,
  settleMaxSeconds: 300,
  rememberPings: 20,
  pingMaxAgeDays: 7,
});

/** A finite number from `value`, else null. */
function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The `elsewhere` measures in milliseconds: ELSEWHERE_DEFAULTS; the live config holds none. `pingMaxAgeDays` 0 would
 * mean no age limit (the ring then bounded by its size only).
 */
export const elsewhereSettings: (config?: Config) => {
  settleMs: number;
  settleMaxMs: number;
  rememberPings: number;
  pingMaxAgeMs: number;
} = () => ({
  settleMs: ELSEWHERE_DEFAULTS.settleSeconds * SECOND_MS,
  settleMaxMs: ELSEWHERE_DEFAULTS.settleMaxSeconds * SECOND_MS,
  rememberPings: ELSEWHERE_DEFAULTS.rememberPings,
  pingMaxAgeMs: ELSEWHERE_DEFAULTS.pingMaxAgeDays * DAY_MS,
});

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
  placeId: string;
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
    const placeId = idOf(entry.placeId);
    if (!messageId || !placeId || typeof entry.ts !== 'number' || !Number.isFinite(entry.ts)) continue;
    entries.push({
      messageId,
      placeId,
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
  { messageId, placeId, ts }: { messageId: string; placeId: string; ts: number },
  { cap, maxAgeMs, now }: { cap: number; maxAgeMs: number; now: number }
): Array<RingPing> {
  const entries = ringEntries(ring).filter((entry) => !isExpired(entry.ts, now, maxAgeMs));
  const id = idOf(messageId);
  const channel = idOf(placeId);
  if (
    id &&
    channel &&
    Number.isFinite(ts) &&
    !isExpired(ts, now, maxAgeMs) &&
    !entries.some((entry) => entry.messageId === id)
  ) {
    entries.push({ messageId: id, placeId: channel, ts, answeredAt: null, skippedAt: null });
  }
  const keep = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 0;
  return keep === 0 ? [] : oldestFirst(entries).slice(-keep);
}

/**
 * Stamp a call answered (a turn that showed it spoke, a reaction alone
 * included). An earlier stamp is kept.
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
  marked: Array<{ messageId: string; placeId: string; status: 'answered' | 'skipped' | 'unanswered' }>;
} {
  let entries = ringEntries(ring);
  const marked: Array<{ messageId: string; placeId: string; status: 'answered' | 'skipped' | 'unanswered' }> = [];
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
    if (after !== before) marked.push({ messageId: id, placeId: found.placeId, status: after });
  }
  return { ring: entries, marked };
}

/**
 * The ring's calls in one channel that are not past `maxAgeMs` at `now`,
 * oldest first (a `maxAgeMs` that is not positive is no limit).
 */
export function pingsIn(
  ring: unknown,
  placeId: string,
  { now, maxAgeMs }: { now: number; maxAgeMs: number }
): Array<RingPing> {
  const channel = idOf(placeId);
  return oldestFirst(
    ringEntries(ring).filter((entry) => entry.placeId === channel && !isExpired(entry.ts, now, maxAgeMs))
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
export function markSeen(seen: unknown, placeId: string, ts: number): Record<string, number> {
  const next: Record<string, number> =
    seen && typeof seen === 'object' && !Array.isArray(seen) ? { ...(seen as Record<string, number>) } : {};
  const channel = idOf(placeId);
  if (!channel || !Number.isFinite(ts)) return next;
  const current = finiteOrNull(next[channel]);
  if (current === null || ts > current) next[channel] = ts;
  return next;
}

// ---- the audience rail ------------------------------------------------------------------

/**
 * Who can view one channel, read by the caller from the platform's permissions.
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
 * still view the destination without the source. The platform applies a member's
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
function memberViewsSource(accountId: string, source: Audience, heldRoles?: Set<string>): boolean {
  if (source.memberAllow.has(accountId)) return true;
  if (source.memberDeny.has(accountId)) return false;
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
  for (const accountId of dest.memberAllow)
    if (!memberViewsSource(accountId, source, dest.memberRoles?.get(accountId))) return false;
  return isSubset(source.memberDeny, dest.memberDeny);
}

// ---- the destination ----------------------------------------------------------------------

// ---- the link of a message ----------------------------------------------------------------

/** A message as the interface named it: where it is, and `url`, its address on the platform when it has one. */
export type MessageReference = { iface: string; conversationId: string; messageId: string; url?: string | null };

/**
 * The reference of a message with the address the interface's template gives it, from the values of its three slots
 * (`url` null when the interface declared no template, or an id is missing). A message with no `community` (null) is
 * in a private chat.
 */
export function messageReference(
  iface: string,
  template: MessageUrlTemplate | null | undefined,
  slots: { community: unknown; conversation: unknown; message: unknown }
): MessageReference {
  const ids = [idOf(slots.conversation), idOf(slots.message)];
  const community = slots.community === null ? null : idOf(slots.community);
  let url: string | null = null;
  if (template && ids[0] && ids[1] && (slots.community === null || community !== null)) {
    url = (slots.community === null ? template.direct : template.community)
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
 * The link to a message in the address form of `port` (its `capabilities().messageUrl`) from the values of the
 * template's slots, null when the port gives none. A message with no `community` (null) is in a private chat.
 */
export function messageLinkOf(
  port: unknown,
  community: unknown,
  conversation: unknown,
  message: unknown
): string | null {
  return messageLink(messageReference(portIface(port), portMessageUrl(port), { community, conversation, message }));
}

/** A message a post may link to: the channel it is in and its id. */
export type LinkTarget = { placeId: string; messageId: string };

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
  linkOf: (placeId: string | undefined, messageId: string) => string | null;
  pulledIds: ReadonlyMap<string, string>;
  sourceTarget: LinkTarget | null;
}): (pulledId: string | null) => string | null {
  const linked = new Set<string>();
  let first = true;
  return (pulledId) => {
    const target = pulledId ? { placeId: pulledIds.get(pulledId), messageId: pulledId } : first ? sourceTarget : null;
    first = false;
    if (!target || linked.has(target.messageId)) return null;
    linked.add(target.messageId);
    return linkOf(target.placeId, target.messageId);
  };
}
