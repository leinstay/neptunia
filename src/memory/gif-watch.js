// Pure rules of the GIF watch (src/memory/describe.js#watchGif), shared by
// the describer, the `<senses>` block (src/behavior/prompt.js) and the owner's
// status lines (src/admin.js), so all three agree on whether GIFs are watched
// right now, which prompt a watch uses and how many watches today has left.
// A GIF watch has its own daily counter (`state.data.gifWatchDay` /
// `gifWatchCount`, `media.gif.maxPerDay`), separate from the video one.

/** The state.json fields of the daily GIF watch counter (counted by src/memory/describe.js). */
/** The state.json fields of the daily counter of GIFs the persona posted (counted by src/behavior/turn.js). */

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
 * they are: `off` (`media.gif.watch` false; a missing key counts as on) or
 * `no-prompt` (neither describe-gif nor describe-video).
 * @param {object} [config]   hot.config.
 * @param {object} [prompts]  hot.prompts.
 * @returns {'off'|'no-prompt'|null}
 */
export function gifWatchBlocker(config, prompts) {
  if (config?.media?.gif?.watch === false) return 'off';
  if (!gifWatchPrompt(prompts)) return 'no-prompt';
  return null;
}
