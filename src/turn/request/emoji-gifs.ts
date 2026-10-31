// The server's custom emoji and the GIF library as a request shows them: the `<emoji>` list ranked by use with its
// captions, the `<gifs>` list held per cache bucket, the `<gifs_recent>` lines of the GIFs the persona posted lately,
// and the caption fields a GIF of the library carries in the transcript. buildRequest (src/behavior/prompt.js), the
// GIF picker (src/turn/draw-gif.ts) and her GIF tools (src/tools/tools.ts) read them.

import { fill, fillGifFields, formatDuration } from '../../format.js';
import { normalizeGifs, rankEmojiUsage, rankGifs } from '../../memory/index.js';
import { clampWithEllipsis } from '../../memory/clamp.js';
import { HOUR_MS } from '../../time.js';
import type { Cost, EmojiConfig, EmojiRef, Fit, GifsConfig, Labels, Message, RequestConfig } from './types.ts';

/** The describer cache (store.getMediaCache), read only: a caption, or a three-field GIF description, per item id. */
export type MediaCache = {
  readonly [itemId: string]:
    | {
        readonly miss?: unknown;
        readonly text?: unknown;
        readonly reaction?: unknown;
        readonly action?: unknown;
        readonly screen?: unknown;
      }
    | undefined;
};

/** One GIF of the library (src/memory/gifs.js): its handle, its media item and when the persona last posted it. */
export type GifEntry = { readonly id: string; readonly itemId: string; readonly ownLast?: number };

/** The describer cache as its callers hand it (store.getMediaCache), read through MediaCache's shape. */
const cacheOf = (mediaCache: object | null | undefined): MediaCache | null | undefined =>
  mediaCache as MediaCache | null | undefined;

/** What freezePerBucket holds under a key for the bucket it was computed in. */
export type Held<T> = { bucket: number; signature: string; value: T };

/**
 * The `<emoji>` section's items: `labels.emoji.header` first, then one line
 * per custom emoji -- the top-ranked ids of `guild.emojiUsage` (see
 * src/memory/emoji-usage.js#rankEmojiUsage) that the index still has, topped
 * up with the rest of the index in its own order (a fresh install with no
 * ranking yet shows the first `max` of the index), at most `max` lines. The
 * name is the index's current one. A `vision` caption cached under
 * `emoji:<id>` (the describer's cache; a `miss` entry has no text) renders
 * through `labels.emoji.entry` (`{name}`/`{text}`), otherwise
 * `labels.emoji.entryNoText` (`{name}`); a caption this request's
 * `describe(id)` knows comes first. Then, when `seen` is given and
 * `labels.emoji.seenInChat` and `entry` are set, the custom emoji of this
 * request's transcript (seenEmoji) not listed above that have a caption:
 * `seenInChat` as a sub-heading, one `entry` line each. `[]` when the index
 * is empty or the labels lack `header`/`entryNoText` (an older labels.json).
 * `index` is the emoji index's list (createEmojiIndex().list()), `usage` is `guild.emojiUsage`, `mediaCache` the
 * describer cache (store.getMediaCache, read only) and `emojiCfg` is `context.customEmoji`.
 */
export function emojiItems(
  index: Array<EmojiRef | null | undefined>,
  usage: unknown,
  mediaCache: MediaCache | null,
  labels: Labels,
  emojiCfg: EmojiConfig | undefined,
  { seen = [], describe = () => '' }: { seen?: Array<EmojiRef>; describe?: (id: string) => string } = {}
): Array<string> {
  const e = labels.emoji;
  if (!e?.header || !e.entryNoText) return [];
  const list = Array.isArray(index) ? index.filter((emoji): emoji is EmojiRef => Boolean(emoji?.id && emoji.name)) : [];
  if (list.length === 0) return [];
  const max = emojiMax(emojiCfg);
  const byId = new Map(list.map((emoji) => [String(emoji.id), emoji]));
  const chosen: Array<EmojiRef> = [];
  const taken = new Set<string>();
  const take = (emoji: EmojiRef | undefined) => {
    if (!emoji || taken.has(String(emoji.id)) || chosen.length >= max) return;
    taken.add(String(emoji.id));
    chosen.push(emoji);
  };
  for (const used of rankEmojiUsage(usage, emojiCfg?.halfLifeDays ?? 30)) take(byId.get(used.id));
  for (const emoji of list) take(emoji);
  if (chosen.length === 0) return [];
  const captionOf = (id: string) => {
    const known = describe(String(id));
    if (known) return known;
    const cached = mediaCache?.[`emoji:${id}`];
    return cached && !cached.miss && typeof cached.text === 'string' ? cached.text.trim() : '';
  };
  const lines = chosen.map((emoji) => {
    const text = captionOf(emoji.id);
    return text && e.entry ? fill(e.entry, { name: emoji.name, text }) : fill(e.entryNoText, { name: emoji.name });
  });
  const more: Array<string> = [];
  if (e.seenInChat && e.entry) {
    for (const emoji of seen) {
      const text = taken.has(String(emoji.id)) ? '' : captionOf(emoji.id);
      if (text) more.push(fill(e.entry, { name: emoji.name, text }));
    }
  }
  return [e.header, ...lines, ...(more.length > 0 ? [e.seenInChat, ...more] : [])];
}

/** The first non-blank caption under `key` in `maps` (each a Map or nothing), trimmed; '' when none. */
export function emojiCaption(key: string, maps: Array<unknown>): string {
  for (const map of maps) {
    const text: unknown = map instanceof Map ? (map as Map<string, unknown>).get(key) : null;
    if (typeof text === 'string' && text.trim()) return text.trim();
  }
  return '';
}

/** `context.customEmoji.max` (30, config.json's value, when missing or unusable). */
export function emojiMax(emojiCfg: EmojiConfig | undefined): number {
  return emojiCfg?.max !== undefined && Number.isInteger(emojiCfg.max) && emojiCfg.max >= 0 ? emojiCfg.max : 30;
}

/**
 * The custom emoji used in `messageSets` (arrays of normalized messages, a
 * forwarded snapshot's emoji included), each id once, in order of first use.
 */
export function seenEmoji(messageSets: Array<Array<Message> | null | undefined>): Array<EmojiRef> {
  const out = new Map<string, EmojiRef>();
  const add = (emojis: Array<EmojiRef | null | undefined> | undefined) => {
    for (const emoji of Array.isArray(emojis) ? emojis : []) {
      if (emoji?.id && emoji.name && !out.has(String(emoji.id)))
        out.set(String(emoji.id), { id: String(emoji.id), name: emoji.name });
    }
  };
  for (const messages of messageSets) {
    for (const message of Array.isArray(messages) ? messages : []) {
      add(message?.emojis);
      for (const snapshot of message?.forwarded ?? []) add(snapshot?.emojis);
    }
  }
  return [...out.values()];
}

/**
 * `compute()`, held in `freeze` under `key` for the time bucket of `now`
 * (`Math.floor(now / bucketMs)`, buckets aligned to the epoch): within one
 * bucket, and while `signature` stays the same, every call returns what the
 * first call of the bucket computed; the first call of the next bucket (or
 * one with another signature) computes again and holds that. The reply's
 * stable part renders what memory changes through this (`<self_facts>`,
 * `<gifs>`), with `bucketMs` the cache TTL (src/llm/openrouter.js#cacheTtlMs):
 * a memory batch or a GIF post then rewrites the cached prefix at most once
 * per TTL, and the persona sees the change at the next bucket edge. `signature`
 * names the settings the value is rendered with (labels, config), so an
 * operator's edit shows at once. No Map, or `now`/`bucketMs` unusable ->
 * `compute()` every time. An array value is returned as a copy, so a caller
 * never changes what is held. Mutates `freeze` only.
 */
export function freezePerBucket<T>(
  freeze: Map<string, Held<unknown>> | null | undefined,
  key: string,
  { now, bucketMs, signature = '' }: { now: number; bucketMs: number; signature?: string },
  compute: () => T
): T {
  if (!(freeze instanceof Map) || !Number.isFinite(now) || !Number.isFinite(bucketMs) || bucketMs <= 0)
    return compute();
  const bucket = Math.floor(now / bucketMs);
  // Each key holds one kind of value, the one its compute gives.
  let held = freeze.get(key) as Held<T> | undefined;
  if (!held || held.bucket !== bucket || held.signature !== signature) {
    held = { bucket, signature, value: compute() };
    freeze.set(key, held);
  }
  // A copy of a held array is the same kind of value.
  return Array.isArray(held.value) ? ([...(held.value as Array<unknown>)] as T) : held.value;
}

/**
 * The `<gifs>` section's items: `labels.gifs.header` first, then one line
 * per GIF of the library -- the top `gifsCfg.max` (default 40) by rank
 * (src/memory/gifs.js#rankGifs, `gifsCfg.halfLifeDays`, default 30), each
 * rendered by gifLine (the three caption fields through
 * `labels.gifs.entryFields`, an older one-line caption through
 * `labels.gifs.entry`, cut per field by `gifsCfg.reactionChars` /
 * `gifsCfg.actionChars` -- only here: the cached caption stays as stored --,
 * else `labels.gifs.entryNoText`), never with an own-post mark: the list sits
 * in the cached stable part, so which GIFs the persona posted lately is said
 * in the tail (`<gifs_recent>`, ownGifLines). `ids[i]` is the handle of
 * `items[i + 1]`. `items` is `[]` when the library is empty or the labels lack
 * `header`/`entryNoText` (an older labels.json).
 * `gifs` is the library (store.getGifs), `mediaCache` the describer cache (store.getMediaCache, read only) and
 * `gifsCfg` is `config.gifs`.
 */
export function gifItems(
  gifs: unknown,
  mediaCache: MediaCache | null,
  labels: Labels,
  gifsCfg: GifsConfig | undefined
): { items: Array<string>; ids: Array<string> } {
  const g = labels.gifs;
  if (!g?.header || !g.entryNoText) return { items: [], ids: [] };
  const max = gifsCfg?.max !== undefined && Number.isInteger(gifsCfg.max) && gifsCfg.max >= 0 ? gifsCfg.max : 25;
  // rankGifs ranks the library's entries, which it returns as plain objects.
  const chosen = (rankGifs(gifs, gifsCfg?.halfLifeDays ?? 30) as Array<GifEntry>).slice(0, max);
  if (chosen.length === 0) return { items: [], ids: [] };
  const options = { ...gifFieldChars(gifsCfg), ownMarkHours: 0, now: 0 };
  return {
    items: [g.header, ...chosen.map((entry) => gifLine(entry, mediaCache, labels, options))],
    ids: chosen.map((entry) => entry.id),
  };
}

/**
 * The `<gifs_recent>` lines of the tail: of the GIFs `<gifs>` shows (`shownIds`, their
 * handles), the ones the persona posted within `ownMarkHours` (0 = never) of `now`
 * according to the live library, newest post first, each as its handle, a space and
 * `labels.gifs.ownMark` with `{ago}` (formatDuration, `labels.units`). [] without that label
 * or the units. Per turn: the ages move, so this never enters a cached part. The GIF
 * picker's tail uses it the same way (src/behavior/turn.js#pickGif). Pure.
 * `gifs` is the live library (store.getGifs).
 */
export function ownGifLines(
  gifs: unknown,
  shownIds: Array<string>,
  labelsGiven: object,
  { ownMarkHours, now }: { ownMarkHours: number; now: number }
): Array<string> {
  const labels = labelsGiven as Labels;
  const g = labels.gifs;
  if (!g?.ownMark || !labels.units || shownIds.length === 0) return [];
  const shown = new Set(shownIds);
  // normalizeGifs gives the library's entries as plain objects.
  return (
    (Object.values(normalizeGifs(gifs).entries) as Array<GifEntry>)
      .filter((entry) => shown.has(entry.id) && ownPostAge(entry, { ownMarkHours, now }) !== null)
      // An entry kept here has an own post (ownPostAge).
      .sort((a, b) => (b.ownLast ?? 0) - (a.ownLast ?? 0))
      .map(
        (entry) =>
          `${entry.id} ${fill(g.ownMark, { ago: formatDuration(ownPostAge(entry, { ownMarkHours, now }) ?? 0, labels.units) })}`
      )
  );
}

/**
 * `gifs.reactionChars` (40) and `gifs.actionChars` (70) of `gifsCfg`
 * (`config.gifs`), config.json's value when missing or not a number >= 0;
 * 0 = no cut. The one reader of both for the `<gifs>` list and the GIF picker.
 */
export function gifFieldChars(gifsCfg: GifsConfig | null | undefined): { reactionChars: number; actionChars: number } {
  const read = (value: number | undefined, fallback: number) =>
    value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
  return { reactionChars: read(gifsCfg?.reactionChars, 40), actionChars: read(gifsCfg?.actionChars, 70) };
}

/**
 * The one-line caption of a GIF library entry: the `vision` caption cached
 * under its `itemId` (the describer's cache; a `miss` entry has none), cut to
 * `actionChars` (0 = whole) at a word boundary, a cut marked with an ellipsis
 * (src/memory/clamp.js#clampWithEllipsis, a hard limit); '' when there is
 * none. Render time only, so a caption stored whole or stored cut renders the
 * same way. Whether an entry is captioned at all (the GIF picker lists only
 * those). Pure.
 * `mediaCache` is the describer cache (store.getMediaCache), read only.
 */
export function gifCaption(
  entry: { readonly itemId: string },
  mediaCache: object | null | undefined,
  actionChars: number
): string {
  const cached = cacheOf(mediaCache)?.[entry?.itemId];
  return cached && !cached.miss && typeof cached.text === 'string' ? clampWithEllipsis(cached.text, actionChars) : '';
}

/**
 * The three caption fields of a GIF library entry described in that format
 * (src/memory/describe.js#parseGifDescription: the cache entry holds a
 * `reaction` or a `screen` string), each cut at render time like gifCaption
 * -- `reaction` and `screen` to `reactionChars`, `action` to `actionChars`
 * (0 = whole) --, `text` being the on-screen text; null for an entry in the
 * older one-line format, a miss or no entry, or when every field is empty. Pure.
 */
export function gifFields(
  entry: { readonly itemId: string },
  mediaCache: object | null | undefined,
  { reactionChars, actionChars }: { reactionChars: number; actionChars: number }
): { reaction: string; action: string; text: string } | null {
  const cached = cacheOf(mediaCache)?.[entry?.itemId];
  if (!cached || cached.miss || (typeof cached.reaction !== 'string' && typeof cached.screen !== 'string')) return null;
  const field = (value: unknown, chars: number) => (typeof value === 'string' ? clampWithEllipsis(value, chars) : '');
  const fields = {
    reaction: field(cached.reaction, reactionChars),
    action: field(cached.action, actionChars),
    text: field(cached.screen, reactionChars),
  };
  return fields.reaction || fields.action || fields.text ? fields : null;
}

/**
 * The transcript's view of the three-field GIF captions: every entry of the
 * describer cache in that format (gifFields, cut per field by `chars` like
 * the `<gifs>` list) as cache key -> `{ reaction, action, screen }`, ready
 * for formatTranscript's `gifFields` option (src/format.js renders
 * `transcript.gifKnownFields` with them for a GIF of the library). Keys are
 * the item ids the transcript and `descriptions` use. Pure.
 * `mediaCache` is the describer cache (store.getMediaCache), read only, and `chars` come from gifFieldChars.
 */
export function gifFieldsMap(
  mediaCache: object | null | undefined,
  chars: { reactionChars: number; actionChars: number }
): Map<string, { reaction: string; action: string; screen: string }> {
  const map = new Map<string, { reaction: string; action: string; screen: string }>();
  for (const itemId of Object.keys(mediaCache ?? {})) {
    const fields = gifFields({ itemId }, mediaCache, chars);
    if (fields) map.set(itemId, { reaction: fields.reaction, action: fields.action, screen: fields.text });
  }
  return map;
}

/**
 * One line of a GIF library entry, as the `<gifs>` section shows it (gifItems,
 * with `ownMarkHours` 0: no mark in the cached list) and the GIF picker lists
 * it (src/behavior/gif-pick.js#renderGifLibrary): an
 * entry described in three fields (gifFields) through `labels.gifs.entryFields`
 * (`{id}`, `{reaction}`, `{action}`, `{text}` = the on-screen text; empty
 * fields left out, see src/format.js#fillGifFields); an older one-line caption (gifCaption,
 * cut to `actionChars`) -- or a three-field one when the labels have no
 * `entryFields` -- through `labels.gifs.entry` (`{id}`/`{text}`); else
 * `labels.gifs.entryNoText` (`{id}`). A GIF the persona itself posted
 * (`ownLast`) no longer than `ownMarkHours` (0 = never) before `now` gets
 * ` ` + `labels.gifs.ownMark` appended, `{ago}` = that time through
 * formatDuration (`labels.units`); no mark without that label. The caller
 * checks that `labels.gifs` carries `entryNoText`. Pure.
 */
export function gifLine(
  entry: GifEntry,
  mediaCache: object | null | undefined,
  labelsGiven: object,
  {
    reactionChars,
    actionChars,
    ownMarkHours,
    now,
  }: { reactionChars: number; actionChars: number; ownMarkHours: number; now: number }
): string {
  const labels = labelsGiven as Labels;
  // The caller checks that `labels.gifs` carries `entryNoText`.
  const g = labels.gifs!;
  const fields = g.entryFields ? gifFields(entry, mediaCache, { reactionChars, actionChars }) : null;
  const text = fields ? '' : gifCaption(entry, mediaCache, actionChars);
  const line = fields
    ? fillGifFields(g.entryFields, entry.id, fields)
    : text && g.entry
      ? fill(g.entry, { id: entry.id, text })
      : fill(g.entryNoText, { id: entry.id });
  const age = g.ownMark && labels.units ? ownPostAge(entry, { ownMarkHours, now }) : null;
  if (age === null) return line;
  return `${line} ${fill(g.ownMark, { ago: formatDuration(age, labels.units) })}`;
}

/** How long ago the persona posted `entry` when that is within `ownMarkHours` (0 = never) of `now`, else null. */
function ownPostAge(entry: GifEntry, { ownMarkHours, now }: { ownMarkHours: number; now: number }): number | null {
  // A GIF the persona never posted has no `ownLast`: no age, so no mark.
  const ownLast = entry.ownLast ?? NaN;
  const age = Math.max(0, now - ownLast);
  if (!Number.isFinite(ownMarkHours) || ownMarkHours <= 0 || !(ownLast > 0) || age > ownMarkHours * HOUR_MS)
    return null;
  return age;
}

/**
 * The `<gifs>` list's order and text, held per cache bucket (frozen): a GIF use or a new caption moves the cached
 * prefix at the next bucket edge at most. The signature lets an edit of its settings show at once.
 */
export function gifListOf(given: {
  config: RequestConfig;
  labels: Labels;
  mediaCache?: MediaCache | null;
  gifsOn: boolean;
  gifLibrary: unknown;
  frozen: <T>(key: string, signature: string, compute: () => T) => T;
}): { items: Array<string>; ids: Array<string> } {
  const { config, labels, gifsOn, gifLibrary, frozen } = given;
  const gifList = gifsOn
    ? frozen('gifs', JSON.stringify([labels.gifs, labels.units, config.gifs ?? null]), () =>
        gifItems(gifLibrary, given.mediaCache ?? null, labels, config.gifs)
      )
    : { items: [], ids: [] };
  return gifList;
}

/**
 * The emoji and GIF lists as kept: a header alone, or entries without it, make no block; then the GIFs of the list the
 * persona posted lately, paid from what the request has left (`<gifs_recent>`). Fills `fit`.
 */
export function trimLists(
  fit: Fit,
  given: {
    config: RequestConfig;
    now: number;
    labels: Labels;
    emojiOnce: boolean;
    gifLibrary: unknown;
    gifList: { items: Array<string>; ids: Array<string> };
    cost: Cost;
    limit: number;
  }
): void {
  const { kept, stats } = fit;
  let { used } = fit;
  const { config, now, labels, emojiOnce, gifLibrary, gifList, cost, limit } = given;
  // The emoji seen in the chat lost to the cap leave no sub-heading of their own behind.
  if (emojiOnce && kept.emoji.length > 0 && kept.emoji.at(-1) === labels.emoji?.seenInChat)
    kept.emoji = kept.emoji.slice(0, -1);
  // The header alone, or entries without their header, make no block.
  if (kept.emoji.length < 2 || kept.emoji[0] !== labels.emoji?.header) kept.emoji = [];
  if (kept.gifs.length < 2 || kept.gifs[0] !== labels.gifs?.header) kept.gifs = [];
  // The GIFs of the list the persona posted lately, with how long ago, in the tail
  // (`<gifs_recent>`): paid from what the request has left, left out when it does not fit.
  kept.gifsRecent = [];
  if (kept.gifs.length > 0) {
    const ownLines = ownGifLines(gifLibrary, gifList.ids.slice(0, kept.gifs.length - 1), labels, {
      ownMarkHours: config.gifs?.ownMarkHours ?? 24,
      now,
    });
    const price = ownLines.length > 0 ? cost(ownLines.join('\n')) : 0;
    if (price > 0 && used + price <= limit) {
      used += price;
      kept.gifsRecent = ownLines;
      stats.gifsRecent = { used: price, kept: ownLines.length, dropped: 0 };
    }
  }
  fit.used = used;
}
