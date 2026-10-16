// Pure helpers for the persona's video vision: which links point at a video
// site, a stable cache key for a video URL (so a repost of the same video
// shares one cache entry), the exact yt-dlp / ffmpeg argument arrays the
// fetcher (src/discord/fetch-video.js) runs (a GIF's conversion to a short
// mp4 included), which links go through the optional yt-dlp proxy
// (proxyFor), and the parsers behind the
// YouTube duration probe that works without yt-dlp (the watch page, the
// optional Data API). No I/O here -- the child processes and requests live at
// the edge, these functions only decide what to run and read what came back.

import { createHash } from 'node:crypto';

// `>` closes Discord's `<url>` embed-suppression form; quotes and `<` never
// belong to a bare URL in chat text. A match therefore never holds a `>`.
const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;
const TRAILING_PUNCTUATION = /[).,]+$/;
// The height ceiling of a GIF's clip (ffmpegGifArgs), the same 360p as ffmpegTrimArgs.
const GIF_MAX_HEIGHT = 360;
// Tried left to right: a <=360p stream pair, a <=360p single file, then the
// best H.264 single file up to 720 on its short side, and only then `w`.
// yt-dlp always ranks the extractor's own preference first, so `w` lands on
// the format the extractor demoted -- on TikTok the watermarked copy of
// unknown size. The H.264 steps keep a real, re-encodable format ahead of it
// (the fetcher re-encodes an oversized download to 360p): the height tier
// catches landscape videos, the width tier portrait ones (TikTok is
// 720x1280, which a height limit alone rejects). `h264` is how TikTok names
// the codec, `avc` how most other extractors do. When none of them exists,
// `w` as before, last.
const YTDLP_FORMAT =
  'bv*[height<=360]+ba/b[height<=360]/b[height<=720][vcodec^=h264]/b[width<=720][vcodec^=h264]/' +
  'b[height<=720][vcodec^=avc]/b[width<=720][vcodec^=avc]/w';

/** Lowercase hostname of `url`, or null when it does not parse. */
function hostOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** The entry of `sites` that `host` equals or is a subdomain of, else null. */
function matchSite(host, sites) {
  if (!host || !Array.isArray(sites)) return null;
  for (const site of sites) {
    const s = String(site ?? '').toLowerCase();
    if (!s) continue;
    if (host === s || host.endsWith(`.${s}`)) return site;
  }
  return null;
}

/**
 * The site from `sites` whose domain `url`'s host equals or ends with
 * `.<site>` (case-insensitive), or null (also for an unparsable URL).
 * @param {string} url
 * @param {string[]} sites
 * @returns {string|null}
 */
export function videoSiteFor(url, sites) {
  return matchSite(hostOf(url), sites);
}

/**
 * Whether `url` belongs to a site whose public URL is handed to the model
 * as-is. Same matching rule as videoSiteFor.
 * @param {string} url
 * @param {string[]} directUrlSites
 * @returns {boolean}
 */
export function isDirectUrlSite(url, directUrlSites) {
  return videoSiteFor(url, directUrlSites) !== null;
}

/**
 * Distinct http(s) URLs in `text` that point at one of `sites`, in order of
 * appearance, with trailing `)`, `.`, `,` stripped. Plain text only.
 * @param {string} text
 * @param {string[]} sites
 * @returns {string[]}
 */
export function extractVideoUrls(text, sites) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = match[0].replace(TRAILING_PUNCTUATION, '');
    if (!url || out.includes(url)) continue;
    if (videoSiteFor(url, sites) !== null) out.push(url);
  }
  return out;
}

// YouTube paths whose second segment is the video id.
const YOUTUBE_ID_PATHS = new Set(['shorts', 'embed', 'live']);

/**
 * The video id of a YouTube URL (`youtu.be/<id>`, `youtube.com/watch?v=<id>`,
 * `/shorts/<id>`, `/embed/<id>`, `/live/<id>`), or null. `host` is already
 * lowercased and stripped of a leading `www.` / `m.`.
 */
function youtubeId(host, parsed) {
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (host === 'youtu.be') return segments[0] ?? null;
  if (host !== 'youtube.com') return null;
  if (segments[0] === 'watch') return parsed.searchParams.get('v') || null;
  if (YOUTUBE_ID_PATHS.has(segments[0])) return segments[1] ?? null;
  return null;
}

/** Lowercase hostname of a parsed URL without a leading `www.` / `m.`. */
function canonicalHost(parsed) {
  return parsed.hostname.toLowerCase().replace(/^(www\.|m\.)/, '');
}

/**
 * The video id of any YouTube URL form videoUrlCacheKey canonicalises
 * (`youtu.be/<id>`, `watch?v=<id>`, `/shorts/<id>`, `/embed/<id>`,
 * `/live/<id>`, on `www.` or `m.`), else null (also for an unparsable URL).
 * @param {string} url
 * @returns {string|null}
 */
export function youtubeVideoId(url) {
  try {
    const parsed = new URL(String(url ?? ''));
    return youtubeId(canonicalHost(parsed), parsed);
  } catch {
    return null;
  }
}

/**
 * The URL a video link goes out by when a provider opens it itself: the
 * canonical `https://www.youtube.com/watch?v=<id>` for any YouTube video form
 * youtubeVideoId reads (so no playlist, timestamp or tracking param reaches
 * the provider -- a `list=` makes it ingest the whole playlist), else `url`
 * unchanged (another site, a YouTube page without an id, an unparsable URL).
 * @param {string} url
 * @returns {string}
 */
export function publicVideoUrl(url) {
  const id = youtubeVideoId(url);
  return id ? `https://www.youtube.com/watch?v=${id}` : url;
}

/**
 * `video:url:<16 hex>` -- sha1 of a canonical form: lowercase host without a
 * leading `www.` / `m.`, the path, and only the `v` query param (YouTube's
 * video id) when present. Every YouTube form of one video (`youtu.be/<id>`,
 * `/shorts/<id>`, `/embed/<id>`, `/live/<id>`, `watch?v=<id>`, any of them on
 * `m.`) canonicalises to `youtube.com/watch?v=<id>` first, so an embed and a
 * typed link of the same video share one key. Tracking params, timestamps
 * and playlists never split the cache. Short links with no id in them
 * (TikTok's `vm.` / `vt.`) are hashed as they are.
 * @param {string} url
 * @returns {string}
 */
export function videoUrlCacheKey(url) {
  let base = String(url ?? '');
  try {
    const parsed = new URL(base);
    const host = canonicalHost(parsed);
    const id = youtubeId(host, parsed);
    if (id) {
      base = `youtube.com/watch?v=${id}`;
    } else {
      const v = parsed.searchParams.get('v');
      base = `${host}${parsed.pathname}${v !== null ? `?v=${v}` : ''}`;
    }
  } catch {
    // An unparsable URL still hashes to something stable -- best effort.
  }
  return `video:url:${createHash('sha1').update(base).digest('hex').slice(0, 16)}`;
}

/**
 * The proxy yt-dlp should use for `url`: `videoCfg.proxy` when it is a
 * non-empty string and `url` belongs to one of `videoCfg.proxySites` (same
 * matching rule as videoSiteFor), else null -- an empty proxy or an empty
 * list turns it off. The value may carry credentials: never log it.
 * @param {string} url
 * @param {{ proxy?: string, proxySites?: string[] }} [videoCfg]
 * @returns {string|null}
 */
export function proxyFor(url, videoCfg) {
  const proxy = videoCfg?.proxy;
  if (typeof proxy !== 'string' || !proxy) return null;
  return videoSiteFor(url, videoCfg.proxySites) !== null ? proxy : null;
}

/** `['--proxy', proxy]` for a non-empty string, else nothing. */
function proxyArgs(proxy) {
  return typeof proxy === 'string' && proxy ? ['--proxy', proxy] : [];
}

/**
 * A metadata-only yt-dlp run (duration, title), no download. A non-empty
 * `proxy` (see proxyFor) is passed verbatim as `--proxy`.
 * @param {string} url
 * @param {{ ytdlpPath: string, proxy?: string|null }} options
 * @returns {{ command: string, args: string[] }}
 */
export function ytdlpProbeArgs(url, { ytdlpPath, proxy = null } = {}) {
  return {
    command: ytdlpPath,
    args: [
      '--dump-single-json', '--skip-download', '--no-playlist', '--no-warnings', '--quiet',
      ...proxyArgs(proxy),
      '--', String(url),
    ],
  };
}

/**
 * A yt-dlp run that downloads a video at low resolution, merged into one mp4
 * at `outPath`. A video longer than `maxSeconds` (or of unknown length) is
 * cut to its first `maxSeconds`, which needs ffmpeg; a known duration within
 * `maxSeconds` is downloaded whole, with no cut. `maxFileSize` is the
 * download ceiling passed as `--max-filesize` (yt-dlp then writes nothing),
 * not the final size limit: the fetcher re-encodes a download over its
 * `maxBytes` with ffmpegTrimArgs. With a non-empty `proxy` (passed
 * verbatim as `--proxy`) the video is always downloaded whole, never cut:
 * the sections cut hands the download to ffmpeg, which cannot speak SOCKS,
 * so the fetcher trims the first `maxSeconds` locally instead (same format
 * selector, same `--max-filesize`). `--ffmpeg-location` is passed
 * only when `ffmpegPath` contains a path separator: yt-dlp resolves the value
 * as a path, so a bare name like `ffmpeg` is left to its own PATH search.
 * @param {string} url
 * @param {{ ytdlpPath: string, ffmpegPath: string, maxSeconds: number, maxFileSize: number, outPath: string,
 *   durationSec?: number|null, proxy?: string|null }} options
 * @returns {{ command: string, args: string[] }}
 */
export function ytdlpClipArgs(url, {
  ytdlpPath, ffmpegPath, maxSeconds, maxFileSize, outPath, durationSec = null, proxy = null,
} = {}) {
  const ffmpegPathStr = ffmpegPath == null ? '' : String(ffmpegPath);
  const location = /[\\/]/.test(ffmpegPathStr) ? ['--ffmpeg-location', ffmpegPathStr] : [];
  const viaProxy = proxyArgs(proxy);
  const whole = viaProxy.length > 0 || (Number.isFinite(durationSec) && durationSec <= maxSeconds);
  const cut = whole ? [] : ['--download-sections', `*0-${maxSeconds}`, '--force-keyframes-at-cuts'];
  return {
    command: ytdlpPath,
    args: [
      '--no-playlist', '--no-warnings', '--quiet',
      ...viaProxy,
      ...location,
      '-f', YTDLP_FORMAT,
      '--merge-output-format', 'mp4',
      ...cut,
      '--max-filesize', String(maxFileSize),
      '-o', String(outPath),
      '--',
      String(url),
    ],
  };
}

// The trim's video ceiling and audio bitrate (kbps), see ffmpegTrimArgs.
const TRIM_VIDEO_KBPS = 400;
const TRIM_AUDIO_KBPS = 96;
// The fit re-encode (fitBitrate): its audio bitrate, the share of maxBytes it
// aims at (container overhead and rate-control overshoot), its video floor.
const FIT_AUDIO_KBPS = 48;
const FIT_HEADROOM = 0.9;
const FIT_VIDEO_FLOOR_KBPS = 100;

/**
 * An ffmpeg run that cuts `inPath` to its first `maxSeconds` and re-encodes
 * it small (360p H.264 + AAC) into `outPath`. The video bitrate is capped
 * (`-maxrate 400k -bufsize 800k` on top of CRF 28) so high-motion content
 * cannot blow the size up: 400k video + 96k audio is ~496 kbps, ~18.6 MB at
 * worst for a 300 s clip. Most clips land far below it; one still over
 * `media.video.maxBytes` is encoded once more at fitBitrate (ffmpegFitArgs).
 * @param {string} inPath
 * @param {string} outPath
 * @param {{ ffmpegPath: string, maxSeconds: number }} options
 * @returns {{ command: string, args: string[] }}
 */
export function ffmpegTrimArgs(inPath, outPath, { ffmpegPath, maxSeconds } = {}) {
  return {
    command: ffmpegPath,
    args: [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', String(inPath),
      '-t', String(maxSeconds),
      '-vf', 'scale=-2:360',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
      '-maxrate', `${TRIM_VIDEO_KBPS}k`, '-bufsize', `${TRIM_VIDEO_KBPS * 2}k`,
      '-c:a', 'aac', '-b:a', `${TRIM_AUDIO_KBPS}k`,
      '-movflags', '+faststart',
      String(outPath),
    ],
  };
}

/**
 * The bitrates of the one fit re-encode of a clip `seconds` long that must
 * stay within `maxBytes`: audio at FIT_AUDIO_KBPS (48), video at what is left
 * of `maxBytes * 8 / seconds` after FIT_HEADROOM (90 %) and the audio, never
 * above the trim's own ceiling (400) nor below FIT_VIDEO_FLOOR_KBPS (100) --
 * a clip that needs less still gets the floor and may stay `size`. Whole
 * kbps, rounded down. Pure.
 * @param {{ maxBytes: number, seconds: number }} options
 * @returns {{ videoKbps: number, audioKbps: number }}
 */
export function fitBitrate({ maxBytes, seconds } = {}) {
  const valid = Number.isFinite(maxBytes) && maxBytes > 0 && Number.isFinite(seconds) && seconds > 0;
  const totalKbps = valid ? (maxBytes * 8 * FIT_HEADROOM) / seconds / 1000 : 0;
  const videoKbps = Math.floor(Math.min(TRIM_VIDEO_KBPS, Math.max(FIT_VIDEO_FLOOR_KBPS, totalKbps - FIT_AUDIO_KBPS)));
  return { videoKbps, audioKbps: FIT_AUDIO_KBPS };
}

/**
 * An ffmpeg run like ffmpegTrimArgs (first `maxSeconds`, 360p, H.264 + AAC)
 * at fixed bitrates from fitBitrate instead of CRF: video `-b:v` = `-maxrate`
 * = `videoKbps` with a buffer of twice that, audio at `audioKbps`. For a
 * clip the trim left over `maxBytes`; it is encoded from the same source.
 * @param {string} inPath
 * @param {string} outPath
 * @param {{ ffmpegPath: string, maxSeconds: number, videoKbps: number, audioKbps: number }} options
 * @returns {{ command: string, args: string[] }}
 */
export function ffmpegFitArgs(inPath, outPath, { ffmpegPath, maxSeconds, videoKbps, audioKbps } = {}) {
  return {
    command: ffmpegPath,
    args: [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', String(inPath),
      '-t', String(maxSeconds),
      '-vf', 'scale=-2:360',
      '-c:v', 'libx264', '-preset', 'veryfast',
      '-b:v', `${videoKbps}k`, '-maxrate', `${videoKbps}k`, '-bufsize', `${videoKbps * 2}k`,
      '-c:a', 'aac', '-b:a', `${audioKbps}k`,
      '-movflags', '+faststart',
      String(outPath),
    ],
  };
}

/**
 * An ffmpeg run that turns a GIF -- a `.gif` file, or the mp4/webm a GIF
 * site (tenor, giphy) serves for it -- into a short clip a video model can
 * take: its first `maxSeconds` (a loop GIF is short; a longer animation is
 * cut), at most GIF_MAX_HEIGHT (360) pixels high but never upscaled, both
 * sides even (H.264 needs it), yuv420p H.264 (a GIF decodes to RGB, which
 * libx264 would otherwise keep as a 4:4:4 stream many decoders refuse), no
 * audio track, and the same bitrate cap as ffmpegTrimArgs. The height
 * expression is quoted so its comma is not read as a filter separator.
 * @param {string} inPath
 * @param {string} outPath
 * @param {{ ffmpegPath: string, maxSeconds: number }} options
 * @returns {{ command: string, args: string[] }}
 */
export function ffmpegGifArgs(inPath, outPath, { ffmpegPath, maxSeconds } = {}) {
  return {
    command: ffmpegPath,
    args: [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', String(inPath),
      '-t', String(maxSeconds),
      '-vf', `scale=-2:'min(${GIF_MAX_HEIGHT},trunc(ih/2)*2)'`,
      '-pix_fmt', 'yuv420p',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
      '-maxrate', '400k', '-bufsize', '800k',
      '-an',
      '-movflags', '+faststart',
      String(outPath),
    ],
  };
}

/**
 * Duration and title from yt-dlp's `--dump-single-json` output; anything
 * missing, mistyped or unparsable becomes null, and so does a zero duration
 * (a live stream, see positiveSeconds).
 * @param {string} jsonText
 * @returns {{ durationSec: number|null, title: string|null }}
 */
export function parseProbe(jsonText) {
  let data;
  try {
    data = JSON.parse(String(jsonText));
  } catch {
    return { durationSec: null, title: null };
  }
  if (!data || typeof data !== 'object') return { durationSec: null, title: null };
  const duration = positiveSeconds(data.duration);
  const title = typeof data.title === 'string' ? data.title : null;
  return { durationSec: duration, title };
}

/**
 * A `content-type` header value as `type/subtype` in lowercase, parameters
 * (`; charset=...`) dropped; '' when missing.
 * @param {string|null|undefined} value
 * @returns {string}
 */
export function bareContentType(value) {
  return String(value ?? '').split(';')[0].trim().toLowerCase();
}

/**
 * `hostname/path`, never the query string -- safe to log.
 * @param {string} url
 * @returns {string}
 */
export function safeLocation(url) {
  try {
    const parsed = new URL(String(url));
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return '(unparsable url)';
  }
}

const ISO_DURATION = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

/**
 * Seconds of an ISO 8601 duration (`PT3M34S` -> 214, `PT1H` -> 3600,
 * `P1DT1S` -> 86401; fractional seconds round up), or null when `text` is not
 * one (an empty `P` / `PT` included).
 * @param {string} text
 * @returns {number|null}
 */
export function parseIsoDuration(text) {
  if (typeof text !== 'string') return null;
  const match = ISO_DURATION.exec(text);
  if (!match || text.endsWith('T')) return null;
  const [, days, hours, minutes, seconds] = match;
  if (days === undefined && hours === undefined && minutes === undefined && seconds === undefined) return null;
  const total =
    Number(days ?? 0) * 86400 + Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0);
  return Math.ceil(total);
}

/** A positive finite number of seconds, else null -- a zero length is a live stream, not a duration. */
function positiveSeconds(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The duration of a YouTube watch page in seconds, or null. Tried in order:
 * `"lengthSeconds":"<n>"`, `"approxDurationMs":"<n>"` (rounded up to whole
 * seconds), the `itemprop="duration" content="PT..."` meta tag. A zero value
 * (a live stream) counts as missing and the next field is tried.
 * @param {string} html
 * @returns {number|null}
 */
export function parseYoutubePageDuration(html) {
  if (typeof html !== 'string' || !html) return null;
  const length = /"lengthSeconds":"(\d+)"/.exec(html);
  const fromLength = length ? positiveSeconds(Number(length[1])) : null;
  if (fromLength !== null) return fromLength;
  const approx = /"approxDurationMs":"(\d+)"/.exec(html);
  const fromApprox = approx ? positiveSeconds(Math.ceil(Number(approx[1]) / 1000)) : null;
  if (fromApprox !== null) return fromApprox;
  const meta = /itemprop="duration"\s+content="([^"]*)"/.exec(html);
  return meta ? positiveSeconds(parseIsoDuration(meta[1])) : null;
}

/**
 * The YouTube Data API v3 request for one video's contentDetails. The URL
 * carries the key: never log it (log the fixed path instead).
 * @param {string} id
 * @param {string} key
 * @returns {string}
 */
export function youtubeDataApiUrl(id, key) {
  return (
    'https://www.googleapis.com/youtube/v3/videos?part=contentDetails' +
    `&id=${encodeURIComponent(String(id))}&key=${encodeURIComponent(String(key))}`
  );
}

/**
 * Seconds from a Data API `videos` response (`items[0].contentDetails.duration`),
 * or null -- no items (private, deleted), a live `P0D`, anything unparsable.
 * @param {string} jsonText
 * @returns {number|null}
 */
export function parseYoutubeDataApi(jsonText) {
  let data;
  try {
    data = JSON.parse(String(jsonText));
  } catch {
    return null;
  }
  const duration = data?.items?.[0]?.contentDetails?.duration;
  return positiveSeconds(parseIsoDuration(duration));
}
