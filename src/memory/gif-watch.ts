// Pure rules of the GIF watch (src/memory/describe.ts#watchGif), shared by
// the describer, the `<senses>` block (src/behavior/prompt.js) and the owner's
// status lines (src/admin.js), so all three agree on whether GIFs are watched
// right now and which prompt a watch uses.

/** The prompt files a GIF watch can use, the dedicated one first. */
const GIF_PROMPTS = ['describe-gif', 'describe-video'];

/**
 * The prompt a GIF watch uses under the live prompts: `describe-gif` when it
 * is there, else `describe-video`; null when neither is.
 * @param [prompts]  hot.prompts.
 */
export function gifWatchPrompt(prompts?: Record<string, unknown>): { name: string; text: string } | null {
  for (const name of GIF_PROMPTS) {
    const text = prompts?.[name];
    if (typeof text === 'string' && text) return { name, text };
  }
  return null;
}

/**
 * Why GIFs are not watched under the live prompts, or null when they are: `no-prompt` (neither describe-gif nor
 * describe-video).
 * @param [prompts]  hot.prompts.
 */
export function gifWatchBlocker(prompts?: Record<string, unknown>): 'no-prompt' | null {
  if (!gifWatchPrompt(prompts)) return 'no-prompt';
  return null;
}
