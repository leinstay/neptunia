// Pure functions for the persona's video vision: which links point at a video
// site, a stable cache key for a video URL (so a repost of the same video
// shares one cache entry), the exact yt-dlp / ffmpeg argument arrays the
// fetcher (src/media/fetch-video.ts) runs (a GIF's conversion to a short
// mp4 included), and the parsers behind the
// YouTube duration probe that works without yt-dlp (the watch page, the
// optional Data API). No I/O here -- the child processes and requests live at
// the edge, these functions only decide what to run and read what came back.

import { createHash } from 'node:crypto';

// `>` closes the `<url>` form chat platforms use to suppress an embed; quotes and `<` never
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
function hostOf(url: unknown): string | null {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** The entry of `sites` that `host` equals or is a subdomain of, else null. */
function matchSite(host: string | null, sites: ReadonlyArray<string> | undefined): string | null {
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
 */
export function videoSiteFor(url: string, sites: ReadonlyArray<string> | undefined): string | null {
  return matchSite(hostOf(url), sites);
}

/**
 * Whether `url` belongs to a site whose public URL is handed to the model
 * as-is. Same matching rule as videoSiteFor.
 */
export function isDirectUrlSite(url: string, directUrlSites: ReadonlyArray<string> | undefined): boolean {
  return videoSiteFor(url, directUrlSites) !== null;
}

/**
 * Distinct http(s) URLs in `text` that point at one of `sites`, in order of
 * appearance, with trailing `)`, `.`, `,` stripped. Plain text only.
 */
export function extractVideoUrls(text: string, sites: ReadonlyArray<string> | undefined): Array<string> {
  if (typeof text !== 'string' || !text) return [];
  const out: Array<string> = [];
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
function youtubeId(host: string, parsed: URL): string | null {
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (host === 'youtu.be') return segments[0] ?? null;
  if (host !== 'youtube.com') return null;
  if (segments[0] === 'watch') return parsed.searchParams.get('v') || null;
  if (YOUTUBE_ID_PATHS.has(segments[0])) return segments[1] ?? null;
  return null;
}

/** Lowercase hostname of a parsed URL without a leading `www.` / `m.`. */
function canonicalHost(parsed: URL): string {
  return parsed.hostname.toLowerCase().replace(/^(www\.|m\.)/, '');
}

/**
 * The video id of any YouTube URL form videoUrlCacheKey canonicalises
 * (`youtu.be/<id>`, `watch?v=<id>`, `/shorts/<id>`, `/embed/<id>`,
 * `/live/<id>`, on `www.` or `m.`), else null (also for an unparsable URL).
 */
export function youtubeVideoId(url: string): string | null {
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
 */
export function publicVideoUrl(url: string): string {
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
 */
export function videoUrlCacheKey(url: string): string {
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

/** `['--proxy', proxy]` for a non-empty string, else nothing. */
function proxyArgs(proxy: unknown): Array<string> {
  return typeof proxy === 'string' && proxy ? ['--proxy', proxy] : [];
}

/**
 * A metadata-only yt-dlp run (duration, title), no download. A non-empty
 * `proxy` (the engine proxy in force, src/net/proxy.ts) is passed verbatim as `--proxy`.
 */
export function ytdlpProbeArgs(
  url: string,
  { ytdlpPath, proxy = null }: { ytdlpPath: string; proxy?: string | null } = { ytdlpPath: '' }
): { command: string; args: Array<string> } {
  return {
    command: ytdlpPath,
    args: [
      '--dump-single-json',
      '--skip-download',
      '--no-playlist',
      '--no-warnings',
      '--quiet',
      ...proxyArgs(proxy),
      '--',
      String(url),
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
 */
export function ytdlpClipArgs(
  url: string,
  {
    ytdlpPath,
    ffmpegPath,
    maxSeconds,
    maxFileSize,
    outPath,
    durationSec = null,
    proxy = null,
  }: {
    ytdlpPath: string;
    ffmpegPath: string;
    maxSeconds: number;
    maxFileSize: number;
    outPath: string;
    durationSec?: number | null;
    proxy?: string | null;
  }
): { command: string; args: Array<string> } {
  const ffmpegPathStr = ffmpegPath == null ? '' : String(ffmpegPath);
  const location = /[\\/]/.test(ffmpegPathStr) ? ['--ffmpeg-location', ffmpegPathStr] : [];
  const viaProxy = proxyArgs(proxy);
  const whole =
    viaProxy.length > 0 ||
    (typeof durationSec === 'number' && Number.isFinite(durationSec) && durationSec <= maxSeconds);
  const cut = whole ? [] : ['--download-sections', `*0-${maxSeconds}`, '--force-keyframes-at-cuts'];
  return {
    command: ytdlpPath,
    args: [
      '--no-playlist',
      '--no-warnings',
      '--quiet',
      ...viaProxy,
      ...location,
      '-f',
      YTDLP_FORMAT,
      '--merge-output-format',
      'mp4',
      ...cut,
      '--max-filesize',
      String(maxFileSize),
      '-o',
      String(outPath),
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
 */
/**
 * The ffmpeg run that carries an audio file as the short clip the `video` role reads: a still black picture with the sound in
 * AAC, cut to `maxSeconds`. The one place the packaging of audio is decided. The clip ends with the sound in this one run:
 * `zerolatency` holds back no frames, which would outlive `-shortest`, and ten frames a second leave at most a tenth of a
 * second of picture past the sound.
 */
export function ffmpegAudioArgs(
  inPath: string,
  outPath: string,
  { ffmpegPath, maxSeconds }: { ffmpegPath: string; maxSeconds: number }
): { command: string; args: Array<string> } {
  return {
    command: ffmpegPath,
    args: [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=64x64:r=10',
      '-i',
      String(inPath),
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-shortest',
      '-t',
      String(maxSeconds),
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-tune',
      'stillimage,zerolatency',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '64k',
      '-movflags',
      '+faststart',
      String(outPath),
    ],
  };
}

export function ffmpegTrimArgs(
  inPath: string,
  outPath: string,
  { ffmpegPath, maxSeconds }: { ffmpegPath: string; maxSeconds: number }
): { command: string; args: Array<string> } {
  return {
    command: ffmpegPath,
    args: [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      String(inPath),
      '-t',
      String(maxSeconds),
      '-vf',
      'scale=-2:360',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '28',
      '-maxrate',
      `${TRIM_VIDEO_KBPS}k`,
      '-bufsize',
      `${TRIM_VIDEO_KBPS * 2}k`,
      '-c:a',
      'aac',
      '-b:a',
      `${TRIM_AUDIO_KBPS}k`,
      '-movflags',
      '+faststart',
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
 */
export function fitBitrate({ maxBytes, seconds }: { maxBytes: number; seconds: number }): {
  videoKbps: number;
  audioKbps: number;
} {
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
 */
export function ffmpegFitArgs(
  inPath: string,
  outPath: string,
  {
    ffmpegPath,
    maxSeconds,
    videoKbps,
    audioKbps,
  }: { ffmpegPath: string; maxSeconds: number; videoKbps: number; audioKbps: number }
): { command: string; args: Array<string> } {
  return {
    command: ffmpegPath,
    args: [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      String(inPath),
      '-t',
      String(maxSeconds),
      '-vf',
      'scale=-2:360',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-b:v',
      `${videoKbps}k`,
      '-maxrate',
      `${videoKbps}k`,
      '-bufsize',
      `${videoKbps * 2}k`,
      '-c:a',
      'aac',
      '-b:a',
      `${audioKbps}k`,
      '-movflags',
      '+faststart',
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
 */
export function ffmpegGifArgs(
  inPath: string,
  outPath: string,
  { ffmpegPath, maxSeconds }: { ffmpegPath: string; maxSeconds: number }
): { command: string; args: Array<string> } {
  return {
    command: ffmpegPath,
    args: [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      String(inPath),
      '-t',
      String(maxSeconds),
      '-vf',
      `scale=-2:'min(${GIF_MAX_HEIGHT},trunc(ih/2)*2)'`,
      '-pix_fmt',
      'yuv420p',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '28',
      '-maxrate',
      '400k',
      '-bufsize',
      '800k',
      '-an',
      '-movflags',
      '+faststart',
      String(outPath),
    ],
  };
}

/**
 * Duration and title from yt-dlp's `--dump-single-json` output; anything
 * missing, mistyped or unparsable becomes null, and so does a zero duration
 * (a live stream, see positiveSeconds).
 */
export function parseProbe(jsonText: string): { durationSec: number | null; title: string | null } {
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
 */
export function bareContentType(value: string | null | undefined): string {
  return String(value ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
}

/** `hostname/path`, never the query string -- safe to log. */
export function safeLocation(url: string): string {
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
 */
export function parseIsoDuration(text: string): number | null {
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
function positiveSeconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The duration of a YouTube watch page in seconds, or null. Tried in order:
 * `"lengthSeconds":"<n>"`, `"approxDurationMs":"<n>"` (rounded up to whole
 * seconds), the `itemprop="duration" content="PT..."` meta tag. A zero value
 * (a live stream) counts as missing and the next field is tried.
 */
export function parseYoutubePageDuration(html: string): number | null {
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
 */
export function youtubeDataApiUrl(id: string, key: string): string {
  return (
    'https://www.googleapis.com/youtube/v3/videos?part=contentDetails' +
    `&id=${encodeURIComponent(String(id))}&key=${encodeURIComponent(String(key))}`
  );
}

/**
 * Seconds from a Data API `videos` response (`items[0].contentDetails.duration`),
 * or null -- no items (private, deleted), a live `P0D`, anything unparsable.
 */
export function parseYoutubeDataApi(jsonText: string): number | null {
  let data;
  try {
    data = JSON.parse(String(jsonText));
  } catch {
    return null;
  }
  const duration = data?.items?.[0]?.contentDetails?.duration;
  return positiveSeconds(parseIsoDuration(duration));
}
