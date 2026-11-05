// The GIF library the persona builds from the chat: every GIF a member posts
// (a GIF embed -- a `gifv` one of any site, or a tenor/giphy/klipy page, see
// src/media/classify.ts#classifyEmbed -- or an attached .gif) is counted deterministically (no
// LLM) into data/places/<id>/gifs.json, and the persona can post one back by
// its short handle (`<gif>g12</gif>`, see src/llm/parse.ts and
// src/behavior/turn.js). An entry is keyed by the describer's item id of the
// GIF, so its caption is found in the media cache under the same id; its
// handle (`g<n>`, from `nextId`) never changes and is never reused. Rank is
// the shared one of src/memory/ranking.ts (as for custom emoji): `count` is
// the weight, `last` (the ts of the latest use) drives the decay. A history
// recount resets every count to 0 and counts again (resetGifCounts), so
// handles survive it; an entry left at 0 ranks below every used one. The
// persona's own posts of a GIF are kept apart (markOwnGif: `ownLast`, the ts
// of its latest post, and `ownUses`), never counted into `count` and never
// reset, so the `<gifs>` list can show it which ones it posted lately.
//
// Shape: `{ nextId, entries: { [key]: { id, kind: 'link'|'attachment', url,
// site?, name?, itemId, messageId, placeId, count, last, firstSeen,
// ownLast?, ownUses? } }, backfill }`. `messageId`/`placeId` point at the latest message carrying
// the GIF, so the poster can re-fetch an attachment's fresh URL (an
// attachment's address may expire).

import { isRecord, isFiniteNumber, isIntegerNumber } from './types.ts';
import { mediaParts } from '../media/classify.ts';
import { sortRanked } from './ranking.ts';
import type { StoredRecord, Untyped } from './types.ts';

// Production values, config cut of 2026-10-31.
/** The GIFs the library keeps. */
export const GIF_STORE_MAX = 300;
/** The half-life in days of a GIF's use in its rank. */
export const GIF_HALF_LIFE_DAYS = 30;

/**
 * The library options: `storeMax` and `halfLifeDays`. Shared by the live observer (src/memory/update.ts, recording
 * on arrival) and the history backfill.
 */
export function gifOpts(): { storeMax: number; halfLifeDays: number } {
  return { storeMax: GIF_STORE_MAX, halfLifeDays: GIF_HALF_LIFE_DAYS };
}

const KINDS = new Set(['link', 'attachment']);
const HANDLE_RE = /^g(\d+)$/;

function str(value: Untyped) {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

/**
 * A stored history-backfill stamp made safe to read -- the GIF library's `backfill` and the
 * place's `emojiBackfill` (src/memory/store.ts) alike: `{ at, channels, messages }` with `at` a
 * non-empty string and the counts non-negative integers (floored, a bad one becomes 0); anything
 * without a string `at` becomes null (never backfilled).
 */
export function normalizeBackfillStamp(value: unknown): { at: string; channels: number; messages: number } | null {
  if (!isRecord(value) || typeof value.at !== 'string' || !value.at) return null;
  const count = (n: number) => (isFiniteNumber(n) && n > 0 ? Math.floor(n) : 0);
  return { at: value.at, channels: count(value.channels), messages: count(value.messages) };
}

/** An empty library. */
export function emptyGifs(): { nextId: number; entries: Record<string, GifEntry>; backfill: object | null } {
  return { nextId: 1, entries: {}, backfill: null };
}

/** One GIF of the library, as `gifs.json` keeps it. */
export type GifEntry = {
  id: string;
  kind: 'link' | 'attachment';
  url: string;
  site?: string;
  name?: string;
  itemId: string;
  messageId: string;
  placeId: string;
  count: number;
  last: number;
  firstSeen: number;
  ownLast?: number;
  ownUses?: number;
};

/**
 * A stored gifs.json value made safe to read. Anything but a plain object
 * becomes the empty library. An entry without a known `kind`, a non-empty
 * `url` or a finite `count` of at least 0 is dropped (count 0 is a reset
 * entry, see resetGifCounts); `last`/`firstSeen` default to 0 /
 * `last`; `itemId` defaults to the key; optional `site`/`name` are kept only
 * as strings, optional `ownLast` only as a positive finite number and `ownUses`
 * only as a count of at least 1 (floored). A missing, malformed or duplicate handle gets a fresh one;
 * `nextId` always ends above every handle in use. Never mutates `value`.
 */
export function normalizeGifs(value: unknown): {
  nextId: number;
  entries: Record<string, GifEntry>;
  backfill: object | null;
} {
  const src = isRecord(value) ? value : {};
  const raw = isRecord(src.entries) ? src.entries : {};
  const kept: Array<[string, GifEntry]> = [];
  let maxHandle = 0;
  for (const [key, entry] of Object.entries(raw)) {
    if (!key || !isRecord(entry) || !KINDS.has(entry.kind)) continue;
    if (typeof entry.url !== 'string' || !entry.url) continue;
    if (!isFiniteNumber(entry.count)) continue;
    const count = Math.floor(entry.count);
    if (count < 0) continue;
    const last = isFiniteNumber(entry.last) ? entry.last : 0;
    const out: GifEntry = {
      id: typeof entry.id === 'string' ? entry.id : '',
      kind: entry.kind,
      url: entry.url,
      ...(typeof entry.site === 'string' && entry.site ? { site: entry.site } : {}),
      ...(typeof entry.name === 'string' && entry.name ? { name: entry.name } : {}),
      itemId: typeof entry.itemId === 'string' && entry.itemId ? entry.itemId : key,
      messageId: str(entry.messageId),
      placeId: str(entry.placeId),
      count,
      last,
      firstSeen: isFiniteNumber(entry.firstSeen) ? entry.firstSeen : last,
      ...(isFiniteNumber(entry.ownLast) && entry.ownLast > 0 ? { ownLast: entry.ownLast } : {}),
      ...(isFiniteNumber(entry.ownUses) && entry.ownUses >= 1 ? { ownUses: Math.floor(entry.ownUses) } : {}),
    };
    const match = HANDLE_RE.exec(out.id);
    if (match) maxHandle = Math.max(maxHandle, Number(match[1]));
    kept.push([key, out]);
  }
  let nextId = isIntegerNumber(src.nextId) && src.nextId > maxHandle ? src.nextId : maxHandle + 1;
  const used = new Set<string>();
  const entries: Record<string, GifEntry> = {};
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
 * The GIFs of one normalized message (src/protocol/events.ts#Message), the
 * message's own first, then each forwarded snapshot's: every attachment of
 * kind `gif` (`key` = its platform id) and every embed link of kind `gif`
 * (`key` = its item id,
 * `url` = the page link the platform embeds again when posted). Items without an
 * id or a URL are skipped, and so is a gif embed of an expiring link (its
 * signed URL lapses, so it could not be posted back). Every item carries the OUTER message's id and
 * channel, like src/media/classify.ts#collectPictures.
 */
export function collectGifItems(message: StoredRecord): Array<{
  key: string;
  kind: 'link' | 'attachment';
  url: string;
  site?: string;
  name?: string;
  itemId: string;
  messageId: string;
  placeId: string;
}> {
  if (!message) return [];
  const messageId = str(message.id);
  const placeId = str(message.placeId);
  const items: ReturnType<typeof collectGifItems> = [];
  const parts: Array<Untyped> = mediaParts(message);
  for (const part of parts) {
    if (!part) continue;
    for (const attachment of Array.isArray(part.attachments) ? part.attachments : []) {
      if (attachment?.kind !== 'gif' || attachment.id == null || typeof attachment.url !== 'string' || !attachment.url)
        continue;
      const key = String(attachment.id);
      items.push({
        key,
        kind: 'attachment',
        url: attachment.url,
        ...(attachment.name ? { name: String(attachment.name) } : {}),
        itemId: key,
        messageId,
        placeId,
      });
    }
    for (const link of Array.isArray(part.links) ? part.links : []) {
      if (link?.kind !== 'gif' || link.id == null || typeof link.url !== 'string' || !link.url) continue;
      // A link the interface marked expiring (a signed address) stops working: posted back later it would not embed.
      if (link.expiring === true) continue;
      const key = String(link.id);
      items.push({
        key,
        kind: 'link',
        url: link.url,
        ...(link.site ? { site: String(link.site) } : {}),
        ...(link.title ? { name: String(link.title) } : {}),
        itemId: key,
        messageId,
        placeId,
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
 * @param gifs  A stored library (normalised here).
 */
export function resetGifCounts(gifs: unknown): {
  nextId: number;
  entries: Record<string, GifEntry>;
  backfill: object | null;
} {
  const next = normalizeGifs(gifs);
  for (const entry of Object.values(next.entries)) entry.count = 0;
  return next;
}

/**
 * `gifs` with the persona's own post of the entry under `key` recorded:
 * `ownLast` set to `ts`, `ownUses` one higher. The members' `count`/`last`
 * are not touched. `marked` is false (and the library unchanged) when `key`
 * is not in it. Never mutates `gifs`.
 * @param gifs  A stored library (normalised here).
 * @param key    The entry's library key (findGif's `key`).
 * @param ts     When the persona posted it (epoch ms).
 */
export function markOwnGif(
  gifs: unknown,
  key: string,
  ts: number
): { gifs: { nextId: number; entries: Record<string, GifEntry>; backfill: object | null }; marked: boolean } {
  const next = normalizeGifs(gifs);
  const entry = typeof key === 'string' ? next.entries[key] : undefined;
  if (!entry || !isFiniteNumber(ts)) return { gifs: next, marked: false };
  next.entries[key] = { ...entry, ownLast: ts, ownUses: (entry.ownUses ?? 0) + 1 };
  return { gifs: next, marked: true };
}

/**
 * The library's entries as `[{ key, ...entry }]`, best first (see
 * src/memory/ranking.ts#sortByRank: `count` is the weight, `last` the date;
 * `halfLifeDays` not a positive number -> count alone). Every entry with a
 * positive count comes before every entry at count 0 (a reset one not seen
 * again), whatever their dates; each group is ordered by sortByRank.
 * @param gifs  A stored library (normalised here).
 */
export function rankGifs(gifs: unknown, halfLifeDays?: number): Array<GifEntry & { key: string }> {
  const items = Object.entries(normalizeGifs(gifs).entries).map(([key, entry]) => ({
    key,
    ...entry,
    weight: entry.count,
    lastSeen: entry.last > 0 ? new Date(entry.last).toISOString() : null,
  }));
  const used = sortRanked(
    items.filter((item) => item.count > 0),
    halfLifeDays
  );
  const unused = sortRanked(
    items.filter((item) => item.count <= 0),
    halfLifeDays
  );
  return [...used, ...unused].map(({ weight, lastSeen, ...entry }) => entry);
}

/**
 * The entry whose handle is `handle` (`g12`), as `{ key, ...entry }`, or null.
 * @param gifs  A stored library (normalised here).
 */
export function findGif(gifs: unknown, handle: string): object | null {
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
 */
export function matchGifKey(
  item: { key: string; kind: 'link' | 'attachment'; url?: string },
  hasKey: (key: string) => boolean,
  keyByUrl: (url: string) => string | null | undefined
): string | null {
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
 * @param gifs  A stored library (normalised here).
 */
export function gifHandleMap(gifs: unknown): Map<string, string> {
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
 */
export function gifHandleOf(
  handles: Map<string, string> | null | undefined,
  item: { id?: string; url?: string | null },
  kind: 'link' | 'attachment'
): string | null {
  if (!(handles instanceof Map) || handles.size === 0 || !item || item.id == null) return null;
  const key = matchGifKey(
    { key: String(item.id), kind, url: typeof item.url === 'string' ? item.url : '' },
    (k) => handles.has(k) && !k.includes('://'),
    (url) => (handles.has(url) ? url : null)
  );
  return key == null ? null : (handles.get(key) ?? null);
}

/**
 * `gifs` with the members' GIFs of `messages` added: the persona's own
 * messages and other bots' are skipped; one count per GIF per message. A GIF
 * is matched by its key, a link GIF also by its URL (the same tenor/giphy
 * link reposted gets a new per-message embed id, but it is the same GIF: the
 * first entry, whose key a caption may already be cached under, keeps
 * counting). A new GIF gets the next handle; a known one -- a reset entry at
 * count 0 included (see resetGifCounts) -- keeps its handle. The latest use
 * moves `last`, `messageId`, `placeId` and `url`. Past `storeMax` entries
 * the lowest-ranked (rankGifs: count-0 entries first) are evicted (`storeMax`
 * not a non-negative integer -> no cap); an evicted handle is never reused.
 * Never mutates `gifs`.
 * @param messages  Normalized messages (URLs present); `self`/`bot`/`ts` read.
 */
export function mergeGifs(
  gifs: unknown,
  messages: Array<StoredRecord>,
  { storeMax, halfLifeDays }: { storeMax?: number; halfLifeDays?: number } = {}
): { gifs: object; counted: number } {
  const next = normalizeGifs(gifs);
  const byUrl = new Map();
  for (const [key, entry] of Object.entries(next.entries)) {
    if (entry.kind === 'link') byUrl.set(entry.url, key);
  }
  let counted = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || message.self || message.bot) continue;
    const ts = isFiniteNumber(message.ts) ? message.ts : 0;
    const seen = new Set();
    for (const item of collectGifItems(message)) {
      const key =
        matchGifKey(
          item,
          (k) => Boolean(next.entries[k]),
          (url) => byUrl.get(url)
        ) ?? item.key;
      if (seen.has(key)) continue;
      seen.add(key);
      const before = next.entries[key];
      const newer = !before || ts >= before.last;
      const { key: _itemKey, ...fresh } = item;
      const entry = before
        ? {
            ...before,
            ...(newer ? { url: item.url, messageId: item.messageId, placeId: item.placeId } : {}),
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
  if (isIntegerNumber(storeMax) && storeMax >= 0 && keys.length > storeMax) {
    const kept = new Set(
      rankGifs(next, halfLifeDays)
        .slice(0, storeMax)
        .map((entry) => entry.key)
    );
    for (const key of keys) if (!kept.has(key)) delete next.entries[key];
  }
  return { gifs: next, counted };
}
