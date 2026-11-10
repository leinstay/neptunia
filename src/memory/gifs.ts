// The one GIF library of the persona, shared across places and interfaces: every GIF a member posts (a GIF embed -- a
// `gifv` one of any site, or a tenor/giphy/klipy page, see src/media/classify.ts#classifyEmbed -- or an attached .gif) is
// counted deterministically (no LLM) into one library of the persona (src/memory/store-gifs.ts), and the media pick
// (src/behavior/media-pick.ts) may post one by its handle. An entry is keyed by the content hash of its file once the
// file is cached (withGifFile; before that by the first item id it was seen under), and keeps every native id and link
// it was seen under, so the same GIF under a new id or link stays one entry. Its handle (`g<n>`, from `nextId`) never
// changes and is never reused. Counters are per place, the place the message was in (`places`), and the global count is
// their sum. Rank is the shared one of src/memory/ranking.ts (as for custom emoji): `count` is the weight, `last` (the ts
// of the latest use) drives the decay. A history recount of one place sets that place's counter to 0 and counts again
// (resetGifCounts), so handles survive it; an entry left at 0 everywhere ranks below every used one. The persona's own
// posts are kept apart (markOwnGif: `ownLast`, `ownUses`, per place and in total), never counted into `count` and never
// reset. `caption` is the describer's text, which the candidate search (searchGifs) reads with its vector, kept apart;
// `file` is the cached file under the data folder (src/media/gif-files.ts), because an attachment's link expires.
//
// Shape: `{ nextId, entries: { [key]: GifEntry }, backfill, backfills }`. `messageId`/`placeId` point at the latest
// message carrying the GIF, so the poster can re-fetch an attachment's fresh URL. `backfills` holds the history
// backfill's stamp per place that was read, and `backfill` the newest of them.

import { isRecord, isFiniteNumber, isIntegerNumber } from './types.ts';
import { mediaParts } from '../media/classify.ts';
import { sortRanked } from './ranking.ts';
import type { StoredRecord, Untyped } from './types.ts';

/** A library entry's own kind: posted as a file, as against a link. */
const ATTACHED = 'attachment';

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

/** A stamp of the history backfill, once normalized. */
export type BackfillStamp = { at: string; channels: number; messages: number };

/** One GIF's counters in one place. */
export type GifPlace = { count: number; last: number; ownLast?: number; ownUses?: number };

/** One GIF of the library. */
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
  nativeIds: Array<string>;
  links: Array<string>;
  places: Record<string, GifPlace>;
  hash?: string;
  file?: string;
  caption?: string;
  vector?: Array<number>;
};

/** The library. */
export type GifLibrary = {
  nextId: number;
  entries: Record<string, GifEntry>;
  backfill: BackfillStamp | null;
  backfills: Record<string, BackfillStamp>;
};

/** An empty library. */
export function emptyGifs(): GifLibrary {
  return { nextId: 1, entries: {}, backfill: null, backfills: {} };
}

/** A stored per-place counter made safe to read, or null when its count is no number of at least 0. */
function normalizePlace(value: unknown): GifPlace | null {
  if (!isRecord(value) || !isFiniteNumber(value.count) || value.count < 0) return null;
  return {
    count: Math.floor(value.count),
    last: isFiniteNumber(value.last) ? value.last : 0,
    ...(isFiniteNumber(value.ownLast) && value.ownLast > 0 ? { ownLast: value.ownLast } : {}),
    ...(isFiniteNumber(value.ownUses) && value.ownUses >= 1 ? { ownUses: Math.floor(value.ownUses) } : {}),
  };
}

/** The strings of `value` without blanks and repeats, in order; `fallback` when it holds none. */
function stringList(value: unknown, fallback: Array<string>): Array<string> {
  const list = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item !== '')
    : [];
  return list.length > 0 ? [...new Set(list)] : fallback;
}

/** The totals of an entry that are the sum over its places: its count, its own uses and its latest own post. */
function withTotals(entry: GifEntry): GifEntry {
  const places = Object.values(entry.places);
  if (places.length === 0) return entry;
  const ownLast = Math.max(0, ...places.map((place) => place.ownLast ?? 0));
  const ownUses = places.reduce((sum, place) => sum + (place.ownUses ?? 0), 0);
  return {
    ...entry,
    count: places.reduce((sum, place) => sum + place.count, 0),
    ...(ownLast > 0 ? { ownLast } : {}),
    ...(ownUses > 0 ? { ownUses } : {}),
  };
}

/** The optional fields of a stored entry that hold a usable value. */
function optionalFields(entry: Record<string, unknown>): Partial<GifEntry> {
  const out: Partial<GifEntry> = {};
  for (const field of ['site', 'name', 'hash', 'file'] as const) {
    const value = entry[field];
    if (typeof value === 'string' && value) out[field] = value;
  }
  if (typeof entry.caption === 'string' && entry.caption.trim()) out.caption = entry.caption;
  if (isVector(entry.vector)) out.vector = entry.vector;
  if (isFiniteNumber(entry.ownLast) && entry.ownLast > 0) out.ownLast = entry.ownLast;
  if (isFiniteNumber(entry.ownUses) && entry.ownUses >= 1) out.ownUses = Math.floor(entry.ownUses);
  return out;
}

/** The per-place counters of a stored entry that hold a usable count. */
function storedPlaces(value: unknown): Record<string, GifPlace> {
  const places: Record<string, GifPlace> = {};
  for (const [place, given] of Object.entries(isRecord(value) ? value : {})) {
    const counter = normalizePlace(given);
    if (counter) places[place] = counter;
  }
  return places;
}

/** One stored entry made safe to read, or null when it cannot be kept. */
function normalizeEntry(key: string, entry: unknown): GifEntry | null {
  if (!key || !isRecord(entry) || !KINDS.has(entry.kind)) return null;
  if (typeof entry.url !== 'string' || !entry.url) return null;
  if (!isFiniteNumber(entry.count) || entry.count < 0) return null;
  const last = isFiniteNumber(entry.last) ? entry.last : 0;
  const itemId = typeof entry.itemId === 'string' && entry.itemId ? entry.itemId : key;
  return withTotals({
    id: typeof entry.id === 'string' ? entry.id : '',
    kind: entry.kind,
    url: entry.url,
    itemId,
    messageId: str(entry.messageId),
    placeId: str(entry.placeId),
    count: Math.floor(entry.count),
    last,
    firstSeen: isFiniteNumber(entry.firstSeen) ? entry.firstSeen : last,
    nativeIds: stringList(entry.nativeIds, [itemId]),
    links: stringList(entry.links, entry.kind === 'link' ? [entry.url] : []),
    places: storedPlaces(entry.places),
    ...optionalFields(entry),
  });
}

/** A non-empty list of finite numbers. */
function isVector(value: unknown): value is Array<number> {
  return Array.isArray(value) && value.length > 0 && value.every((item) => isFiniteNumber(item));
}

/**
 * A stored library value made safe to read. Anything but a plain object becomes the empty library. An entry without a
 * known `kind`, a non-empty `url` or a finite `count` of at least 0 is dropped (count 0 is a reset entry, see
 * resetGifCounts); a per-place counter that is no number of at least 0 is dropped too, and with any counter left the
 * totals are their sum. `last`/`firstSeen` default to 0 / `last`; `itemId` defaults to the key, `nativeIds` to the
 * `itemId` and a link entry's `links` to its `url`. A missing, malformed or duplicate handle gets a fresh one; `nextId`
 * always ends above every handle in use. Never mutates `value`.
 */
export function normalizeGifs(value: unknown): GifLibrary {
  const src = isRecord(value) ? value : {};
  const raw = isRecord(src.entries) ? src.entries : {};
  const kept: Array<[string, GifEntry]> = [];
  let maxHandle = 0;
  for (const [key, given] of Object.entries(raw)) {
    const entry = normalizeEntry(key, given);
    if (!entry) continue;
    const match = HANDLE_RE.exec(entry.id);
    if (match) maxHandle = Math.max(maxHandle, Number(match[1]));
    kept.push([key, entry]);
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
  const backfills: Record<string, BackfillStamp> = {};
  for (const [place, stamp] of Object.entries(isRecord(src.backfills) ? src.backfills : {})) {
    const read = normalizeBackfillStamp(stamp);
    if (read) backfills[place] = read;
  }
  return { nextId, entries, backfill: normalizeBackfillStamp(src.backfill), backfills };
}

/** The item ids of a library's entries: the keys of their captions in the describer's cache. */
export function gifItemIds(gifs: unknown): Array<string> {
  return Object.values(normalizeGifs(gifs).entries).map((entry) => entry.itemId);
}

/** `gifs` with this place's history backfill stamped. Never mutates `gifs`. */
export function stampGifBackfill(gifs: unknown, placeId: string, stamp: BackfillStamp): GifLibrary {
  const next = normalizeGifs(gifs);
  const read = normalizeBackfillStamp(stamp);
  return read ? { ...next, backfill: read, backfills: { ...next.backfills, [placeId]: read } } : next;
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
        kind: ATTACHED,
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
 * `gifs` with this place's counter of every entry set to 0 and the global count following -- keys, handles, `last`,
 * `firstSeen`, the message pointer, `nextId`, the backfill stamps and the other places' counters kept. The GIF history
 * backfill recounts the place from here, so a GIF seen again keeps its handle (see mergeGifs) and one no longer in any
 * history stays, ranked lowest, until storeMax evicts it. No `placeId`: every place's. Never mutates `gifs`.
 * @param gifs  A stored library (normalised here).
 */
export function resetGifCounts(gifs: unknown, placeId?: string): GifLibrary {
  const next = normalizeGifs(gifs);
  for (const [key, entry] of Object.entries(next.entries)) {
    const places = Object.fromEntries(
      Object.entries(entry.places).map(([place, counter]) => [
        place,
        placeId === undefined || place === placeId ? { ...counter, count: 0 } : counter,
      ])
    );
    next.entries[key] = withTotals({ ...entry, places, ...(placeId === undefined ? { count: 0 } : {}) });
  }
  return next;
}

/**
 * `gifs` with the persona's own post of the entry under `key` recorded on the place it went to: `ownLast` set to `ts`,
 * `ownUses` one higher, there and in the totals. The members' counts are not touched. `marked` is false (and the
 * library unchanged) when `key` is not in it. Never mutates `gifs`.
 * @param gifs  A stored library (normalised here).
 * @param key    The entry's library key (findGif's `key`).
 * @param ts     When the persona posted it (epoch ms).
 * @param placeId  Where it went.
 */
export function markOwnGif(
  gifs: unknown,
  key: string,
  ts: number,
  placeId?: string
): { gifs: GifLibrary; marked: boolean } {
  const next = normalizeGifs(gifs);
  const entry = typeof key === 'string' ? next.entries[key] : undefined;
  if (!entry || !isFiniteNumber(ts)) return { gifs: next, marked: false };
  const counter = (placeId ? entry.places[placeId] : undefined) ?? { count: 0, last: 0 };
  next.entries[key] = {
    ...entry,
    ownLast: ts,
    ownUses: (entry.ownUses ?? 0) + 1,
    places: placeId
      ? { ...entry.places, [placeId]: { ...counter, ownLast: ts, ownUses: (counter.ownUses ?? 0) + 1 } }
      : entry.places,
  };
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
 * The slice of one place: the entries it saw or she posted there, ranked by that place's counter alone (rankGifs), each
 * with `count`, `last`, `ownLast` and `ownUses` as that place holds them.
 * @param gifs  A stored library (normalised here).
 */
export function gifsOfPlace(gifs: unknown, placeId: string, halfLifeDays?: number): Array<GifEntry & { key: string }> {
  const { entries } = normalizeGifs(gifs);
  const slice: Record<string, GifEntry> = {};
  for (const [key, entry] of Object.entries(entries)) {
    const counter = entry.places[placeId];
    if (!counter) continue;
    // Without its places the entry ranks by this place's numbers alone; an own post of another place is no own post here.
    slice[key] = { ...entry, ownLast: counter.ownLast, ownUses: counter.ownUses, ...counter, places: {} };
  }
  return rankGifs({ nextId: 1, entries: slice }, halfLifeDays).map((entry) => ({
    ...entry,
    places: entries[entry.key].places,
  }));
}

/**
 * The entry whose handle is `handle` (`g12`), as `{ key, ...entry }`, or null.
 * @param gifs  A stored library (normalised here).
 */
export function findGif(gifs: unknown, handle: string): (GifEntry & { key: string }) | null {
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
 * The library's handles for the transcript: every entry's key and native id -> its handle (`g12`), and a link entry's
 * links -> the same handle, so gifHandleOf can apply matchGifKey's rule to a GIF seen in a message. Keys and URLs never
 * collide (a URL carries `://`).
 * @param gifs  A stored library (normalised here).
 */
export function gifHandleMap(gifs: unknown): Map<string, string> {
  const { entries } = normalizeGifs(gifs);
  const handles = new Map<string, string>();
  for (const [key, entry] of Object.entries(entries)) handles.set(key, entry.id);
  for (const entry of Object.values(entries)) {
    for (const id of entry.nativeIds) if (!handles.has(id)) handles.set(id, entry.id);
    for (const link of entry.kind === 'link' ? [entry.url, ...entry.links] : []) {
      if (!handles.has(link)) handles.set(link, entry.id);
    }
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

/** Where a GIF item counts: the key that holds its key, its native id or its link. */
function libraryIndex(entries: Record<string, GifEntry>): {
  byNative: Map<string, string>;
  byLink: Map<string, string>;
} {
  const byNative = new Map<string, string>();
  const byLink = new Map<string, string>();
  for (const [key, entry] of Object.entries(entries)) {
    for (const id of entry.nativeIds) byNative.set(id, key);
    if (entry.kind === 'link') for (const link of [entry.url, ...entry.links]) byLink.set(link, key);
  }
  return { byNative, byLink };
}

/** A GIF item of a message, as collectGifItems gives it. */
type GifItem = ReturnType<typeof collectGifItems>[number];

/** The entry after one more sighting of `item` at `ts`, on the counter of the place the message was in. */
function counted(before: GifEntry | undefined, item: GifItem, ts: number, handle: string): GifEntry {
  const { key: itemKey, ...fresh } = item;
  const counter = before?.places[item.placeId] ?? { count: 0, last: 0 };
  const places = {
    ...before?.places,
    [item.placeId]: { ...counter, count: counter.count + 1, last: Math.max(counter.last, ts) },
  };
  if (!before) {
    const links = item.kind === 'link' ? [item.url] : [];
    return withTotals({ id: handle, ...fresh, count: 1, last: ts, firstSeen: ts, nativeIds: [itemKey], links, places });
  }
  const newer = ts >= before.last;
  return withTotals({
    ...before,
    ...(newer ? { url: item.url, messageId: item.messageId, placeId: item.placeId } : {}),
    count: before.count + 1,
    last: newer ? ts : before.last,
    firstSeen: Math.min(before.firstSeen, ts),
    nativeIds: [...new Set([...before.nativeIds, itemKey])],
    links: item.kind === 'link' ? [...new Set([...before.links, item.url])] : before.links,
    places,
  });
}

/**
 * `gifs` with the members' GIFs of `messages` added: the persona's own messages and other bots' are skipped; one count
 * per GIF per message, on the counter of the place the message was in. A GIF is matched by its key or a native id, a
 * link GIF also by its links (the same tenor/giphy link reposted gets a new per-message embed id, but it is the same
 * GIF: the first entry keeps counting). A new GIF gets the next handle; a known one -- a reset entry at count 0 included
 * (see resetGifCounts) -- keeps its handle. The latest use moves `last`, `messageId`, `placeId` and `url`. Past
 * `storeMax` entries the lowest-ranked (rankGifs: count-0 entries first) are evicted (`storeMax` not a non-negative
 * integer -> no cap); an evicted handle is never reused. Never mutates `gifs`.
 * @param messages  Normalized messages (URLs present); `self`/`bot`/`ts`/`placeId` read.
 */
export function mergeGifs(
  gifs: unknown,
  messages: Array<StoredRecord>,
  { storeMax, halfLifeDays }: { storeMax?: number; halfLifeDays?: number } = {}
): { gifs: GifLibrary; counted: number } {
  const next = normalizeGifs(gifs);
  const { byNative, byLink } = libraryIndex(next.entries);
  let total = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || message.self) continue;
    const ts = isFiniteNumber(message.ts) ? message.ts : 0;
    const seen = new Set();
    for (const item of collectGifItems(message)) {
      const key =
        matchGifKey(
          item,
          (k) => Boolean(next.entries[k]) || byNative.has(k),
          (url) => byLink.get(url)
        ) ?? item.key;
      const held = next.entries[key] ? key : (byNative.get(key) ?? key);
      if (seen.has(held)) continue;
      seen.add(held);
      const before = next.entries[held];
      const entry = counted(before, item, ts, `g${next.nextId}`);
      if (!before) next.nextId += 1;
      // Re-inserted so a just-used GIF sits last: an exact rank tie keeps it (see sortByRank).
      delete next.entries[held];
      next.entries[held] = entry;
      byNative.set(item.key, held);
      if (entry.kind === 'link') byLink.set(item.url, held);
      total += 1;
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
  return { gifs: next, counted: total };
}

/** The key of the entry held under `key` or seen under that native id, or null. */
function keyOfEntry(entries: Record<string, GifEntry>, key: string): string | null {
  if (entries[key]) return key;
  for (const [held, entry] of Object.entries(entries)) if (entry.nativeIds.includes(key)) return held;
  return null;
}

/** The handle's number, for telling which of two entries is the older. */
const handleNumber = (entry: GifEntry): number => Number(HANDLE_RE.exec(entry.id)?.[1] ?? Infinity);

/** Two places' counters of one GIF as one. */
function joinPlaces(one: Record<string, GifPlace>, two: Record<string, GifPlace>): Record<string, GifPlace> {
  const places: Record<string, GifPlace> = { ...one };
  for (const [place, counter] of Object.entries(two)) {
    const held = places[place] ?? { count: 0, last: 0 };
    const ownLast = Math.max(held.ownLast ?? 0, counter.ownLast ?? 0);
    const ownUses = (held.ownUses ?? 0) + (counter.ownUses ?? 0);
    places[place] = {
      count: held.count + counter.count,
      last: Math.max(held.last, counter.last),
      ...(ownLast > 0 ? { ownLast } : {}),
      ...(ownUses > 0 ? { ownUses } : {}),
    };
  }
  return places;
}

/** One entry out of two that hold the same GIF: the older handle, every id, link and counter of both. */
function joinEntries(one: GifEntry, two: GifEntry): GifEntry {
  const [older, younger] = handleNumber(one) <= handleNumber(two) ? [one, two] : [two, one];
  const newest = older.last >= younger.last ? older : younger;
  const links = [...new Set([...older.links, ...younger.links])];
  // What only one of them holds comes along: its caption, its vector, its file.
  const { caption, vector, hash, file } = { ...younger, ...older };
  return withTotals({
    ...older,
    // A link posts again for good, so an entry holding one is a link entry.
    kind: links.length > 0 ? 'link' : older.kind,
    url: links.length > 0 && older.kind !== 'link' ? links[0] : newest.url,
    messageId: newest.messageId,
    placeId: newest.placeId,
    count: older.count + younger.count,
    last: Math.max(older.last, younger.last),
    firstSeen: Math.min(older.firstSeen, younger.firstSeen),
    nativeIds: [...new Set([...older.nativeIds, ...younger.nativeIds])],
    links,
    places: joinPlaces(older.places, younger.places),
    ...(caption ? { caption } : {}),
    ...(vector ? { vector } : {}),
    ...(hash ? { hash } : {}),
    ...(file ? { file } : {}),
  });
}

/**
 * `gifs` with the entry under `key` (its library key or a native id) holding its cached file: it moves under the content
 * hash, and when an entry already holds those bytes the two become one with the older handle (joinEntries). An unknown
 * key leaves the library as it is. Never mutates `gifs`.
 */
export function withGifFile(gifs: unknown, key: string, { hash, file }: { hash: string; file: string }): GifLibrary {
  const next = normalizeGifs(gifs);
  const held = keyOfEntry(next.entries, key);
  if (held === null) return next;
  const entry: GifEntry = { ...next.entries[held], hash, file };
  const other = held === hash ? undefined : next.entries[hash];
  delete next.entries[held];
  next.entries[hash] = other ? joinEntries(other, entry) : entry;
  return next;
}

/**
 * `gifs` with the entry under `key` (its library key or a native id) described: its caption and the caption's vector
 * (null: none, the search then reads the caption's words alone). An unknown key leaves the library as it is. Never
 * mutates `gifs`.
 */
export function withGifCaption(
  gifs: unknown,
  key: string,
  { caption, vector }: { caption: string; vector: ArrayLike<number> | null }
): GifLibrary {
  const next = normalizeGifs(gifs);
  const held = keyOfEntry(next.entries, key);
  if (held === null) return next;
  const entry = { ...next.entries[held], caption };
  if (vector) entry.vector = Array.from(vector);
  else delete entry.vector;
  next.entries[held] = entry;
  return next;
}

/** The caption a describer's cache entry gives a GIF: its three fields joined, else its text; '' for a miss or nothing. */
export function captionOfCached(cached: unknown): string {
  if (!isRecord(cached) || cached.miss) return '';
  const fields = [cached.reaction, cached.action, cached.screen].filter(
    (field): field is string => typeof field === 'string' && field.trim() !== ''
  );
  if (fields.length > 0) return fields.join('; ');
  return typeof cached.text === 'string' ? cached.text.trim() : '';
}

/** An entry of a place's library with its counter under the place of its latest message and the cached caption. */
function carriedEntry(key: string, entry: GifEntry, place: string, cache: Record<string, unknown>): GifEntry {
  const counter: GifPlace = {
    count: entry.count,
    last: entry.last,
    ...(entry.ownLast ? { ownLast: entry.ownLast } : {}),
    ...(entry.ownUses ? { ownUses: entry.ownUses } : {}),
  };
  const caption = entry.caption ?? captionOfCached(cache[entry.itemId] ?? cache[key]);
  return {
    ...entry,
    places: Object.keys(entry.places).length > 0 ? entry.places : { [entry.placeId || place]: counter },
    ...(caption ? { caption } : {}),
  };
}

/** Lowercase with accents off, so a query matches a caption in any case. */
function folded(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

const wordsOf = (text: string): Set<string> => new Set(folded(text).match(/[\p{L}\p{N}]+/gu) ?? []);

/** How close a caption's vector must be to the query's to make it a candidate on meaning alone. */
const MIN_SIMILARITY = 0.3;

/** The cosine of two vectors of one dimension, null when there is no comparing them. */
function similarity(
  one: ArrayLike<number> | null | undefined,
  two: ArrayLike<number> | null | undefined
): number | null {
  if (!one || !two || one.length === 0 || one.length !== two.length) return null;
  let dot = 0;
  let oneSquared = 0;
  let twoSquared = 0;
  for (let i = 0; i < one.length; i += 1) {
    dot += one[i] * two[i];
    oneSquared += one[i] * one[i];
    twoSquared += two[i] * two[i];
  }
  const norm = Math.sqrt(oneSquared * twoSquared);
  return norm > 0 ? dot / norm : null;
}

/**
 * The candidates of a query, best score first, at most `cap`: captioned entries scored by the share of the query's words
 * their caption holds plus the similarity of their vector to the query's (a similarity under the floor counts nothing).
 * An entry that scores nothing is no candidate, and neither is one `accept` refuses. Equal scores go to the GIF used
 * more, then to the one used last. A vector of another dimension counts as no vector. Pure.
 * @param gifs  A stored library (normalised here).
 */
export function searchGifs(
  gifs: unknown,
  {
    words,
    vector,
    cap,
    vectors = null,
    accept = () => true,
  }: {
    words: string;
    vector: ArrayLike<number> | null;
    cap: number;
    /** The captions' vectors by item id, kept outside the library's JSON (src/memory/db/gif-vectors.ts). */
    vectors?: ReadonlyMap<string, ArrayLike<number>> | null;
    accept?: (entry: GifEntry & { key: string }) => boolean;
  }
): Array<{ entry: GifEntry & { key: string }; score: number }> {
  if (!(cap > 0)) return [];
  const wanted = [...wordsOf(String(words ?? ''))];
  if (wanted.length === 0 && !vector) return [];
  const found: Array<{ entry: GifEntry & { key: string }; score: number }> = [];
  for (const [key, entry] of Object.entries(normalizeGifs(gifs).entries)) {
    if (!entry.caption || !accept({ key, ...entry })) continue;
    const caption = wordsOf(entry.caption);
    const shared = wanted.filter((word) => caption.has(word)).length;
    const wordScore = wanted.length > 0 ? shared / wanted.length : 0;
    const close = similarity(vector, vectors?.get(entry.itemId) ?? entry.vector) ?? 0;
    const score = wordScore + (close >= MIN_SIMILARITY ? close : 0);
    if (score > 0) found.push({ entry: { key, ...entry }, score });
  }
  found.sort(
    (one, two) => two.score - one.score || two.entry.count - one.entry.count || two.entry.last - one.entry.last
  );
  return found.slice(0, cap);
}
