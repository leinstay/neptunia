// Whether YouTube video vision can work on this host. A YouTube link's
// duration comes from yt-dlp, else the Data API (YOUTUBE_API_KEY), else the
// watch page (src/memory/describe.js#fetchVideoMedia); on many servers
// YouTube answers yt-dlp with a bot check and the page carries no duration,
// so without the key most links end as "could not load" -- silently, one link
// at a time. This probes one fixed canary video (`media.video.canaryUrl`)
// through the same fetcher and says which link of that chain works, for
// `/nep ping video` and one startup log line. No LLM call, nothing cached,
// nothing written under data/; never logs the URL or the key.

import { log as defaultLog } from '../log.js';
import { proxyFor } from '../media/video-sites.js';

/**
 * Whether video vision is on: features.mediaDescriptions AND
 * features.videoDescriptions (a missing key counts as on), like the describer.
 * @param {object} config
 */
export function isVideoVisionOn(config) {
  const features = config?.features ?? {};
  return features.mediaDescriptions === true && features.videoDescriptions !== false;
}

/** A probe failure's reason for the detail string; never an error message. */
function reasonOf(result) {
  return typeof result?.reason === 'string' ? result.reason : 'download';
}

/** Whether a probe result carries a usable (positive, finite) duration. */
function hasDuration(result) {
  return Boolean(result?.ok) && Number.isFinite(result.durationSec) && result.durationSec > 0;
}

/**
 * @param {object} deps
 * @param {object} deps.hot  Live config; read at the moment of use.
 * @param {object} deps.videoFetcher  From createVideoFetcher(): `probeSite`, `probeYoutube`.
 * @param {string|null} [deps.youtubeApiKey]  Optional YOUTUBE_API_KEY; never logged or returned.
 * @returns {() => Promise<{ status: 'ytdlp'|'api'|'page'|'blocked', detail: string, keySet: boolean }>}
 *   Never rejects. `detail` is a short operator-facing note (a duration or the probes' reasons).
 */
export function createYoutubeCheck({ hot, videoFetcher, youtubeApiKey = null }) {
  return async function checkYoutube() {
    const keySet = typeof youtubeApiKey === 'string' && youtubeApiKey !== '';
    const videoCfg = hot.config.media?.video ?? {};
    const url = videoCfg.canaryUrl;
    if (typeof url !== 'string' || !url) return { status: 'blocked', detail: 'canaryUrl not set', keySet };
    const fetchTimeoutMs = hot.config.context?.vision?.fetchTimeoutMs;

    try {
      const site = await videoFetcher.probeSite(url, {
        ytdlpPath: videoCfg.ytdlpPath,
        toolTimeoutMs: videoCfg.toolTimeoutMs,
        proxy: proxyFor(url, videoCfg),
        proxyRetryMinutes: videoCfg.proxyRetryMinutes,
      });
      if (hasDuration(site)) return { status: 'ytdlp', detail: `duration ${site.durationSec}s`, keySet };
      const reasons = [`ytdlp=${site?.ok ? 'no-duration' : reasonOf(site)}`];

      if (keySet) {
        const api = await videoFetcher.probeYoutube(url, {
          fetchTimeoutMs,
          apiKey: youtubeApiKey,
          pageFallback: false,
        });
        if (hasDuration(api)) return { status: 'api', detail: `duration ${api.durationSec}s`, keySet };
        reasons.push(`api=${reasonOf(api)}`);
      } else {
        reasons.push('api=no-key');
      }

      const page = await videoFetcher.probeYoutube(url, { fetchTimeoutMs, apiKey: null });
      if (hasDuration(page)) return { status: 'page', detail: `duration ${page.durationSec}s`, keySet };
      reasons.push(`page=${reasonOf(page)}`);
      return { status: 'blocked', detail: reasons.join(' '), keySet };
    } catch {
      return { status: 'blocked', detail: 'check failed', keySet };
    }
  };
}

/**
 * The startup check: fire-and-forget, only when video vision is on. Logs the
 * status (info), or a warning with a hint when YouTube links will mostly fail.
 * @param {{ hot: object, checkYoutube: () => Promise<{ status: string }>, log?: object }} deps
 * @returns {Promise<void>|null}  null when the check was not run (video vision off).
 */
export function startYoutubeCheck({ hot, checkYoutube, log = defaultLog }) {
  if (!isVideoVisionOn(hot.config)) return null;
  return Promise.resolve()
    .then(() => checkYoutube())
    .then(({ status }) => {
      if (status === 'page' || status === 'blocked') {
        log.warn('youtube-check: status', { status, hint: 'set YOUTUBE_API_KEY' });
      } else {
        log.info('youtube-check: status', { status });
      }
    })
    .catch((err) => log.error('youtube-check: failed', { error: err?.name ?? 'Error' }));
}
