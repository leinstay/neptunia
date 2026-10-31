// The media prefill of an observed line: its pictures captioned, its first videos watched and its first readable link
// read ahead of time, each fire-and-forget, so a turn finds them in the cache; and the cached captions the address and
// room classifiers show. createMessageHandler (src/behavior/pipeline.js) builds it once with createMediaPrefill.

import { log } from '../log.js';
import {
  collectEmojiItems,
  collectPictures,
  collectReadableLinks,
  collectVideos,
  isDescribable,
} from '../media/classify.js';
import type { formatTranscript } from '../format.js';
import { isVideoVisionOn } from '../memory/index.js';
import { utcDay } from '../time.js';
import type { PipelineHot } from './types.ts';

// The most links one observed message has read ahead of time (web.links.prefill).
const MAX_WARM_LINKS_PER_MESSAGE = 1;
// Only when web.links.prefillPerUserPerDay is missing (config.json always has it).
const PREFILL_PER_USER_PER_DAY_FALLBACK = 10;

/** A normalized line (src/behavior/line-of.js#lineOf), as the media collectors read it. */
type MediaLine = Parameters<typeof collectPictures>[0] & { readonly authorId?: string };

/** What the classifiers' transcript shows of a line's media (src/format.js#formatTranscript). */
export type CachedMedia = Pick<Parameters<typeof formatTranscript>[1], 'descriptions' | 'videos'>;

/** The describer (src/memory/describe.js#createDescriber), as the prefill calls it. */
type Describer = {
  describeMany: (guildId: string, items: Array<unknown>) => Promise<unknown>;
  describeVideos?: (guildId: string, items: Array<unknown>) => Promise<unknown>;
  cachedDescriptions?: (guildId: string, items: Array<unknown>) => CachedMedia['descriptions'];
  cachedVideos?: (guildId: string, items: Array<unknown>) => Promise<CachedMedia['videos']>;
};

/** What createMediaPrefill reads: the dependencies of createMessageHandler. */
export type MediaPrefillContext = {
  hot: PipelineHot;
  describer: Describer | null | undefined;
  lookup:
    | {
        readLinks?: (
          guildId: string,
          links: Array<unknown>,
          options: { maxNew: number }
        ) => Promise<{ newCount?: number }>;
      }
    | null
    | undefined;
  now: () => number;
};

export type MediaPrefill = {
  warmMediaCache: (guildId: string, normalized: MediaLine) => Promise<void> | null;
  cachedFollowUpMedia: (
    guildId: string,
    messages: Array<MediaLine>,
    config: PipelineHot['config'],
    ownPrefill: Promise<void> | null
  ) => Promise<CachedMedia>;
};

/**
 * How many items of one observed message a prefill may take: `value` (a
 * config count, read by the caller now) floored at 0, or `fallback` (the
 * config.json value) when it is missing or not a number. 0 turns that prefill off.
 */
function prefillPerMessage(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value as number)) : fallback;
}

export function createMediaPrefill({ hot, describer, lookup, now }: MediaPrefillContext): MediaPrefill {
  /**
   * Fire-and-forget: the message path never waits on it (see
   * createMessageHandler). A no-op when the feature is off or no describer was wired in, so
   * this pipeline makes zero describer calls in that case. Returns the
   * picture prefill's promise (it never rejects), or null when none started:
   * only the address and room classifiers await it, so a sticker- or
   * picture-only line reaches them with its caption (see cachedFollowUpMedia).
   */
  function warmMediaCache(guildId: string, normalized: MediaLine): Promise<void> | null {
    warmLinkCache(guildId, normalized);
    if (!describer) return null;
    warmVideoCache(guildId, normalized);
    if (hot.config.features?.mediaDescriptions !== true) return null;
    // Per real-time message, not per batch, so it stays small (media.prefillPerMessage).
    const max = prefillPerMessage(hot.config.media?.prefillPerMessage, 5);
    const candidates: Array<unknown> = describableItems([normalized]).slice(0, max);
    if (candidates.length === 0) return null;
    return describer
      .describeMany(guildId, candidates)
      .then(() => {})
      .catch((err: unknown) => log.warn('events: media cache prefill failed', { error: err }));
  }

  /**
   * The describable items of `messages`, in order: each message's pictures
   * (attachments/embeds/stickers) before its custom emoji, both filtered to
   * what the describer can actually caption.
   */
  function describableItems(messages: Array<MediaLine>): Array<unknown> {
    return messages.flatMap((m) => {
      const pictures: Array<unknown> = collectPictures(m);
      const emoji: Array<unknown> = collectEmojiItems(m);
      return [...pictures, ...emoji].filter(isDescribable);
    });
  }

  /**
   * What the address classifier's transcript shows of `messages`' media:
   * `{ descriptions, videos }` read from the describer's cache only -- no
   * new request, nothing counted. `ownPrefill` (the candidate's own picture
   * prefill from warmMediaCache, already running) is awaited first, so the
   * candidate's caption is in the cache when it can be; it is never started
   * again here. Empty without a describer or with features.mediaDescriptions
   * off (read now).
   */
  async function cachedFollowUpMedia(
    guildId: string,
    messages: Array<MediaLine>,
    config: PipelineHot['config'],
    ownPrefill: Promise<void> | null
  ): Promise<CachedMedia> {
    if (!describer || config.features?.mediaDescriptions !== true) return {};
    if (ownPrefill) await ownPrefill;
    const media: CachedMedia = {};
    if (typeof describer.cachedDescriptions === 'function') {
      media.descriptions = describer.cachedDescriptions(guildId, describableItems(messages));
    }
    if (typeof describer.cachedVideos === 'function') {
      const sites = config.media?.video?.sites;
      const items = messages.flatMap((m): Array<unknown> => collectVideos(m, { videoSites: sites }));
      if (items.length > 0) media.videos = await describer.cachedVideos(guildId, items);
    }
    return media;
  }

  /** Fire-and-forget like warmMediaCache: watch the message's first videos now, not when a turn needs it. */
  function warmVideoCache(guildId: string, normalized: MediaLine): void {
    const config = hot.config;
    // Both switches, like the describer and the senses line; a missing videoDescriptions counts as on.
    if (!isVideoVisionOn(config)) return;
    if (config.media?.video?.prefill !== true) return;
    // warmMediaCache calls this only with a describer.
    const media = describer as Describer;
    if (typeof media.describeVideos !== 'function') return;
    // Watching is far dearer than a picture caption: one video per message by default.
    const max = prefillPerMessage(config.media.video.prefillPerMessage, 5);
    const candidates: Array<unknown> = collectVideos(normalized, { videoSites: config.media.video.sites }).slice(
      0,
      max
    );
    if (candidates.length === 0) return;
    media
      .describeVideos(guildId, candidates)
      .catch((err: unknown) => log.warn('events: video cache prefill failed', { error: err }));
  }

  /**
   * Fire-and-forget like warmMediaCache: read the message's first readable
   * link now (src/web/lookup.js), not when a turn needs it. Needs
   * features.webLookup (a missing key counts as OFF: it costs money),
   * web.links.enabled (a missing key counts as on) and web.links.prefill.
   * One member gets at most `web.links.prefillPerUserPerDay` new fetches a
   * UTC day this way (in memory; cache hits are free), so posting links
   * cannot spend `web.maxPerDay` for everyone. The turn path is not limited.
   */
  function warmLinkCache(guildId: string, normalized: MediaLine): void {
    if (typeof lookup?.readLinks !== 'function') return;
    const config = hot.config;
    if (config.features?.webLookup !== true) return;
    const linksCfg = config.web?.links ?? {};
    if (linksCfg.enabled === false || linksCfg.prefill !== true) return;
    const links: Array<unknown> = collectReadableLinks(normalized, {
      videoSites: config.media?.video?.sites ?? [],
    }).slice(0, MAX_WARM_LINKS_PER_MESSAGE);
    if (links.length === 0) return;
    const perUser = Number.isFinite(linksCfg.prefillPerUserPerDay)
      ? Math.max(0, Math.floor(linksCfg.prefillPerUserPerDay as number))
      : PREFILL_PER_USER_PER_DAY_FALLBACK;
    const slot = reservePrefill(`${guildId}:${normalized.authorId ?? ''}`, links.length, perUser);
    if (slot.granted === 0) return;
    Promise.resolve()
      .then(() => lookup.readLinks?.(guildId, links, { maxNew: slot.granted }))
      .then((result) => refundPrefill(slot, slot.granted - (result?.newCount ?? 0)))
      .catch((err: unknown) => log.warn('events: link prefill failed', { error: err }));
  }

  // Per-(guild, author) prefill counts for the current UTC day; cleared when the day turns.
  const prefillCounts = new Map<string, number>();
  let prefillDay: string | null = null;

  /** Take up to `wanted` of the member's remaining daily prefill slots: `{ key, day, granted }`. */
  function reservePrefill(key: string, wanted: number, perUser: number) {
    const day = utcDay(now());
    if (day !== prefillDay) {
      prefillDay = day;
      prefillCounts.clear();
    }
    const used = prefillCounts.get(key) ?? 0;
    const granted = Math.max(0, Math.min(wanted, perUser - used));
    if (granted > 0) prefillCounts.set(key, used + granted);
    return { key, day, granted };
  }

  /** Give back the slots a prefill did not spend on a new fetch (a cache hit, a fresh miss, the daily cap). */
  function refundPrefill(slot: { key: string; day: string; granted: number }, unused: number): void {
    if (unused <= 0 || slot.day !== prefillDay) return;
    const used = prefillCounts.get(slot.key) ?? 0;
    prefillCounts.set(slot.key, Math.max(0, used - unused));
  }

  return { warmMediaCache, cachedFollowUpMedia };
}
