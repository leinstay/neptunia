// The media prefill of an observed line: its pictures captioned, its first videos watched and its first readable link
// read ahead of time, each fire-and-forget, so a turn finds them in the cache; and the cached captions the address and
// room classifiers show. createMessageHandler (src/behavior/pipeline.ts) builds it once with createMediaPrefill.

import { log } from '../log.ts';
import {
  collectEmojiItems,
  collectPictures,
  collectReadableLinks,
  collectVideos,
  isDescribable,
} from '../media/classify.ts';
import type { formatTranscript } from '../format.ts';
import type { PipelineHot } from './types.ts';

// The most links one observed message has read ahead of time.
const MAX_WARM_LINKS_PER_MESSAGE = 1;
// Production values, config cut of 2026-10-31.
/** The pictures of one observed message captioned ahead of time. */
const PICTURES_PER_MESSAGE = 5;
/** The videos of one observed message watched ahead of time. */
const VIDEOS_PER_MESSAGE = 5;

/** A normalized line (src/behavior/line-of.ts#lineOf), as the media collectors read it. */
type MediaLine = Parameters<typeof collectPictures>[0] & { readonly authorId?: string };

/** What the classifiers' transcript shows of a line's media (src/format.ts#formatTranscript). */
export type CachedMedia = Pick<Parameters<typeof formatTranscript>[1], 'descriptions' | 'videos'>;

/** The describer (src/memory/describe.ts#createDescriber), as the prefill calls it. */
type Describer = {
  describeMany: (placeId: string, items: Array<unknown>) => Promise<unknown>;
  describeVideos?: (placeId: string, items: Array<unknown>) => Promise<unknown>;
  cachedDescriptions?: (placeId: string, items: Array<unknown>) => CachedMedia['descriptions'];
  cachedVideos?: (placeId: string, items: Array<unknown>) => Promise<CachedMedia['videos']>;
};

/** What createMediaPrefill reads: the dependencies of createMessageHandler. */
export type MediaPrefillContext = {
  hot: PipelineHot;
  describer: Describer | null | undefined;
  lookup:
    | {
        readLinks?: (placeId: string, links: Array<unknown>, options: { maxNew: number }) => Promise<unknown>;
      }
    | null
    | undefined;
  now: () => number;
};

export type MediaPrefill = {
  warmMediaCache: (placeId: string, normalized: MediaLine) => Promise<void> | null;
  cachedFollowUpMedia: (
    placeId: string,
    messages: Array<MediaLine>,
    config: PipelineHot['config'],
    ownPrefill: Promise<void> | null
  ) => Promise<CachedMedia>;
};

export function createMediaPrefill({ hot, describer, lookup }: MediaPrefillContext): MediaPrefill {
  /**
   * Fire-and-forget: the message path never waits on it (see
   * createMessageHandler). A no-op when the feature is off or no describer was wired in, so
   * this pipeline makes zero describer calls in that case. Returns the
   * picture prefill's promise (it never rejects), or null when none started:
   * only the address and room classifiers await it, so a sticker- or
   * picture-only line reaches them with its caption (see cachedFollowUpMedia).
   */
  function warmMediaCache(placeId: string, normalized: MediaLine): Promise<void> | null {
    warmLinkCache(placeId, normalized);
    if (!describer) return null;
    warmVideoCache(placeId, normalized);
    // Per real-time message, not per batch, so it stays small.
    const candidates: Array<unknown> = describableItems([normalized]).slice(0, PICTURES_PER_MESSAGE);
    if (candidates.length === 0) return null;
    return describer
      .describeMany(placeId, candidates)
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
    placeId: string,
    messages: Array<MediaLine>,
    config: PipelineHot['config'],
    ownPrefill: Promise<void> | null
  ): Promise<CachedMedia> {
    if (!describer) return {};
    if (ownPrefill) await ownPrefill;
    const media: CachedMedia = {};
    if (typeof describer.cachedDescriptions === 'function') {
      media.descriptions = describer.cachedDescriptions(placeId, describableItems(messages));
    }
    if (typeof describer.cachedVideos === 'function') {
      const sites = config.media?.video?.sites;
      const items = messages.flatMap((m): Array<unknown> => collectVideos(m, { videoSites: sites }));
      if (items.length > 0) media.videos = await describer.cachedVideos(placeId, items);
    }
    return media;
  }

  /** Fire-and-forget like warmMediaCache: watch the message's first videos now, not when a turn needs it. */
  function warmVideoCache(placeId: string, normalized: MediaLine): void {
    const config = hot.config;
    // warmMediaCache calls this only with a describer.
    const media = describer as Describer;
    if (typeof media.describeVideos !== 'function') return;
    const candidates: Array<unknown> = collectVideos(normalized, { videoSites: config.media?.video?.sites }).slice(
      0,
      VIDEOS_PER_MESSAGE
    );
    if (candidates.length === 0) return;
    media
      .describeVideos(placeId, candidates)
      .catch((err: unknown) => log.warn('events: video cache prefill failed', { error: err }));
  }

  /**
   * Fire-and-forget like warmMediaCache: read the message's first readable
   * link now (src/web/lookup.ts), not when a turn needs it.
   */
  function warmLinkCache(placeId: string, normalized: MediaLine): void {
    if (typeof lookup?.readLinks !== 'function') return;
    const links: Array<unknown> = collectReadableLinks(normalized, {
      videoSites: hot.config.media?.video?.sites ?? [],
    }).slice(0, MAX_WARM_LINKS_PER_MESSAGE);
    if (links.length === 0) return;
    Promise.resolve()
      .then(() => lookup.readLinks?.(placeId, links, { maxNew: links.length }))
      .catch((err: unknown) => log.warn('events: link prefill failed', { error: err }));
  }

  return { warmMediaCache, cachedFollowUpMedia };
}
