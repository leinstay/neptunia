// The GIF library the persona builds from the chat: every GIF a member posts
// (a GIF embed -- a `gifv` one of any site, or a tenor/giphy/klipy page, see
// src/media/classify.js#classifyEmbed -- or an attached .gif) is counted deterministically (no
// LLM) into data/guilds/<id>/gifs.json, and the persona can post one back by
// its short handle (`<gif>g12</gif>`, see src/llm/parse.js and
// src/behavior/turn.js). An entry is keyed by the describer's item id of the
// GIF, so its caption is found in the media cache under the same id; its
// handle (`g<n>`, from `nextId`) never changes and is never reused. Rank is
// the shared one of src/memory/ranking.js (as for custom emoji): `count` is
// the weight, `last` (the ts of the latest use) drives the decay. A history
// recount resets every count to 0 and counts again (resetGifCounts), so
// handles survive it; an entry left at 0 ranks below every used one. The
// persona's own posts of a GIF are kept apart (markOwnGif: `ownLast`, the ts
// of its latest post, and `ownUses`), never counted into `count` and never
// reset, so the `<gifs>` list can show it which ones it posted lately.
//
// Shape: `{ nextId, entries: { [key]: { id, kind: 'link'|'attachment', url,
// site?, name?, itemId, messageId, channelId, count, last, firstSeen,
// ownLast?, ownUses? } }, backfill }`. `messageId`/`channelId` point at the latest message carrying
// the GIF, so the poster can re-fetch an attachment's fresh CDN URL (Discord
// attachment URLs expire).

import { isPlainObject } from '../config.js';
import { DISCORD_CDN_SITES, mediaParts, siteOf } from '../media/classify.js';
import { sortByRank } from './ranking.js';

/**
 * The library options from `gifs`, read by the caller at the moment of use: `storeMax` (300)
 * and `halfLifeDays` (30), config.json's values when a key is missing. Shared by the
 * analyzer (src/memory/update.js, recording on arrival) and the history backfill.
 * @param {object} config  Live config.
 * @returns {{ storeMax: number, halfLifeDays: number }}
 */
export function gifOpts(config) {
  const gifCfg = config?.gifs ?? {};
  return { storeMax: gifCfg.storeMax ?? 300, halfLifeDays: gifCfg.halfLifeDays ?? 30 };
}

const KINDS = new Set(['link', 'attachment']);
const HANDLE_RE = /^g(\d+)$/;

function str(value) {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

/**
 * A stored history-backfill stamp made safe to read -- the GIF library's `backfill` and the
 * guild's `emojiBackfill` (src/memory/store.js) alike: `{ at, channels, messages }` with `at` a
 * non-empty string and the counts non-negative integers (floored, a bad one becomes 0); anything
 * without a string `at` becomes null (never backfilled).
 * @param {unknown} value
 * @returns {{ at: string, channels: number, messages: number }|null}
 */
export function normalizeBackfillStamp(value) {
  if (!isPlainObject(value) || typeof value.at !== 'string' || !value.at) return null;
  const count = (n) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
  return { at: value.at, channels: count(value.channels), messages: count(value.messages) };
}

/** An empty library. */
export function emptyGifs() {
  return { nextId: 1, entries: {}, backfill: null };
}

/**
 * A stored gifs.json value made safe to read. Anything but a plain object
 * becomes the empty library. An entry without a known `kind`, a non-empty
 * `url` or a finite `count` of at least 0 is dropped (count 0 is a reset
 * entry, see resetGifCounts); `last`/`firstSeen` default to 0 /
 * `last`; `itemId` defaults to the key; optional `site`/`name` are kept only
 * as strings, optional `ownLast` only as a positive finite number and `ownUses`
 * only as a count of at least 1 (floored). A missing, malformed or duplicate handle gets a fresh one;
 * `nextId` always ends above every handle in use. Never mutates `value`.
 * @param {unknown} value
 * @returns {{ nextId: number, entries: Record<string, object>, backfill: object|null }}
 */
export function normalizeGifs(value) {
  const src = isPlainObject(value) ? value : {};
  const raw = isPlainObject(src.entries) ? src.entries : {};
  const kept = [];
  let maxHandle = 0;
  for (const [key, entry] of Object.entries(raw)) {
    if (!key || !isPlainObject(entry) || !KINDS.has(entry.kind)) continue;
    if (typeof entry.url !== 'string' || !entry.url) continue;
    if (!Number.isFinite(entry.count)) continue;
    const count = Math.floor(entry.count);
    if (count < 0) continue;
    const last = Number.isFinite(entry.last) ? entry.last : 0;
    const out = {
      id: typeof entry.id === 'string' ? entry.id : '',
      kind: entry.kind,
      url: entry.url,
      ...(typeof entry.site === 'string' && entry.site ? { site: entry.site } : {}),
      ...(typeof entry.name === 'string' && entry.name ? { name: entry.name } : {}),
      itemId: typeof entry.itemId === 'string' && entry.itemId ? entry.itemId : key,
      messageId: str(entry.messageId),
      channelId: str(entry.channelId),
      count,
      last,
      firstSeen: Number.isFinite(entry.firstSeen) ? entry.firstSeen : last,
      ...(Number.isFinite(entry.ownLast) && entry.ownLast > 0 ? { ownLast: entry.ownLast } : {}),
      ...(Number.isFinite(entry.ownUses) && entry.ownUses >= 1 ? { ownUses: Math.floor(entry.ownUses) } : {}),
    };
    const match = HANDLE_RE.exec(out.id);
    if (match) maxHandle = Math.max(maxHandle, Number(match[1]));
    kept.push([key, out]);
  }
  let nextId = Number.isInteger(src.nextId) && src.nextId > maxHandle ? src.nextId : maxHandle + 1;
  const used = new Set();
  const entries = {};
  for (const [key, entry] of kept) {
    if (!HANDLE_RE.test(entry.id) || used.has(entry.id)) {
      entry.id = `g${nextId}`;
      nextId += 1;
    }
    used.add(entry.id);
    entries[key] = entry;
  }
  return { nextId, entries, backfill: normalizeBackfillStamp(src.backfill) };
}

/**
 * The GIFs of one normalized message (see interfaces/discord/collect.js), the
 * message's own first, then each forwarded snapshot's: every attachment of
 * kind `gif` (`key` = its Discord id) and every embed link of kind `gif`
 * (see src/media/classify.js#classifyEmbed; `key` = its item id,
 * `url` = the page link Discord embeds again when posted). Items without an
 * id or a URL are skipped, and so is a gif embed of a Discord CDN link (its
 * signed URL expires, so it could not be posted back). Every item carries the OUTER message's id and
 * channel, like src/media/classify.js#collectPictures.
 * @param {object} message
 * @returns {{ key: string, kind: 'link'|'attachment', url: string, site?: string, name?: string,
 *   itemId: string, messageId: string, channelId: string }[]}
 */
export function collectGifItems(message) {
  if (!message) return [];
  const messageId = str(message.id);
  const channelId = str(message.channelId);
  const items = [];
  for (const part of mediaParts(message)) {
    if (!part) continue;
    for (const attachment of Array.isArray(part.attachments) ? part.attachments : []) {
      if (attachment?.kind !== 'gif' || attachment.id == null || typeof attachment.url !== 'string' || !attachment.url) continue;
      const key = String(attachment.id);
      items.push({
        key,
        kind: 'attachment',
        url: attachment.url,
        ...(attachment.name ? { name: String(attachment.name) } : {}),
        itemId: key,
        messageId,
        channelId,
      });
    }
    for (const link of Array.isArray(part.links) ? part.links : []) {
      if (link?.kind !== 'gif' || link.id == null || typeof link.url !== 'string' || !link.url) continue;
      // A Discord CDN link's signed URL expires: posted back later it would not embed.
      if (DISCORD_CDN_SITES.includes(siteOf(link.url))) continue;
      const key = String(link.id);
      items.push({
        key,
        kind: 'link',
        url: link.url,
        ...(link.site ? { site: String(link.site) } : {}),
        ...(link.title ? { name: String(link.title) } : {}),
        itemId: key,
        messageId,
        channelId,
      });
    }
  }
  return items;
}

/**
 * `gifs` with every entry's `count` set to 0 -- keys, handles, `last`,
 * `firstSeen`, the message pointer, `nextId` and the backfill stamp kept.
 * The GIF history backfill recounts from here, so a GIF seen again keeps its
 * handle (see mergeGifs) and one no longer in the history stays, ranked
 * lowest, until storeMax evicts it. Never mutates `gifs`.
 * @param {unknown} gifs  A stored library (normalised here).
 * @returns {{ nextId: number, entries: Record<string, object>, backfill: object|null }}
 */
export function resetGifCounts(gifs) {
  const next = normalizeGifs(gifs);
  for (const entry of Object.values(next.entries)) entry.count = 0;
  return next;
}

/**
 * `gifs` with the persona's own post of the entry under `key` recorded:
 * `ownLast` set to `ts`, `ownUses` one higher. The members' `count`/`last`
 * are not touched. `marked` is false (and the library unchanged) when `key`
 * is not in it. Never mutates `gifs`.
 * @param {unknown} gifs  A stored library (normalised here).
 * @param {string} key    The entry's library key (findGif's `key`).
 * @param {number} ts     When the persona posted it (epoch ms).
 * @returns {{ gifs: { nextId: number, entries: Record<string, object>, backfill: object|null }, marked: boolean }}
 */
export function markOwnGif(gifs, key, ts) {
  const next = normalizeGifs(gifs);
  const entry = typeof key === 'string' ? next.entries[key] : undefined;
  if (!entry || !Number.isFinite(ts)) return { gifs: next, marked: false };
  next.entries[key] = { ...entry, ownLast: ts, ownUses: (entry.ownUses ?? 0) + 1 };
  return { gifs: next, marked: true };
}

/**
 * The library's entries as `[{ key, ...entry }]`, best first (see
 * src/memory/ranking.js#sortByRank: `count` is the weight, `last` the date;
 * `halfLifeDays` not a positive number -> count alone). Every entry with a
 * positive count comes before every entry at count 0 (a reset one not seen
 * again), whatever their dates; each group is ordered by sortByRank.
 * @param {unknown} gifs  A stored library (normalised here).
 * @param {number} [halfLifeDays]
 * @returns {object[]}
 */
export function rankGifs(gifs, halfLifeDays) {
  const items = Object.entries(normalizeGifs(gifs).entries).map(([key, entry]) => ({
    key,
    ...entry,
    weight: entry.count,
    lastSeen: entry.last > 0 ? new Date(entry.last).toISOString() : null,
  }));
  const used = sortByRank(items.filter((item) => item.count > 0), halfLifeDays);
  const unused = sortByRank(items.filter((item) => item.count <= 0), halfLifeDays);
  return [...used, ...unused].map(({ weight, lastSeen, ...entry }) => entry);
}

/**
 * The entry whose handle is `handle` (`g12`), as `{ key, ...entry }`, or null.
 * @param {unknown} gifs  A stored library (normalised here).
 * @param {string} handle
 * @returns {object|null}
 */
export function findGif(gifs, handle) {
  const wanted = str(handle).trim().toLowerCase();
  if (!HANDLE_RE.test(wanted)) return null;
  for (const [key, entry] of Object.entries(normalizeGifs(gifs).entries)) {
    if (entry.id === wanted) return { key, ...entry };
  }
  return null;
}

/**
 * The library key a GIF item counts on, or null when the library does not
 * know it: its own key first, then -- for a link GIF only -- the key of the
 * entry holding the same URL (the same tenor/giphy link reposted gets a new
 * per-message embed id, but the first entry keeps counting). The one
 * matching rule of the library, shared by mergeGifs and the transcript's
 * handles (see gifHandleMap).
 * @param {{ key: string, kind: 'link'|'attachment', url?: string }} item
 * @param {(key: string) => boolean} hasKey
 * @param {(url: string) => (string|null|undefined)} keyByUrl
 * @returns {string|null}
 */
export function matchGifKey(item, hasKey, keyByUrl) {
  if (!item) return null;
  if (hasKey(item.key)) return item.key;
  if (item.kind === 'link' && item.url) {
    const key = keyByUrl(item.url);
    if (key != null) return key;
  }
  return null;
}

/**
 * The library's handles for the transcript: every entry's key -> its handle
 * (`g12`), and a link entry's URL -> the same handle, so gifHandleOf can
 * apply matchGifKey's rule to a GIF seen in a message. Keys and URLs never
 * collide (a URL carries `://`).
 * @param {unknown} gifs  A stored library (normalised here).
 * @returns {Map<string, string>}
 */
export function gifHandleMap(gifs) {
  const { entries } = normalizeGifs(gifs);
  const handles = new Map();
  for (const [key, entry] of Object.entries(entries)) handles.set(key, entry.id);
  for (const entry of Object.values(entries)) {
    if (entry.kind === 'link' && !handles.has(entry.url)) handles.set(entry.url, entry.id);
  }
  return handles;
}

/**
 * The handle of a GIF seen in a message (a normalized attachment or embed
 * link of kind `gif`), by matchGifKey's rule over `handles` (gifHandleMap),
 * or null.
 * @param {Map<string, string>|null|undefined} handles
 * @param {{ id?: string, url?: string|null }} item
 * @param {'link'|'attachment'} kind
 * @returns {string|null}
 */
export function gifHandleOf(handles, item, kind) {
  if (!(handles instanceof Map) || handles.size === 0 || !item || item.id == null) return null;
  const key = matchGifKey(
    { key: String(item.id), kind, url: typeof item.url === 'string' ? item.url : '' },
    (k) => handles.has(k) && !k.includes('://'),
    (url) => (handles.has(url) ? url : null),
  );
  return key == null ? null : handles.get(key);
}

/**
 * `gifs` with the members' GIFs of `messages` added: the persona's own
 * messages and other bots' are skipped; one count per GIF per message. A GIF
 * is matched by its key, a link GIF also by its URL (the same tenor/giphy
 * link reposted gets a new per-message embed id, but it is the same GIF: the
 * first entry, whose key a caption may already be cached under, keeps
 * counting). A new GIF gets the next handle; a known one -- a reset entry at
 * count 0 included (see resetGifCounts) -- keeps its handle. The latest use
 * moves `last`, `messageId`, `channelId` and `url`. Past `storeMax` entries
 * the lowest-ranked (rankGifs: count-0 entries first) are evicted (`storeMax`
 * not a non-negative integer -> no cap); an evicted handle is never reused.
 * Never mutates `gifs`.
 * @param {unknown} gifs
 * @param {object[]} messages  Normalized messages (URLs present); `self`/`bot`/`ts` read.
 * @param {{ storeMax?: number, halfLifeDays?: number }} [opts]
 * @returns {{ gifs: object, counted: number }}
 */
export function mergeGifs(gifs, messages, { storeMax, halfLifeDays } = {}) {
  const next = normalizeGifs(gifs);
  const byUrl = new Map();
  for (const [key, entry] of Object.entries(next.entries)) {
    if (entry.kind === 'link') byUrl.set(entry.url, key);
  }
  let counted = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || message.self || message.bot) continue;
    const ts = Number.isFinite(message.ts) ? message.ts : 0;
    const seen = new Set();
    for (const item of collectGifItems(message)) {
      const key =
        matchGifKey(
          item,
          (k) => Boolean(next.entries[k]),
          (url) => byUrl.get(url),
        ) ?? item.key;
      if (seen.has(key)) continue;
      seen.add(key);
      const before = next.entries[key];
      const newer = !before || ts >= before.last;
      const { key: _itemKey, ...fresh } = item;
      const entry = before
        ? {
            ...before,
            ...(newer ? { url: item.url, messageId: item.messageId, channelId: item.channelId } : {}),
            count: before.count + 1,
            last: newer ? ts : before.last,
            firstSeen: Math.min(before.firstSeen, ts),
          }
        : { id: `g${next.nextId}`, ...fresh, count: 1, last: ts, firstSeen: ts };
      if (!before) next.nextId += 1;
      // Re-inserted so a just-used GIF sits last: an exact rank tie keeps it (see sortByRank).
      delete next.entries[key];
      next.entries[key] = entry;
      if (entry.kind === 'link') byUrl.set(entry.url, key);
      counted += 1;
    }
  }
  const keys = Object.keys(next.entries);
  if (Number.isInteger(storeMax) && storeMax >= 0 && keys.length > storeMax) {
    const kept = new Set(rankGifs(next, halfLifeDays).slice(0, storeMax).map((entry) => entry.key));
    for (const key of keys) if (!kept.has(key)) delete next.entries[key];
  }
  return { gifs: next, counted };
}
