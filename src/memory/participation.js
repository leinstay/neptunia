// The participation store, pure: the exchanges the persona took part in on the
// server's channels over the last days, kept so a turn in one channel can
// remember what she said in another one hours ago. The unit is a PARTICIPATION
// EPISODE: a slice of one channel around her own lines -- a few lines before
// each of hers, the message she answered when it is older, and a line or so
// after. Code records it deterministically from the messages themselves (no
// model decides what is kept); src/memory/store.js keeps it in
// data/guilds/<id>/participation.json and runs every write through
// `expireEpisodes`.
//
// Life of an episode: it lives `participation.hours` after her newest line in
// it (`lastOwnAt`) and is dropped at the next write past that, never on read;
// the storage cap (`participation.maxStored`) drops the oldest by `lastOwnAt`.
// Besides that only a forget of a member (`purgeParticipationFor`: their lines
// go, an episode left without a line of hers goes too) and a wipe of the guild
// (src/memory/store.js) remove anything. Private chats are never recorded: an
// episode always names its channel, and `recordOwnLine` refuses a line without
// one.
//
// The read side only ranks and cuts: `episodeHeadlines` (one short line pair
// per episode, for the picking classifier), `selectEpisodes` (which few a turn
// shows), `earlierEpisodes` (the current channel's lines the chat window has
// already let go of) and `cutEpisode` (which messages of one episode fit a
// character budget). Rendering and wording belong to the request builder. The clock is
// always passed in (`now`).

import { isPlainObject } from '../config.js';
import { HOUR_MS, MINUTE_MS } from '../time.js';
import { clampText, oneLine } from './clamp.js';

/**
 * config.json's own values for the `participation` section, the code fallbacks
 * when a deployment's config lacks a key. `contextMessages`, `maxOutputTokens` and
 * `pickTimeoutMs` belong to the pick classifier (src/behavior/participation-pick.js, which
 * applies the time limit), `earlierHours` and `earlierShown` to the current channel's
 * `<earlier>` block (`earlierEpisodes`).
 */
export const PARTICIPATION_DEFAULTS = Object.freeze({
  hours: 72,
  linesBefore: 3,
  linesAfter: 1,
  followMinutes: 10,
  mergeGapMinutes: 10,
  contextMinutes: 30,
  maxMessages: 32,
  maxStored: 120,
  maxTextChars: 400,
  shown: 4,
  perChannel: 2,
  episodeChars: 1800,
  contextMessages: 6,
  maxOutputTokens: 60,
  pickTimeoutMs: 1500,
  earlierHours: 3,
  earlierShown: 3,
});

/** How long a headline's member line and self line may be (a hard cut at a word boundary). */
const HEADLINE_CHARS = 120;
// The whole-episode columns: each line cut to HEADLINE_LINE_CHARS, the joined column to the SELF / MEMBER cap.
const HEADLINE_LINE_CHARS = 90;
const HEADLINE_SELF_CHARS = 320;
const HEADLINE_MEMBER_CHARS = 200;
const HEADLINE_JOIN = ' / ';

/** How many messages at each end of an episode a priority cut keeps when the budget allows. */
const CUT_EDGE = 2;

/**
 * The participation settings, read from `config` at the moment of use:
 * `config.participation`'s numbers with `PARTICIPATION_DEFAULTS` as fallbacks.
 * The `features.participation` switch is not read here (the caller's).
 * @param {object} config
 * @returns {{ hours: number, linesBefore: number, linesAfter: number, followMinutes: number,
 *   mergeGapMinutes: number, contextMinutes: number, maxMessages: number, maxStored: number, maxTextChars: number,
 *   shown: number, perChannel: number, episodeChars: number, contextMessages: number, maxOutputTokens: number,
 *   pickTimeoutMs: number, earlierHours: number, earlierShown: number }}
 */
export function participationSettings(config) {
  const section = isPlainObject(config?.participation) ? config.participation : {};
  const out = {};
  for (const [key, fallback] of Object.entries(PARTICIPATION_DEFAULTS)) out[key] = section[key] ?? fallback;
  return out;
}

/**
 * The store of a guild nothing was recorded for yet.
 * @returns {{ episodes: object[], nextId: number }}
 */
export function emptyParticipation() {
  return { episodes: [], nextId: 1 };
}

/** `settings` completed with the defaults (a missing or non-object value reads as the defaults). */
function settingsOf(settings) {
  const given = isPlainObject(settings) ? settings : {};
  const out = {};
  for (const [key, fallback] of Object.entries(PARTICIPATION_DEFAULTS)) {
    out[key] = typeof given[key] === 'number' && Number.isFinite(given[key]) && given[key] >= 0 ? given[key] : fallback;
  }
  return out;
}

/** `raw` as an id: a non-empty string trimmed, a finite number as its decimal form, else null. */
function idOf(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

/** `raw` as a clock reading: a finite number, else the wall clock. */
function nowOf(raw) {
  return Number.isFinite(raw) ? raw : Date.now();
}

/** The length of `text` in code points (0 for anything but a string). */
function lengthOf(text) {
  return typeof text === 'string' ? [...text].length : 0;
}

/** An episode id `p<n>` as its number, else null. */
function episodeNumber(id) {
  const match = typeof id === 'string' ? /^p(\d+)$/.exec(id) : null;
  return match ? Number(match[1]) : null;
}

/**
 * One message (untrusted) in the stored shape, or null when it lacks an id or a
 * finite `ts`. `text` kept on one line and, when `maxTextChars` is given, cut to
 * it at a word boundary; `caption` one line or null; `self` true only when it is
 * exactly true (or forced by `self`).
 */
function messageOf(raw, { maxTextChars, self } = {}) {
  if (!isPlainObject(raw)) return null;
  const id = idOf(raw.id);
  if (id === null || !Number.isFinite(raw.ts)) return null;
  const flat = typeof raw.text === 'string' ? oneLine(raw.text) : '';
  const text = maxTextChars === undefined ? flat : clampText(flat, maxTextChars, { tolerance: 1 });
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
function withMessages(episode, messages) {
  const sorted = [...messages].sort((a, b) => a.ts - b.ts);
  const own = sorted.filter((m) => m.self);
  const out = {
    id: episode.id,
    channelId: episode.channelId,
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
 * @param {unknown} value
 * @returns {{ episodes: object[], nextId: number }}
 */
export function normalizeParticipation(value) {
  const source = isPlainObject(value) ? value : {};
  const episodes = [];
  const seenIds = new Set();
  let highest = 0;
  for (const raw of Array.isArray(source.episodes) ? source.episodes : []) {
    if (!isPlainObject(raw)) continue;
    const number = episodeNumber(raw.id);
    const channelId = idOf(raw.channelId);
    if (number === null || channelId === null || seenIds.has(raw.id)) continue;
    const messages = [];
    const seenMessages = new Set();
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
    episodes.push(withMessages({ id: raw.id, channelId, continues, itemId: raw.itemId }, messages));
  }
  const storedNext = Number.isInteger(source.nextId) && source.nextId >= 1 ? source.nextId : 1;
  return { episodes, nextId: Math.max(storedNext, highest + 1) };
}

/** The index of the newest episode of `channelId` in `episodes` (by `lastAt`, then position), or -1. */
function newestOfChannel(episodes, channelId, key = 'lastAt') {
  let best = -1;
  for (let i = 0; i < episodes.length; i += 1) {
    const ep = episodes[i];
    if (ep.channelId !== channelId) continue;
    if (best === -1 || (ep[key] ?? ep.lastAt) >= (episodes[best][key] ?? episodes[best].lastAt)) best = i;
  }
  return best;
}

/** The message ids held by `episode` and the episodes it continues, walking `continues` back. */
function chainIds(episodes, episode) {
  const ids = new Set();
  const visited = new Set();
  let current = episode;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    for (const m of current.messages) ids.add(m.id);
    current = current.continues ? episodes.find((ep) => ep.id === current.continues) : null;
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
 * `continues` names the full one. Texts are kept on one line and cut to
 * `maxTextChars` at a word boundary. The state comes back unchanged (the same
 * reference) when the line has no `channelId`, `own` is not a message (an id and
 * a finite `ts`), her line is already past `hours` before `now`, or nothing new
 * would be added. Pure: no input is mutated.
 * @param {unknown} state
 * @param {{ channelId: string, own: object, before?: object[], parent?: object|null }} line
 * @param {object} [settings]  `participationSettings`'s shape; missing keys read as the defaults.
 * @param {number} now
 * @returns {{ episodes: object[], nextId: number }}
 */
export function recordOwnLine(state, { channelId, own, before = [], parent = null } = {}, settings, now) {
  const s = settingsOf(settings);
  const channel = idOf(channelId);
  const ownLine = messageOf(own, { maxTextChars: s.maxTextChars, self: true });
  if (channel === null || !ownLine) return state;
  if (ownLine.ts < nowOf(now) - s.hours * HOUR_MS) return state;

  const base = normalizeParticipation(state);
  const take = Math.floor(s.linesBefore);
  const contextFrom = ownLine.ts - s.contextMinutes * MINUTE_MS;
  const context =
    take > 0 && Array.isArray(before)
      ? before.slice(-take).filter((m) => isPlainObject(m) && Number.isFinite(m.ts) && m.ts >= contextFrom)
      : [];
  const incoming = [];
  const incomingIds = new Set();
  for (const raw of [parent, ...context, own]) {
    const message = raw === own ? ownLine : messageOf(raw, { maxTextChars: s.maxTextChars });
    if (!message || incomingIds.has(message.id)) continue;
    incomingIds.add(message.id);
    incoming.push(message);
  }
  incoming.sort((a, b) => a.ts - b.ts);

  const gapMs = s.mergeGapMinutes * MINUTE_MS;
  const newest = newestOfChannel(base.episodes, channel);
  const targetIndex = newest !== -1 && ownLine.ts - base.episodes[newest].lastAt <= gapMs ? newest : -1;
  const target = targetIndex === -1 ? null : base.episodes[targetIndex];
  const held = target ? chainIds(base.episodes, target) : new Set();
  let fresh = incoming.filter((m) => !held.has(m.id));
  if (fresh.length === 0) return state;

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
      { id: `p${nextId}`, channelId: channel, continues: previous ? previous.id : null },
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
 * @param {unknown} state
 * @param {{ channelId: string, message: object }} line
 * @param {object} [settings]
 * @param {number} now
 * @returns {{ episodes: object[], nextId: number }}
 */
export function recordFollowing(state, { channelId, message } = {}, settings, now) {
  const s = settingsOf(settings);
  const channel = idOf(channelId);
  const line = messageOf(message, { maxTextChars: s.maxTextChars });
  if (channel === null || !line || line.self) return state;
  if (line.ts < nowOf(now) - s.hours * HOUR_MS) return state;
  const base = normalizeParticipation(state);
  const index = newestOfChannel(base.episodes, channel, 'lastOwnAt');
  if (index === -1) return state;
  const episode = base.episodes[index];
  const after = line.ts - episode.lastOwnAt;
  if (after <= 0 || after > s.followMinutes * MINUTE_MS) return state;
  if (episode.messages.some((m) => m.id === line.id)) return state;
  if (episode.messages.filter((m) => m.ts > episode.lastOwnAt).length >= s.linesAfter) return state;
  if (episode.messages.length >= Math.max(1, Math.floor(s.maxMessages))) return state;
  const episodes = [...base.episodes];
  episodes[index] = withMessages(episode, [...episode.messages, line]);
  return { episodes, nextId: base.nextId };
}

/**
 * Expiry, run by the store on every write: episodes whose `lastOwnAt` is older
 * than `hours` before `now` go; then, when more than `maxStored` remain, the
 * oldest by `lastOwnAt` go. The rest keep their order. A `continues` naming a
 * gone episode is kept as it is. Pure: `state` is never mutated.
 * @param {unknown} state
 * @param {object} [settings]
 * @param {number} now
 * @returns {{ state: { episodes: object[], nextId: number }, dropped: object[] }}  `dropped`: the
 *   episodes that went, as normalised (their `itemId` included) -- the expired, then the ones over
 *   the cap, each in stored order.
 */
export function expireEpisodes(state, settings, now) {
  const s = settingsOf(settings);
  const base = normalizeParticipation(state);
  const cutoff = nowOf(now) - s.hours * HOUR_MS;
  let episodes = base.episodes.filter((ep) => ep.lastOwnAt >= cutoff);
  const dropped = base.episodes.filter((ep) => ep.lastOwnAt < cutoff);
  const cap = Math.floor(s.maxStored);
  if (episodes.length > cap) {
    const keep = new Set([...episodes].sort((a, b) => b.lastOwnAt - a.lastOwnAt).slice(0, cap));
    dropped.push(...episodes.filter((ep) => !keep.has(ep)));
    episodes = episodes.filter((ep) => keep.has(ep));
  }
  return { state: { episodes, nextId: base.nextId }, dropped };
}

/**
 * The store without one member's messages, for a forget: every message whose
 * `authorId` is `userId` leaves every episode, and an episode left with no line
 * of the persona is dropped. Pure: `state` is never mutated; `nextId` is kept.
 * @param {unknown} state
 * @param {string} userId
 * @returns {{ value: { episodes: object[], nextId: number }, removed: number }}  `removed`: the
 *   messages taken out.
 */
export function purgeParticipationFor(state, userId) {
  const base = normalizeParticipation(state);
  const id = idOf(userId);
  let removed = 0;
  const episodes = [];
  for (const ep of base.episodes) {
    const kept = ep.messages.filter((m) => m.authorId !== id);
    removed += ep.messages.length - kept.length;
    if (!kept.some((m) => m.self)) continue;
    episodes.push(kept.length === ep.messages.length ? ep : withMessages(ep, kept));
  }
  return { value: { episodes, nextId: base.nextId }, removed };
}

/** The live episodes a view may offer: inside `hours` before `now`, not in `excludeChannelId`, and
 * accepted by `audience` (no predicate accepts nothing: the audience is the caller's to give). */
function visibleEpisodes(state, { excludeChannelId, audience, now }, s) {
  const base = normalizeParticipation(state);
  const cutoff = nowOf(now) - s.hours * HOUR_MS;
  const exclude = idOf(excludeChannelId);
  const shows = typeof audience === 'function' ? audience : () => false;
  return base.episodes.filter((ep) => ep.lastOwnAt >= cutoff && ep.channelId !== exclude && shows(ep.channelId));
}

/** A message's readable text for a headline: its text, else its caption, cut at a word boundary. */
function headlineText(message) {
  return clampText(message.text || message.caption || '', HEADLINE_CHARS, { tolerance: 1 });
}

/** All of an episode's lines of one side, in order, each cut per line and the whole cut to `cap`. '' when none. */
function headlineColumn(messages, cap) {
  const parts = messages
    .map((m) => clampText(m.text || m.caption || '', HEADLINE_LINE_CHARS, { tolerance: 1 }))
    .filter(Boolean);
  return clampText(parts.join(HEADLINE_JOIN), cap, { tolerance: 1 });
}

/**
 * One headline per live episode, for the classifier that picks which ones a turn
 * shows, newest `lastOwnAt` first. The current channel (`excludeChannelId`) and
 * every channel `audience(channelId)` refuses are skipped; without an `audience`
 * predicate nothing is offered. `memberLine`: the first line not the persona's
 * (null when there is none), `selfLine`: her first line; each its text (or the
 * caption when the text is empty) cut to 120 characters at a word boundary.
 * `selfLines` / `memberLines`: ALL her lines / all other members' lines of the
 * episode in order, each cut to 90 characters, joined with ' / ' and the whole
 * cut to 320 / 200 characters (all at word boundaries); '' when there are none.
 * No labels, no rendering. Pure.
 * @param {unknown} state
 * @param {{ excludeChannelId?: string|null, audience?: (channelId: string) => boolean, now: number }} view
 * @param {object} [settings]
 * @returns {Array<{ id: string, channelId: string, lastOwnAt: number, ageMs: number,
 *   memberLine: string|null, selfLine: string, memberLines: string, selfLines: string }>}
 */
export function episodeHeadlines(state, { excludeChannelId, audience, now } = {}, settings) {
  const s = settingsOf(settings);
  const clock = nowOf(now);
  return visibleEpisodes(state, { excludeChannelId, audience, now: clock }, s)
    .sort((a, b) => b.lastOwnAt - a.lastOwnAt)
    .map((ep) => {
      const member = ep.messages.find((m) => !m.self);
      const self = ep.messages.find((m) => m.self);
      return {
        id: ep.id,
        channelId: ep.channelId,
        lastOwnAt: ep.lastOwnAt,
        ageMs: clock - ep.lastOwnAt,
        memberLine: member ? headlineText(member) : null,
        selfLine: headlineText(self),
        memberLines: headlineColumn(
          ep.messages.filter((m) => !m.self),
          HEADLINE_MEMBER_CHARS
        ),
        selfLines: headlineColumn(
          ep.messages.filter((m) => m.self),
          HEADLINE_SELF_CHARS
        ),
      };
    });
}

/**
 * The episodes a turn shows: at most `shown`, at most `perChannel` per channel,
 * from the live episodes outside the current channel that `audience` accepts
 * (see `episodeHeadlines`). The `pickedIds` come first in their given order (an
 * unknown, refused or repeated id is ignored, and a pick over its channel's
 * share is passed over), then the newest by `lastOwnAt` fill up to `shown`. The
 * result is grouped by channel, the channel with the newest `lastOwnAt` first,
 * its episodes oldest first. The episodes are normalised copies (see
 * `normalizeParticipation`). Pure.
 * @param {unknown} state
 * @param {{ pickedIds?: string[], excludeChannelId?: string|null,
 *   audience?: (channelId: string) => boolean, now: number }} view
 * @param {object} [settings]
 * @returns {Array<{ channelId: string, episodes: object[] }>}
 */
export function selectEpisodes(state, { pickedIds = [], excludeChannelId, audience, now } = {}, settings) {
  const s = settingsOf(settings);
  const visible = visibleEpisodes(state, { excludeChannelId, audience, now }, s);
  const byId = new Map(visible.map((ep) => [ep.id, ep]));
  const newestFirst = [...visible].sort((a, b) => b.lastOwnAt - a.lastOwnAt);
  const picked = (Array.isArray(pickedIds) ? pickedIds : []).map((id) => byId.get(id)).filter(Boolean);

  const chosen = [];
  const perChannel = new Map();
  for (const ep of [...picked, ...newestFirst]) {
    if (chosen.length >= s.shown) break;
    if (chosen.includes(ep)) continue;
    const count = perChannel.get(ep.channelId) ?? 0;
    if (count >= s.perChannel) continue;
    perChannel.set(ep.channelId, count + 1);
    chosen.push(ep);
  }

  const groups = new Map();
  for (const ep of chosen) {
    if (!groups.has(ep.channelId)) groups.set(ep.channelId, []);
    groups.get(ep.channelId).push(ep);
  }
  return [...groups.entries()]
    .map(([channelId, episodes]) => ({ channelId, episodes: [...episodes].sort((a, b) => a.lastOwnAt - b.lastOwnAt) }))
    .sort((a, b) => b.episodes[b.episodes.length - 1].lastOwnAt - a.episodes[a.episodes.length - 1].lastOwnAt);
}

/**
 * The current channel's stretch the chat window no longer holds: the episodes of
 * `channelId` cut down to their lines older than `before` (the window's first
 * line) and no older than `earlierHours` before `now`; an episode left with no
 * line goes. The `earlierShown` episodes with the newest kept line are returned,
 * oldest first, each with its times recomputed from the kept lines (`lastOwnAt`
 * null when none of hers is left). The result moves only when a stored line
 * crosses `before` or the age bound, never with the clock alone. `[]` with
 * `earlierHours` or `earlierShown` 0, no channel or no finite `before`. Pure.
 * @param {unknown} state
 * @param {{ channelId: string, before: number, now: number }} view
 * @param {object} [settings]
 * @returns {object[]}
 */
export function earlierEpisodes(state, { channelId, before, now } = {}, settings) {
  const s = settingsOf(settings);
  const channel = idOf(channelId);
  const shown = Math.floor(s.earlierShown);
  if (channel === null || !Number.isFinite(before) || s.earlierHours <= 0 || shown <= 0) return [];
  const from = nowOf(now) - s.earlierHours * HOUR_MS;
  const out = [];
  for (const ep of normalizeParticipation(state).episodes) {
    if (ep.channelId !== channel) continue;
    const messages = ep.messages.filter((m) => m.ts < before && m.ts >= from);
    if (messages.length > 0) out.push(withMessages(ep, messages));
  }
  return out
    .sort((a, b) => b.lastAt - a.lastAt)
    .slice(0, shown)
    .sort((a, b) => a.startAt - b.startAt);
}

/** A message's weight against a cut's budget: its text plus its caption, in code points. */
function sizeOf(message) {
  return lengthOf(message.text) + lengthOf(message.caption);
}

/**
 * The messages of one episode that fit `maxChars` (the sum of `text` and
 * `caption` lengths), chronological, never cutting inside a message. When all
 * fit, every message. Otherwise kept in priority, each while it still fits:
 *   1. the persona's lines, each with the message it replies to (`replyTo`);
 *   2. the `keepIds` (lines the caller matched), each with one neighbour on each side;
 *   3. the first 2 and the last 2 messages;
 *   4. the rest, in chronological order.
 * Within a tier the order is chronological. A run of dropped messages becomes
 * one `{ skipped: n }` between kept ones. Pure: the items point at the
 * episode's own messages.
 * @param {{ messages: object[] }} episode
 * @param {{ maxChars: number, keepIds?: string[] }} opts
 * @returns {Array<{ message: object } | { skipped: number }>}
 */
export function cutEpisode(episode, { maxChars, keepIds = [] } = {}) {
  const messages = Array.isArray(episode?.messages) ? [...episode.messages].sort((a, b) => a.ts - b.ts) : [];
  const budget = Number.isFinite(maxChars) && maxChars >= 0 ? maxChars : PARTICIPATION_DEFAULTS.episodeChars;
  const total = messages.reduce((sum, m) => sum + sizeOf(m), 0);
  if (total <= budget) return messages.map((message) => ({ message }));

  const indexOf = new Map(messages.map((m, i) => [m.id, i]));
  const tiers = [[], [], [], []];
  messages.forEach((m, i) => {
    if (!m.self) return;
    if (m.replyTo !== null && indexOf.has(m.replyTo)) tiers[0].push(indexOf.get(m.replyTo));
    tiers[0].push(i);
  });
  const keeping = new Set((Array.isArray(keepIds) ? keepIds : []).map(idOf));
  messages.forEach((m, i) => {
    if (keeping.has(m.id)) tiers[1].push(i - 1, i, i + 1);
  });
  tiers[2].push(...[...Array(CUT_EDGE).keys()], ...[...Array(CUT_EDGE).keys()].map((k) => messages.length - 1 - k));
  tiers[3].push(...messages.keys());

  const kept = new Set();
  let used = 0;
  for (const tier of tiers) {
    const order = [...new Set(tier.filter((i) => i >= 0 && i < messages.length))].sort((a, b) => a - b);
    for (const i of order) {
      if (kept.has(i)) continue;
      const size = sizeOf(messages[i]);
      if (used + size > budget) continue;
      kept.add(i);
      used += size;
    }
  }

  const out = [];
  let skipped = 0;
  messages.forEach((message, i) => {
    if (!kept.has(i)) {
      skipped += 1;
      return;
    }
    if (skipped > 0) out.push({ skipped });
    skipped = 0;
    out.push({ message });
  });
  if (skipped > 0) out.push({ skipped });
  return out;
}
