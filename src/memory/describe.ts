// The media describer: turns one picture (an image, a gif frame or a video
// poster — see src/media/classify.ts#isDescribable) into a plain one-line
// caption via a cheap vision-capable model, so the persona can react to what
// is on a picture it did not itself see (features.mediaDescriptions, on by
// default). One request per NEW picture: two callers reaching the same new
// picture at once (a message prefill and a turn) share one download and one
// request. Results are cached per
// attachment/embed id on the item's row of `media` (src/memory/store-media.ts), the rows of a place capped by last
// use at `MEDIA_CACHE_ENTRIES` (src/memory/db/media-store.ts), what a stored line or diary post links
// never trimmed. A failure is cached as a miss for an
// hour, so a broken picture is not retried on every turn/batch -- except a
// refusal by `llm.maxRequestsPerDay`, which says nothing about the picture.
// Once that cap is spent (llm.capLeft) nothing is downloaded
// and no miss is cached, so the pictures and
// videos of the last hours are still described after 00:00 UTC. Descriptions
// are data: never logged. A picture's caption is the whole answer of the
// vision model, every line joined into one with single spaces. Its length is
// `PICTURE_DESCRIPTION_CHARS` (750, the prompt learns it through `{{maxChars}}`),
// shared by a sticker and an emoji. A GIF takes `GIF_DESCRIPTION_CHARS`
// (1,000), a video's summary `VIDEO_DESCRIPTION_CHARS` (5,000) and a sound's
// `AUDIO_DESCRIPTION_CHARS` (3,000). A second look takes the length of its
// media. Nothing is cut: an answer over its length goes once through the
// `summarize` dependency (src/behavior/summarize.ts), and what it returns is
// stored whole on one line, as the answer is, even when it is still longer.
// The final text of a picture, GIF or video description and of a second look
// is made plain (src/memory/plain-description.ts) before it is cached or returned.
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
// A summary's length is `VIDEO_DESCRIPTION_CHARS` (the describe-video
// prompt learns it through `{{maxChars}}`). `rewatchVideo()` is the
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
// A GIF is always watched as a clip (`media.gif.watch`, a missing key counts
// as on, plus video vision on and the describe-gif or describe-video prompt,
// see src/memory/gif-watch.ts): its animation -- the mp4 of a tenor/giphy
// embed, an attached .gif, a .gif link -- is converted to a short mp4 (the
// first `media.gif.maxSeconds`) and summarised by the video model under the
// video request rails. Every attachment with a message, a GIF included, is
// downloaded from the address the `freshAddress` dependency reads from its
// message again, else from its stored address. The description is cached under the GIF's own item id like a
// picture's (so the transcript, the analyzer and the GIF library read it
// unchanged), marked `watched: true`. The answer is prose, kept as one text on
// one line and shown whole. A failed fetch, conversion or request, or an
// empty answer, is cached as a miss with its reason (`llm`, `empty` or the
// fetcher's own), tried again after `media.video.errorRetryMinutes`, and the
// transcript shows it as a GIF not watched. With GIFs not watched now, no
// animation or a spent daily rail nothing is requested and nothing cached.
//
// Provenance and the recache rule. Every description the describer writes
// (a picture's caption -- an emoji and a sticker included --, a GIF watch, a
// video summary) carries `describedAt` (ms) and `model` (the model id the
// request asked for); a cache hit stamps `usedAt` (ms), which tells recent use from
// the write time `ts`. With `media.recacheBefore` set (an ISO date-time, read
// at the moment of use; null = off) a cached description whose `describedAt`
// is missing or earlier is stale: it is treated as a miss and described
// again through the normal path, under every cap of a new one
// (`llm.maxRequestsPerDay`, the caller's `maxNew`). A failed attempt keeps the old text (better a stale
// description than none), stamps the entry `refreshFailedAt` and is not
// tried again for the miss TTL (an hour; `media.video.errorRetryMinutes` for
// a video); a refusal by the daily cap only serves the
// old text.
//
// The English standard (docs/prompt-contract.md). A caption, a GIF watch or a video summary whose letters are mostly of
// another script outside quotes (src/memory/text-standard.ts) is described again once. The second answer stands and the
// entry says `redescribed`. A second answer that fails the standard too is kept and the entry also says `offScript`, and a
// first answer is kept the same way, with `offScript`, when the second request fails. Nothing is dropped, cut or edited for
// this, and a second look's answer is outside it.
//
// An answer cut short (askWhole). An answer whose finish reason is not `stop` is never a description: the same request is
// asked once more, and a second cut is a miss with the reason `filter` (the content filter) or `cut` (anything else).

import { fetchTextPreview } from '../media/text-preview.ts';
import { TEXT_FORM_CHARS, hearAudio, readTextFile } from './describe-audio.ts';
import type { AudioDeps } from './describe-audio.ts';
import { isRecord, propOf, isFiniteNumber } from './types.ts';
import { watchedLengths } from '../media/classify.ts';
import { createImageFetcher, VISION_MAX_BYTES } from '../media/fetch-image.ts';
import { createVideoFetcher } from '../media/fetch-video.ts';
import { audioMapSettings, videoAudioNote, withAudioNote } from '../media/audio-map.ts';
import { isDirectUrlSite, publicVideoUrl, safeLocation, youtubeVideoId } from '../media/video-sites.ts';
import {
  roleRequestOptions,
  railReason,
  VIDEO_TOKENS_PER_SECOND as STATIC_TOKENS_PER_SECOND_FALLBACK,
} from '../llm/openrouter.ts';
import { oneLine } from './clamp.ts';
import { plainDescription } from './plain-description.ts';
import { fill } from '../format.ts';
import { roleModel, roleOn } from '../llm/roles.ts';
import { fillPromptTemplate } from '../behavior/prompt.ts';
import { createYoutubeCheck } from './youtube-check.ts';
import { gifWatchBlocker as gifWatchBlockerOf, gifWatchPrompt } from './gif-watch.ts';
import { log } from '../log.ts';
import { MINUTE_MS, utcDay } from '../time.ts';
import { hashedKey } from '../web/cache.ts';
import { normalizeQuery } from '../web/lookup.ts';
import { isOffScript } from './text-standard.ts';
import type { StoredRecord, Untyped } from './types.ts';
import type { StoreView } from './store.ts';
import type { Track } from '../loop-watch.ts';
import { untracked } from '../loop-watch.ts';

const MISS_TTL_MS = 60 * MINUTE_MS;
/** What a store with no database links. */
// Only when media.video.errorRetryMinutes is missing or invalid (config.json always has it).
const VIDEO_ERROR_RETRY_MINUTES_FALLBACK = 60;
// The describer's measures. Production values, config cut of 2026-10-31.
/** The length of a picture's, a sticker's and an emoji's description, and of a second look at a picture. */
const PICTURE_DESCRIPTION_CHARS = 750;
/** The length of a GIF's description and of a second look at a GIF. */
const GIF_DESCRIPTION_CHARS = 1000;
/** The length of a video's summary and of a second look at a video. */
const VIDEO_DESCRIPTION_CHARS = 5000;
/** The length of a voice message's or an audio file's summary. */
const AUDIO_DESCRIPTION_CHARS = 3000;

/** `seconds` rounded to one decimal, so a whole second reads with no decimal. */
function oneDecimal(seconds: number): number {
  return Math.round(seconds * 10) / 10;
}

/** What a description is shortened as (src/behavior/summarize.ts). */
type SummaryKind = 'picture' | 'GIF' | 'video' | 'text';
/** The seconds of a GIF that are watched. */
const GIF_MAX_SECONDS = 15;
/**
 * The fixed fields of `media.video`, laid over the live section by videoSettingsOf: the
 * lengths a clip and a public URL may run, the clip's bytes, the per-second estimates, the sites whose videos go out
 * by their public URL, the processing mode of a public URL and the reasoning effort of a video request.
 */
const VIDEO_FIXED = Object.freeze({
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
/** The miss reasons of an answer the provider cut short twice (askWhole). */
const CUT_REASONS: ReadonlySet<string> = new Set<CutReason>(['filter', 'cut']);

/** The model a second look is asked of, when it is not the role's own. */
type Ask = { model?: string | null };

/** The purposes of a request on the `video` role (src/llm/roles.ts#PURPOSE_ROLES): a watch, a GIF, a voice message, a re-watch. */
type VideoPurpose = 'watch' | 'gif' | 'voice' | 'rewatch';

/** What a second look answers: the question as asked and the text, or null when there is nothing to look at. */
/** A second look's answer, `{ question, failed }` when the provider cut it short twice, null on any other failure. */
type Looked = Promise<{ question: string; text: string } | { question: string; failed: CutReason } | null>;

/** A picture, GIF or video the describer is asked about: its item id, its kind and where it is fetched from. */
export type MediaItem = {
  [field: string]: Untyped;
  itemId: string;
  kind: string;
  url: string;
  previewUrl?: string | null;
  source?: string | null;
};

/** Whether `item` is an animated custom emoji or sticker: watched as a GIF from its `animationUrl`. */
function isMovingPicture(item: MediaItem): boolean {
  return (item.kind === 'emoji' || item.kind === 'sticker') && item.animated === true && Boolean(item.animationUrl);
}

/** Whether `item` takes the GIF watch: a GIF, or an animated custom emoji or sticker. */
function watchedAsGif(item: MediaItem): boolean {
  return item.kind === 'gif' || isMovingPicture(item);
}

/**
 * The file a GIF watch downloads: a gif embed's `animationUrl` (the mp4 of
 * a tenor/giphy embed, or a `.gif` link, see src/media/classify.ts#classifyEmbed)
 * or an animated emoji's or sticker's, else an attached gif's own file. Null for anything else: a gif embed
 * with neither is not watched.
 */
function gifAnimationSource(item: MediaItem) {
  if (!watchedAsGif(item)) return null;
  if (typeof item.animationUrl === 'string' && item.animationUrl) return item.animationUrl;
  if (item.source === 'attachment' && typeof item.url === 'string' && item.url) return item.url;
  return null;
}

/** The model role that describes `item`: a GIF or a video needs `video`, every other picture `vision`. */
function mediaRoleOf(item: MediaItem): string {
  return item.kind === 'gif' || item.kind === 'video' || isAudioItem(item) ? 'video' : 'vision';
}

/** A voice message or an audio file: the `video` role hears it. */
const isAudioItem = (item: MediaItem): boolean => item.kind === 'voice' || item.kind === 'audio';

/** The kinds a still picture has; their misses are tried again whatever the reason. */
const STILL_PICTURE_KINDS: ReadonlySet<string> = new Set(['image', 'sticker', 'emoji']);

/** A cached failure whose cause a later try cannot change: the file itself is refused. */
const isRefused = (miss: unknown): boolean => PERMANENT_VIDEO_MISSES.has((miss as { reason?: string }).reason ?? '');

/** A model name as the request's options take it. */
const asModel = (model: unknown): string | null => (typeof model === 'string' ? model : null);

/** Whether `item` is one collectVideos candidate (an attached video or a video-site link). */
function isVideoCandidate(item: MediaItem) {
  return (
    Boolean(item) &&
    (item.source === 'attachment' || item.source === 'link') &&
    Boolean(item.itemId) &&
    Boolean(item.url)
  );
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
 * for its platform (a picture at most `media.imageSize` long, a video as a poster frame),
 * else the item's own `url` exactly as it came (a sticker or emoji address is already sized by its own builder).
 */
function pictureImageUrl(item: MediaItem) {
  return item.previewUrl ?? item.url;
}

/** What the model client answers a description's request. */
type Answered = {
  text?: unknown;
  usage?: unknown;
  estimated?: number;
  finishReason?: unknown;
  nativeFinishReason?: unknown;
};

/** Why an answer the provider cut short twice is no description: its content filter, or the output cap or any other abnormal finish. */
type CutReason = 'filter' | 'cut';

/** Whether an answer ended normally: `stop`, or no finish reason at all (a provider that omits it). */
function endedNormally(answer: Answered): boolean {
  return answer.finishReason == null || answer.finishReason === 'stop';
}

/**
 * One request's answer, asked once more when the provider cut the first short: `{ answer }` for an answer that ended
 * normally, `{ cut }` when both ended otherwise. One `describe: cut` line per cut answer, its finish reasons and never its
 * text. A failed request throws as `ask` does. The second request is the same request.
 */
async function askWhole<TAnswer extends Answered>(
  kind: string,
  ask: () => Promise<TAnswer>
): Promise<{ answer: TAnswer } | { cut: CutReason }> {
  let answer = await ask();
  for (let asked = 1; !endedNormally(answer); asked += 1) {
    log.warn('describe: cut', {
      kind,
      finishReason: String(answer.finishReason),
      nativeFinishReason: answer.nativeFinishReason ?? null,
    });
    if (asked === 2) return { cut: answer.finishReason === 'content_filter' ? 'filter' : 'cut' };
    answer = await ask();
  }
  return { answer };
}

/** askWhole's answer on one line: `{ answer, text }`, or `{ failed }` for an answer cut short twice or an empty one. */
async function askText(
  kind: string,
  ask: () => Promise<Answered>
): Promise<{ answer: Answered; text: string } | { failed: CutReason | 'empty' }> {
  const asked = await askWhole(kind, ask);
  if ('cut' in asked) return { failed: asked.cut };
  const text = oneLine(typeof asked.answer.text === 'string' ? asked.answer.text : '');
  return text ? { answer: asked.answer, text } : { failed: 'empty' };
}

/** The answer of the English standard's second request (toStandard): null for one cut short twice or empty. */
async function askAgain(kind: string, ask: () => Promise<Answered>, spent: (estimated: number) => void) {
  const again = await askText(kind, ask);
  if ('failed' in again) return null;
  spent(again.answer.estimated ?? 0);
  return { text: again.text, usage: again.answer.usage };
}

/** What an entry says of the English standard (src/memory/text-standard.ts). */
type StandardMarks = { redescribed?: true; offScript?: true };

/**
 * An answer brought to the English standard: `first` when `textOf` it is on script, else what `again` answers. A second answer
 * that fails the standard too stands marked, and when `again` fails or answers nothing `first` stands marked. Asks once more at
 * most, and never throws for the second request.
 */
async function toStandard<TAnswer>(
  first: TAnswer,
  textOf: (answer: TAnswer) => string,
  again: () => Promise<TAnswer | null>
): Promise<{ answer: TAnswer; marks: StandardMarks }> {
  if (!isOffScript(textOf(first))) return { answer: first, marks: {} };
  let second: TAnswer | null = null;
  try {
    second = await again();
  } catch (err) {
    log.warn('describe: off script', { reason: requestFailureReason(err) });
  }
  if (second === null) return { answer: first, marks: { offScript: true } };
  return {
    answer: second,
    marks: isOffScript(textOf(second)) ? { redescribed: true, offScript: true } : { redescribed: true },
  };
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
 * permanent miss (`length`, `size`), `{ state: 'error', reason }` for a GIF whose watch failed, or null -- no entry, an error miss (retried after
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
  | { state: 'error'; reason: string }
  | null {
  if (!entry) return null;
  // An entry from before watchedSeconds / totalSeconds were stored renders as watched whole.
  if (entry.watched) return { state: 'watched', text: entry.text, ...watchedLengths(entry) };
  if (entry.miss && item.kind === 'gif') return { state: 'error', reason: String(entry.reason ?? '') };
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

type DescribeManyOptions = {
  maxNew?: number;
  concurrency?: number;
  onCharge?: (r: Untyped) => void;
  /** The owner's backfill asked again: a passing failure is tried now, whatever its age. A refused file stays refused. */
  retryMisses?: boolean;
};

type DescriberDeps = {
  hot: { readonly config: Untyped; readonly prompts: Untyped };
  store: Pick<StoreView, 'mediaEntry' | 'putMediaEntry' | 'dropMediaEntry' | 'state'> &
    Partial<Pick<StoreView, 'getMediaDescription'>>;
  llm: Untyped;
  now?: () => number;
  imageFetcher?: Untyped;
  videoFetcher?: Untyped;
  state?: { data: Untyped; markDirty: () => void };
  youtubeApiKey?: string | null;
  /** The engine proxy in force now (src/net/proxy.ts#ProxyMonitor.current), read at each fetch; null goes direct. */
  proxy?: () => string | null;
  /** The event loop watch's `track` (src/loop-watch.ts); a description is a named operation. */
  track?: Track;
  /** Reads a text file's words: `{ ok, text }` or `{ ok: false, reason }`. */
  fetchText?: (url: string) => Promise<{ ok: boolean; text?: string; reason?: string }>;
  /** Shortens an answer over `maxChars` (src/behavior/summarize.ts); none keeps every answer whole. */
  summarize?: (text: string, options: { maxChars: number; kind: SummaryKind }) => Promise<string>;
  /**
   * A fresh address of an attachment, read from its message again (`item.placeId` the place of that message when the
   * item names one, else the place it is described in); null, or no dependency, fetches the stored address.
   */
  freshAddress?: (item: AttachedItem) => Promise<string | null>;
};

/** An attachment whose address is read again: the place it is described in and the message it came with. */
export type AttachedItem = MediaItem & { placeId: string; messageId?: string };

/** A text file's whole text, over plain HTTP; `readTextFile` retells one over `TEXT_FORM_CHARS`. */
async function readTextForm(url: string): Promise<{ ok: boolean; text?: string; reason?: string }> {
  const text = await fetchTextPreview(url, TEXT_FORM_CHARS);
  return text === null ? { ok: false, reason: 'download' } : { ok: true, text };
}

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

  /** A cache hit: stamped `usedAt` and written, which makes it the place's most recently used row. */
  function touchHit(placeId: string, key: string, entry: Untyped) {
    entry.usedAt = now();
    store.putMediaEntry(placeId, key, entry);
  }

  /** The entry under `key`, else the saved description the cache's cap took out, written back. */
  function readEntry(placeId: string, key: string): Untyped {
    const held = store.mediaEntry(placeId, key);
    if (held !== undefined) return held;
    const saved = store.getMediaDescription?.(placeId, key);
    if (!saved) return undefined;
    store.putMediaEntry(placeId, key, saved);
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
  proxy: proxyNow = () => null,
  track = untracked,
  fetchText = readTextForm,
  summarize,
  freshAddress,
}: DescriberDeps) {
  /** `text` through the summarizer at `maxChars`, kept whole on one line as the answers are; `text` itself without one. */
  async function shorten(text: string, maxChars: number, kind: SummaryKind): Promise<string> {
    return summarize ? oneLine(await summarize(text, { maxChars, kind })) : text;
  }

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
  function cachedPicture(placeId: string, item: MediaItem, retryMisses = false) {
    const { itemId } = item;
    const cached = readEntry(placeId, itemId);
    if (!cached) return null;
    if (cached.miss) {
      const gif = watchedAsGif(item);
      // A refused file stays a miss; a still picture's miss of any reason is tried again after MISS_TTL_MS.
      const still = !gif && STILL_PICTURE_KINDS.has(item.kind);
      if (!still && isRefused(cached)) return FRESH_MISS;
      // A failed GIF watch waits as long as a failed video watch.
      const ttl = gif ? videoErrorTtlMs() : MISS_TTL_MS;
      return !retryMisses && now() - cached.ts < ttl ? FRESH_MISS : null;
    }
    // A request out now, or one a stop cut that the start has not turned into a miss yet: looked at again.
    if (cached.pending === true) return null;
    touchHit(placeId, itemId, cached);
    const result = { text: cached.text, usage: null, estimated: 0, cached: true };
    return { result, stale: dueForRecache(cached, MISS_TTL_MS), entry: cached };
  }

  /**
   * `run`, the request of the item under `key`, with the entry marked `pending` while it is out, so a stop that cuts it
   * leaves a mark the start reads (src/memory/db/media-store.ts#interruptPendingMediaEntries). A stale entry described
   * again (`previous`) keeps its text under the mark, and the start stamps it `refreshFailedAt`. A run that cached
   * nothing, such as one the daily cap refused, takes its mark away and leaves `previous` as it was.
   */
  async function whilePending<TResult>(
    placeId: string,
    key: string,
    previous: Record<string, unknown> | null,
    run: () => Promise<TResult>
  ): Promise<TResult> {
    store.putMediaEntry(placeId, key, previous ? { ...previous, pending: true } : { pending: true, ts: now() });
    try {
      return await run();
    } finally {
      if (store.mediaEntry(placeId, key)?.pending === true) {
        if (previous) store.putMediaEntry(placeId, key, previous);
        else store.dropMediaEntry(placeId, key);
      }
    }
  }

  // One in-flight description per place + picture: a message prefill and a
  // turn that reach the same new picture at once share one download and one request.
  const pictureFlights = new Map();

  /**
   * describe() with describeMany's accounting: `joined` is true when this
   * call waited on another caller's description of the same picture (its
   * request was not this call's).
   */
  async function describeShared(placeId: string, item: MediaItem, retryMisses = false) {
    if (!picturesOn()) return { result: null, joined: false };
    const hit = cachedPicture(placeId, item, retryMisses);
    if (hit === FRESH_MISS) return { result: null, joined: false };
    if (hit && !hit.stale) return { result: hit.result, joined: false };
    // A stale caption (media.recacheBefore) is described again; its old text is the fallback.
    const kept = hit?.result ?? null;
    const flightKey = `${placeId}:${item.itemId}`;
    const running = pictureFlights.get(flightKey);
    if (running) return { result: (await running) ?? kept, joined: true };
    if (capSpent()) return { result: kept, joined: false };
    const promise = whilePending(placeId, item.itemId, hit?.entry ?? null, () =>
      describeNow(placeId, item, hit?.entry ?? null)
    ).finally(() => pictureFlights.delete(flightKey));
    pictureFlights.set(flightKey, promise);
    return { result: await promise, joined: false };
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
   * `item` with the address to download it from: an attachment with a message to ask gets the address `freshAddress`
   * reads from it in place of its stored url and preview address, else keeps its stored ones. A link, an embed, a sticker and an emoji ask nothing.
   */
  async function addressed(placeId: string, item: MediaItem): Promise<MediaItem> {
    if (item.source !== 'attachment' || !item.messageId || !freshAddress) return item;
    const fresh = await freshAddress({ placeId, ...item });
    return fresh ? { ...item, url: fresh, previewUrl: null } : item;
  }

  /**
   * The uncached part of describe(): the GIF watch, else the download and
   * the request; the cache is written here. `previous` is the cached entry
   * being described again (a stale caption), else null: on a
   * failure it is kept (its text returned as a cached result marked `kept`,
   * the entry stamped `refreshFailedAt` unless the daily cap refused the
   * request) instead of a miss being cached.
   */
  // health: allow complexity until 2027-04-01 -- the steps of one description, in their order
  async function describeNow(placeId: string, stored: MediaItem, previous: Untyped = null) {
    if (watchedAsGif(stored)) return describeGif(placeId, stored, previous);
    const item = await addressed(placeId, stored);
    if (isAudioItem(item)) return hearAudio(audioDeps(placeId), item);
    if (item.kind === 'text') return readTextFile(audioDeps(placeId), item);
    const promptText: unknown = hot.prompts?.describe;
    if (typeof promptText !== 'string' || !promptText) return null;

    const keepPrevious = (mark: boolean) => keptCaption(placeId, item, previous, mark);

    // The interface's preview address when it gave one, else the item's own URL (pictureImageUrl).
    const imageUrl = pictureImageUrl(item);

    // A failure: the previous caption kept, else a miss cached with its reason, which the transcript shows.
    const fail = (reason: string) => {
      if (previous) return keepPrevious(true);
      store.putMediaEntry(placeId, item.itemId, { miss: true, ts: now(), reason });
      return null;
    };

    const visionCfg = hot.config.context?.vision ?? {};
    // src/media/fetch-image.ts answers the picture as a data URL, null on a failure with its reason told to onMiss.
    // A fetcher that tells no reason is a failed download.
    let missReason = 'download';
    const downloaded = (await imageFetcher.fetchAsDataUrl(imageUrl, {
      maxBytes: VISION_MAX_BYTES,
      timeoutMs: visionCfg.fetchTimeoutMs,
      onMiss: (reason: string) => (missReason = reason),
    })) as { dataUrl: string } | null;
    if (!downloaded) {
      log.warn('describe: failed', { kind: item.kind, reason: missReason });
      return fail(missReason);
    }

    const captioned = await captionPicture(placeId, downloaded.dataUrl, promptText, item.kind);
    if ('failed' in captioned) {
      const { failed } = captioned;
      // A refusal by the daily cap says nothing about the picture: nothing cached, described after the reset.
      if (failed === 'daily-cap') return previous ? keepPrevious(false) : null;
      // A cut answer keeps its reason, an empty one is `empty`, and any failed request (a rail's included) is `llm`.
      return fail(CUT_REASONS.has(failed) || failed === 'empty' ? failed : 'llm');
    }
    const { text, usage, estimated, model, marks } = captioned;
    const ts = now();
    store.putMediaEntry(placeId, item.itemId, { text, ts, describedAt: ts, model, ...marks });
    return { text, usage, estimated };
  }

  /**
   * One picture's caption from the vision model: the describe prompt over the picture at `dataUrl`, brought to the
   * English standard, summarized past PICTURE_DESCRIPTION_CHARS and made plain. Caches nothing; a
   * failure is `{ failed }` with its reason (`daily-cap` for a refusal by `llm.maxRequestsPerDay`).
   */
  async function captionPicture(
    placeId: string,
    dataUrl: string,
    promptText: string,
    kind: string
  ): Promise<
    | { text: string; usage: Untyped; estimated: number; model: string | undefined; marks: StandardMarks }
    | { failed: string }
  > {
    const mediaCfg = hot.config.media ?? {};
    const descriptionChars = PICTURE_DESCRIPTION_CHARS;
    const model = roleModel(hot.config, 'vision', 'describe');
    const ask = (): Promise<Answered> =>
      llm.complete(
        [
          {
            role: 'system',
            content: fillPromptTemplate(promptText, {
              maxChars: descriptionChars,
              today: todayDate(),
            }),
          },
          { role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl } }] },
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
      ) as Promise<Answered>;
    let asked: Awaited<ReturnType<typeof askText>>;
    try {
      asked = await askText(kind, ask);
    } catch (err) {
      const reason = requestFailureReason(err);
      log.warn('describe: failed', {
        kind,
        reason,
        status: propOf(err, 'statusCode'),
        detail: safeDetail(propOf(err, 'message')),
      });
      return { failed: reason };
    }
    if ('failed' in asked) {
      log.warn('describe: failed', { kind, reason: asked.failed });
      return { failed: asked.failed };
    }

    let estimated = asked.answer.estimated ?? 0;
    const standard = await toStandard(
      { text: asked.text, usage: asked.answer.usage },
      (answer) => answer.text,
      () => askAgain(kind, ask, (spent) => (estimated += spent))
    );
    const text = plainDescription(await shorten(standard.answer.text, descriptionChars, 'picture'));

    return { text, usage: standard.answer.usage ?? null, estimated, model, marks: standard.marks };
  }

  /**
   * The caption of a picture that has no message yet, from its `data:` address (a diary picture she staged): one
   * request, nothing cached, null on any failure, with pictures off or with `llm.maxRequestsPerDay` spent.
   */
  async function describeDataUrl(placeId: string, dataUrl: string): Promise<string | null> {
    const promptText: unknown = hot.prompts?.describe;
    if (!picturesOn() || typeof promptText !== 'string' || !promptText || capSpent()) return null;
    const captioned = await captionPicture(placeId, dataUrl, promptText, 'image');
    return 'failed' in captioned ? null : captioned.text;
  }

  /** The old caption of `item` kept on a failure, its entry stamped `refreshFailedAt` when `mark` is set. */
  function keptCaption(placeId: string, item: MediaItem, previous: Untyped, mark: boolean) {
    if (mark) store.putMediaEntry(placeId, item.itemId, { ...previous, refreshFailedAt: now() });
    return { text: previous.text, usage: null, estimated: 0, cached: true, kept: true };
  }

  /**
   * A GIF's description from its watch (watchGifShared). A failed watch caches a miss with its reason, or keeps `previous`
   * (a stale description described again) stamped. With GIFs not watched now, no animation or a spent daily rail nothing
   * is cached: `previous` is served, else nothing.
   */
  async function describeGif(placeId: string, item: MediaItem, previous: Untyped) {
    const watched = await watchGifShared(placeId, item);
    if (watched?.state === 'watched') {
      return { text: watched.text, usage: watched.usage ?? null, estimated: watched.estimated ?? 0 };
    }
    const failed = watched?.state === 'failed';
    if (previous) return keptCaption(placeId, item, previous, failed);
    if (failed) store.putMediaEntry(placeId, item.itemId, { miss: true, ts: now(), reason: watched.reason });
    return null;
  }

  /** What src/memory/describe-audio.ts works with, placed: a text form goes to this place's cache as a picture's does. */
  const audioDeps = (placeId: string): AudioDeps => ({
    prompt: () => (hot.prompts as Record<string, unknown> | null | undefined)?.['describe-audio'],
    settings: () =>
      ({ ...videoSettingsOf(hot.config), summaryChars: AUDIO_DESCRIPTION_CHARS }) as ReturnType<AudioDeps['settings']>,
    model: () => roleModel(hot.config, 'video'),
    fill: (template, values) => fillPromptTemplate(template, { ...values, today: todayDate() }),
    fetchAudio: (url, options) => (videoFetcher as Pick<AudioDeps, 'fetchAudio'>).fetchAudio(url, options),
    fetchText,
    summarize: (text, maxChars) => shorten(text, maxChars, 'text'),
    ask: (kind, messages, options) =>
      askWhole(kind, () =>
        (llm as { complete: (m: unknown, o: unknown) => Promise<Answered> }).complete(messages, options)
      ),
    requestOptions: (settings, seconds, model) =>
      videoRequestOptions(
        settings,
        { seconds },
        { maxOutputTokens: settings.maxOutputTokens, purpose: 'voice', model: asModel(model) }
      ),
    failureReason: (error) => String(requestFailureReason(error)),
    keep: (item, entry) => {
      store.putMediaEntry(placeId, item.itemId, entry);
    },
    miss: (item, reason) => {
      log.warn('describe: failed', { kind: item.kind, reason });
      store.putMediaEntry(placeId, item.itemId, { miss: true, ts: now(), reason });
      return null;
    },
    now,
  });

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
   * (`{{maxChars}}` = `GIF_DESCRIPTION_CHARS` and `{{seconds}}` the clip's length to one decimal, with
   * `labels.gifCut` after a blank line when the GIF runs longer than the clip),
   * else the `describe-video` prompt with `{{maxChars}}` alone;
   * under the video token cap and output budget. The answer on one line, through the summarizer at
   * `GIF_DESCRIPTION_CHARS` and made plain, is cached under the GIF's own item id as `{ text, ts, watched: true, gif: true }`;
   * nothing is cached otherwise. An attached GIF's clip comes from the address `freshAddress` reads, else from
   * `source`.
   * Resolves `{ state: 'watched', text, usage, estimated }`, `{ state:
   * 'failed', reason }` (the fetch's own reason, `llm` for a failed request, `empty` for an empty
   * answer) or `{ state: 'unavailable', reason: 'daily'|'daily-cap' }` (a
   * daily rail is spent: no failure of this GIF; with `llm.maxRequestsPerDay`
   * spent before the watch, nothing is fetched). One
   * `describe: gif` log line, codes only.
   */
  async function watchGifNow(placeId: string, item: MediaItem, source: Untyped) {
    const videoCfg = videoSettingsOf(hot.config);
    const maxSeconds = GIF_MAX_SECONDS;
    const descriptionChars = GIF_DESCRIPTION_CHARS;
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

    const fetched = await fetchGifClip(
      item.source === 'attachment' ? (await addressed(placeId, item)).url : source,
      maxSeconds
    );
    if (!fetched.ok) return report({ state: 'failed', reason: fetched.reason });

    const { clip } = fetched;
    const sizes = { seconds: clip.seconds, bytes: fetched.bytes };
    const options = videoRequestOptions(videoCfg, clip, { maxOutputTokens: videoCfg.maxOutputTokens, purpose: 'gif' });
    const ask = (): Promise<Answered> =>
      llm.complete(
        [
          { role: 'system', content: gifSystemPrompt(descriptionChars, clip.seconds, fetched.totalSeconds) },
          { role: 'user', content: [videoPart(videoCfg, clip)] },
        ],
        options
      ) as Promise<Answered>;
    let asked: Awaited<ReturnType<typeof askText>>;
    try {
      asked = await askText('gif', ask);
    } catch (err) {
      const reason = railReason(err, 'llm');
      if (reason === 'daily-cap') return report({ state: 'unavailable', reason }, sizes);
      return report({ state: 'failed', reason }, { ...sizes, status: propOf(err, 'statusCode') });
    }
    if ('failed' in asked) return report({ state: 'failed', reason: asked.failed }, sizes);

    let estimated = asked.answer.estimated ?? 0;
    const standard = await toStandard(
      { text: asked.text, usage: asked.answer.usage },
      (answer) => answer.text,
      () => askAgain('gif', ask, (spent) => (estimated += spent))
    );
    const text = plainDescription(await shorten(standard.answer.text, descriptionChars, 'GIF'));
    const ts = now();
    putVideoEntry(placeId, item.itemId, {
      text,
      ts,
      watched: true,
      gif: true,
      describedAt: ts,
      model: options.model,
      ...standard.marks,
    });
    report({ state: 'watched' }, sizes);
    return { state: 'watched', text, usage: standard.answer.usage ?? null, estimated };
  }

  /**
   * Download the animation at `source` and convert it to a short mp4
   * (src/media/fetch-video.ts#fetchGif: the first `maxSeconds`, the video
   * size and tool settings read now) -- the one fetch of a GIF watch and of
   * its second look. `{ ok: true, clip: { url, seconds, pinned: false },
   * bytes, totalSeconds }` (`seconds` the clip's length, never above `maxSeconds`, `totalSeconds` the whole GIF's,
   * null when unknown) or `{ ok: false, reason }`.
   */
  async function fetchGifClip(
    source: Untyped,
    maxSeconds: number
  ): Promise<
    | { ok: false; reason: string }
    | {
        ok: true;
        clip: { url: string; seconds: number; pinned: boolean };
        bytes: number | null;
        totalSeconds: number | null;
      }
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
    const totalSeconds = isFiniteNumber(media.totalSeconds) ? media.totalSeconds : null;
    return { ok: true, clip, bytes: media.bytes ?? null, totalSeconds };
  }

  /**
   * The system message of a GIF watch: `describe-gif` with `{{maxChars}}`,
   * `{{seconds}}` (the clip's length to one decimal) and `{{today}}`, else `describe-video` with `{{maxChars}}` and
   * `{{today}}`. A GIF longer than the clip adds `labels.gifCut` after a blank line. Read at the moment of use.
   */
  function gifSystemPrompt(maxChars: number, seconds: number, totalSeconds: number | null) {
    const prompt = gifWatchPrompt(hot.prompts);
    const values: Record<string, Untyped> = { maxChars, today: todayDate() };
    const clipSeconds = oneDecimal(seconds);
    if (prompt?.name === 'describe-gif') values.seconds = clipSeconds;
    const filled = fillPromptTemplate(prompt?.text, values);
    const labels = hot.prompts?.labels;
    const cut = labels?.gifCut;
    // A GIF the fetcher could not probe, or one no longer than the clip, is watched whole.
    if (totalSeconds === null || oneDecimal(totalSeconds) <= clipSeconds || typeof cut !== 'string') return filled;
    return `${filled}\n\n${fill(cut, { seconds: clipSeconds, total: oneDecimal(totalSeconds) })}`;
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
   * `retryMisses` picks a passing failure of any age as new; a refused file stays out.
   * `onCharge(result)` is called once per successful NEW request of this call
   * (never for a cache hit or a description shared with another caller) so a
   * caller with its own separate token budget can account for it.
   */
  async function describeMany(
    placeId: string,
    items: Array<MediaItem>,
    { maxNew = Infinity, concurrency = Infinity, onCharge, retryMisses = false }: DescribeManyOptions = {}
  ): Promise<{ descriptions: Map<string, string>; newCount: number }> {
    const found = new Map();
    const picked: Array<Untyped> = [];
    const seen = new Set();
    const on = picturesOn();
    const spent = on && capSpent();
    for (const item of on ? (items ?? []) : []) {
      if (!item?.itemId || seen.has(item.itemId) || item.kind === 'file') continue;
      if (item.kind !== 'text' && !roleOn(hot.config, mediaRoleOf(item))) continue;
      seen.add(item.itemId);
      const hit = cachedPicture(placeId, item, retryMisses);
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
        const { result, joined } = await describeShared(placeId, item, retryMisses);
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
    for (const item of items ?? []) {
      const entry = item?.itemId ? readEntry(placeId, item.itemId) : undefined;
      if (!entry || entry.miss || typeof entry.text !== 'string' || !entry.text) continue;
      touchHit(placeId, item.itemId, entry);
      descriptions.set(item.itemId, entry.text);
    }
    return descriptions;
  }

  // One in-flight watch per place + video: a message prefill and a turn that
  // reach the same new video at once share one request.
  const inFlight = new Map();

  /** Store a video cache entry, written like the picture entries. */
  function putVideoEntry(placeId: string, key: string, value: Untyped) {
    store.putMediaEntry(placeId, key, value);
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
    const entry = readEntry(placeId, key);
    if (!entry) return null;
    const lasting = videoStateFromCache(entry, hot.config, item);
    if (lasting?.state === 'watched') {
      touchHit(placeId, key, entry);
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
    {
      maxOutputTokens,
      purpose,
      model = null,
    }: { maxOutputTokens: number; purpose: VideoPurpose; model?: string | null }
  ) {
    return {
      model: model ?? roleModel(hot.config, 'video', purpose),
      role: 'video',
      purpose,
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
  async function fetchVideoMedia(placeId: string, item: MediaItem, videoCfg: Untyped) {
    const { maxSeconds, maxBytes, toolTimeoutMs, ffmpegPath, ytdlpPath } = videoCfg;
    const audioMap = audioMapSettings();
    if (item.source === 'attachment') {
      const got = await videoFetcher.fetchAttachment((await addressed(placeId, item)).url, {
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
    // Every site goes through the engine proxy while it is in force.
    const proxy = proxyNow();
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
    const summaryChars = VIDEO_DESCRIPTION_CHARS;
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
      putVideoEntry(placeId, key, { ...previous.entry, refreshFailedAt: now() });
      return previous.result;
    };
    const errorMiss = (reason: string, extra: Record<string, Untyped> = {}) => {
      if (previous) {
        report({ state: 'error' }, { ...extra, reason });
        return keepPrevious();
      }
      // A cut answer keeps its reason (`filter`, `cut`) on the miss and the result; any other failure is an `error`.
      const cut = CUT_REASONS.has(reason);
      putVideoEntry(placeId, key, { miss: true, ts: now(), reason: cut ? reason : 'error' });
      return report(cut ? { state: 'error', reason } : { state: 'error' }, { ...extra, reason });
    };

    // The request would be refused: no fetch, no slot, no miss.
    if (capSpent()) {
      report({ state: 'skipped' }, { reason: 'daily-cap' });
      return { result: previous?.result ?? null, sent: false, attempted: false };
    }

    const media = await fetchVideoMedia(placeId, item, videoCfg);
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
    const options = videoRequestOptions(videoCfg, media, {
      maxOutputTokens: videoCfg.maxOutputTokens,
      purpose: 'watch',
    });
    const ask = (): Promise<Answered> =>
      llm.complete(
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
      ) as Promise<Answered>;
    let asked: Awaited<ReturnType<typeof askText>>;
    try {
      asked = await askText('video', ask);
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

    if ('failed' in asked) return { result: errorMiss(asked.failed, sizes), sent: true, attempted: true };

    let estimated = asked.answer.estimated ?? 0;
    const standard = await toStandard(
      { text: asked.text, usage: asked.answer.usage },
      (answer) => answer.text,
      () => askAgain('video', ask, (spent) => (estimated += spent))
    );
    const text = plainDescription(await shorten(standard.answer.text, summaryChars, 'video'));
    const ts = now();
    const entry: Record<string, Untyped> = {
      text,
      ts,
      watched: true,
      describedAt: ts,
      model: options.model,
      ...standard.marks,
    };
    // How much of the video the summary saw: a downloaded clip is cut to
    // maxSeconds; a public URL is opened whole by the provider.
    if (!media.pinned && typeof media.seconds === 'number' && isFiniteNumber(media.seconds)) {
      entry.watchedSeconds = media.seconds;
      if (typeof media.totalSeconds === 'number') entry.totalSeconds = media.totalSeconds;
    }
    putVideoEntry(placeId, key, entry);
    const result = { state: 'watched', text, usage: standard.answer.usage ?? null, estimated };
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
    const promise = whilePending(placeId, key, previous?.entry ?? null, () =>
      watchVideo(placeId, item, key, promptText, force, previous)
    ).finally(() => inFlight.delete(flightKey));
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
   * The end of a second look: the answer of `ask`, a request of `kind`, made plain, shortened at `answerChars` and cached for an hour under `key`, or
   * `{ question, failed }` for an answer the provider cut short twice, or null for a failed request or an empty answer.
   * `report` gets the outcome with `extra` and the reason.
   */
  async function answerLook(
    placeId: string,
    key: string,
    asked: string,
    answerChars: number,
    report: (outcome: string, extra?: Record<string, Untyped>) => void,
    extra: Record<string, Untyped>,
    kind: string,
    ask: () => Promise<Answered>
  ): Looked {
    let got: Awaited<ReturnType<typeof askText>>;
    try {
      got = await askText(kind, ask);
    } catch (err) {
      report('error', { ...extra, reason: requestFailureReason(err) });
      return null;
    }
    if ('failed' in got) {
      report('error', { ...extra, reason: got.failed });
      return got.failed === 'empty' ? null : { question: asked, failed: got.failed };
    }
    const text = plainDescription(await shorten(got.text, answerChars, 'text'));
    putVideoEntry(placeId, key, { answer: text, question: asked, ts: now() });
    report('answered', extra);
    return { question: asked, text };
  }

  /**
   * The second look on a question: fetch `item` again exactly like a watch
   * (fetchVideoMedia -- same probe chain, direct-URL rules, caps and pinned
   * provider) and ask the video model `question`: the `rewatch-answer`
   * prompt is the system message (`{{maxChars}}` =
   * `VIDEO_DESCRIPTION_CHARS`; a `{{question}}` still in it is filled
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
    const answerChars = VIDEO_DESCRIPTION_CHARS;
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

    const key = questionKey(item.itemId, asked);
    const hit = readEntry(placeId, key);
    if (hit && typeof hit.answer === 'string') {
      if (now() - hit.ts < REWATCH_TTL_MS) {
        store.putMediaEntry(placeId, key, hit);
        report('answered', { cached: true });
        return { question: hit.question ?? asked, text: hit.answer };
      }
      store.dropMediaEntry(placeId, key);
    }

    // The request would be refused: no fetch, no slot.
    if (capSpent()) {
      report('limit', { reason: 'daily-cap' });
      return null;
    }

    const media = await fetchVideoMedia(placeId, item, videoCfg);
    if (!media.ok) {
      report(PERMANENT_VIDEO_MISSES.has(media.reason) ? 'limit' : 'error', { reason: media.reason ?? 'download' });
      return null;
    }

    return answerLook(
      placeId,
      key,
      asked,
      answerChars,
      report,
      { seconds: media.seconds ?? null },
      'video',
      () =>
        llm.complete(
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
          videoRequestOptions(videoCfg, media, {
            maxOutputTokens: rewatchCfg.maxOutputTokens,
            purpose: 'rewatch',
            model,
          })
        ) as Promise<Answered>
    );
  }

  /**
   * The second look at a picture on a question (features.imageRelook, a missing
   * key counts as on): download `item` the way a caption does (pictureImageUrl,
   * `context.vision.maxBytes`) and ask the
   * media model (`vision`, a request on a model role other than `core`, `purpose: 'relook'`,
   * output capped at `media.video.rewatch.maxOutputTokens`) `question`: the
   * `rewatch-answer` prompt is the system message (`{{maxChars}}` =
   * `PICTURE_DESCRIPTION_CHARS`; a `{{question}}` still in it is filled
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
    const answerChars = PICTURE_DESCRIPTION_CHARS;
    const report = (outcome: string, extra: Record<string, Untyped> = {}) => {
      log.info('describe: relook', {
        source: item.source ?? null,
        state: outcome,
        reason: extra.reason ?? null,
        cached: extra.cached ?? false,
      });
    };

    const key = questionKey(item.itemId, asked, 'image');
    const hit = readEntry(placeId, key);
    if (hit && typeof hit.answer === 'string') {
      if (now() - hit.ts < REWATCH_TTL_MS) {
        store.putMediaEntry(placeId, key, hit);
        report('answered', { cached: true });
        return { question: hit.question ?? asked, text: hit.answer };
      }
      store.dropMediaEntry(placeId, key);
    }

    // The request would be refused: no download, no slot.
    if (capSpent()) {
      report('limit', { reason: 'daily-cap' });
      return null;
    }

    const visionCfg = hot.config.context?.vision ?? {};
    const downloaded = await imageFetcher.fetchAsDataUrl(pictureImageUrl(await addressed(placeId, item)), {
      maxBytes: VISION_MAX_BYTES,
      timeoutMs: visionCfg.fetchTimeoutMs,
    });
    if (!downloaded) {
      report('error', { reason: 'download' });
      return null;
    }

    return answerLook(
      placeId,
      key,
      asked,
      answerChars,
      report,
      {},
      'image',
      () =>
        llm.complete(
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
        ) as Promise<Answered>
    );
  }

  /**
   * The GIFs of `items` whose watch failed (videoStateFromCache) and the pictures whose answer the provider cut short
   * twice (a miss with a reason), from the cache alone: `itemId` -> `{ state: 'error', reason }`, for formatTranscript's
   * `videos` option. Never a download or a request.
   * @param items  collectPictures items; `gif` and `image` ones count.
   */
  function failedMedia(placeId: string, items: Array<MediaItem>): Map<string, { state: 'error'; reason: string }> {
    const failed = new Map<string, { state: 'error'; reason: string }>();
    for (const item of items ?? []) {
      if (!item?.itemId) continue;
      if (item.kind === 'gif') {
        const cached = videoStateFromCache(readEntry(placeId, item.itemId), hot.config, item);
        if (cached?.state === 'error') failed.set(item.itemId, cached);
      } else if (item.kind === 'image') {
        const entry = readEntry(placeId, item.itemId);
        if (entry?.miss && typeof entry.reason === 'string')
          failed.set(item.itemId, { state: 'error', reason: entry.reason });
      }
    }
    return failed;
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
   * (`{{question}}`, `{{maxChars}}` = `GIF_DESCRIPTION_CHARS`,
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
    const answerChars = GIF_DESCRIPTION_CHARS;
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

    const key = questionKey(item.itemId, asked, 'gif');
    const hit = readEntry(placeId, key);
    if (hit && typeof hit.answer === 'string') {
      if (now() - hit.ts < REWATCH_TTL_MS) {
        store.putMediaEntry(placeId, key, hit);
        report('answered', { cached: true });
        return { question: hit.question ?? asked, text: hit.answer };
      }
      store.dropMediaEntry(placeId, key);
    }

    // The request would be refused: no fetch, no slot.
    if (capSpent()) {
      report('limit', { reason: 'daily-cap' });
      return null;
    }

    const fetched = await fetchGifClip(
      item.source === 'attachment' ? (await addressed(placeId, item)).url : source,
      maxSeconds
    );
    if (!fetched.ok) {
      report('error', { reason: fetched.reason });
      return null;
    }
    const { clip } = fetched;

    return answerLook(
      placeId,
      key,
      asked,
      answerChars,
      report,
      { seconds: clip.seconds },
      'gif',
      () =>
        llm.complete(
          [
            {
              role: 'system',
              content: fillPromptTemplate(promptText, { question: asked, maxChars: answerChars, today: todayDate() }),
            },
            { role: 'user', content: [videoPart(videoCfg, clip)] },
          ],
          videoRequestOptions(videoCfg, clip, {
            maxOutputTokens: rewatchCfg.maxOutputTokens,
            purpose: 'rewatch',
            model,
          })
        ) as Promise<Answered>
    );
  }

  // Which link of the YouTube duration chain works on this host (src/memory/youtube-check.ts):
  // the same fetcher and key as a real link, no LLM call, nothing cached.
  const checkYoutube = createYoutubeCheck({ hot, videoFetcher, youtubeApiKey, proxy: proxyNow });

  return {
    describe: ((...args) => track('describe', () => describe(...args))) as typeof describe,
    pictureBlocker: () => pictureBlockerOf(hot),
    describeDataUrl: ((...args) => track('describe.data', () => describeDataUrl(...args))) as typeof describeDataUrl,
    describeMany: ((...args) => track('describe.many', () => describeMany(...args))) as typeof describeMany,
    cachedDescriptions,
    describeVideo,
    describeVideos,
    cachedVideos,
    rewatchVideo,
    relookImage,
    rewatchGif,
    watchedGifs,
    failedMedia,
    gifWatchBlocker,
    checkYoutube,
  };
}

export type Describer = ReturnType<typeof buildDescriber>;

/**
 * What the describer sees on a picture she drew (src/turn/draw-gif.ts), from its bytes as a `data:` address: a posted
 * one through describe() as the attachment it became (`itemId`), so its caption is cached under it; one with no
 * message yet through describeDataUrl, caching nothing. Null with no bytes or no caption.
 */
export async function describeDrawn(
  describer: Pick<Describer, 'describe' | 'describeDataUrl'>,
  picture: { placeId: string; itemId?: string; buffer?: Buffer; mediaType?: string }
): Promise<string | null> {
  // The image client answers a picture without bytes when its provider sent none.
  if (!picture.buffer || !picture.mediaType) return null;
  const url = `data:${picture.mediaType};base64,${picture.buffer.toString('base64')}`;
  if (!picture.itemId) return describer.describeDataUrl(picture.placeId, url);
  return (await describer.describe(picture.placeId, { itemId: picture.itemId, kind: 'image', url }))?.text ?? null;
}

/**
 * @param deps.hot     Live config + prompts; read at the moment of use.
 * @param deps.llm     From createLlm().
 * @param [deps.imageFetcher]  From createImageFetcher() (src/media/fetch-image.ts).
 * @param [deps.videoFetcher]  From createVideoFetcher() (src/media/fetch-video.ts).
 * @param [deps.state]  The persistent state (store.state) holding the
 *   daily video and re-watch counters; without it the counters live in memory only.
 * @param [deps.youtubeApiKey]  Optional YouTube Data API key (the `youtube` service of keys.json), handed to
 *   probeYoutube only; never logged.
 */
export function createDescriber(deps: Parameters<typeof buildDescriber>[0]): Describer {
  return buildDescriber(deps);
}
