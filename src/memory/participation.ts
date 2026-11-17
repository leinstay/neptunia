// The participation store, pure: the exchanges the persona took part in on the
// server's channels over the last days, kept so a turn in one channel can
// remember what she said in another one hours ago. The unit is a PARTICIPATION
// EPISODE: a slice of one channel around her own lines -- a few lines before
// each of hers, the message she answered when it is older, and a line or so
// after. Code records it deterministically from the messages themselves (no
// model decides what is kept); src/memory/store.ts keeps it in
// data/places/<id>/participation.json and runs every write through
// `expireEpisodes`.
//
// Life of an episode: it lives `participation.hours` after her newest line in
// it (`lastOwnAt`) and is dropped at the next write past that, never on read;
// the storage cap (`participation.maxStored`) drops the oldest by `lastOwnAt`.
// Besides that only a wipe of the place (src/memory/store.ts) removes anything.
// Private chats are never recorded: an episode always names its channel, and
// `recordOwnLine` refuses a line without one.
//
// This module records and expires episodes. Rendering and wording belong to the
// request builder. The clock is always passed in (`now`).

import { isRecord, isFiniteNumber, isIntegerNumber } from './types.ts';
import { HOUR_MS, MINUTE_MS } from '../time.ts';
import { oneLine } from './clamp.ts';
import type { Untyped } from './types.ts';

/** The participation settings: how many hours and lines a stored episode spans, and how many are shown. */
export type ParticipationSettings = {
  hours: number;
  linesBefore: number;
  linesAfter: number;
  followMinutes: number;
  mergeGapMinutes: number;
  contextMinutes: number;
  maxMessages: number;
  maxStored: number;
  shown: number;
  perChannel: number;
  episodeChars: number;
  earlierHours: number;
  earlierShown: number;
};

/** The stored participation: the episodes and the next episode number. */
/** One message of an episode, in the stored shape. */
export type ParticipationMessage = {
  id: string;
  ts: number;
  authorId: string;
  name: string;
  self: boolean;
  text: string;
  replyTo: string | null;
  caption: string | null;
};

/** A stretch of a channel around the persona's own lines: its messages, its times and the episode it continues. */
export type Episode = {
  id: string;
  placeId: string;
  startAt: number;
  lastAt: number;
  lastOwnAt: number | null;
  messages: Array<ParticipationMessage>;
  continues: string | null;
  itemId?: string;
};

/** The stored participation: the episodes and the next episode number. */
export type ParticipationState = { episodes: Array<Episode>; nextId: number };

/** The participation measures: production values of the config cut of 2026-10-31. */
export const PARTICIPATION_DEFAULTS: Readonly<ParticipationSettings> = Object.freeze({
  hours: 72,
  linesBefore: 3,
  linesAfter: 1,
  followMinutes: 10,
  mergeGapMinutes: 10,
  contextMinutes: 30,
  maxMessages: 32,
  maxStored: 120,
  shown: 4,
  perChannel: 2,
  episodeChars: 1800,
  earlierHours: 3,
  earlierShown: 3,
});

/** The participation settings: PARTICIPATION_DEFAULTS, production values of the config cut of 2026-10-31. */
export function participationSettings(): ParticipationSettings {
  return { ...PARTICIPATION_DEFAULTS };
}

/**
 * The store of a place nothing was recorded for yet.
 */
export function emptyParticipation(): ParticipationState {
  return { episodes: [], nextId: 1 };
}

/** `settings` completed with the defaults (a missing or non-object value reads as the defaults). */
function settingsOf(settings: unknown): ParticipationSettings {
  const given = isRecord(settings) ? settings : {};
  const out: Record<string, number> = {};
  for (const [key, fallback] of Object.entries(PARTICIPATION_DEFAULTS)) {
    out[key] = typeof given[key] === 'number' && isFiniteNumber(given[key]) && given[key] >= 0 ? given[key] : fallback;
  }
  return { ...PARTICIPATION_DEFAULTS, ...out };
}

/** `raw` as an id: a non-empty string trimmed, a finite number as its decimal form, else null. */
function idOf(raw: unknown): string | null {
  if (typeof raw === 'number' && isFiniteNumber(raw)) return String(raw);
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

/** `raw` as a clock reading: a finite number, else the wall clock. */
function nowOf(raw: unknown): number {
  return isFiniteNumber(raw) ? raw : Date.now();
}

/** An episode id `p<n>` as its number, else null. */
function episodeNumber(id: string) {
  const match = typeof id === 'string' ? /^p(\d+)$/.exec(id) : null;
  return match ? Number(match[1]) : null;
}

/**
 * One message (untrusted) in the stored shape, or null when it lacks an id or a
 * finite `ts`. `text` kept on one line, whole; `caption` one line or null; `self` true only when it is
 * exactly true (or forced by `self`).
 */
function messageOf(raw: unknown, { self }: { self?: boolean } = {}): ParticipationMessage | null {
  if (!isRecord(raw)) return null;
  const id = idOf(raw.id);
  if (id === null || !isFiniteNumber(raw.ts)) return null;
  const text = typeof raw.text === 'string' ? oneLine(raw.text) : '';
  const caption = typeof raw.caption === 'string' && oneLine(raw.caption) ? oneLine(raw.caption) : null;
  return {
    id,
    ts: raw.ts,
    authorId: idOf(raw.authorId) ?? '',
    name: typeof raw.name === 'string' ? oneLine(raw.name) : '',
    self: self === undefined ? raw.self === true : self,
    text,
    replyTo: idOf(raw.replyTo),
    caption,
  };
}

/** An episode with `messages` (sorted by `ts`), its times recomputed from them; its optional
 * `itemId` (a non-empty string) rides along, none is added. */
function withMessages(
  episode: { id: string; placeId: string; continues?: string | null; itemId?: unknown },
  messages: Array<ParticipationMessage>
): Episode {
  const sorted = [...messages].sort((a, b) => a.ts - b.ts);
  const own = sorted.filter((m) => m.self);
  const out: Episode = {
    id: episode.id,
    placeId: episode.placeId,
    startAt: sorted[0].ts,
    lastAt: sorted[sorted.length - 1].ts,
    lastOwnAt: own.length ? own[own.length - 1].ts : null,
    messages: sorted,
    continues: episode.continues ?? null,
  };
  if (typeof episode.itemId === 'string' && episode.itemId) out.itemId = episode.itemId;
  return out;
}

/**
 * A stored value (untrusted: hand-edited, or from another version) as the store
 * holds it. An episode that is not an object, lacks a `p<n>` id or a channel id,
 * repeats an earlier episode's id, or keeps no line of the persona once its
 * messages are read is dropped. A message without an id or a finite `ts` is
 * dropped, a repeated message id keeps its first copy; messages are sorted by
 * `ts` and the episode's times recomputed from them. `nextId` ends above every
 * episode number. Pure: `value` is never mutated; the result normalises to itself.
 */
export function normalizeParticipation(value: unknown): ParticipationState {
  const source = isRecord(value) ? value : {};
  const episodes: Array<Episode> = [];
  const seenIds = new Set<string>();
  let highest = 0;
  for (const raw of Array.isArray(source.episodes) ? source.episodes : []) {
    if (!isRecord(raw)) continue;
    const number = episodeNumber(raw.id);
    const placeId = idOf(raw.placeId);
    if (number === null || placeId === null || seenIds.has(raw.id)) continue;
    const messages: Array<ParticipationMessage> = [];
    const seenMessages = new Set<string>();
    for (const rawMessage of Array.isArray(raw.messages) ? raw.messages : []) {
      const message = messageOf(rawMessage);
      if (!message || seenMessages.has(message.id)) continue;
      seenMessages.add(message.id);
      messages.push(message);
    }
    if (!messages.some((m) => m.self)) continue;
    seenIds.add(raw.id);
    highest = Math.max(highest, number);
    const continues = episodeNumber(raw.continues) === null ? null : raw.continues;
    episodes.push(withMessages({ id: raw.id, placeId, continues, itemId: raw.itemId }, messages));
  }
  const storedNext = isIntegerNumber(source.nextId) && source.nextId >= 1 ? source.nextId : 1;
  return { episodes, nextId: Math.max(storedNext, highest + 1) };
}

/** The index of the newest episode of `placeId` in `episodes` (by `lastAt`, then position), or -1. */
function newestOfChannel(episodes: Array<Episode>, placeId: string, key: 'lastAt' | 'lastOwnAt' = 'lastAt') {
  let best = -1;
  for (let i = 0; i < episodes.length; i += 1) {
    const ep = episodes[i];
    if (ep.placeId !== placeId) continue;
    if (best === -1 || (ep[key] ?? ep.lastAt) >= (episodes[best][key] ?? episodes[best].lastAt)) best = i;
  }
  return best;
}

/** The message ids held by `episode` and the episodes it continues, walking `continues` back. */
function chainIds(episodes: Array<Episode>, episode: Episode) {
  const ids = new Set<string>();
  const visited = new Set<string>();
  let current: Episode | null | undefined = episode;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    for (const m of current.messages) ids.add(m.id);
    const next: string | null = current.continues;
    current = next ? episodes.find((ep) => ep.id === next) : null;
  }
  return ids;
}

/**
 * Record one line of the persona and its surroundings. `own` is her message (the
 * normalised shape, `self` forced true), `before` up to `linesBefore` channel
 * messages before it (chronological; the last `linesBefore` are taken), `parent`
 * the message she replied to when it is older than `before` (may be null; kept
 * whatever its age). A `before` line older than `contextMinutes` before her line
 * is dropped. The target is the newest episode of the channel whose `lastAt` lies
 * within `mergeGapMinutes` before HER line, else a new episode. A message
 * the target (or an episode it continues) already holds is not added again;
 * messages stay sorted by `ts`. When the target would exceed `maxMessages`, the
 * new messages that do not fit (the newest ones) start a new episode whose
 * `continues` names the full one. Texts are kept on one line and whole. The state comes back unchanged (the same
 * reference) when the line has no `placeId`, `own` is not a message (an id and
 * a finite `ts`), her line is already past `hours` before `now`, or nothing new
 * would be added. Pure: no input is mutated.
 * @param [settings]  `participationSettings`'s shape; missing keys read as the defaults.
 */
export function recordOwnLine(
  state: unknown,
  {
    placeId,
    own,
    before = [],
    parent = null,
  }: { placeId: string; own: Untyped; before?: Array<Untyped>; parent?: Untyped },
  settings: Partial<ParticipationSettings> | undefined,
  now: number
): ParticipationState {
  const s = settingsOf(settings);
  // The caller's own stored state, handed back as it came when nothing changes.
  const unchanged = state as ParticipationState;
  const channel = idOf(placeId);
  const ownLine = messageOf(own, { self: true });
  if (channel === null || !ownLine) return unchanged;
  if (ownLine.ts < nowOf(now) - s.hours * HOUR_MS) return unchanged;

  const base = normalizeParticipation(state);
  const take = Math.floor(s.linesBefore);
  const contextFrom = ownLine.ts - s.contextMinutes * MINUTE_MS;
  const context =
    take > 0 && Array.isArray(before)
      ? before.slice(-take).filter((m) => isRecord(m) && isFiniteNumber(m.ts) && m.ts >= contextFrom)
      : [];
  const incoming = [];
  const incomingIds = new Set();
  for (const raw of [parent, ...context, own]) {
    const message = raw === own ? ownLine : messageOf(raw);
    if (!message || incomingIds.has(message.id)) continue;
    incomingIds.add(message.id);
    incoming.push(message);
  }
  incoming.sort((a, b) => a.ts - b.ts);

  const gapMs = s.mergeGapMinutes * MINUTE_MS;
  const newest = newestOfChannel(base.episodes, channel);
  const newestEpisode = base.episodes[newest];
  const targetIndex = newest !== -1 && ownLine.ts - newestEpisode.lastAt <= gapMs ? newest : -1;
  const target = targetIndex === -1 ? null : base.episodes[targetIndex];
  const held = target ? chainIds(base.episodes, target) : new Set();
  let fresh = incoming.filter((m) => !held.has(m.id));
  if (fresh.length === 0) return unchanged;

  const episodes = [...base.episodes];
  let nextId = base.nextId;
  const max = Math.max(1, Math.floor(s.maxMessages));
  let previous = target;
  if (target) {
    const room = Math.max(0, max - target.messages.length);
    episodes[targetIndex] = withMessages(target, [...target.messages, ...fresh.slice(0, room)]);
    previous = episodes[targetIndex];
    fresh = fresh.slice(room);
  }
  while (fresh.length > 0) {
    const part = fresh.slice(0, max);
    fresh = fresh.slice(max);
    const episode = withMessages(
      { id: `p${nextId}`, placeId: channel, continues: previous ? previous.id : null },
      part
    );
    nextId += 1;
    episodes.push(episode);
    previous = episode;
  }
  return { episodes, nextId };
}

/**
 * Record a channel message (not the persona's) that arrives after her line: it
 * joins the channel's newest episode (by `lastOwnAt`) when it comes after her
 * newest line there by at most `followMinutes`, the episode holds fewer than
 * `linesAfter` messages newer than that line and fewer than `maxMessages` in all,
 * and the message is not already in it. Otherwise -- her own line included, which
 * goes through `recordOwnLine` -- the state comes back unchanged (the same
 * reference). Pure: no input is mutated.
 */
export function recordFollowing(
  state: unknown,
  { placeId, message }: { placeId: string; message: Untyped },
  settings: Partial<ParticipationSettings> | undefined,
  now: number
): ParticipationState {
  const s = settingsOf(settings);
  // The caller's own stored state, handed back as it came when nothing changes.
  const unchanged = state as ParticipationState;
  const channel = idOf(placeId);
  const line = messageOf(message);
  if (channel === null || !line || line.self) return unchanged;
  if (line.ts < nowOf(now) - s.hours * HOUR_MS) return unchanged;
  const base = normalizeParticipation(state);
  const index = newestOfChannel(base.episodes, channel, 'lastOwnAt');
  if (index === -1) return unchanged;
  const episode = base.episodes[index];
  const after = line.ts - Number(episode.lastOwnAt);
  if (after <= 0 || after > s.followMinutes * MINUTE_MS) return unchanged;
  if (episode.messages.some((m) => m.id === line.id)) return unchanged;
  if (episode.messages.filter((m) => m.ts > Number(episode.lastOwnAt)).length >= s.linesAfter) return unchanged;
  if (episode.messages.length >= Math.max(1, Math.floor(s.maxMessages))) return unchanged;
  const episodes = [...base.episodes];
  episodes[index] = withMessages(episode, [...episode.messages, line]);
  return { episodes, nextId: base.nextId };
}

/**
 * Expiry, run by the store on every write: episodes whose `lastOwnAt` is older
 * than `hours` before `now` go; then, when more than `maxStored` remain, the
 * oldest by `lastOwnAt` go. The rest keep their order. A `continues` naming a
 * gone episode is kept as it is. Pure: `state` is never mutated.
 * @returns `dropped`: the
 *   episodes that went, as normalised (their `itemId` included) -- the expired, then the ones over
 *   the cap, each in stored order.
 */
export function expireEpisodes(
  state: unknown,
  settings: Partial<ParticipationSettings> | undefined,
  now: number
): { state: ParticipationState; dropped: Array<Episode> } {
  const s = settingsOf(settings);
  const base = normalizeParticipation(state);
  const cutoff = nowOf(now) - s.hours * HOUR_MS;
  let episodes = base.episodes.filter((ep) => Number(ep.lastOwnAt) >= cutoff);
  const dropped = base.episodes.filter((ep) => Number(ep.lastOwnAt) < cutoff);
  const cap = Math.floor(s.maxStored);
  if (episodes.length > cap) {
    const keep = new Set([...episodes].sort((a, b) => Number(b.lastOwnAt) - Number(a.lastOwnAt)).slice(0, cap));
    dropped.push(...episodes.filter((ep) => !keep.has(ep)));
    episodes = episodes.filter((ep) => keep.has(ep));
  }
  return { state: { episodes, nextId: base.nextId }, dropped };
}
