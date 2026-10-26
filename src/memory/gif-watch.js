// Pure rules of the GIF watch (src/memory/describe.js#watchGif), shared by
// the describer, the `<senses>` block (src/behavior/prompt.js) and the owner's
// status lines (src/admin.js), so all three agree on whether GIFs are watched
// right now, which prompt a watch uses and how many watches today has left.
// A GIF watch has its own daily counter (`state.data.gifWatchDay` /
// `gifWatchCount`, `media.gif.maxPerDay`), separate from the video one.

import { countToday } from '../time.js';
import { isVideoVisionOn } from './youtube-check.js';

/** `media.gif.maxPerDay` when missing or invalid (config.json carries the same). */
export const GIF_MAX_PER_DAY_FALLBACK = 200;

/** The state.json fields of the daily GIF watch counter (counted by src/memory/describe.js). */
const GIF_WATCH_DAILY = { dayKey: 'gifWatchDay', countKey: 'gifWatchCount' };
/** The state.json fields of the daily counter of GIFs the persona posted (counted by src/behavior/turn.js). */
const GIF_POSTS_DAILY = { dayKey: 'gifDay', countKey: 'gifCount' };

/** The prompt files a GIF watch can use, the dedicated one first. */
const GIF_PROMPTS = ['describe-gif', 'describe-video'];

/**
 * The prompt a GIF watch uses under the live prompts: `describe-gif` when it
 * is there, else `describe-video`; null when neither is.
 * @param {object} [prompts]  hot.prompts.
 * @returns {{ name: string, text: string }|null}
 */
export function gifWatchPrompt(prompts) {
  for (const name of GIF_PROMPTS) {
    const text = prompts?.[name];
    if (typeof text === 'string' && text) return { name, text };
  }
  return null;
}

/**
 * Why GIFs are not watched under the live config and prompts, or null when
 * they are: `off` (features.mediaDescriptions not on, or `media.gif.watch`
 * false -- a missing key counts as on), `video-off` (features.videoDescriptions
 * false: video vision off) or `no-prompt` (neither describe-gif nor describe-video).
 * @param {object} [config]   hot.config.
 * @param {object} [prompts]  hot.prompts.
 * @returns {'off'|'video-off'|'no-prompt'|null}
 */
export function gifWatchBlocker(config, prompts) {
  const features = config?.features ?? {};
  if (features.mediaDescriptions !== true || config?.media?.gif?.watch === false) return 'off';
  if (!isVideoVisionOn(config)) return 'video-off';
  if (!gifWatchPrompt(prompts)) return 'no-prompt';
  return null;
}

/**
 * The daily GIF watch cap: `media.gif.maxPerDay` (0 = no watches), else the fallback.
 * @param {object} [config]  hot.config.
 * @returns {number}
 */
export function gifWatchCap(config) {
  const cap = config?.media?.gif?.maxPerDay;
  return typeof cap === 'number' && Number.isFinite(cap) && cap >= 0 ? cap : GIF_MAX_PER_DAY_FALLBACK;
}

/**
 * Today's GIF watches against the cap, read only (the describer rolls the day
 * over): the `state.data.gifWatchDay` / `gifWatchCount` pair through
 * src/time.js#countToday, so another day -- and a count that is not a finite
 * number >= 0 -- counts as 0.
 * @param {object} [data]    store.state.data.
 * @param {object} [config]  hot.config.
 * @param {string} today     `YYYY-MM-DD` (UTC).
 * @returns {{ used: number, cap: number }}
 */
export function gifWatchesToday(data, config, today) {
  return { used: countToday(data, GIF_WATCH_DAILY, today), cap: gifWatchCap(config) };
}

/** `gifs.maxPerDay` when missing or invalid (config.json carries the same). */
export const GIF_POSTS_PER_DAY_FALLBACK = 40;

/**
 * Today's GIFs posted by the persona against `gifs.maxPerDay`, read only
 * (src/behavior/turn.js counts a post and rolls the day over): the
 * `state.data.gifDay` / `gifCount` pair through src/time.js#countToday, another
 * day -- and a count that is not a finite number >= 0 -- counting as 0. Shared
 * by the turn's daily check and `/nep gifs status`.
 * @param {object} [data]    store.state.data.
 * @param {object} [config]  hot.config.
 * @param {string} today     `YYYY-MM-DD` (UTC).
 * @returns {{ used: number, cap: number }}
 */
export function gifPostsToday(data, config, today) {
  const cap = config?.gifs?.maxPerDay;
  return {
    used: countToday(data, GIF_POSTS_DAILY, today),
    cap: Number.isFinite(cap) ? cap : GIF_POSTS_PER_DAY_FALLBACK,
  };
}
