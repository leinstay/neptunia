// The media describer: turns one picture (an image, a gif frame or a video
// poster — see src/media/classify.ts#isDescribable) into a plain one-line
// caption via a cheap vision-capable model, so the persona can react to what
// is on a picture it did not itself see (features.mediaDescriptions, on by
// default). One request per NEW picture: two callers reaching the same new
// picture at once (a message prefill and a turn) share one download and one
// request. Results are cached per
// attachment/embed id in data/places/<id>/media.json (src/memory/store.ts),
// LRU-trimmed to `MEDIA_CACHE_ENTRIES` (src/web/cache.ts). A failure is cached as a miss for an
// hour, so a broken picture is not retried on every turn/batch -- except a
// refusal by `llm.maxRequestsPerDay`, which says nothing about the picture.
// Once that cap is spent (llm.capLeft) nothing is downloaded
// and no miss is cached, so the pictures and
// videos of the last hours are still described after 00:00 UTC. Descriptions
// are data: never logged. A caption is capped at `media.descriptionChars`
// (the describe prompt may learn the cap through `{{maxChars}}`).
//
// The picture is downloaded first (src/media/fetch-image.ts) and sent to
// the model as a data: URL, never as a bare platform URL -- a platform's media host may refuse
// the provider's own fetcher even though our server
// fetches the same URL fine (see src/behavior/turn.js for the live-vision
// side of the same fix). A failed download costs nothing and is cached as a
// miss exactly like a failed LLM request.
//
// The same module watches videos (features.mediaDescriptions AND
// features.videoDescriptions -- a missing key counts as on -- like the senses
// line): an attached video or a link to a known video site
// (src/media/classify.ts#collectVideos)
// is fetched through src/media/fetch-video.ts -- or, for a video of at most
// `media.video.directUrlMaxSeconds` (less outside agentic processing, see
// lengthCap) on a site whose public URL the pinned
// provider can open itself (`media.video.directUrlSites`, and only when
// `media.video.provider` is a real provider object), passed by URL -- and
// summarised by a
// video-capable model into one line. A YouTube link goes out by its canonical
// `watch?v=<id>` URL, its playlist, timestamp and tracking params dropped
// (src/media/video-sites.ts#publicVideoUrl); another site's as posted. A
// public URL goes out with OpenRouter's
// processing mode (`media.video.urlProcessing`); every video request carries
// `media.video.reasoning` so reasoning does not eat the output budget. A link's duration comes from yt-dlp;
// when yt-dlp fails on a YouTube link, from the YouTube Data API (with a
// configured key) or the watch page (src/media/fetch-video.ts#probeYoutube).
// With no duration at all a direct-URL link is sent only when the owner
// opted in (`media.video.directUrlUnknownDuration`, billed as `maxSeconds`).
// Results share the picture cache under `video:<itemId>`: a watched summary,
// a `length` miss (a video over its cap whose clip download fails; it keeps
// the known `durationSec` and is retried once the live cap -- see lengthCap
// -- has grown to fit it, or when the duration is unknown), a permanent
// `size` miss, or an `error`
// miss (retried after `media.video.errorRetryMinutes`, default 60, or at
// once on a forced attempt -- describeVideo's `force`, used when the person
// asks to try a video that did not load again). Summaries are
// data: never logged. `checkYoutube()` probes one canary video to tell the
// operator which link of the YouTube duration chain works here.
//
// A downloaded clip (an attachment, a link's yt-dlp clip; never a public URL
// the provider opens itself, never a GIF) has its sound measured by the
// fetcher (`media.video.audioMap`, null or false = off); a clip with nothing
// audible gets `labels.videoAudio.none` and a mostly silent one
// `labels.videoAudio.map` with its audible stretches, appended to the video
// model's system prompt after a blank line, on a watch and a re-watch alike
// (src/media/audio-map.ts). A watched summary of a downloaded clip keeps
// the clip's length as `watchedSeconds`, so the transcript can tell a video
// watched only in part (src/media/classify.ts, `videoWatchedPart`).
//
// A summary is capped at `media.video.summaryChars` (the describe-video
// prompt learns the cap through `{{maxChars}}`). `rewatchVideo()` is the
// second look on a question (features.videoRewatch, a missing key counts as
// on): the same media fetch as a watch, asked one question through the
// `rewatch-answer` prompt. Its answer is cached for an hour under
// `video:<itemId>:q:<hash of the question>`, failures never. `relookImage()`
// is the same second look at a picture: the picture
// downloaded as for a caption, the question asked through the same prompt on
// the media model. Its answer is cached apart from the
// picture's caption, under `image:<itemId>:q:<hash>`. `rewatchGif()` is the
// same second look at a watched GIF (features.videoRewatch, GIFs watched now):
// its clip fetched again exactly as the GIF watch fetches it (the first
// `media.gif.maxSeconds`), the question asked through the same prompt on the
// video model. Its answer is cached for an
// hour under `gif:<itemId>:q:<hash>`. `watchedGifs()` tells, from the cache
// alone, which GIFs were watched (the re-watch classifier's candidates).
//
// A GIF is watched, not described from one still frame (`media.gif.watch`,
// a missing key counts as on, plus video vision on and the describe-gif or
// describe-video prompt, see src/memory/gif-watch.ts): its animation -- the
// mp4 of a tenor/giphy embed, an attached .gif, a .gif link -- is converted
// to a short mp4 (the first `media.gif.maxSeconds`) and summarised by the
// video model under the video request rails. The caption is cached under the
// GIF's own item id like a picture's (so the transcript, the analyzer and
// the GIF library read it unchanged), marked `watched: true`, with the
// answer's three fields beside it (`reaction`, `action`, `screen`: what reply
// the clip expresses, what visibly happens, its on-screen text; see
// parseGifDescription; stored whole, cut per field only where they are
// shown) for the `<gifs>` list and the transcript. A GIF that
// cannot be watched -- the switches, no animation, a spent daily rail, a
// failed fetch, conversion or request -- gets the one-frame description as
// before (marked `gif: true`, plus `watchFailed` when a watch failed). A
// cached one-frame caption is served as it is; only `watchGif()` (the
// owner's recache, src/memory/gif-recache.ts) replaces it -- or
// `media.recacheBefore`, below.
//
// Provenance and the recache rule. Every description the describer writes
// (a picture's caption -- an emoji and a sticker included --, a GIF watch, a
// video summary) carries `describedAt` (ms) and `model` (the model id the
// request asked for); a cache hit stamps `usedAt` (ms), so the owner's
// recache (src/memory/gif-recache.ts#startMedia) can tell recent use from
// the write time `ts`. With `media.recacheBefore` set (an ISO date-time, read
// at the moment of use; null = off) a cached description whose `describedAt`
// is missing or earlier is stale: it is treated as a miss and described
// again through the normal path, under every cap of a new one
// (`llm.maxRequestsPerDay`, the caller's `maxNew`). A failed attempt keeps the old text (better a stale
// description than none), stamps the entry `refreshFailedAt` and is not
// tried again for the miss TTL (an hour; `media.video.errorRetryMinutes` for
// a video); a refusal by the daily cap only serves the
// old text. A stale watched GIF is never replaced by a one-frame caption.

import { isRecord, propOf, isFiniteNumber } from './types.ts';
import { watchedLengths } from '../media/classify.ts';
import { createImageFetcher, VISION_MAX_BYTES } from '../media/fetch-image.ts';
import { createVideoFetcher } from '../media/fetch-video.ts';
import { audioMapSettings, videoAudioNote, withAudioNote } from '../media/audio-map.ts';
import { isDirectUrlSite, proxyFor, publicVideoUrl, safeLocation, youtubeVideoId } from '../media/video-sites.ts';
import {
  roleRequestOptions,
  railReason,
  VIDEO_TOKENS_PER_SECOND as STATIC_TOKENS_PER_SECOND_FALLBACK,
} from '../llm/openrouter.ts';
import { clampText, oneLine } from './clamp.ts';
import { roleModel, roleOn } from '../llm/roles.ts';
import { fillPromptTemplate } from '../behavior/prompt.ts';
import { createYoutubeCheck } from './youtube-check.ts';
import { gifWatchBlocker as gifWatchBlockerOf, gifWatchPrompt } from './gif-watch.ts';
import { log } from '../log.ts';
import { MINUTE_MS, utcDay } from '../time.ts';
import { MEDIA_CACHE_ENTRIES, hashedKey, touchKey, trimCache } from '../web/cache.ts';
import { normalizeQuery } from '../web/lookup.ts';
import type { StoredRecord, Untyped } from './types.ts';
import type { StoreView } from './store.ts';
import type { Track } from '../loop-watch.ts';
import { untracked } from '../loop-watch.ts';
import { isMediaDescriptionEntry } from './db/export.ts';

const MISS_TTL_MS = 60 * MINUTE_MS;
// Only when media.video.errorRetryMinutes is missing or invalid (config.json always has it).
const VIDEO_ERROR_RETRY_MINUTES_FALLBACK = 60;
// The describer's measures. Production values, config cut of 2026-10-31.
/** The length of a picture's or a GIF's caption. */
const DESCRIPTION_CHARS = 500;
/** The seconds of a GIF that are watched. */
const GIF_MAX_SECONDS = 15;
/** The length of the answer of a second look. */
const REWATCH_ANSWER_CHARS = 1200;
/**
 * The fixed fields of `media.video`, laid over the live section by videoSettingsOf: the summary's length, the
 * lengths a clip and a public URL may run, the clip's bytes, the per-second estimates, the sites whose videos go out
 * by their public URL, the processing mode of a public URL and the reasoning effort of a video request.
 */
const VIDEO_FIXED = Object.freeze({
  summaryChars: 1500,
  maxSeconds: 300,
  directUrlMaxSeconds: 3600,
  maxBytes: 14500000,
  tokensPerSecond: 120,
  directUrlTokensPerSecond: 10,
  directUrlSites: Object.freeze(['youtube.com', 'youtu.be']),
  urlProcessing: 'agentic',
  reasoning: Object.freeze({ effort: 'low' }),
});

/** The live `media.video` section with the fixed fields (VIDEO_FIXED) over it. */
function videoSettingsOf(config: Untyped) {
  return { ...(config?.media?.video ?? {}), ...VIDEO_FIXED };
}
const REWATCH_TTL_MS = 60 * MINUTE_MS;
const PERMANENT_VIDEO_MISSES = new Set(['length', 'size']);
/** What cachedPicture returns for a picture whose recent failure is still remembered. */
const FRESH_MISS = Symbol('fresh-miss');

/** The model a second look is asked of, when it is not the role's own. */
type Ask = { model?: string | null };

/** What a second look answers: the question as asked and the text, or null when there is nothing to look at. */
type Looked = Promise<{ question: string; text: string } | null>;

/** A picture, GIF or video the describer is asked about: its item id, its kind and where it is fetched from. */
export type MediaItem = {
  [field: string]: Untyped;
  itemId: string;
  kind: string;
  url: string;
  previewUrl?: string | null;
  source?: string | null;
};

/**
 * The file a GIF watch downloads: a gif embed's `animationUrl` (the mp4 of
 * a tenor/giphy embed, or a `.gif` link, see src/media/classify.ts#classifyEmbed),
 * else an attached gif's own file. Null for anything else -- a gif embed
 * with neither keeps the one-frame description.
 */
function gifAnimationSource(item: MediaItem) {
  if (item?.kind !== 'gif') return null;
  if (typeof item.animationUrl === 'string' && item.animationUrl) return item.animationUrl;
  if (item.source === 'attachment' && typeof item.url === 'string' && item.url) return item.url;
  return null;
}

/** The model role that describes `item`: a GIF or a video needs `video`, every other picture `vision`. */
function mediaRoleOf(item: MediaItem): string {
  return item.kind === 'gif' || item.kind === 'video' ? 'video' : 'vision';
}

/** Whether `item` is one collectVideos candidate (an attached video or a video-site link). */
function isVideoCandidate(item: MediaItem) {
  return (
    Boolean(item) &&
    (item.source === 'attachment' || item.source === 'link') &&
    Boolean(item.itemId) &&
    Boolean(item.url)
  );
}

/** Collapse every run of whitespace to one space, then cap at `maxChars` on a word boundary. */
function cleanVideoText(raw: Untyped, maxChars: Untyped) {
  return clampText(oneLine(raw), maxChars, { tolerance: 1 });
}

// One labelled line of a GIF watch's answer (prompts/describe-gif.md): `reaction:`, `action:`
// or `text:`, in any case, a list mark or bold markers around the label tolerated.
const GIF_FIELD_LINE = /^[\s*_•-]*(reaction|action|text)[\s*_]*:[\s*_]*(.*)$/i;
// The answer's word for an empty field, with an optional full stop.
const GIF_NONE = /^none\.?$/i;
// One pair of quotes around a whole value (the on-screen text is often quoted).
const QUOTE_PAIRS = [
  ['"', '"'],
  ['«', '»'],
  ['“', '”'],
  ['„', '“'],
  ["'", "'"],
  ['‘', '’'],
];

/** A field's value on one line, without one pair of surrounding quotes; '' for "none". */
function gifFieldValue(raw: Untyped) {
  let value = oneLine(raw);
  for (const [open, close] of QUOTE_PAIRS) {
    if (value.length >= 2 && value.startsWith(open) && value.endsWith(close)) {
      value = value.slice(open.length, -close.length).trim();
      break;
    }
  }
  return GIF_NONE.test(value) ? '' : value;
}

/**
 * A GIF watch's answer read as its three fields (prompts/describe-gif.md):
 * `reaction:`, `action:` and `text:` lines, labels in any case and any order,
 * a missing line read as empty, `none` read as empty, an unlabelled line after
 * a labelled one continuing that field. An answer with no label at all is the
 * action alone (an older prompt's one-line account, or describe-video's).
 * `reaction`, `action` and `screen` (the on-screen text) are kept whole, each
 * bounded only by `descriptionChars` (clampText, a hard limit): the readers
 * cut them per field at render time (`gifs.reactionChars` /
 * `gifs.actionChars`, src/behavior/prompt.js#gifFieldChars), so nothing is
 * lost in the cache. `text`, the line the transcript and every other
 * reader of the cache show, is the whole action -- the reaction, else the
 * on-screen text, when the answer gives no action -- on one line under
 * `descriptionChars` (clampText, a hard limit). Null when every field is
 * empty. Pure.
 * @param raw  The model's answer.
 */
export function parseGifDescription(
  raw: unknown,
  { descriptionChars }: { descriptionChars: number }
): { text: string; reaction: string; action: string; screen: string } | null {
  const source = String(raw ?? '');
  const fields: Record<string, Array<string>> = { reaction: [], action: [], text: [] };
  let current: string | null = null;
  let labelled = false;
  for (const line of source.split(/\r?\n/)) {
    const match = GIF_FIELD_LINE.exec(line);
    if (match) {
      current = match[1].toLowerCase();
      labelled = true;
      fields[current].push(match[2]);
    } else if (current && line.trim() !== '') {
      fields[current].push(line);
    }
  }
  const reactionWhole = labelled ? gifFieldValue(fields.reaction.join(' ')) : '';
  const actionWhole = labelled ? gifFieldValue(fields.action.join(' ')) : oneLine(source);
  const screenWhole = labelled ? gifFieldValue(fields.text.join(' ')) : '';
  const bound = (value: Untyped) => clampText(value, descriptionChars, { tolerance: 1 });
  const text = bound(actionWhole || reactionWhole || screenWhole);
  if (!text) return null;
  return { text, reaction: bound(reactionWhole), action: bound(actionWhole), screen: bound(screenWhole) };
}

/**
 * The cache key of one question's answer: `<prefix>:<itemId>:q:` (`video`
 * for a re-watch, `image` for a picture's second look, `gif` for a GIF's) and the sha1 prefix
 * of the question lower-cased and whitespace-collapsed (the search cache's
 * normalisation).
 */
function questionKey(itemId: string, question: Untyped, prefix = 'video') {
  return hashedKey(`${prefix}:${itemId}:q`, normalizeQuery(question));
}

/**
 * The URL a picture is downloaded from for the vision model: the item's `previewUrl`, the address the interface sized
 * for its platform (a picture at most `media.imageSize` long, a GIF as one still frame, a video as a poster frame),
 * else the item's own `url` exactly as it came (a sticker or emoji address is already sized by its own builder).
 */
function pictureImageUrl(item: MediaItem) {
  return item.previewUrl ?? item.url;
}

/** ≤200 chars, with any query string stripped -- an error message must never leak a signed URL. */
function safeDetail(message: Untyped) {
  return String(message ?? '')
    .replace(/\?[^\s'")]*/g, '')
    .slice(0, 200);
}

/** The log/outcome code of a failed request: a rail (`token-limit`, `daily-cap`) or `llm-error`. */
function requestFailureReason(err: Untyped) {
  return railReason(err, 'llm-error');
}

/**
 * Whether `item` is a link that may go out by its public URL: a pinned
 * provider object and a `directUrlSites` site.
 */
function isPinnableLink(item: Partial<MediaItem>, videoCfg: Untyped) {
  // An item whose source is a link always carries its url.
  return (
    item?.source === 'link' &&
    isRecord(videoCfg.provider) &&
    isDirectUrlSite(item.url as string, videoCfg.directUrlSites ?? [])
  );
}

/**
 * The length cap that applies to `item` under the live config: a pinnable
 * direct-URL link is sent by URL up to `directUrlMaxSeconds` (falling back
 * to `maxSeconds` when unset); anything else is clipped at `maxSeconds`.
 * With agentic processing `directUrlMaxSeconds * directUrlTokensPerSecond`
 * must stay under `media.video.maxRequestTokens` (3600 * 10 = 36 000 <
 * 60 000 by default), or every long direct-URL video trips the token rail.
 * With any other processing mode the request is estimated at
 * `tokensPerSecond`, so the cap is also held to what the video token cap
 * allows (60 000 / 120 = 500 s by default): a longer video takes the clip
 * route instead of being refused by the rail on every retry.
 */
function lengthCap(item: Partial<MediaItem>, videoCfg: Untyped, llmCfg: Untyped) {
  if (!isPinnableLink(item, videoCfg)) return videoCfg.maxSeconds;
  const cap = videoCfg.directUrlMaxSeconds ?? videoCfg.maxSeconds;
  if (urlProcessingMode(videoCfg) === 'agentic') return cap;
  const tokenSeconds = staticRequestSeconds(videoCfg, llmCfg);
  return tokenSeconds === null ? cap : Math.min(cap, tokenSeconds);
}

/**
 * How many seconds of video fit the pre-flight token cap at the static
 * per-second estimate: `floor(maxRequestTokens / tokensPerSecond)`, with the
 * same values the client then applies (`media.video.maxRequestTokens`, else
 * `llm.maxRequestTokens`; `tokensPerSecond`, else 300). Null when no cap is
 * known.
 */
function staticRequestSeconds(videoCfg: Untyped, llmCfg: Untyped) {
  const isPositive = (value: Untyped) => typeof value === 'number' && isFiniteNumber(value) && value > 0;
  const maxRequestTokens = isPositive(videoCfg.maxRequestTokens) ? videoCfg.maxRequestTokens : llmCfg?.maxRequestTokens;
  if (!isPositive(maxRequestTokens)) return null;
  const tokensPerSecond = isPositive(videoCfg.tokensPerSecond)
    ? videoCfg.tokensPerSecond
    : STATIC_TOKENS_PER_SECOND_FALLBACK;
  return Math.floor(maxRequestTokens / tokensPerSecond);
}

/** The processing mode a public URL goes out with (see videoPart), or null when the field is omitted. */
function urlProcessingMode(videoCfg: Untyped) {
  const mode = videoCfg.urlProcessing;
  return typeof mode === 'string' && mode ? mode : null;
}

/**
 * The lasting video state a media cache entry (`video:<item id>`) stands for, by the describer's
 * own rules, read-only: `{ state: 'watched', text, watchedSeconds?, totalSeconds? }` (the length of the
 * downloaded clip the summary was made from and a link's probed total, when the entry has them),
 * `{ state: 'limit', reason }` for a
 * permanent miss (`length`, `size`), or null -- no entry, an error miss (retried after
 * `media.video.errorRetryMinutes`, see describeVideo), or a `length` miss whose duration is
 * unknown or fits the length cap that applies to `item` now (a raised cap retries it). `item`
 * (a collectVideos candidate) only decides the cap: a pinnable direct-URL link has its own; without
 * one (a buffered message keeps no URL) the cap is VIDEO_FIXED's `maxSeconds`. Pure. Used by the
 * describer's cache lookup.
 * @param config  Live config (`media.video`, `llm`).
 */
export function videoStateFromCache(
  entry: StoredRecord,
  config: StoredRecord,
  item: Partial<MediaItem> = {}
):
  | { state: 'watched'; text: string; watchedSeconds?: number; totalSeconds?: number }
  | { state: 'limit'; reason: string }
  | null {
  if (!entry) return null;
  // An entry from before watchedSeconds / totalSeconds were stored renders as watched whole.
  if (entry.watched) return { state: 'watched', text: entry.text, ...watchedLengths(entry) };
  if (!entry.miss || !PERMANENT_VIDEO_MISSES.has(entry.reason)) return null;
  if (entry.reason === 'length') {
    // An unknown duration (older entries included) costs one probe to learn.
    if (typeof entry.durationSec !== 'number') return null;
    if (entry.durationSec <= lengthCap(item, videoSettingsOf(config), config?.llm)) return null;
  }
  return { state: 'limit', reason: entry.reason };
}

/**
 * `media.recacheBefore` as epoch ms: an ISO date-time string, else null (off) -- null, a
 * missing key, a non-string or an unparsable value alike. Pure.
 * @param config  The live config.
 */
export function recacheCutoffMs(config: StoredRecord): number | null {
  const value = config?.media?.recacheBefore;
  if (typeof value !== 'string' || value === '') return null;
  const ms = Date.parse(value);
  return isFiniteNumber(ms) ? ms : null;
}

/**
 * Whether a cached description is stale under the cutoff `cutoffMs` (recacheCutoffMs): its
 * `describedAt` is missing or earlier. With no cutoff nothing is. Pure.
 * @param entry  A media cache entry.
 */
export function isStaleDescription(entry: StoredRecord, cutoffMs: number | null): boolean {
  if (typeof cutoffMs !== 'number' || !isFiniteNumber(cutoffMs)) return false;
  const at = entry?.describedAt;
  return !(typeof at === 'number' && isFiniteNumber(at) && at >= cutoffMs);
}

type DescribeManyOptions = { maxNew?: number; concurrency?: number; onCharge?: (r: Untyped) => void };

type DescriberDeps = {
  hot: { readonly config: Untyped; readonly prompts: Untyped };
  store: Pick<StoreView, 'getMediaCache' | 'markMediaCacheDirty' | 'state'> &
    Partial<Pick<StoreView, 'getMediaDescription' | 'rememberMediaDescription' | 'markMediaDescriptionRefreshFailed'>>;
  llm: Untyped;
  now?: () => number;
  imageFetcher?: Untyped;
  videoFetcher?: Untyped;
  state?: { data: Untyped; markDirty: () => void };
  youtubeApiKey?: string | null;
  videoProxy?: string | null;
  /** The event loop watch's `track` (src/loop-watch.ts); a description is a named operation. */
  track?: Track;
};

/**
 * The `video_url` part of a video request. A public URL (a pinned
 * direct-URL request) carries OpenRouter's processing mode
 * (`media.video.urlProcessing`, a missing key = 'agentic', a non-string or
 * empty value omits it) -- without it the provider samples a single frame;
 * a data: URL part never does.
 */
function videoPart(videoCfg: Untyped, media: Untyped) {
  const videoUrl: Record<string, Untyped> = { url: media.url };
  if (media.pinned) {
    const mode = urlProcessingMode(videoCfg);
    if (mode) videoUrl.processing = mode;
  }
  return { type: 'video_url', video_url: videoUrl };
}

/**
 * The per-second token estimate of a public URL in agentic processing
 * (`media.video.directUrlTokensPerSecond`), or undefined for every other
 * request -- a data: URL clip, a public URL in another or no processing
 * mode, a missing or invalid setting -- which then keeps the client's
 * `media.video.tokensPerSecond`. Agentic processing does not bill the video
 * as prompt tokens; its exploration shows up as a few completion tokens per
 * second of video.
 */
function videoTokensPerSecond(videoCfg: Untyped, media: Untyped) {
  if (!media.pinned || urlProcessingMode(videoCfg) !== 'agentic') return undefined;
  const value = videoCfg.directUrlTokensPerSecond;
  return typeof value === 'number' && isFiniteNumber(value) && value > 0 ? value : undefined;
}

/** Cache access promotes one durable media payload while preserving the shared LRU and retry policy. */
function mediaCacheAccess({ store, hot, now }: Pick<DescriberDeps, 'store' | 'hot'> & { now: () => number }) {
  /**
   * Whether a cached description must be described again now: stale under
   * the live `media.recacheBefore` (isStaleDescription) and no failed attempt
   * (`refreshFailedAt`) younger than `ttlMs`.
   */
  function dueForRecache(entry: Untyped, ttlMs: Untyped) {
    if (!isStaleDescription(entry, recacheCutoffMs(hot.config))) return false;
    const failedAt = entry.refreshFailedAt;
    return !(typeof failedAt === 'number' && isFiniteNumber(failedAt) && now() - failedAt < ttlMs);
  }

  /** A cache hit: LRU-touched and stamped `usedAt`, the place's cache marked dirty. */
  function touchHit(placeId: string, cache: Untyped, key: string, entry: Untyped) {
    entry.usedAt = now();
    touchKey(cache, key, entry);
    store.markMediaCacheDirty(placeId);
  }

  function readEntry(placeId: string, key: string): Untyped {
    const cache = store.getMediaCache(placeId);
    if (Object.hasOwn(cache, key)) return cache[key];
    const saved = store.getMediaDescription?.(placeId, key);
    if (!saved) return undefined;
    touchKey(cache, key, saved);
    trimCache(cache, MEDIA_CACHE_ENTRIES);
    store.markMediaCacheDirty(placeId);
    return saved;
  }
  return { dueForRecache, touchHit, readEntry };
}

/** The picture prompt is read at use so an owner reload takes effect on the next request. */
function pictureBlockerOf(hot: DescriberDeps['hot']): 'no-prompt' | null {
  return hot.prompts?.describe ? null : 'no-prompt';
}

// health: allow function-length until 2027-04-01 -- the closure holds its whole operation, grown by the one dependency that names the loop watch
function buildDescriber({
  hot,
  store,
  llm,
  now = Date.now,
  imageFetcher = createImageFetcher(),
  videoFetcher = createVideoFetcher(),
  youtubeApiKey = null,
  videoProxy = null,
  track = untracked,
}: DescriberDeps) {
  /** Today's UTC date as `YYYY-MM-DD` from the injected clock: the daily counters and the prompts' `{{today}}`. */
  function todayDate() {
    return utcDay(now());
  }

  /**
   * Whether `llm.maxRequestsPerDay` is spent today (the client's read-only
   * `capLeft`): the next counted request would be refused, so nothing is
   * downloaded, reserved or cached for it. A client without `capLeft` never is.
   */
  function capSpent() {
    return typeof llm?.capLeft === 'function' && llm.capLeft() <= 0;
  }

  /** Whether pictures are described under the live prompts (the describe prompt is there). */
  function picturesOn() {
    return pictureBlockerOf(hot) === null;
  }

  const { dueForRecache, touchHit, readEntry } = mediaCacheAccess({ store, hot, now });

  /**
   * The cached state of one picture, synchronously: `{ result, stale, entry }`
   * for a caption (`result` a describe() result, `cached: true`; the entry
   * LRU-touched; `stale` when media.recacheBefore wants it described again,
   * see dueForRecache), FRESH_MISS while a failure younger than an hour is
   * remembered, or null when it must be described.
   */
  function cachedPicture(placeId: string, itemId: string) {
    const cache = store.getMediaCache(placeId);
    const cached = readEntry(placeId, itemId);
    if (!cached) return null;
    if (cached.miss) return now() - cached.ts < MISS_TTL_MS ? FRESH_MISS : null;
    touchHit(placeId, cache, itemId, cached);
    const result = { text: cached.text, usage: null, estimated: 0, cached: true };
    return { result, stale: dueForRecache(cached, MISS_TTL_MS), entry: cached };
  }

  // One in-flight description per place + picture: a message prefill and a
  // turn that reach the same new picture at once share one download and one request.
  const pictureFlights = new Map();

  /**
   * describe() with describeMany's accounting: `joined` is true when this
   * call waited on another caller's description of the same picture (its
   * request was not this call's).
   */
  async function describeShared(placeId: string, item: MediaItem) {
    if (!picturesOn()) return { result: null, joined: false };
    const hit = cachedPicture(placeId, item.itemId);
    if (hit === FRESH_MISS) return { result: null, joined: false };
    if (hit && !hit.stale) return { result: hit.result, joined: false };
    // A stale caption (media.recacheBefore) is described again; its old text is the fallback.
    const kept = hit?.result ?? null;
    const flightKey = `${placeId}:${item.itemId}`;
    const running = pictureFlights.get(flightKey);
    if (running) return { result: (await running) ?? kept, joined: true };
    if (capSpent()) return { result: kept, joined: false };
    const promise = describeNow(placeId, item, hit?.entry ?? null).finally(() => pictureFlights.delete(flightKey));
    pictureFlights.set(flightKey, promise);
    return { result: await promise, joined: false };
  }

  /**
   * Describe one picture again whatever its cache holds, for the owner's
   * recache (src/memory/gif-recache.ts#startMedia): the normal uncached path
   * (describeNow, a GIF watched first), every rail of a new description. A
   * cached caption is the fallback: a failure keeps it (stamped
   * `refreshFailedAt`). Joins a description of the same picture already in
   * flight.
   * @param item  One collectPictures / collectEmojiItems item.
   *   `unavailable`: pictures are not described now (pictureBlocker) or `llm.maxRequestsPerDay` is spent.
   */
  async function redescribe(
    placeId: string,
    item: MediaItem
  ): Promise<{ state: 'done' } | { state: 'failed' } | { state: 'unavailable'; reason: string }> {
    const blocker = pictureBlockerOf(hot);
    if (blocker !== null) return { state: 'unavailable', reason: blocker };
    if (capSpent()) return { state: 'unavailable', reason: 'daily-cap' };
    const flightKey = `${placeId}:${item.itemId}`;
    let promise = pictureFlights.get(flightKey);
    if (!promise) {
      const entry = readEntry(placeId, item.itemId);
      const previous = entry && !entry.miss && typeof entry.text === 'string' && entry.text ? entry : null;
      promise = describeNow(placeId, item, previous).finally(() => pictureFlights.delete(flightKey));
      pictureFlights.set(flightKey, promise);
    }
    const result = await promise;
    if (result && !result.kept) return { state: 'done' };
    // The request itself may have been the one the daily cap refused.
    if (capSpent()) return { state: 'unavailable', reason: 'daily-cap' };
    return { state: 'failed' };
  }

  /**
   * One picture's caption through the cache. A new picture is described once
   * even when several callers reach it at once (they share the result); with
   * `llm.maxRequestsPerDay` spent it is not downloaded and nothing is cached.
   * Every request counts against that cap.
   * @param item  See
   *   src/media/classify.ts#collectPictures.
   */
  async function describe(
    placeId: string,
    item: { itemId: string; kind: string; url: string }
  ): Promise<{ text: string; usage: Untyped; estimated: number; cached?: boolean } | null> {
    return (await describeShared(placeId, item)).result;
  }

  /**
   * The uncached part of describe(): the GIF watch, else the download and
   * the request; the cache is written here. `previous` is the cached entry
   * being described again (a stale or recached caption), else null: on a
   * failure it is kept (its text returned as a cached result marked `kept`,
   * the entry stamped `refreshFailedAt` unless the daily cap refused the
   * request) instead of a miss being cached.
   */
  async function describeNow(placeId: string, item: MediaItem, previous: Untyped = null) {
    const promptText = hot.prompts?.describe;
    if (!promptText) return null;
    const mediaCfg = hot.config.media ?? {};
    const descriptionChars = DESCRIPTION_CHARS;
    const cache = store.getMediaCache(placeId);

    // The old caption kept on a failure, its entry stamped when `mark` is set.
    const keepPrevious = (mark: Untyped) => {
      if (mark) {
        store.markMediaDescriptionRefreshFailed?.(placeId, item.itemId, now());
        touchKey(cache, item.itemId, { ...previous, refreshFailedAt: now() });
        store.markMediaCacheDirty(placeId);
      }
      return { text: previous.text, usage: null, estimated: 0, cached: true, kept: true };
    };

    // A GIF is watched like a short video first (see watchGifShared); one
    // that cannot be watched, or whose watch fails, keeps the one-frame
    // description below -- never nothing. A watched caption described again
    // is never replaced by one frame: it is kept instead.
    let watchFailed = false;
    if (item.kind === 'gif') {
      const watched = await watchGifShared(placeId, item);
      if (watched?.state === 'watched') {
        return { text: watched.text, usage: watched.usage ?? null, estimated: watched.estimated ?? 0 };
      }
      if (previous?.watched === true) return keepPrevious(watched?.reason !== 'daily-cap');
      watchFailed = watched?.state === 'failed';
    }

    // The interface's preview address when it gave one, else the item's own URL (pictureImageUrl).
    const imageUrl = pictureImageUrl(item);

    // A failure: the previous caption kept, else a miss cached (`mark` false: the daily cap, nothing cached).
    const fail = (mark = true) => {
      if (previous) return keepPrevious(mark);
      if (mark) {
        touchKey(cache, item.itemId, { miss: true, ts: now() });
        trimCache(cache, MEDIA_CACHE_ENTRIES);
        store.markMediaCacheDirty(placeId);
      }
      return null;
    };

    const visionCfg = hot.config.context?.vision ?? {};
    const downloaded = await imageFetcher.fetchAsDataUrl(imageUrl, {
      maxBytes: VISION_MAX_BYTES,
      timeoutMs: visionCfg.fetchTimeoutMs,
    });
    if (!downloaded) {
      log.warn('describe: failed', { kind: item.kind, reason: 'download' });
      return fail();
    }

    const model = roleModel(hot.config, 'vision', 'describe');
    let completion;
    try {
      completion = await llm.complete(
        [
          {
            role: 'system',
            content: fillPromptTemplate(promptText, { maxChars: descriptionChars, today: todayDate() }),
          },
          { role: 'user', content: [{ type: 'image_url', image_url: { url: downloaded.dataUrl } }] },
        ],
        // An in-turn `vision` request (llm.analyzerTimeoutMs, counted, never calibrated: the
        // rail estimates the picture at a flat context.vision.tokensPerImage while
        // the vision model counts far more).
        {
          model,
          ...roleRequestOptions(hot.config, {
            role: 'vision',
            maxOutputTokens: mediaCfg.maxOutputTokens,
            purpose: 'describe',
          }),
        }
      );
    } catch (err) {
      const reason = requestFailureReason(err);
      log.warn('describe: failed', {
        kind: item.kind,
        reason,
        status: propOf(err, 'statusCode'),
        detail: safeDetail(propOf(err, 'message')),
      });
      // A refusal by the daily cap says nothing about the picture: described after the reset.
      return fail(reason !== 'daily-cap');
    }

    // First line only, hard-capped on a word boundary (never mid-token).
    const firstLine = String(completion.text ?? '')
      .trim()
      .split('\n')[0];
    const text = clampText(firstLine, descriptionChars, { tolerance: 1 });

    if (!text) {
      log.warn('describe: failed', { kind: item.kind, reason: 'empty' });
      return fail();
    }

    // A GIF's one-frame caption is marked (`gif`) so the recache can find it
    // (src/memory/gif-recache.ts), and `watchFailed` when a watch was tried.
    const ts = now();
    const entry: Record<string, Untyped> = { text, ts, describedAt: ts, model };
    if (item.kind === 'gif') entry.gif = true;
    if (watchFailed) entry.watchFailed = entry.ts;
    if (isMediaDescriptionEntry(entry)) store.rememberMediaDescription?.(placeId, item.itemId, entry);
    touchKey(cache, item.itemId, entry);
    trimCache(cache, MEDIA_CACHE_ENTRIES);
    store.markMediaCacheDirty(placeId);
    return { text, usage: completion.usage ?? null, estimated: completion.estimated ?? 0 };
  }

  /**
   * Why GIFs are not watched under the live config and prompts, or null when
   * they are: `off`, `video-off` or `no-prompt` (src/memory/gif-watch.ts#gifWatchBlocker).
   */
  function gifWatchBlocker(): 'off' | 'video-off' | 'no-prompt' | null {
    return gifWatchBlockerOf(hot.prompts);
  }

  /**
   * One GIF watch, uncached: the animation at `source` is downloaded and
   * converted to a short mp4 (src/media/fetch-video.ts#fetchGif, the first
   * `media.gif.maxSeconds`, the video size and tool settings), then
   * summarised by the video model through the `describe-gif` prompt
   * (`{{maxChars}}` = `media.descriptionChars` -- a GIF caption keeps a
   * picture caption's length -- and `{{seconds}}` = `media.gif.maxSeconds`),
   * else the `describe-video` prompt with `{{maxChars}}` alone as before;
   * under the video token cap and output budget. The answer is read as three fields (parseGifDescription,
   * each kept whole under `media.descriptionChars`) and cached under the
   * GIF's own item id as `{ text, reaction, action, screen, ts, watched: true,
   * gif: true }`; nothing is cached otherwise.
   * Resolves `{ state: 'watched', text, usage, estimated }`, `{ state:
   * 'failed', reason }` (the fetch, the conversion, the request or an empty
   * answer) or `{ state: 'unavailable', reason: 'daily'|'daily-cap' }` (a
   * daily rail is spent: no failure of this GIF; with `llm.maxRequestsPerDay`
   * spent before the watch, nothing is fetched). One
   * `describe: gif` log line, codes only.
   */
  async function watchGifNow(placeId: string, item: MediaItem, source: Untyped) {
    const videoCfg = videoSettingsOf(hot.config);
    const maxSeconds = GIF_MAX_SECONDS;
    const descriptionChars = DESCRIPTION_CHARS;
    const report = <const TOutcome extends { state: string; reason?: string }>(
      outcome: TOutcome,
      extra: Record<string, Untyped> = {}
    ): TOutcome => {
      log.info('describe: gif', {
        state: outcome.state,
        reason: outcome.reason ?? null,
        seconds: extra.seconds ?? null,
        bytes: extra.bytes ?? null,
        status: propOf(extra, 'status'),
        location: safeLocation(source),
      });
      return outcome;
    };

    // The request would be refused: no fetch, no GIF slot.
    if (capSpent()) return report({ state: 'unavailable', reason: 'daily-cap' });

    const fetched = await fetchGifClip(source, maxSeconds);
    if (!fetched.ok) return report({ state: 'failed', reason: fetched.reason });

    const { clip } = fetched;
    const sizes = { seconds: clip.seconds, bytes: fetched.bytes };
    const options = videoRequestOptions(videoCfg, clip, { maxOutputTokens: videoCfg.maxOutputTokens });
    let completion;
    try {
      completion = await llm.complete(
        [
          { role: 'system', content: gifSystemPrompt(descriptionChars, maxSeconds) },
          { role: 'user', content: [videoPart(videoCfg, clip)] },
        ],
        options
      );
    } catch (err) {
      const reason = requestFailureReason(err);
      if (reason === 'daily-cap') return report({ state: 'unavailable', reason }, sizes);
      return report({ state: 'failed', reason }, { ...sizes, status: propOf(err, 'statusCode') });
    }

    const fields = parseGifDescription(completion.text, { descriptionChars });
    if (!fields) return report({ state: 'failed', reason: 'empty' }, sizes);
    const { text, reaction, action, screen } = fields;
    const ts = now();
    putVideoEntry(
      placeId,
      item.itemId,
      {
        text,
        reaction,
        action,
        screen,
        ts,
        watched: true,
        gif: true,
        describedAt: ts,
        model: options.model,
      },
      true
    );
    report({ state: 'watched' }, sizes);
    return { state: 'watched', text, usage: completion.usage ?? null, estimated: completion.estimated ?? 0 };
  }

  /**
   * Download the animation at `source` and convert it to a short mp4
   * (src/media/fetch-video.ts#fetchGif: the first `maxSeconds`, the video
   * size and tool settings read now) -- the one fetch of a GIF watch and of
   * its second look. `{ ok: true, clip: { url, seconds, pinned: false },
   * bytes }` (`seconds` never above `maxSeconds`) or `{ ok: false, reason }`.
   */
  async function fetchGifClip(
    source: Untyped,
    maxSeconds: number
  ): Promise<
    | { ok: false; reason: string }
    | { ok: true; clip: { url: string; seconds: number; pinned: boolean }; bytes: number | null }
  > {
    const videoCfg = videoSettingsOf(hot.config);
    const media = await videoFetcher.fetchGif(source, {
      maxSeconds,
      maxBytes: videoCfg.maxBytes,
      toolTimeoutMs: videoCfg.toolTimeoutMs,
      ffmpegPath: videoCfg.ffmpegPath,
      fetchTimeoutMs: hot.config.context?.vision?.fetchTimeoutMs,
    });
    if (!media.ok) return { ok: false, reason: media.reason ?? 'download' };
    const clip = { url: media.dataUrl, seconds: Math.min(media.seconds ?? maxSeconds, maxSeconds), pinned: false };
    return { ok: true, clip, bytes: media.bytes ?? null };
  }

  /**
   * The system message of a GIF watch: `describe-gif` with `{{maxChars}}`,
   * `{{seconds}}` and `{{today}}`, else `describe-video` exactly as a GIF got
   * it before (`{{maxChars}}`, `{{today}}`). Read at the moment of use.
   */
  function gifSystemPrompt(maxChars: Untyped, seconds: Untyped) {
    const prompt = gifWatchPrompt(hot.prompts);
    const values: Record<string, Untyped> = { maxChars, today: todayDate() };
    if (prompt?.name === 'describe-gif') values.seconds = seconds;
    return fillPromptTemplate(prompt?.text, values);
  }

  /**
   * watchGifNow behind the switches and the in-flight guard: null when GIFs
   * are not watched now (gifWatchBlocker) or the item has no animation to
   * download (gifAnimationSource); otherwise the outcome, shared with any
   * caller already watching the same GIF of the same place.
   */
  function watchGifShared(placeId: string, item: MediaItem) {
    if (gifWatchBlocker() !== null) return null;
    const source = gifAnimationSource(item);
    if (!source) return null;
    const flightKey = `${placeId}:gif:${item.itemId}`;
    const running = inFlight.get(flightKey);
    if (running) return running;
    const promise = watchGifNow(placeId, item, source).finally(() => inFlight.delete(flightKey));
    inFlight.set(flightKey, promise);
    return promise;
  }

  /** Mark a GIF's cache entry as a failed watch (`watchFailed`): its caption, if any, is kept. */
  function markGifWatchFailed(placeId: string, itemId: string) {
    const cache = store.getMediaCache(placeId);
    const entry = cache[itemId];
    const ts = now();
    const next =
      entry && !entry.miss && typeof entry.text === 'string' && entry.text
        ? { ...entry, watchFailed: ts }
        : { miss: true, ts, gif: true, watchFailed: ts };
    putVideoEntry(placeId, itemId, next);
  }

  /**
   * Re-describe one GIF by watching it, for the recache
   * (src/memory/gif-recache.ts): an entry already watched with its three
   * fields (`reaction` present) is served from the cache; any other cached
   * caption (a one-frame one, or a watched one of the older one-line format)
   * is ignored and, when
   * the watch succeeds, replaced -- under the same item id, so nothing else
   * has to change. A failed watch never falls back to one frame here: the
   * old caption stays and the entry is marked `watchFailed` (a GIF with no
   * caption gets a miss so marked). Every rail of watchGifNow applies.
   * @param item  A gif picture item (src/media/classify.ts#collectPictures).
   *   `unavailable`: GIFs are not watched now (see gifWatchBlocker) or a daily rail is spent.
   */
  async function watchGif(
    placeId: string,
    item: MediaItem
  ): Promise<
    | { state: 'watched'; text: string; cached?: true }
    | { state: 'failed'; reason: string }
    | { state: 'unavailable'; reason: string }
  > {
    const blocker = gifWatchBlocker();
    if (blocker !== null) return { state: 'unavailable', reason: blocker };
    const cached = readEntry(placeId, item.itemId);
    // An old-format watched entry (no `reaction` field) is watched again for its three fields.
    if (cached?.watched && typeof cached.text === 'string' && typeof cached.reaction === 'string') {
      return { state: 'watched', text: cached.text, cached: true };
    }
    if (!gifAnimationSource(item)) {
      markGifWatchFailed(placeId, item.itemId);
      log.info('describe: gif', { state: 'failed', reason: 'source' });
      return { state: 'failed', reason: 'source' };
    }
    const outcome = await watchGifShared(placeId, item);
    if (outcome.state === 'failed') markGifWatchFailed(placeId, item.itemId);
    if (outcome.state === 'watched') return { state: 'watched', text: outcome.text };
    return { state: outcome.state, reason: outcome.reason };
  }

  /**
   * Describe up to `maxNew` NEW (non-cached) pictures of `items`. The first
   * `maxNew` items without a cached caption or a fresh miss are picked up
   * front, in the order given, and every picked item counts toward `maxNew`
   * whether its description succeeds or fails -- so a run of broken pictures
   * never turns into a run of requests. The picked items are described in
   * parallel, at most `concurrency` at a time (every one at once by default);
   * cached captions anywhere in `items` are filled in without counting, and
   * an item listed twice is looked at once. Nothing is picked while
   * `llm.maxRequestsPerDay` is spent (see describe()).
   * Returns `{ descriptions, newCount }` -- `descriptions` maps `itemId` to
   * caption text, ready to hand to formatTranscript's `descriptions` option;
   * `newCount` is the number of picked items.
   * `onCharge(result)` is called once per successful NEW request of this call
   * (never for a cache hit or a description shared with another caller) so a
   * caller with its own separate token budget can account for it.
   */
  async function describeMany(
    placeId: string,
    items: Array<MediaItem>,
    { maxNew = Infinity, concurrency = Infinity, onCharge }: DescribeManyOptions = {}
  ): Promise<{ descriptions: Map<string, string>; newCount: number }> {
    const found = new Map();
    const picked: Array<Untyped> = [];
    const seen = new Set();
    const on = picturesOn();
    const spent = on && capSpent();
    for (const item of on ? (items ?? []) : []) {
      if (!item?.itemId || seen.has(item.itemId) || !roleOn(hot.config, mediaRoleOf(item))) continue;
      seen.add(item.itemId);
      const hit = cachedPicture(placeId, item.itemId);
      if (hit === FRESH_MISS) continue;
      // A stale caption (media.recacheBefore) is picked like a new picture;
      // past `maxNew` (or with the cap spent) its old text is served.
      if (hit && !hit.stale) found.set(item.itemId, hit.result.text);
      else if (!spent && picked.length < maxNew) picked.push(item);
      else if (hit) found.set(item.itemId, hit.result.text);
    }

    let next = 0;
    const worker = async () => {
      while (next < picked.length) {
        const item = picked[next];
        next += 1;
        const { result, joined } = await describeShared(placeId, item);
        if (!result) continue;
        if (!result.cached && !joined) onCharge?.(result);
        found.set(item.itemId, result.text);
      }
    };
    const limit = isFiniteNumber(concurrency) && concurrency >= 1 ? Math.floor(concurrency) : picked.length;
    await Promise.all(Array.from({ length: Math.min(limit, picked.length) }, worker));

    // In the order of `items`, whatever order the requests came back in.
    const descriptions = new Map();
    for (const id of seen) if (found.has(id)) descriptions.set(id, found.get(id));
    return { descriptions, newCount: picked.length };
  }

  /**
   * The captions the media cache already holds for `items`, never a
   * download or a request, never a daily count: `itemId` -> caption text,
   * ready for formatTranscript's `descriptions` option. Misses and unknown
   * items are left out; a hit is LRU-touched as describe() does. Empty
   * when describe() would not run (features.mediaDescriptions off, no
   * describe prompt). Used where a caption helps but may not cost a request
   * (the address classifier, src/behavior/pipeline.js).
   */
  function cachedDescriptions(placeId: string, items: Array<MediaItem>): Map<string, string> {
    const descriptions = new Map();
    if (!hot.prompts?.describe) return descriptions;
    const cache = store.getMediaCache(placeId);
    for (const item of items ?? []) {
      const entry = item?.itemId ? readEntry(placeId, item.itemId) : undefined;
      if (!entry || entry.miss || typeof entry.text !== 'string' || !entry.text) continue;
      touchHit(placeId, cache, item.itemId, entry);
      descriptions.set(item.itemId, entry.text);
    }
    return descriptions;
  }

  // One in-flight watch per place + video: a message prefill and a turn that
  // reach the same new video at once share one request.
  const inFlight = new Map();

  /** Store a video cache entry, LRU-touched and trimmed like the picture entries. */
  function putVideoEntry(placeId: string, key: string, value: Untyped, generated = false) {
    if (generated && isMediaDescriptionEntry(value)) store.rememberMediaDescription?.(placeId, key, value);
    const cache = store.getMediaCache(placeId);
    touchKey(cache, key, value);
    trimCache(cache, MEDIA_CACHE_ENTRIES);
    store.markMediaCacheDirty(placeId);
  }

  /**
   * The cached state under `key`, or null when the video must be (re)watched:
   * the lasting states by videoStateFromCache (a watched entry is LRU-touched;
   * a `length` miss of unknown duration, or one that fits the cap now, is
   * absent so a raised cap retries it), plus an error miss, which counts only
   * for `media.video.errorRetryMinutes` (read now) and never when `force` is set.
   * A watched summary that media.recacheBefore wants watched again
   * (dueForRecache, the error retry time as its TTL) comes with `stale`: its
   * cache entry.
   */
  function cachedVideo(placeId: string, key: string, item: MediaItem, force = false) {
    const cache = store.getMediaCache(placeId);
    const entry = readEntry(placeId, key);
    if (!entry) return null;
    const lasting = videoStateFromCache(entry, hot.config, item);
    if (lasting?.state === 'watched') {
      touchHit(placeId, cache, key, entry);
      const result = { ...lasting, usage: null, estimated: 0, cached: true };
      return dueForRecache(entry, videoErrorTtlMs()) ? { ...result, stale: entry } : result;
    }
    if (lasting) return lasting;
    if (entry.miss && PERMANENT_VIDEO_MISSES.has(entry.reason)) return null; // a length miss to retry
    if (entry.miss && !force && now() - entry.ts < videoErrorTtlMs()) return { state: 'error' };
    return null;
  }

  /** How long a video error miss is served from the cache: `media.video.errorRetryMinutes`, read at the moment of use. */
  function videoErrorTtlMs() {
    const minutes = hot.config.media?.video?.errorRetryMinutes;
    const valid = typeof minutes === 'number' && isFiniteNumber(minutes) && minutes >= 0;
    return (valid ? minutes : VIDEO_ERROR_RETRY_MINUTES_FALLBACK) * MINUTE_MS;
  }

  /**
   * The system prompt of a video request on `media` (a watch or a re-watch):
   * `filled` plus the measured-sound note of a downloaded clip
   * (audio-map.js#videoAudioNote on the live `labels.videoAudio`), after a
   * blank line; `filled` alone without one.
   */
  function videoSystemPrompt(filled: Untyped, media: Untyped) {
    return withAudioNote(filled, videoAudioNote(media.audio, hot.prompts?.labels));
  }

  /**
   * The `llm.complete` options of a video request (a watch or a re-watch):
   * the video model and timeout, the video-only token cap, the per-second
   * estimate of an agentic public URL, the pinned provider only for a public
   * URL, the reasoning settings (`media.video.reasoning`, a plain object or
   * nothing), never the text calibration.
   */
  function videoRequestOptions(
    videoCfg: Untyped,
    media: Untyped,
    { maxOutputTokens, model = null }: { maxOutputTokens: number; model?: string | null }
  ) {
    return {
      model: model ?? roleModel(hot.config, 'video'),
      role: 'video',
      maxOutputTokens,
      timeoutMs: videoCfg.timeoutMs,
      videoSeconds: media.seconds ?? videoCfg.maxSeconds,
      videoTokensPerSecond: videoTokensPerSecond(videoCfg, media),
      // Video requests have their own pre-flight cap; every other caller
      // stays under the global llm.maxRequestTokens.
      maxRequestTokens: videoCfg.maxRequestTokens,
      provider: media.pinned ? videoCfg.provider : undefined,
      // Without it the video model's reasoning can eat the whole output budget.
      reasoning: isRecord(videoCfg.reasoning) ? videoCfg.reasoning : undefined,
      countAgainstDailyCap: true,
      // A video's provider-counted prompt tokens say nothing about the
      // text ratio every chat request is checked against.
      skipCalibration: true,
    };
  }

  /**
   * Get the media of one candidate: `{ ok: true, url, seconds, bytes, pinned, audio, totalSeconds? }`
   * (`totalSeconds`: a link clip's probed total length, null when unknown)
   * or `{ ok: false, reason }` (a `length` failure adds `durationSec`, null when unknown).
   * `audio` is the fetcher's measured sound of a downloaded clip
   * (`media.video.audioMap`, read now), null for a public URL, with measuring
   * off or after a failed measurement.
   */
  async function fetchVideoMedia(item: MediaItem, videoCfg: Untyped) {
    const { maxSeconds, maxBytes, toolTimeoutMs, ffmpegPath, ytdlpPath } = videoCfg;
    const audioMap = audioMapSettings();
    if (item.source === 'attachment') {
      const got = await videoFetcher.fetchAttachment(item.url, {
        durationSec: item.durationSec,
        maxSeconds,
        maxBytes,
        toolTimeoutMs,
        ffmpegPath,
        // A video file is downloaded under the video tools' timeout, never a picture's (context.vision.fetchTimeoutMs):
        // a large clip on a slow CDN outlives ten seconds.
        audioMap,
      });
      if (got.ok) {
        return {
          ok: true,
          url: got.dataUrl,
          seconds: got.seconds,
          bytes: got.bytes,
          pinned: false,
          audio: got.audio ?? null,
        };
      }
      if (got.reason === 'length') {
        return { ok: false, reason: 'length', durationSec: isFiniteNumber(got.durationSec) ? got.durationSec : null };
      }
      return got;
    }
    // Only the listed sites go through the proxy (media.video.proxySites).
    const proxy = proxyFor(item.url, videoCfg, videoProxy);
    const { proxyRetryMinutes } = videoCfg;
    let probe = await videoFetcher.probeSite(item.url, { ytdlpPath, toolTimeoutMs, proxy, proxyRetryMinutes });
    // yt-dlp can be blocked by YouTube's bot check; the duration alone is
    // still learnable from the Data API or the watch page.
    if (!probe.ok && youtubeVideoId(item.url) !== null) {
      const youtube = await videoFetcher.probeYoutube(item.url, {
        fetchTimeoutMs: hot.config.context?.vision?.fetchTimeoutMs,
        apiKey: youtubeApiKey,
      });
      if (youtube.ok) probe = youtube;
    }
    // The public URL goes out only with a pinned provider that can open it
    // (a YouTube link in its canonical watch form, see publicVideoUrl);
    // without one the clip is downloaded like any other site's.
    const pinnable = isPinnableLink(item, videoCfg);
    if (!probe.ok) {
      return probe;
    }
    const durationSec = probe.durationSec ?? item.durationSec ?? null;
    // A direct-URL video has its own cap (directUrlMaxSeconds, see lengthCap);
    // past it the clip route below still gets the first maxSeconds.
    if (pinnable && durationSec != null && durationSec <= lengthCap(item, videoCfg, hot.config.llm)) {
      return { ok: true, url: publicVideoUrl(item.url), seconds: durationSec, bytes: null, pinned: true };
    }
    const clip = await videoFetcher.fetchSiteClip(item.url, {
      ytdlpPath,
      ffmpegPath,
      maxSeconds,
      maxBytes,
      toolTimeoutMs,
      durationSec,
      proxy,
      proxyRetryMinutes,
      audioMap,
    });
    if (clip.ok) {
      return {
        ok: true,
        url: clip.dataUrl,
        seconds: clip.seconds,
        bytes: clip.bytes,
        pinned: false,
        audio: clip.audio ?? null,
        // The probed total: a link item seldom carries its own length.
        totalSeconds: typeof durationSec === 'number' && isFiniteNumber(durationSec) ? durationSec : null,
      };
    }
    // Too long and not clippable: the video will not get shorter, so this is final.
    // The duration is kept so a later, larger cap can retry it (cachedVideo).
    if (durationSec != null && durationSec > maxSeconds) return { ok: false, reason: 'length', durationSec };
    return clip;
  }

  /**
   * The uncached part of describeVideo: resolves `{ result, sent, attempted }`.
   * `sent` = a request reached the provider; `attempted` = the media was
   * fetched (or probed) at all, successful or not -- a daily cap alone is
   * not an attempt. With `llm.maxRequestsPerDay` spent nothing is fetched,
   * no video slot is taken and nothing is cached (`result` null), and a
   * request the cap refuses caches no miss either: the video is watched
   * after the reset. `forced` only marks the log line. `previous` (`{ entry,
   * result }`) is a stale watched summary being watched again: every failure
   * returns its result instead, a spent rail as it is, any other failure
   * with its entry stamped `refreshFailedAt` -- never a miss over it.
   */
  async function watchVideo(
    placeId: string,
    item: MediaItem,
    key: string,
    promptText: Untyped,
    forced = false,
    previous: Untyped = null
  ) {
    const videoCfg = videoSettingsOf(hot.config);
    const summaryChars = videoCfg.summaryChars;
    const report = (result: Untyped, extra: Record<string, Untyped> = {}) => {
      log.info('describe: video', {
        source: item.source,
        state: result.state,
        reason: result.reason ?? extra.reason ?? null,
        seconds: extra.seconds ?? null,
        bytes: extra.bytes ?? null,
        status: propOf(extra, 'status'),
        // The measured sound of a downloaded clip (none / map / full), when measured.
        ...(extra.audio ? { audio: extra.audio } : {}),
        cached: false,
        location: safeLocation(item.url),
        ...(forced ? { forced: true } : {}),
      });
      return result;
    };
    // The stale summary kept, its entry stamped so it waits the error retry time.
    const keepPrevious = () => {
      store.markMediaDescriptionRefreshFailed?.(placeId, key, now());
      putVideoEntry(placeId, key, { ...previous.entry, refreshFailedAt: now() });
      return previous.result;
    };
    const errorMiss = (reason: string, extra: Record<string, Untyped> = {}) => {
      if (previous) {
        report({ state: 'error' }, { ...extra, reason });
        return keepPrevious();
      }
      putVideoEntry(placeId, key, { miss: true, ts: now(), reason: 'error' });
      return report({ state: 'error' }, { ...extra, reason });
    };

    // The request would be refused: no fetch, no slot, no miss.
    if (capSpent()) {
      report({ state: 'skipped' }, { reason: 'daily-cap' });
      return { result: previous?.result ?? null, sent: false, attempted: false };
    }

    const media = await fetchVideoMedia(item, videoCfg);
    if (!media.ok) {
      if (previous) {
        report(
          { state: PERMANENT_VIDEO_MISSES.has(media.reason) ? 'limit' : 'error' },
          { reason: media.reason ?? 'download' }
        );
        return { result: keepPrevious(), sent: false, attempted: true };
      }
      if (PERMANENT_VIDEO_MISSES.has(media.reason)) {
        const entry: Record<string, Untyped> = { miss: true, ts: now(), reason: media.reason };
        if (media.reason === 'length') entry.durationSec = media.durationSec ?? null;
        putVideoEntry(placeId, key, entry);
        return { result: report({ state: 'limit', reason: media.reason }), sent: false, attempted: true };
      }
      return { result: errorMiss(media.reason ?? 'download'), sent: false, attempted: true };
    }

    const sizes = { seconds: media.seconds ?? null, bytes: media.bytes ?? null, audio: media.audio?.kind ?? null };
    const options = videoRequestOptions(videoCfg, media, { maxOutputTokens: videoCfg.maxOutputTokens });
    let completion;
    try {
      completion = await llm.complete(
        [
          {
            role: 'system',
            content: videoSystemPrompt(
              fillPromptTemplate(promptText, { maxChars: summaryChars, today: todayDate() }),
              media
            ),
          },
          { role: 'user', content: [videoPart(videoCfg, media)] },
        ],
        options
      );
    } catch (err) {
      const reason = requestFailureReason(err);
      if (reason === 'daily-cap') {
        report({ state: 'skipped' }, { ...sizes, reason });
        return { result: previous?.result ?? null, sent: false, attempted: true };
      }
      return {
        result: errorMiss(reason, { ...sizes, status: propOf(err, 'statusCode') }),
        sent: reason !== 'token-limit',
        attempted: true,
      };
    }

    const text = cleanVideoText(completion.text, summaryChars);
    if (!text) return { result: errorMiss('empty', sizes), sent: true, attempted: true };

    const ts = now();
    const entry: Record<string, Untyped> = { text, ts, watched: true, describedAt: ts, model: options.model };
    // How much of the video the summary saw: a downloaded clip is cut to
    // maxSeconds; a public URL is opened whole by the provider.
    if (!media.pinned && typeof media.seconds === 'number' && isFiniteNumber(media.seconds)) {
      entry.watchedSeconds = media.seconds;
      if (typeof media.totalSeconds === 'number') entry.totalSeconds = media.totalSeconds;
    }
    putVideoEntry(placeId, key, entry, true);
    const result = { state: 'watched', text, usage: completion.usage ?? null, estimated: completion.estimated ?? 0 };
    Object.assign(result, watchedLengths(entry));
    report(result, sizes);
    return { result, sent: true, attempted: true };
  }

  /**
   * describeVideo plus describeVideos' accounting: `sent` (a request reached
   * the provider) and `attempted` (a fetch was tried, or this call waited on
   * another caller's in-flight watch of the same video). `force` ignores an
   * `error` miss (a limit miss and a watched entry still count; every rail
   * still applies).
   */
  async function describeVideoCharged(placeId: string, item: MediaItem, { cacheOnly = false, force = false } = {}) {
    const promptText = hot.prompts?.['describe-video'];
    if (!promptText || !isVideoCandidate(item)) return { result: null, sent: false, attempted: false };

    const key = `video:${item.itemId}`;
    const cached: Untyped = cachedVideo(placeId, key, item, force);
    // A stale summary (media.recacheBefore) is watched again; its old result is the fallback.
    let previous: Untyped = null;
    if (cached?.stale) {
      const { stale, ...result } = cached;
      previous = { entry: stale, result };
    } else if (cached) {
      log.info('describe: video', {
        source: item.source,
        state: cached.state,
        reason: cached.reason ?? null,
        cached: true,
      });
      return { result: cached, sent: false, attempted: false };
    }
    if (cacheOnly) return { result: previous?.result ?? null, sent: false, attempted: false };

    const flightKey = `${placeId}:${key}`;
    const running = inFlight.get(flightKey);
    if (running) {
      const { result } = await running;
      return { result: result ?? previous?.result ?? null, sent: false, attempted: true };
    }
    const promise = watchVideo(placeId, item, key, promptText, force, previous).finally(() =>
      inFlight.delete(flightKey)
    );
    inFlight.set(flightKey, promise);
    return promise;
  }

  /**
   * Watch one video candidate (src/media/classify.ts#collectVideos) and
   * summarise it in one line, through the shared media cache.
   * @param item  One collectVideos candidate.
   * @param [options]  `force`: try again
   *   despite a cached `error` miss (a limit and a watched entry are still served from the cache).
   * @returns null when the
   *   feature is off, the prompt is missing, `item` is not a video candidate, or `llm.maxRequestsPerDay`
   *   is spent (nothing fetched or cached).
   */
  async function describeVideo(
    placeId: string,
    item: MediaItem,
    { force = false }: { force?: boolean } = {}
  ): Promise<
    | { state: 'watched'; text: string; usage: Untyped; estimated: number; cached?: true }
    | { state: 'limit'; reason: 'length' | 'size' | 'daily' }
    | { state: 'error' }
    | null
  > {
    const { result } = await describeVideoCharged(placeId, item, { force });
    return result;
  }

  /**
   * Try up to `maxNew` NEW videos of `items`, in the order given. Every fetch
   * ATTEMPT counts toward `maxNew` -- a probe, download or LLM failure
   * included -- so a caller never waits on several tool timeouts in a row;
   * cache hits (limit/error states included) and the daily cap are free.
   * `onCharge(result)` fires only for a request actually sent. Past `maxNew`
   * the remaining items are still looked up in the cache, never fetched.
   * Returns `{ videos, newCount }` (`newCount` = attempts) -- `videos` maps
   * `itemId` to a video state, ready for formatTranscript's `videos` option.
   */
  async function describeVideos(
    placeId: string,
    items: Array<MediaItem>,
    { maxNew = Infinity, onCharge }: { maxNew?: number; onCharge?: (r: Untyped) => void } = {}
  ) {
    const videos = new Map();
    let newCount = 0;
    for (const item of roleOn(hot.config, 'video') ? items : []) {
      const cacheOnly = newCount >= maxNew;
      const { result, sent, attempted } = await describeVideoCharged(placeId, item, { cacheOnly });
      if (attempted) newCount += 1;
      if (sent) onCharge?.(result);
      if (result) videos.set(item.itemId, result);
    }
    return { videos, newCount };
  }

  /**
   * The video states the media cache already holds for `items` (the same
   * lookup as describeVideos past its `maxNew`): never a fetch, a request or
   * a daily video slot, and an in-flight watch is not waited for. `itemId`
   * -> video state, ready for formatTranscript's `videos` option.
   * @param items  collectVideos candidates.
   */
  async function cachedVideos(placeId: string, items: Array<MediaItem>): Promise<Map<string, Untyped>> {
    const videos = new Map();
    for (const item of items ?? []) {
      const { result } = await describeVideoCharged(placeId, item, { cacheOnly: true });
      if (result) videos.set(item.itemId, result);
    }
    return videos;
  }

  /**
   * The second look on a question: fetch `item` again exactly like a watch
   * (fetchVideoMedia -- same probe chain, direct-URL rules, caps and pinned
   * provider) and ask the video model `question`: the `rewatch-answer`
   * prompt is the system message (`{{maxChars}}` =
   * `media.video.rewatch.answerChars`; a `{{question}}` still in it is filled
   * too, never left literal) and the question goes as a text part of the user
   * message next to the video. Needs video vision on,
   * `features.videoRewatch` not false, the prompt, a video candidate and a
   * non-empty question. An answer is
   * cached for an hour under `video:<itemId>:q:<hash>`; a failure is never
   * cached. With `llm.maxRequestsPerDay` spent nothing is fetched. The question and the answer are data: never logged.
   * @param item  One collectVideos candidate.
   */
  async function rewatchVideo(placeId: string, item: MediaItem, question: string, { model = null }: Ask = {}): Looked {
    const promptText = hot.prompts?.['rewatch-answer'];
    const asked = String(question ?? '').trim();
    if (!promptText || !isVideoCandidate(item) || !asked) return null;

    const videoCfg = videoSettingsOf(hot.config);
    const rewatchCfg = videoCfg.rewatch ?? {};
    const answerChars = REWATCH_ANSWER_CHARS;
    const report = (outcome: string, extra: Record<string, Untyped> = {}) => {
      log.info('describe: rewatch', {
        source: item.source,
        state: outcome,
        reason: extra.reason ?? null,
        cached: extra.cached ?? false,
        seconds: extra.seconds ?? null,
        location: safeLocation(item.url),
      });
    };

    const cache = store.getMediaCache(placeId);
    const key = questionKey(item.itemId, asked);
    const hit = readEntry(placeId, key);
    if (hit && typeof hit.answer === 'string') {
      if (now() - hit.ts < REWATCH_TTL_MS) {
        touchKey(cache, key, hit);
        store.markMediaCacheDirty(placeId);
        report('answered', { cached: true });
        return { question: hit.question ?? asked, text: hit.answer };
      }
      delete cache[key];
      store.markMediaCacheDirty(placeId);
    }

    // The request would be refused: no fetch, no slot.
    if (capSpent()) {
      report('limit', { reason: 'daily-cap' });
      return null;
    }

    const media = await fetchVideoMedia(item, videoCfg);
    if (!media.ok) {
      report(PERMANENT_VIDEO_MISSES.has(media.reason) ? 'limit' : 'error', { reason: media.reason ?? 'download' });
      return null;
    }

    let completion;
    try {
      completion = await llm.complete(
        [
          {
            role: 'system',
            content: videoSystemPrompt(
              fillPromptTemplate(promptText, { question: asked, maxChars: answerChars, today: todayDate() }),
              media
            ),
          },
          { role: 'user', content: [{ type: 'text', text: asked }, videoPart(videoCfg, media)] },
        ],
        videoRequestOptions(videoCfg, media, { maxOutputTokens: rewatchCfg.maxOutputTokens, model })
      );
    } catch (err) {
      report('error', { reason: requestFailureReason(err), seconds: media.seconds ?? null });
      return null;
    }

    const text = cleanVideoText(completion.text, answerChars);
    if (!text) {
      report('error', { reason: 'empty', seconds: media.seconds ?? null });
      return null;
    }
    putVideoEntry(placeId, key, { answer: text, question: asked, ts: now() }, true);
    report('answered', { seconds: media.seconds ?? null });
    return { question: asked, text };
  }

  /**
   * The second look at a picture on a question (features.imageRelook, a missing
   * key counts as on): download `item` the way a caption does (pictureImageUrl,
   * `context.vision.maxBytes`) and ask the
   * media model (`vision`, a request on a model role other than `core`, `purpose: 'relook'`,
   * output capped at `media.video.rewatch.maxOutputTokens`) `question`: the
   * `rewatch-answer` prompt is the system message (`{{maxChars}}` =
   * `media.video.rewatch.answerChars`; a `{{question}}` still in it is filled
   * too, never left literal) and the question goes as a text part of the user
   * message next to the picture. Only an `image` item with a URL and a
   * non-empty question. The answer is NOT the picture's caption: it is
   * cached for an hour under `image:<itemId>:q:<hash>`, failures never. With
   * `llm.maxRequestsPerDay` spent nothing is downloaded.
   * The question and the answer are data: never logged.
   * @param item  One collectPictures item of kind `image`.
   */
  async function relookImage(placeId: string, item: MediaItem, question: string, { model = null }: Ask = {}): Looked {
    const promptText = hot.prompts?.['rewatch-answer'];
    const asked = String(question ?? '').trim();
    if (!promptText || item?.kind !== 'image' || !item.itemId || !item.url || !asked) return null;

    const mediaCfg = hot.config.media ?? {};
    const rewatchCfg = mediaCfg.video?.rewatch ?? {};
    const answerChars = REWATCH_ANSWER_CHARS;
    const report = (outcome: string, extra: Record<string, Untyped> = {}) => {
      log.info('describe: relook', {
        source: item.source ?? null,
        state: outcome,
        reason: extra.reason ?? null,
        cached: extra.cached ?? false,
      });
    };

    const cache = store.getMediaCache(placeId);
    const key = questionKey(item.itemId, asked, 'image');
    const hit = readEntry(placeId, key);
    if (hit && typeof hit.answer === 'string') {
      if (now() - hit.ts < REWATCH_TTL_MS) {
        touchKey(cache, key, hit);
        store.markMediaCacheDirty(placeId);
        report('answered', { cached: true });
        return { question: hit.question ?? asked, text: hit.answer };
      }
      delete cache[key];
      store.markMediaCacheDirty(placeId);
    }

    // The request would be refused: no download, no slot.
    if (capSpent()) {
      report('limit', { reason: 'daily-cap' });
      return null;
    }

    const visionCfg = hot.config.context?.vision ?? {};
    const downloaded = await imageFetcher.fetchAsDataUrl(pictureImageUrl(item), {
      maxBytes: VISION_MAX_BYTES,
      timeoutMs: visionCfg.fetchTimeoutMs,
    });
    if (!downloaded) {
      report('error', { reason: 'download' });
      return null;
    }

    let completion;
    try {
      completion = await llm.complete(
        [
          {
            role: 'system',
            content: fillPromptTemplate(promptText, { question: asked, maxChars: answerChars, today: todayDate() }),
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: asked },
              { type: 'image_url', image_url: { url: downloaded.dataUrl } },
            ],
          },
        ],
        {
          model: model ?? roleModel(hot.config, 'vision', 'relook'),
          ...roleRequestOptions(hot.config, {
            role: 'vision',
            maxOutputTokens: rewatchCfg.maxOutputTokens,
            purpose: 'relook',
          }),
        }
      );
    } catch (err) {
      report('error', { reason: requestFailureReason(err) });
      return null;
    }

    const text = cleanVideoText(completion.text, answerChars);
    if (!text) {
      report('error', { reason: 'empty' });
      return null;
    }
    putVideoEntry(placeId, key, { answer: text, question: asked, ts: now() }, true);
    report('answered');
    return { question: asked, text };
  }

  /**
   * The GIFs of `items` the media cache holds as watched (`watched: true`
   * under the GIF's own item id, see watchGifNow), with an animation that
   * can be fetched again (gifAnimationSource): `itemId` -> the watched
   * caption, in the order of `items`. Never a download, a request or a daily
   * count. Empty while GIFs are not watched (gifWatchBlocker: the switches,
   * `media.gif.watch`, video vision, the prompt) -- there is nothing to
   * re-watch then. The re-watch classifier's GIF candidates.
   * @param items  collectPictures items; only `gif` ones count.
   */
  function watchedGifs(placeId: string, items: Array<MediaItem>): Map<string, string> {
    const watched = new Map();
    if (gifWatchBlocker() !== null) return watched;
    for (const item of items ?? []) {
      if (item?.kind !== 'gif' || !item.itemId || watched.has(item.itemId) || !gifAnimationSource(item)) continue;
      const entry = readEntry(placeId, item.itemId);
      if (!entry || entry.miss || entry.watched !== true || typeof entry.text !== 'string' || !entry.text) continue;
      watched.set(item.itemId, entry.text);
    }
    return watched;
  }

  /**
   * The second look at a watched GIF on a question: its clip fetched again
   * the way the GIF watch fetches it (fetchGifClip, the first
   * `media.gif.maxSeconds` -- the same cap as the first watch) and the video
   * model asked `question` through the `rewatch-answer` prompt
   * (`{{question}}`, `{{maxChars}}` = `media.video.rewatch.answerChars`,
   * output capped at `media.video.rewatch.maxOutputTokens`), under the video
   * request rails. Needs GIFs watched now (gifWatchBlocker),
   * the prompt, a `gif` item with an
   * animation and a non-empty question. An answer is cached for an hour under
   * `gif:<itemId>:q:<hash>` (the GIF's own item id, `<message>#e<n>` for an
   * embed); a failure never. With `llm.maxRequestsPerDay` spent nothing is
   * fetched. One `describe: rewatch` line with
   * `kind: 'gif'`; the question and the answer are data: never logged.
   * @param item  One collectPictures item of kind `gif`.
   */
  async function rewatchGif(placeId: string, item: MediaItem, question: string, { model = null }: Ask = {}): Looked {
    if (gifWatchBlocker() !== null) return null;
    const promptText = hot.prompts?.['rewatch-answer'];
    const asked = String(question ?? '').trim();
    const source = gifAnimationSource(item);
    if (!promptText || !item?.itemId || !source || !asked) return null;

    const videoCfg = videoSettingsOf(hot.config);
    const rewatchCfg = videoCfg.rewatch ?? {};
    const answerChars = REWATCH_ANSWER_CHARS;
    const maxSeconds = GIF_MAX_SECONDS;
    const report = (outcome: string, extra: Record<string, Untyped> = {}) => {
      log.info('describe: rewatch', {
        kind: 'gif',
        source: item.source ?? null,
        state: outcome,
        reason: extra.reason ?? null,
        cached: extra.cached ?? false,
        seconds: extra.seconds ?? null,
        location: safeLocation(source),
      });
    };

    const cache = store.getMediaCache(placeId);
    const key = questionKey(item.itemId, asked, 'gif');
    const hit = readEntry(placeId, key);
    if (hit && typeof hit.answer === 'string') {
      if (now() - hit.ts < REWATCH_TTL_MS) {
        touchKey(cache, key, hit);
        store.markMediaCacheDirty(placeId);
        report('answered', { cached: true });
        return { question: hit.question ?? asked, text: hit.answer };
      }
      delete cache[key];
      store.markMediaCacheDirty(placeId);
    }

    // The request would be refused: no fetch, no slot.
    if (capSpent()) {
      report('limit', { reason: 'daily-cap' });
      return null;
    }

    const fetched = await fetchGifClip(source, maxSeconds);
    if (!fetched.ok) {
      report('error', { reason: fetched.reason });
      return null;
    }
    const { clip } = fetched;

    let completion;
    try {
      completion = await llm.complete(
        [
          {
            role: 'system',
            content: fillPromptTemplate(promptText, { question: asked, maxChars: answerChars, today: todayDate() }),
          },
          { role: 'user', content: [videoPart(videoCfg, clip)] },
        ],
        videoRequestOptions(videoCfg, clip, { maxOutputTokens: rewatchCfg.maxOutputTokens, model })
      );
    } catch (err) {
      report('error', { reason: requestFailureReason(err), seconds: clip.seconds });
      return null;
    }

    const text = cleanVideoText(completion.text, answerChars);
    if (!text) {
      report('error', { reason: 'empty', seconds: clip.seconds });
      return null;
    }
    putVideoEntry(placeId, key, { answer: text, question: asked, ts: now() }, true);
    report('answered', { seconds: clip.seconds });
    return { question: asked, text };
  }

  // Which link of the YouTube duration chain works on this host (src/memory/youtube-check.ts):
  // the same fetcher and key as a real link, no LLM call, nothing cached.
  const checkYoutube = createYoutubeCheck({ hot, videoFetcher, youtubeApiKey, videoProxy });

  return {
    describe: ((...args) => track('describe', () => describe(...args))) as typeof describe,
    redescribe,
    pictureBlocker: () => pictureBlockerOf(hot),
    describeMany: ((...args) => track('describe.many', () => describeMany(...args))) as typeof describeMany,
    cachedDescriptions,
    describeVideo,
    describeVideos,
    cachedVideos,
    rewatchVideo,
    relookImage,
    rewatchGif,
    watchedGifs,
    watchGif,
    gifWatchBlocker,
    checkYoutube,
  };
}

export type Describer = ReturnType<typeof buildDescriber>;

/**
 * @param deps.hot     Live config + prompts; read at the moment of use.
 * @param deps.llm     From createLlm().
 * @param [deps.imageFetcher]  From createImageFetcher() (src/media/fetch-image.ts).
 * @param [deps.videoFetcher]  From createVideoFetcher() (src/media/fetch-video.ts).
 * @param [deps.state]  The persistent state (store.state) holding the
 *   daily video and re-watch counters; without it the counters live in memory only.
 * @param [deps.youtubeApiKey]  Optional YouTube Data API key (YOUTUBE_API_KEY), handed to
 *   probeYoutube only; never logged.
 */
export function createDescriber(deps: Parameters<typeof buildDescriber>[0]): Describer {
  return buildDescriber(deps);
}
