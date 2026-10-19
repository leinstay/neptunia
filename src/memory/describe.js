// The media describer: turns one picture (an image, a gif frame or a video
// poster — see src/media/classify.js#isDescribable) into a plain one-line
// caption via a cheap vision-capable model, so the persona can react to what
// is on a picture it did not itself see (features.mediaDescriptions, on by
// default). One request per NEW picture: two callers reaching the same new
// picture at once (a message prefill and a turn) share one download and one
// request. Results are cached per
// attachment/embed id in data/guilds/<id>/media.json (src/memory/store.js),
// LRU-trimmed to `media.cacheEntries`. A failure is cached as a miss for an
// hour, so a broken picture is not retried on every turn/batch -- except a
// refusal by `llm.maxRequestsPerDay`, which says nothing about the picture.
// Once that cap is spent (llm.capLeft) nothing is downloaded, no daily video,
// re-watch or GIF slot is taken and no miss is cached, so the pictures and
// videos of the last hours are still described after 00:00 UTC. Descriptions
// are data: never logged. A caption is capped at `media.descriptionChars`
// (the describe prompt may learn the cap through `{{maxChars}}`).
//
// The picture is downloaded first (src/media/fetch-image.js) and sent to
// the model as a data: URL, never as a bare Discord URL -- the provider's own
// fetcher gets a 403 from Discord on some CDN hosts even though our server
// fetches the same URL fine (see src/behavior/turn.js for the live-vision
// side of the same fix). A failed download costs nothing and is cached as a
// miss exactly like a failed LLM request.
//
// The same module watches videos (features.mediaDescriptions AND
// features.videoDescriptions -- a missing key counts as on -- like the senses
// line): an attached video or a link to a known video site
// (src/media/classify.js#collectVideos)
// is fetched through src/media/fetch-video.js -- or, for a video of at most
// `media.video.directUrlMaxSeconds` (less outside agentic processing, see
// lengthCap) on a site whose public URL the pinned
// provider can open itself (`media.video.directUrlSites`, and only when
// `media.video.provider` is a real provider object), passed by URL -- and
// summarised by a
// video-capable model into one line. A YouTube link goes out by its canonical
// `watch?v=<id>` URL, its playlist, timestamp and tracking params dropped
// (src/media/video-sites.js#publicVideoUrl); another site's as posted. A
// public URL goes out with OpenRouter's
// processing mode (`media.video.urlProcessing`); every video request carries
// `media.video.reasoning` so reasoning does not eat the output budget. A link's duration comes from yt-dlp;
// when yt-dlp fails on a YouTube link, from the YouTube Data API (with a
// configured key) or the watch page (src/media/fetch-video.js#probeYoutube).
// With no duration at all a direct-URL link is sent only when the owner
// opted in (`media.video.directUrlUnknownDuration`, billed as `maxSeconds`).
// Results share the picture cache under `video:<itemId>`: a watched summary,
// a `length` miss (a video over its cap whose clip download fails; it keeps
// the known `durationSec` and is retried once the live cap -- see lengthCap
// -- has grown to fit it, or when the duration is unknown), a permanent
// `size` miss, or an `error`
// miss (retried after `media.video.errorRetryMinutes`, default 60, or at
// once on a forced attempt -- describeVideo's `force`, used when the person
// asks to try a video that did not load again). A separate daily
// counter (`state.data.videoDay` / `videoCount`, `media.video.maxPerDay`)
// caps how many videos are attempted per day: the slot is reserved before the
// fetch and kept even when the fetch or the request fails. Summaries are
// data: never logged. `checkYoutube()` probes one canary video to tell the
// operator which link of the YouTube duration chain works here.
//
// A downloaded clip (an attachment, a link's yt-dlp clip; never a public URL
// the provider opens itself, never a GIF) has its sound measured by the
// fetcher (`media.video.audioMap`, null or false = off); a clip with nothing
// audible gets `labels.videoAudio.none` and a mostly silent one
// `labels.videoAudio.map` with its audible stretches, appended to the video
// model's system prompt after a blank line, on a watch and a re-watch alike
// (src/media/audio-map.js). A watched summary of a downloaded clip keeps
// the clip's length as `watchedSeconds`, so the transcript can tell a video
// watched only in part (src/media/classify.js, `videoWatchedPart`).
//
// A summary is capped at `media.video.summaryChars` (the describe-video
// prompt learns the cap through `{{maxChars}}`). `rewatchVideo()` is the
// second look on a question (features.videoRewatch, a missing key counts as
// on): the same media fetch as a watch, asked one question through the
// `rewatch-answer` prompt. It has its own daily counter
// (`state.data.rewatchDay` / `rewatchCount`, `media.video.rewatch.maxPerDay`)
// on top of the ordinary video one; its answer is cached for an hour under
// `video:<itemId>:q:<hash of the question>`, failures never. `relookImage()`
// is the same second look at a picture (features.imageRelook): the picture
// downloaded as for a caption, the question asked through the same prompt on
// the media model. It takes the same re-watch counter (one counter for both
// kinds), never a video slot, and its answer is cached apart from the
// picture's caption, under `image:<itemId>:q:<hash>`. `rewatchGif()` is the
// same second look at a watched GIF (features.videoRewatch, GIFs watched now):
// its clip fetched again exactly as the GIF watch fetches it (the first
// `media.gif.maxSeconds`), the question asked through the same prompt on the
// video model. It takes a re-watch slot and a GIF watch slot
// (`media.gif.maxPerDay`), never a video slot; its answer is cached for an
// hour under `gif:<itemId>:q:<hash>`. `watchedGifs()` tells, from the cache
// alone, which GIFs were watched (the re-watch classifier's candidates).
//
// A GIF is watched, not described from one still frame (`media.gif.watch`,
// a missing key counts as on, plus video vision on and the describe-gif or
// describe-video prompt, see src/memory/gif-watch.js): its animation -- the
// mp4 of a tenor/giphy embed, an attached .gif, a .gif link -- is converted
// to a short mp4 (the first `media.gif.maxSeconds`) and summarised by the
// video model under the video request rails, but with its own daily counter
// (`state.data.gifWatchDay` / `gifWatchCount`, `media.gif.maxPerDay`): a GIF
// never takes a video slot, nor a video a GIF one. The caption is cached under the
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
// owner's recache, src/memory/gif-recache.js) replaces it -- or
// `media.recacheBefore`, below.
//
// Provenance and the recache rule. Every description the describer writes
// (a picture's caption -- an emoji and a sticker included --, a GIF watch, a
// video summary) carries `describedAt` (ms) and `model` (the model id the
// request asked for); a cache hit stamps `usedAt` (ms), so the owner's
// recache (src/memory/gif-recache.js#startMedia) can tell recent use from
// the write time `ts`. With `media.recacheBefore` set (an ISO date-time, read
// at the moment of use; null = off) a cached description whose `describedAt`
// is missing or earlier is stale: it is treated as a miss and described
// again through the normal path, under every cap of a new one
// (`llm.maxRequestsPerDay`, the caller's `maxNew`, the daily video and GIF
// counters). A failed attempt keeps the old text (better a stale
// description than none), stamps the entry `refreshFailedAt` and is not
// tried again for the miss TTL (an hour; `media.video.errorRetryMinutes` for
// a video); a refusal by the daily cap or a spent daily slot only serves the
// old text. A stale watched GIF is never replaced by a one-frame caption.

import { isPlainObject } from '../config.js';
import { fitBox, mediaProxyUrl, watchedLengths } from '../media/classify.js';
import { createImageFetcher } from '../media/fetch-image.js';
import { createVideoFetcher } from '../media/fetch-video.js';
import { audioMapSettings, videoAudioNote, withAudioNote } from '../media/audio-map.js';
import { isDirectUrlSite, proxyFor, publicVideoUrl, safeLocation, youtubeVideoId } from '../media/video-sites.js';
import {
  helperRequestOptions,
  railReason,
  VIDEO_TOKENS_PER_SECOND_FALLBACK as STATIC_TOKENS_PER_SECOND_FALLBACK,
} from '../llm/openrouter.js';
import { clampText, oneLine } from './clamp.js';
import { roleModel } from '../llm/roles.js';
import { fillPromptTemplate } from '../behavior/prompt.js';
import { createYoutubeCheck, isVideoVisionOn } from './youtube-check.js';
import { gifWatchBlocker as gifWatchBlockerOf, gifWatchCap, gifWatchPrompt } from './gif-watch.js';
import { log } from '../log.js';
import { countToday as readDailyCount, dailyCounter, MINUTE_MS, utcDay } from '../time.js';
import { hashedKey, touchKey, trimCache } from '../web/cache.js';
import { normalizeQuery } from '../web/lookup.js';

const MISS_TTL_MS = 60 * MINUTE_MS;
// Only when media.descriptionChars is missing or invalid (config.json always has it).
const DESCRIPTION_CHARS_FALLBACK = 500;
// Only when media.video.errorRetryMinutes is missing or invalid (config.json always has it).
const VIDEO_ERROR_RETRY_MINUTES_FALLBACK = 60;
// Only when media.video.urlProcessing is missing (config.json always has it; null omits the field).
const VIDEO_URL_PROCESSING_FALLBACK = 'agentic';
// Only when media.video.summaryChars is missing (config.json always has it, the same value).
const VIDEO_TEXT_CHARS_FALLBACK = 1500;
const REWATCH_ANSWER_CHARS_FALLBACK = 1200;
const REWATCH_TTL_MS = 60 * MINUTE_MS;
const PERMANENT_VIDEO_MISSES = new Set(['length', 'size']);
/** The state.json fields of the daily video counter (every watch and every re-watch attempt). */
export const VIDEO_DAILY = Object.freeze({ dayKey: 'videoDay', countKey: 'videoCount' });
/** The state.json fields of the daily second-look counter: a video re-watch and a picture relook alike. */
const REWATCH_DAILY = Object.freeze({ dayKey: 'rewatchDay', countKey: 'rewatchCount' });
/** The state.json fields of the daily GIF watch counter: a GIF watch and a GIF's second look alike. */
const GIF_WATCH_DAILY = Object.freeze({ dayKey: 'gifWatchDay', countKey: 'gifWatchCount' });
/** What cachedPicture returns for a picture whose recent failure is still remembered. */
const FRESH_MISS = Symbol('fresh-miss');
// Only when media.gif.maxSeconds is missing or invalid (config.json always has it).
const GIF_MAX_SECONDS_FALLBACK = 15;

/**
 * The file a GIF watch downloads: a gif embed's `animationUrl` (the mp4 of
 * a tenor/giphy embed, or a `.gif` link, see src/media/classify.js#classifyEmbed),
 * else an attached gif's own file. Null for anything else -- a gif embed
 * with neither keeps the one-frame description.
 */
function gifAnimationSource(item) {
  if (item?.kind !== 'gif') return null;
  if (typeof item.animationUrl === 'string' && item.animationUrl) return item.animationUrl;
  if (item.source === 'attachment' && typeof item.url === 'string' && item.url) return item.url;
  return null;
}

/** Whether `item` is one collectVideos candidate (an attached video or a video-site link). */
function isVideoCandidate(item) {
  return (
    Boolean(item) && (item.source === 'attachment' || item.source === 'link') && Boolean(item.itemId) && Boolean(item.url)
  );
}

/** Collapse every run of whitespace to one space, then cap at `maxChars` on a word boundary. */
function cleanVideoText(raw, maxChars) {
  return clampText(oneLine(raw), maxChars, { tolerance: 1 });
}

// One labelled line of a GIF watch's answer (prompts/describe-gif.md): `reaction:`, `action:`
// or `text:`, in any case, a list mark or bold markers around the label tolerated.
const GIF_FIELD_LINE = /^[\s*_•-]*(reaction|action|text)[\s*_]*:[\s*_]*(.*)$/i;
// The answer's word for an empty field, with an optional full stop.
const GIF_NONE = /^none\.?$/i;
// One pair of quotes around a whole value (the on-screen text is often quoted).
const QUOTE_PAIRS = [['"', '"'], ['«', '»'], ['“', '”'], ['„', '“'], ["'", "'"], ['‘', '’']];

/** A field's value on one line, without one pair of surrounding quotes; '' for "none". */
function gifFieldValue(raw) {
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
 * @param {unknown} raw  The model's answer.
 * @param {{ descriptionChars: number }} caps
 * @returns {{ text: string, reaction: string, action: string, screen: string }|null}
 */
export function parseGifDescription(raw, { descriptionChars }) {
  const source = String(raw ?? '');
  const fields = { reaction: [], action: [], text: [] };
  let current = null;
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
  const bound = (value) => clampText(value, descriptionChars, { tolerance: 1 });
  const text = bound(actionWhole || reactionWhole || screenWhole);
  if (!text) return null;
  return { text, reaction: bound(reactionWhole), action: bound(actionWhole), screen: bound(screenWhole) };
}

/** A positive number from the config, else `fallback`. */
function positiveOr(value, fallback) {
  return typeof value === 'number' && value > 0 ? value : fallback;
}

/**
 * The cache key of one question's answer: `<prefix>:<itemId>:q:` (`video`
 * for a re-watch, `image` for a picture's second look, `gif` for a GIF's) and the sha1 prefix
 * of the question lower-cased and whitespace-collapsed (the search cache's
 * normalisation).
 */
function questionKey(itemId, question, prefix = 'video') {
  return hashedKey(`${prefix}:${itemId}:q`, normalizeQuery(question));
}

/**
 * The URL a picture is downloaded from for the vision model: a sticker or
 * emoji URL as it is (already sized by its own builder; the proxy must never
 * touch either), every other kind through the media proxy -- a video
 * poster as webp, a gif as one still png frame (as webp the proxy serves the
 * whole animation, often above `context.vision.maxBytes`), anything else as
 * webp. A gif or a picture of known size has its longer side scaled to at
 * most `media.imageSize`, the aspect kept (fitBox: the proxy crops any box
 * of another aspect); of unknown size it gets no size at all and the
 * original is served, `context.vision.maxBytes` still capping the download.
 * A no-op for a non-Discord host such as a YouTube thumbnail's i.ytimg.com.
 */
function pictureImageUrl(item, mediaCfg) {
  if (item.kind === 'sticker' || item.kind === 'emoji') return item.url;
  const sized = fitBox(item.width, item.height, mediaCfg.imageSize) ?? {};
  if (item.kind === 'video') return mediaProxyUrl(item.url, { format: 'webp' });
  if (item.kind === 'gif') return mediaProxyUrl(item.url, { ...sized, format: 'png', animated: false });
  return mediaProxyUrl(item.url, { ...sized, format: 'webp' });
}

/** A stand-in for the persistent state when none is wired (tests, tools): the daily count lives in memory. */
function memoryState() {
  return { data: {}, markDirty() {} };
}

/** ≤200 chars, with any query string stripped -- an error message must never leak a signed URL. */
function safeDetail(message) {
  return String(message ?? '')
    .replace(/\?[^\s'")]*/g, '')
    .slice(0, 200);
}

/** The log/outcome code of a failed request: a rail (`token-limit`, `daily-cap`) or `llm-error`. */
function requestFailureReason(err) {
  return railReason(err, 'llm-error');
}

/**
 * Whether `item` is a link that may go out by its public URL: a pinned
 * provider object and a `directUrlSites` site.
 */
function isPinnableLink(item, videoCfg) {
  return (
    item?.source === 'link' &&
    isPlainObject(videoCfg.provider) &&
    isDirectUrlSite(item.url, videoCfg.directUrlSites ?? [])
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
function lengthCap(item, videoCfg, llmCfg) {
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
function staticRequestSeconds(videoCfg, llmCfg) {
  const isPositive = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;
  const maxRequestTokens = isPositive(videoCfg.maxRequestTokens)
    ? videoCfg.maxRequestTokens
    : llmCfg?.maxRequestTokens;
  if (!isPositive(maxRequestTokens)) return null;
  const tokensPerSecond = isPositive(videoCfg.tokensPerSecond) ? videoCfg.tokensPerSecond : STATIC_TOKENS_PER_SECOND_FALLBACK;
  return Math.floor(maxRequestTokens / tokensPerSecond);
}

/** The processing mode a public URL goes out with (see videoPart), or null when the field is omitted. */
function urlProcessingMode(videoCfg) {
  const mode = videoCfg.urlProcessing === undefined ? VIDEO_URL_PROCESSING_FALLBACK : videoCfg.urlProcessing;
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
 * one (a buffered message keeps no URL) the cap is `media.video.maxSeconds`. Pure. Shared by the
 * describer's cache lookup and the live analyzer (src/memory/update.js).
 * @param {object|undefined} entry
 * @param {object} config  Live config (`media.video`, `llm`).
 * @param {object} [item]
 * @returns {{ state: 'watched', text: string, watchedSeconds?: number, totalSeconds?: number }
 *   | { state: 'limit', reason: string } | null}
 */
export function videoStateFromCache(entry, config, item = {}) {
  if (!entry) return null;
  // An entry from before watchedSeconds / totalSeconds were stored renders as watched whole.
  if (entry.watched) return { state: 'watched', text: entry.text, ...watchedLengths(entry) };
  if (!entry.miss || !PERMANENT_VIDEO_MISSES.has(entry.reason)) return null;
  if (entry.reason === 'length') {
    // An unknown duration (older entries included) costs one probe to learn.
    if (typeof entry.durationSec !== 'number') return null;
    if (entry.durationSec <= lengthCap(item, config?.media?.video ?? {}, config?.llm)) return null;
  }
  return { state: 'limit', reason: entry.reason };
}

/**
 * `media.recacheBefore` as epoch ms: an ISO date-time string, else null (off) -- null, a
 * missing key, a non-string or an unparsable value alike. Pure.
 * @param {object} config  The live config.
 * @returns {number|null}
 */
export function recacheCutoffMs(config) {
  const value = config?.media?.recacheBefore;
  if (typeof value !== 'string' || value === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Whether a cached description is stale under the cutoff `cutoffMs` (recacheCutoffMs): its
 * `describedAt` is missing or earlier. With no cutoff nothing is. Pure.
 * @param {object|undefined} entry  A media cache entry.
 * @param {number|null} cutoffMs
 * @returns {boolean}
 */
export function isStaleDescription(entry, cutoffMs) {
  if (typeof cutoffMs !== 'number' || !Number.isFinite(cutoffMs)) return false;
  const at = entry?.describedAt;
  return !(typeof at === 'number' && Number.isFinite(at) && at >= cutoffMs);
}

/**
 * @param {object} deps
 * @param {object} deps.hot     Live config + prompts; read at the moment of use.
 * @param {object} deps.store
 * @param {object} deps.llm     From createLlm().
 * @param {() => number} [deps.now]
 * @param {object} [deps.imageFetcher]  From createImageFetcher() (src/media/fetch-image.js).
 * @param {object} [deps.videoFetcher]  From createVideoFetcher() (src/media/fetch-video.js).
 * @param {{ data: object, markDirty: () => void }} [deps.state]  The persistent state (store.state) holding the
 *   daily video and re-watch counters; without it the counters live in memory only.
 * @param {string|null} [deps.youtubeApiKey]  Optional YouTube Data API key (YOUTUBE_API_KEY), handed to
 *   probeYoutube only; never logged.
 */
export function createDescriber({
  hot,
  store,
  llm,
  now = Date.now,
  imageFetcher = createImageFetcher(),
  videoFetcher = createVideoFetcher(),
  state = memoryState(),
  youtubeApiKey = null,
}) {
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

  /** Whether pictures are described under the live config and prompts (the switch and the describe prompt). */
  function picturesOn() {
    return pictureBlocker() === null;
  }

  /**
   * Why pictures are not described under the live config and prompts, or
   * null when they are: `off` (features.mediaDescriptions not true) or
   * `no-prompt` (no describe prompt).
   * @returns {'off'|'no-prompt'|null}
   */
  function pictureBlocker() {
    if (hot.config.features?.mediaDescriptions !== true) return 'off';
    if (!hot.prompts?.describe) return 'no-prompt';
    return null;
  }

  /**
   * Whether a cached description must be described again now: stale under
   * the live `media.recacheBefore` (isStaleDescription) and no failed attempt
   * (`refreshFailedAt`) younger than `ttlMs`.
   */
  function dueForRecache(entry, ttlMs) {
    if (!isStaleDescription(entry, recacheCutoffMs(hot.config))) return false;
    const failedAt = entry.refreshFailedAt;
    return !(typeof failedAt === 'number' && Number.isFinite(failedAt) && now() - failedAt < ttlMs);
  }

  /** A cache hit: LRU-touched and stamped `usedAt`, the guild's cache marked dirty. */
  function touchHit(guildId, cache, key, entry) {
    entry.usedAt = now();
    touchKey(cache, key, entry);
    store.markMediaCacheDirty(guildId);
  }

  /**
   * The cached state of one picture, synchronously: `{ result, stale, entry }`
   * for a caption (`result` a describe() result, `cached: true`; the entry
   * LRU-touched; `stale` when media.recacheBefore wants it described again,
   * see dueForRecache), FRESH_MISS while a failure younger than an hour is
   * remembered, or null when it must be described.
   */
  function cachedPicture(guildId, itemId) {
    const cache = store.getMediaCache(guildId);
    const cached = cache[itemId];
    if (!cached) return null;
    if (cached.miss) return now() - cached.ts < MISS_TTL_MS ? FRESH_MISS : null;
    touchHit(guildId, cache, itemId, cached);
    const result = { text: cached.text, usage: null, estimated: 0, cached: true };
    return { result, stale: dueForRecache(cached, MISS_TTL_MS), entry: cached };
  }

  // One in-flight description per guild + picture: a message prefill and a
  // turn that reach the same new picture at once share one download and one request.
  const pictureFlights = new Map();

  /**
   * describe() with describeMany's accounting: `joined` is true when this
   * call waited on another caller's description of the same picture (its
   * request was not this call's).
   */
  async function describeShared(guildId, item) {
    if (!picturesOn()) return { result: null, joined: false };
    const hit = cachedPicture(guildId, item.itemId);
    if (hit === FRESH_MISS) return { result: null, joined: false };
    if (hit && !hit.stale) return { result: hit.result, joined: false };
    // A stale caption (media.recacheBefore) is described again; its old text is the fallback.
    const kept = hit?.result ?? null;
    const flightKey = `${guildId}:${item.itemId}`;
    const running = pictureFlights.get(flightKey);
    if (running) return { result: (await running) ?? kept, joined: true };
    if (capSpent()) return { result: kept, joined: false };
    const promise = describeNow(guildId, item, hit?.entry ?? null).finally(() => pictureFlights.delete(flightKey));
    pictureFlights.set(flightKey, promise);
    return { result: await promise, joined: false };
  }

  /**
   * Describe one picture again whatever its cache holds, for the owner's
   * recache (src/memory/gif-recache.js#startMedia): the normal uncached path
   * (describeNow, a GIF watched first), every rail of a new description. A
   * cached caption is the fallback: a failure keeps it (stamped
   * `refreshFailedAt`). Joins a description of the same picture already in
   * flight.
   * @param {string} guildId
   * @param {object} item  One collectPictures / collectEmojiItems item.
   * @returns {Promise<{ state: 'done' } | { state: 'failed' } | { state: 'unavailable', reason: string }>}
   *   `unavailable`: pictures are not described now (pictureBlocker) or `llm.maxRequestsPerDay` is spent.
   */
  async function redescribe(guildId, item) {
    const blocker = pictureBlocker();
    if (blocker !== null) return { state: 'unavailable', reason: blocker };
    if (capSpent()) return { state: 'unavailable', reason: 'daily-cap' };
    const flightKey = `${guildId}:${item.itemId}`;
    let promise = pictureFlights.get(flightKey);
    if (!promise) {
      const entry = store.getMediaCache(guildId)[item.itemId];
      const previous = entry && !entry.miss && typeof entry.text === 'string' && entry.text ? entry : null;
      promise = describeNow(guildId, item, previous).finally(() => pictureFlights.delete(flightKey));
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
   * @param {string} guildId
   * @param {{ itemId: string, kind: string, url: string }} item  See
   *   src/media/classify.js#collectPictures.
   * @returns {Promise<{ text: string, usage: object|null, estimated: number, cached?: boolean }|null>}
   */
  async function describe(guildId, item) {
    return (await describeShared(guildId, item)).result;
  }

  /**
   * The uncached part of describe(): the GIF watch, else the download and
   * the request; the cache is written here. `previous` is the cached entry
   * being described again (a stale or recached caption), else null: on a
   * failure it is kept (its text returned as a cached result marked `kept`,
   * the entry stamped `refreshFailedAt` unless the daily cap refused the
   * request) instead of a miss being cached.
   */
  async function describeNow(guildId, item, previous = null) {
    const promptText = hot.prompts?.describe;
    if (!promptText) return null;
    const mediaCfg = hot.config.media ?? {};
    const descriptionChars = positiveOr(mediaCfg.descriptionChars, DESCRIPTION_CHARS_FALLBACK);
    const cache = store.getMediaCache(guildId);

    // The old caption kept on a failure, its entry stamped when `mark` is set.
    const keepPrevious = (mark) => {
      if (mark) {
        touchKey(cache, item.itemId, { ...previous, refreshFailedAt: now() });
        store.markMediaCacheDirty(guildId);
      }
      return { text: previous.text, usage: null, estimated: 0, cached: true, kept: true };
    };

    // A GIF is watched like a short video first (see watchGifShared); one
    // that cannot be watched, or whose watch fails, keeps the one-frame
    // description below -- never nothing. A watched caption described again
    // is never replaced by one frame: it is kept instead.
    let watchFailed = false;
    if (item.kind === 'gif') {
      const watched = await watchGifShared(guildId, item);
      if (watched?.state === 'watched') {
        return { text: watched.text, usage: watched.usage ?? null, estimated: watched.estimated ?? 0 };
      }
      if (previous?.watched === true) return keepPrevious(watched?.reason !== 'daily-cap');
      watchFailed = watched?.state === 'failed';
    }

    // A sticker/emoji URL is already fully sized by its own pure builder
    // (stickerUrl/emojiUrl -- `size=`, not width/height/format, and the
    // emoji CDN host is deliberately not media.discordapp.net); every other
    // kind goes through the media proxy (pictureImageUrl).
    const imageUrl = pictureImageUrl(item, mediaCfg);

    // A failure: the previous caption kept, else a miss cached (`mark` false: the daily cap, nothing cached).
    const fail = (mark = true) => {
      if (previous) return keepPrevious(mark);
      if (mark) {
        touchKey(cache, item.itemId, { miss: true, ts: now() });
        trimCache(cache, mediaCfg.cacheEntries ?? Infinity);
        store.markMediaCacheDirty(guildId);
      }
      return null;
    };

    const visionCfg = hot.config.context?.vision ?? {};
    const downloaded = await imageFetcher.fetchAsDataUrl(imageUrl, {
      maxBytes: visionCfg.maxBytes,
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
          { role: 'system', content: fillPromptTemplate(promptText, { maxChars: descriptionChars, today: todayDate() }) },
          { role: 'user', content: [{ type: 'image_url', image_url: { url: downloaded.dataUrl } }] },
        ],
        // An in-turn helper (llm.helperTimeoutMs, counted, never calibrated: a
        // picture is estimated at a flat context.vision.tokensPerImage while the
        // vision model counts far more).
        {
          model,
          ...helperRequestOptions(hot.config, { role: 'vision', maxOutputTokens: mediaCfg.maxOutputTokens, purpose: 'describe' }),
        },
      );
    } catch (err) {
      const reason = requestFailureReason(err);
      log.warn('describe: failed', { kind: item.kind, reason, status: err.statusCode, detail: safeDetail(err.message) });
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
    // (src/memory/gif-recache.js), and `watchFailed` when a watch was tried.
    const ts = now();
    const entry = { text, ts, describedAt: ts, model };
    if (item.kind === 'gif') entry.gif = true;
    if (watchFailed) entry.watchFailed = entry.ts;
    touchKey(cache, item.itemId, entry);
    trimCache(cache, mediaCfg.cacheEntries ?? Infinity);
    store.markMediaCacheDirty(guildId);
    return { text, usage: completion.usage ?? null, estimated: completion.estimated ?? 0 };
  }

  /**
   * Why GIFs are not watched under the live config and prompts, or null when
   * they are: `off`, `video-off` or `no-prompt` (src/memory/gif-watch.js#gifWatchBlocker).
   * @returns {'off'|'video-off'|'no-prompt'|null}
   */
  function gifWatchBlocker() {
    return gifWatchBlockerOf(hot.config, hot.prompts);
  }

  /**
   * One GIF watch, uncached: the animation at `source` is downloaded and
   * converted to a short mp4 (src/media/fetch-video.js#fetchGif, the first
   * `media.gif.maxSeconds`, the video size and tool settings), then
   * summarised by the video model through the `describe-gif` prompt
   * (`{{maxChars}}` = `media.descriptionChars` -- a GIF caption keeps a
   * picture caption's length -- and `{{seconds}}` = `media.gif.maxSeconds`),
   * else the `describe-video` prompt with `{{maxChars}}` alone as before;
   * under the video token cap and output budget, and a slot of the GIF's own
   * `media.gif.maxPerDay` (never the video one) reserved before the fetch and
   * kept on failure. The answer is read as three fields (parseGifDescription,
   * each kept whole under `media.descriptionChars`) and cached under the
   * GIF's own item id as `{ text, reaction, action, screen, ts, watched: true,
   * gif: true }`; nothing is cached otherwise.
   * Resolves `{ state: 'watched', text, usage, estimated }`, `{ state:
   * 'failed', reason }` (the fetch, the conversion, the request or an empty
   * answer) or `{ state: 'unavailable', reason: 'daily'|'daily-cap' }` (a
   * daily rail is spent: no failure of this GIF; with `llm.maxRequestsPerDay`
   * spent before the watch, nothing is fetched and no GIF slot is taken). One
   * `describe: gif` log line, codes only.
   */
  async function watchGifNow(guildId, item, source) {
    const mediaCfg = hot.config.media ?? {};
    const videoCfg = mediaCfg.video ?? {};
    const maxSeconds = positiveOr(mediaCfg.gif?.maxSeconds, GIF_MAX_SECONDS_FALLBACK);
    const descriptionChars = positiveOr(mediaCfg.descriptionChars, DESCRIPTION_CHARS_FALLBACK);
    const report = (outcome, extra = {}) => {
      log.info('describe: gif', {
        state: outcome.state,
        reason: outcome.reason ?? null,
        seconds: extra.seconds ?? null,
        bytes: extra.bytes ?? null,
        status: extra.status,
        location: safeLocation(source),
      });
      return outcome;
    };

    // The request would be refused: no fetch, no GIF slot.
    if (capSpent()) return report({ state: 'unavailable', reason: 'daily-cap' });
    // The daily GIF slot, reserved synchronously like a video watch's.
    const watchedToday = countToday('gifWatchDay', 'gifWatchCount');
    if (watchedToday >= gifWatchCap(hot.config)) return report({ state: 'unavailable', reason: 'daily' });
    state.data.gifWatchCount = watchedToday + 1;
    state.markDirty();

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
        options,
      );
    } catch (err) {
      const reason = requestFailureReason(err);
      if (reason === 'daily-cap') return report({ state: 'unavailable', reason }, sizes);
      return report({ state: 'failed', reason }, { ...sizes, status: err.statusCode });
    }

    const fields = parseGifDescription(completion.text, { descriptionChars });
    if (!fields) return report({ state: 'failed', reason: 'empty' }, sizes);
    const { text, reaction, action, screen } = fields;
    const ts = now();
    putVideoEntry(guildId, item.itemId, { text, reaction, action, screen, ts, watched: true, gif: true, describedAt: ts, model: options.model });
    report({ state: 'watched' }, sizes);
    return { state: 'watched', text, usage: completion.usage ?? null, estimated: completion.estimated ?? 0 };
  }

  /**
   * Download the animation at `source` and convert it to a short mp4
   * (src/media/fetch-video.js#fetchGif: the first `maxSeconds`, the video
   * size and tool settings read now) -- the one fetch of a GIF watch and of
   * its second look. `{ ok: true, clip: { url, seconds, pinned: false },
   * bytes }` (`seconds` never above `maxSeconds`) or `{ ok: false, reason }`.
   */
  async function fetchGifClip(source, maxSeconds) {
    const videoCfg = hot.config.media?.video ?? {};
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
  function gifSystemPrompt(maxChars, seconds) {
    const prompt = gifWatchPrompt(hot.prompts);
    const values = { maxChars, today: todayDate() };
    if (prompt?.name === 'describe-gif') values.seconds = seconds;
    return fillPromptTemplate(prompt?.text, values);
  }

  /**
   * watchGifNow behind the switches and the in-flight guard: null when GIFs
   * are not watched now (gifWatchBlocker) or the item has no animation to
   * download (gifAnimationSource); otherwise the outcome, shared with any
   * caller already watching the same GIF of the same guild.
   */
  function watchGifShared(guildId, item) {
    if (gifWatchBlocker() !== null) return null;
    const source = gifAnimationSource(item);
    if (!source) return null;
    const flightKey = `${guildId}:gif:${item.itemId}`;
    const running = inFlight.get(flightKey);
    if (running) return running;
    const promise = watchGifNow(guildId, item, source).finally(() => inFlight.delete(flightKey));
    inFlight.set(flightKey, promise);
    return promise;
  }

  /** Mark a GIF's cache entry as a failed watch (`watchFailed`): its caption, if any, is kept. */
  function markGifWatchFailed(guildId, itemId) {
    const cache = store.getMediaCache(guildId);
    const entry = cache[itemId];
    const ts = now();
    const next =
      entry && !entry.miss && typeof entry.text === 'string' && entry.text
        ? { ...entry, watchFailed: ts }
        : { miss: true, ts, gif: true, watchFailed: ts };
    putVideoEntry(guildId, itemId, next);
  }

  /**
   * Re-describe one GIF by watching it, for the recache
   * (src/memory/gif-recache.js): an entry already watched with its three
   * fields (`reaction` present) is served from the cache; any other cached
   * caption (a one-frame one, or a watched one of the older one-line format)
   * is ignored and, when
   * the watch succeeds, replaced -- under the same item id, so nothing else
   * has to change. A failed watch never falls back to one frame here: the
   * old caption stays and the entry is marked `watchFailed` (a GIF with no
   * caption gets a miss so marked). Every rail of watchGifNow applies.
   * @param {string} guildId
   * @param {object} item  A gif picture item (src/media/classify.js#collectPictures).
   * @returns {Promise<{ state: 'watched', text: string, cached?: true }
   *   | { state: 'failed', reason: string } | { state: 'unavailable', reason: string }>}
   *   `unavailable`: GIFs are not watched now (see gifWatchBlocker) or a daily rail is spent.
   */
  async function watchGif(guildId, item) {
    const blocker = gifWatchBlocker();
    if (blocker !== null) return { state: 'unavailable', reason: blocker };
    const cached = store.getMediaCache(guildId)[item.itemId];
    // An old-format watched entry (no `reaction` field) is watched again for its three fields.
    if (cached?.watched && typeof cached.text === 'string' && typeof cached.reaction === 'string') {
      return { state: 'watched', text: cached.text, cached: true };
    }
    if (!gifAnimationSource(item)) {
      markGifWatchFailed(guildId, item.itemId);
      log.info('describe: gif', { state: 'failed', reason: 'source' });
      return { state: 'failed', reason: 'source' };
    }
    const outcome = await watchGifShared(guildId, item);
    if (outcome.state === 'failed') markGifWatchFailed(guildId, item.itemId);
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
   * @param {string} guildId
   * @param {object[]} items
   * @param {{ maxNew?: number, concurrency?: number, onCharge?: (r: object) => void }} [options]
   * @returns {Promise<{ descriptions: Map<string, string>, newCount: number }>}
   */
  async function describeMany(guildId, items, { maxNew = Infinity, concurrency = Infinity, onCharge } = {}) {
    const found = new Map();
    const picked = [];
    const seen = new Set();
    const on = picturesOn();
    const spent = on && capSpent();
    for (const item of on ? (items ?? []) : []) {
      if (!item?.itemId || seen.has(item.itemId)) continue;
      seen.add(item.itemId);
      const hit = cachedPicture(guildId, item.itemId);
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
        const { result, joined } = await describeShared(guildId, item);
        if (!result) continue;
        if (!result.cached && !joined) onCharge?.(result);
        found.set(item.itemId, result.text);
      }
    };
    const limit = Number.isFinite(concurrency) && concurrency >= 1 ? Math.floor(concurrency) : picked.length;
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
   * @param {string} guildId
   * @param {object[]} items
   * @returns {Map<string, string>}
   */
  function cachedDescriptions(guildId, items) {
    const descriptions = new Map();
    if (hot.config.features?.mediaDescriptions !== true || !hot.prompts?.describe) return descriptions;
    const cache = store.getMediaCache(guildId);
    for (const item of items ?? []) {
      const entry = item?.itemId ? cache[item.itemId] : undefined;
      if (!entry || entry.miss || typeof entry.text !== 'string' || !entry.text) continue;
      touchHit(guildId, cache, item.itemId, entry);
      descriptions.set(item.itemId, entry.text);
    }
    return descriptions;
  }

  // One in-flight watch per guild + video: a message prefill and a turn that
  // reach the same new video at once share one request.
  const inFlight = new Map();

  /** Store a video cache entry, LRU-touched and trimmed like the picture entries. */
  function putVideoEntry(guildId, key, value) {
    const cache = store.getMediaCache(guildId);
    touchKey(cache, key, value);
    trimCache(cache, hot.config.media?.cacheEntries ?? Infinity);
    store.markMediaCacheDirty(guildId);
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
  function cachedVideo(guildId, key, item, force = false) {
    const cache = store.getMediaCache(guildId);
    const entry = cache[key];
    if (!entry) return null;
    const lasting = videoStateFromCache(entry, hot.config, item);
    if (lasting?.state === 'watched') {
      touchHit(guildId, cache, key, entry);
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
    const valid = typeof minutes === 'number' && Number.isFinite(minutes) && minutes >= 0;
    return (valid ? minutes : VIDEO_ERROR_RETRY_MINUTES_FALLBACK) * MINUTE_MS;
  }

  /**
   * Today's count of one daily counter (`state.data[dayKey]` / `[countKey]`);
   * resets it when the day changed (same day logic as the LLM client's).
   */
  function countToday(dayKey, countKey) {
    const { count, rolled } = dailyCounter(state.data, { dayKey, countKey }, now());
    if (rolled) state.markDirty();
    return count;
  }

  /** Today's video count (every watch and every re-watch attempt). */
  function videoCountToday() {
    return countToday(VIDEO_DAILY.dayKey, VIDEO_DAILY.countKey);
  }

  /**
   * The video slots left today, read only (the counters are never rolled
   * over or written here): `video` under `media.video.maxPerDay` (a watch, a
   * retry and a re-watch each take one) and `rewatch` under
   * `media.video.rewatch.maxPerDay` (a re-watch also needs a `video` slot; a
   * picture's second look, relookImage, takes a `rewatch` slot only), plus
   * `gif` under `media.gif.maxPerDay` (gifWatchCap; a GIF's second look,
   * rewatchGif, takes a `rewatch` and a `gif` slot, never a video one).
   * A cap that is not a number leaves its rail unlimited (Infinity), as the
   * watch itself reads it. For a turn that skips a classifier whose action
   * could not run.
   * @returns {{ video: number, rewatch: number, gif: number }}
   */
  function videoCapsLeft() {
    const videoCfg = hot.config.media?.video ?? {};
    const nowMs = now();
    const left = (cap, keys) =>
      typeof cap === 'number' && !Number.isNaN(cap) ? Math.max(0, cap - readDailyCount(state.data, keys, nowMs)) : Infinity;
    return {
      video: left(videoCfg.maxPerDay, VIDEO_DAILY),
      rewatch: left(videoCfg.rewatch?.maxPerDay, REWATCH_DAILY),
      gif: left(gifWatchCap(hot.config), GIF_WATCH_DAILY),
    };
  }

  /**
   * The `video_url` part of a video request. A public URL (a pinned
   * direct-URL request) carries OpenRouter's processing mode
   * (`media.video.urlProcessing`, a missing key = 'agentic', a non-string or
   * empty value omits it) -- without it the provider samples a single frame;
   * a data: URL part never does.
   */
  function videoPart(videoCfg, media) {
    const videoUrl = { url: media.url };
    if (media.pinned) {
      const mode = urlProcessingMode(videoCfg);
      if (mode) videoUrl.processing = mode;
    }
    return { type: 'video_url', video_url: videoUrl };
  }

  /**
   * The system prompt of a video request on `media` (a watch or a re-watch):
   * `filled` plus the measured-sound note of a downloaded clip
   * (audio-map.js#videoAudioNote on the live `labels.videoAudio`), after a
   * blank line; `filled` alone without one.
   */
  function videoSystemPrompt(filled, media) {
    return withAudioNote(filled, videoAudioNote(media.audio, hot.prompts?.labels));
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
  function videoTokensPerSecond(videoCfg, media) {
    if (!media.pinned || urlProcessingMode(videoCfg) !== 'agentic') return undefined;
    const value = videoCfg.directUrlTokensPerSecond;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
  }

  /**
   * The `llm.complete` options of a video request (a watch or a re-watch):
   * the video model and timeout, the video-only token cap, the per-second
   * estimate of an agentic public URL, the pinned provider only for a public
   * URL, the reasoning settings (`media.video.reasoning`, a plain object or
   * nothing), never the text calibration.
   */
  function videoRequestOptions(videoCfg, media, { maxOutputTokens }) {
    return {
      model: roleModel(hot.config, 'video'),
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
      reasoning: isPlainObject(videoCfg.reasoning) ? videoCfg.reasoning : undefined,
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
  async function fetchVideoMedia(item, videoCfg) {
    const { maxSeconds, maxBytes, toolTimeoutMs, ffmpegPath, ytdlpPath } = videoCfg;
    const audioMap = audioMapSettings(videoCfg.audioMap);
    if (item.source === 'attachment') {
      const got = await videoFetcher.fetchAttachment(item.url, {
        durationSec: item.durationSec,
        maxSeconds,
        maxBytes,
        toolTimeoutMs,
        ffmpegPath,
        fetchTimeoutMs: hot.config.context?.vision?.fetchTimeoutMs,
        audioMap,
      });
      if (got.ok) {
        return { ok: true, url: got.dataUrl, seconds: got.seconds, bytes: got.bytes, pinned: false, audio: got.audio ?? null };
      }
      if (got.reason === 'length') {
        return { ok: false, reason: 'length', durationSec: Number.isFinite(got.durationSec) ? got.durationSec : null };
      }
      return got;
    }
    // Only the listed sites go through the proxy (media.video.proxySites).
    const proxy = proxyFor(item.url, videoCfg);
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
      // No duration at all: only the owner's explicit switch sends the URL,
      // billed as the longest allowed video.
      if (pinnable && videoCfg.directUrlUnknownDuration === true) {
        return { ok: true, url: publicVideoUrl(item.url), seconds: maxSeconds, bytes: null, pinned: true };
      }
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
        totalSeconds: typeof durationSec === 'number' && Number.isFinite(durationSec) ? durationSec : null,
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
  async function watchVideo(guildId, item, key, promptText, forced = false, previous = null) {
    const videoCfg = hot.config.media?.video ?? {};
    const summaryChars = positiveOr(videoCfg.summaryChars, VIDEO_TEXT_CHARS_FALLBACK);
    const report = (result, extra = {}) => {
      log.info('describe: video', {
        source: item.source,
        state: result.state,
        reason: result.reason ?? extra.reason ?? null,
        seconds: extra.seconds ?? null,
        bytes: extra.bytes ?? null,
        status: extra.status,
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
      putVideoEntry(guildId, key, { ...previous.entry, refreshFailedAt: now() });
      return previous.result;
    };
    const errorMiss = (reason, extra = {}) => {
      if (previous) {
        report({ state: 'error' }, { ...extra, reason });
        return keepPrevious();
      }
      putVideoEntry(guildId, key, { miss: true, ts: now(), reason: 'error' });
      return report({ state: 'error' }, { ...extra, reason });
    };

    // The request would be refused: no fetch, no slot, no miss.
    if (capSpent()) {
      report({ state: 'skipped' }, { reason: 'daily-cap' });
      return { result: previous?.result ?? null, sent: false, attempted: false };
    }

    // Reserve the daily slot synchronously, before any await, so concurrent
    // watches can never overshoot maxPerDay. A failed fetch or request keeps
    // its slot: attempts count, like media.video.maxPerTurn.
    const countToday = videoCountToday();
    if (countToday >= (videoCfg.maxPerDay ?? Infinity)) {
      const limit = report({ state: 'limit', reason: 'daily' });
      return { result: previous?.result ?? limit, sent: false, attempted: false };
    }
    state.data.videoCount = countToday + 1;
    state.markDirty();

    const media = await fetchVideoMedia(item, videoCfg);
    if (!media.ok) {
      if (previous) {
        report({ state: PERMANENT_VIDEO_MISSES.has(media.reason) ? 'limit' : 'error' }, { reason: media.reason ?? 'download' });
        return { result: keepPrevious(), sent: false, attempted: true };
      }
      if (PERMANENT_VIDEO_MISSES.has(media.reason)) {
        const entry = { miss: true, ts: now(), reason: media.reason };
        if (media.reason === 'length') entry.durationSec = media.durationSec ?? null;
        putVideoEntry(guildId, key, entry);
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
          { role: 'system', content: videoSystemPrompt(fillPromptTemplate(promptText, { maxChars: summaryChars, today: todayDate() }), media) },
          { role: 'user', content: [videoPart(videoCfg, media)] },
        ],
        options,
      );
    } catch (err) {
      const reason = requestFailureReason(err);
      if (reason === 'daily-cap') {
        report({ state: 'skipped' }, { ...sizes, reason });
        return { result: previous?.result ?? null, sent: false, attempted: true };
      }
      return { result: errorMiss(reason, { ...sizes, status: err.statusCode }), sent: reason !== 'token-limit', attempted: true };
    }

    const text = cleanVideoText(completion.text, summaryChars);
    if (!text) return { result: errorMiss('empty', sizes), sent: true, attempted: true };

    const ts = now();
    const entry = { text, ts, watched: true, describedAt: ts, model: options.model };
    // How much of the video the summary saw: a downloaded clip is cut to
    // maxSeconds; a public URL is opened whole by the provider.
    if (!media.pinned && typeof media.seconds === 'number' && Number.isFinite(media.seconds)) {
      entry.watchedSeconds = media.seconds;
      if (typeof media.totalSeconds === 'number') entry.totalSeconds = media.totalSeconds;
    }
    putVideoEntry(guildId, key, entry);
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
  async function describeVideoCharged(guildId, item, { cacheOnly = false, force = false } = {}) {
    // Video vision needs both switches, like the senses line (src/behavior/prompt.js#renderSenses).
    if (!isVideoVisionOn(hot.config)) return { result: null, sent: false, attempted: false };
    const promptText = hot.prompts?.['describe-video'];
    if (!promptText || !isVideoCandidate(item)) return { result: null, sent: false, attempted: false };

    const key = `video:${item.itemId}`;
    const cached = cachedVideo(guildId, key, item, force);
    // A stale summary (media.recacheBefore) is watched again; its old result is the fallback.
    let previous = null;
    if (cached?.stale) {
      const { stale, ...result } = cached;
      previous = { entry: stale, result };
    } else if (cached) {
      log.info('describe: video', { source: item.source, state: cached.state, reason: cached.reason ?? null, cached: true });
      return { result: cached, sent: false, attempted: false };
    }
    if (cacheOnly) return { result: previous?.result ?? null, sent: false, attempted: false };

    const flightKey = `${guildId}:${key}`;
    const running = inFlight.get(flightKey);
    if (running) {
      const { result } = await running;
      return { result: result ?? previous?.result ?? null, sent: false, attempted: true };
    }
    const promise = watchVideo(guildId, item, key, promptText, force, previous).finally(() =>
      inFlight.delete(flightKey),
    );
    inFlight.set(flightKey, promise);
    return promise;
  }

  /**
   * Watch one video candidate (src/media/classify.js#collectVideos) and
   * summarise it in one line, through the shared media cache.
   * @param {string} guildId
   * @param {object} item  One collectVideos candidate.
   * @param {{ force?: boolean }} [options]  `force`: try again
   *   despite a cached `error` miss (a limit and a watched entry are still served from the cache).
   * @returns {Promise<{ state: 'watched', text: string, usage: object|null, estimated: number, cached?: true }
   *   | { state: 'limit', reason: 'length'|'size'|'daily' } | { state: 'error' } | null>}  null when the
   *   feature is off, the prompt is missing, `item` is not a video candidate, or `llm.maxRequestsPerDay`
   *   is spent (nothing fetched or cached).
   */
  async function describeVideo(guildId, item, { force = false } = {}) {
    const { result } = await describeVideoCharged(guildId, item, { force });
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
   * @param {string} guildId
   * @param {object[]} items
   * @param {{ maxNew?: number, onCharge?: (r: object) => void }} [options]
   */
  async function describeVideos(guildId, items, { maxNew = Infinity, onCharge } = {}) {
    const videos = new Map();
    let newCount = 0;
    for (const item of items) {
      const cacheOnly = newCount >= maxNew;
      const { result, sent, attempted } = await describeVideoCharged(guildId, item, { cacheOnly });
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
   * @param {string} guildId
   * @param {object[]} items  collectVideos candidates.
   * @returns {Promise<Map<string, object>>}
   */
  async function cachedVideos(guildId, items) {
    const videos = new Map();
    for (const item of items ?? []) {
      const { result } = await describeVideoCharged(guildId, item, { cacheOnly: true });
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
   * non-empty question. Both daily counters must have room
   * (`media.video.rewatch.maxPerDay` and `media.video.maxPerDay`); both
   * slots are reserved before the fetch and kept on failure. An answer is
   * cached for an hour under `video:<itemId>:q:<hash>`; a failure is never
   * cached. With `llm.maxRequestsPerDay` spent nothing is fetched and no slot
   * is taken. The question and the answer are data: never logged.
   * @param {string} guildId
   * @param {object} item  One collectVideos candidate.
   * @param {string} question
   * @returns {Promise<{ question: string, text: string }|null>}
   */
  async function rewatchVideo(guildId, item, question) {
    if (!isVideoVisionOn(hot.config) || hot.config.features?.videoRewatch === false) return null;
    const promptText = hot.prompts?.['rewatch-answer'];
    const asked = String(question ?? '').trim();
    if (!promptText || !isVideoCandidate(item) || !asked) return null;

    const videoCfg = hot.config.media?.video ?? {};
    const rewatchCfg = videoCfg.rewatch ?? {};
    const answerChars = positiveOr(rewatchCfg.answerChars, REWATCH_ANSWER_CHARS_FALLBACK);
    const report = (outcome, extra = {}) => {
      log.info('describe: rewatch', {
        source: item.source,
        state: outcome,
        reason: extra.reason ?? null,
        cached: extra.cached ?? false,
        seconds: extra.seconds ?? null,
        location: safeLocation(item.url),
      });
    };

    const cache = store.getMediaCache(guildId);
    const key = questionKey(item.itemId, asked);
    const hit = cache[key];
    if (hit && typeof hit.answer === 'string') {
      if (now() - hit.ts < REWATCH_TTL_MS) {
        touchKey(cache, key, hit);
        store.markMediaCacheDirty(guildId);
        report('answered', { cached: true });
        return { question: hit.question ?? asked, text: hit.answer };
      }
      delete cache[key];
      store.markMediaCacheDirty(guildId);
    }

    // The request would be refused: no fetch, no slot.
    if (capSpent()) {
      report('limit', { reason: 'daily-cap' });
      return null;
    }
    // Both rails, both reserved synchronously before any await (like a watch).
    const rewatchedToday = countToday(REWATCH_DAILY.dayKey, REWATCH_DAILY.countKey);
    const videosToday = videoCountToday();
    if (rewatchedToday >= (rewatchCfg.maxPerDay ?? Infinity) || videosToday >= (videoCfg.maxPerDay ?? Infinity)) {
      report('limit', { reason: 'daily' });
      return null;
    }
    state.data.rewatchCount = rewatchedToday + 1;
    state.data.videoCount = videosToday + 1;
    state.markDirty();

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
            content: videoSystemPrompt(fillPromptTemplate(promptText, { question: asked, maxChars: answerChars, today: todayDate() }), media),
          },
          { role: 'user', content: [{ type: 'text', text: asked }, videoPart(videoCfg, media)] },
        ],
        videoRequestOptions(videoCfg, media, { maxOutputTokens: rewatchCfg.maxOutputTokens }),
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
    putVideoEntry(guildId, key, { answer: text, question: asked, ts: now() });
    report('answered', { seconds: media.seconds ?? null });
    return { question: asked, text };
  }

  /**
   * The second look at a picture on a question (features.imageRelook, a missing
   * key counts as on; never features.vision, which gates only the pictures sent
   * in the persona's own request): download `item` the way a
   * caption does (pictureImageUrl, `context.vision.maxBytes`) and ask the
   * media model (`vision`, a helper request, `purpose: 'relook'`,
   * output capped at `media.video.rewatch.maxOutputTokens`) `question`: the
   * `rewatch-answer` prompt is the system message (`{{maxChars}}` =
   * `media.video.rewatch.answerChars`; a `{{question}}` still in it is filled
   * too, never left literal) and the question goes as a text part of the user
   * message next to the picture. Only an `image` item with a URL and a
   * non-empty question. It shares the one second-look counter with
   * rewatchVideo (`media.video.rewatch.maxPerDay`, `state.data.rewatchDay` /
   * `rewatchCount`), reserved before the download and kept on failure; it
   * never takes a video slot. The answer is NOT the picture's caption: it is
   * cached for an hour under `image:<itemId>:q:<hash>`, failures never. With
   * `llm.maxRequestsPerDay` spent nothing is downloaded and no slot is taken.
   * The question and the answer are data: never logged.
   * @param {string} guildId
   * @param {object} item  One collectPictures item of kind `image`.
   * @param {string} question
   * @returns {Promise<{ question: string, text: string }|null>}
   */
  async function relookImage(guildId, item, question) {
    const features = hot.config.features ?? {};
    if (features.imageRelook === false) return null;
    const promptText = hot.prompts?.['rewatch-answer'];
    const asked = String(question ?? '').trim();
    if (!promptText || item?.kind !== 'image' || !item.itemId || !item.url || !asked) return null;

    const mediaCfg = hot.config.media ?? {};
    const rewatchCfg = mediaCfg.video?.rewatch ?? {};
    const answerChars = positiveOr(rewatchCfg.answerChars, REWATCH_ANSWER_CHARS_FALLBACK);
    const report = (outcome, extra = {}) => {
      log.info('describe: relook', {
        source: item.source ?? null,
        state: outcome,
        reason: extra.reason ?? null,
        cached: extra.cached ?? false,
      });
    };

    const cache = store.getMediaCache(guildId);
    const key = questionKey(item.itemId, asked, 'image');
    const hit = cache[key];
    if (hit && typeof hit.answer === 'string') {
      if (now() - hit.ts < REWATCH_TTL_MS) {
        touchKey(cache, key, hit);
        store.markMediaCacheDirty(guildId);
        report('answered', { cached: true });
        return { question: hit.question ?? asked, text: hit.answer };
      }
      delete cache[key];
      store.markMediaCacheDirty(guildId);
    }

    // The request would be refused: no download, no slot.
    if (capSpent()) {
      report('limit', { reason: 'daily-cap' });
      return null;
    }
    // The one second-look counter, reserved synchronously before any await.
    const lookedToday = countToday(REWATCH_DAILY.dayKey, REWATCH_DAILY.countKey);
    if (lookedToday >= (rewatchCfg.maxPerDay ?? Infinity)) {
      report('limit', { reason: 'daily' });
      return null;
    }
    state.data.rewatchCount = lookedToday + 1;
    state.markDirty();

    const visionCfg = hot.config.context?.vision ?? {};
    const downloaded = await imageFetcher.fetchAsDataUrl(pictureImageUrl(item, mediaCfg), {
      maxBytes: visionCfg.maxBytes,
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
          { role: 'system', content: fillPromptTemplate(promptText, { question: asked, maxChars: answerChars, today: todayDate() }) },
          { role: 'user', content: [{ type: 'text', text: asked }, { type: 'image_url', image_url: { url: downloaded.dataUrl } }] },
        ],
        {
          model: roleModel(hot.config, 'vision', 'relook'),
          ...helperRequestOptions(hot.config, { role: 'vision', maxOutputTokens: rewatchCfg.maxOutputTokens, purpose: 'relook' }),
        },
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
    putVideoEntry(guildId, key, { answer: text, question: asked, ts: now() });
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
   * @param {string} guildId
   * @param {object[]} items  collectPictures items; only `gif` ones count.
   * @returns {Map<string, string>}
   */
  function watchedGifs(guildId, items) {
    const watched = new Map();
    if (gifWatchBlocker() !== null) return watched;
    const cache = store.getMediaCache(guildId);
    for (const item of items ?? []) {
      if (item?.kind !== 'gif' || !item.itemId || watched.has(item.itemId) || !gifAnimationSource(item)) continue;
      const entry = cache[item.itemId];
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
   * `features.videoRewatch` not false, the prompt, a `gif` item with an
   * animation and a non-empty question. Two daily counters must have room:
   * the second-look one (`media.video.rewatch.maxPerDay`, shared with
   * rewatchVideo and relookImage) and the GIF watch one
   * (`media.gif.maxPerDay`) -- never a video slot; both are reserved before
   * the fetch and kept on failure. An answer is cached for an hour under
   * `gif:<itemId>:q:<hash>` (the GIF's own item id, `<message>#e<n>` for an
   * embed); a failure never. With `llm.maxRequestsPerDay` spent nothing is
   * fetched and no slot is taken. One `describe: rewatch` line with
   * `kind: 'gif'`; the question and the answer are data: never logged.
   * @param {string} guildId
   * @param {object} item  One collectPictures item of kind `gif`.
   * @param {string} question
   * @returns {Promise<{ question: string, text: string }|null>}
   */
  async function rewatchGif(guildId, item, question) {
    if (gifWatchBlocker() !== null || hot.config.features?.videoRewatch === false) return null;
    const promptText = hot.prompts?.['rewatch-answer'];
    const asked = String(question ?? '').trim();
    const source = gifAnimationSource(item);
    if (!promptText || !item?.itemId || !source || !asked) return null;

    const mediaCfg = hot.config.media ?? {};
    const videoCfg = mediaCfg.video ?? {};
    const rewatchCfg = videoCfg.rewatch ?? {};
    const answerChars = positiveOr(rewatchCfg.answerChars, REWATCH_ANSWER_CHARS_FALLBACK);
    const maxSeconds = positiveOr(mediaCfg.gif?.maxSeconds, GIF_MAX_SECONDS_FALLBACK);
    const report = (outcome, extra = {}) => {
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

    const cache = store.getMediaCache(guildId);
    const key = questionKey(item.itemId, asked, 'gif');
    const hit = cache[key];
    if (hit && typeof hit.answer === 'string') {
      if (now() - hit.ts < REWATCH_TTL_MS) {
        touchKey(cache, key, hit);
        store.markMediaCacheDirty(guildId);
        report('answered', { cached: true });
        return { question: hit.question ?? asked, text: hit.answer };
      }
      delete cache[key];
      store.markMediaCacheDirty(guildId);
    }

    // The request would be refused: no fetch, no slot.
    if (capSpent()) {
      report('limit', { reason: 'daily-cap' });
      return null;
    }
    // Both rails, both reserved synchronously before any await (like a watch).
    const lookedToday = countToday(REWATCH_DAILY.dayKey, REWATCH_DAILY.countKey);
    const gifsToday = countToday(GIF_WATCH_DAILY.dayKey, GIF_WATCH_DAILY.countKey);
    if (lookedToday >= (rewatchCfg.maxPerDay ?? Infinity) || gifsToday >= gifWatchCap(hot.config)) {
      report('limit', { reason: 'daily' });
      return null;
    }
    state.data.rewatchCount = lookedToday + 1;
    state.data.gifWatchCount = gifsToday + 1;
    state.markDirty();

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
          { role: 'system', content: fillPromptTemplate(promptText, { question: asked, maxChars: answerChars, today: todayDate() }) },
          { role: 'user', content: [videoPart(videoCfg, clip)] },
        ],
        videoRequestOptions(videoCfg, clip, { maxOutputTokens: rewatchCfg.maxOutputTokens }),
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
    putVideoEntry(guildId, key, { answer: text, question: asked, ts: now() });
    report('answered', { seconds: clip.seconds });
    return { question: asked, text };
  }

  // Which link of the YouTube duration chain works on this host (src/memory/youtube-check.js):
  // the same fetcher and key as a real link, no LLM call, nothing cached.
  const checkYoutube = createYoutubeCheck({ hot, videoFetcher, youtubeApiKey });

  return {
    describe,
    redescribe,
    pictureBlocker,
    describeMany,
    cachedDescriptions,
    describeVideo,
    describeVideos,
    cachedVideos,
    rewatchVideo,
    relookImage,
    rewatchGif,
    watchedGifs,
    videoCapsLeft,
    watchGif,
    gifWatchBlocker,
    checkYoutube,
  };
}
