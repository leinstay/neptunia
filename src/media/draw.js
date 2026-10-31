// Drawing, a built-in ability of the core: the persona's scene goes into the drawing prompt exactly
// as she wrote it (prompts `draw` + `appearance` + the local time around it, the request only cut
// to `image.maxPromptChars`), the bot's avatar rides along as the reference for a picture she is in
// (`image.reference: 'avatar'`), and the Images client (src/llm/images.js, injected as `images`:
// the boundary every picture crosses, its rails and `image.timeoutMs` included) makes the picture.
// Nothing else touches her scene: no model rewrites, summarizes or "improves" it.
//
// Every call site goes through `drawPicture`: her `draw.create` tool (a diary post's pictures
// included) and `/nep draw`. A failure is the Images client's own error, unwrapped:
// `ImageCapError` (a rail), `ImageGenError` (a generation that was sent and failed) and
// `UnsupportedImageModelError`, which the call sites map to their result codes.
//
// Settings and prompts are read at the moment of use. Logs carry codes and counts, never a scene.

import { buildDrawPrompt } from '../behavior/prompt.js';
import { formatNow } from '../format.js';
import { avatarReference } from './fetch-image.js';
import { clampAtBoundary } from '../memory/clamp.js';

/**
 * The drawing prompt of `scene`: prompts `draw` and `appearance` (read now) around the request,
 * cut to `image.maxPromptChars` at a boundary, with `{{when}}` the local date and time now
 * (`bot.timezone`) when `withTime` and a timezone is set (the owner's command carries none), and
 * the appearance only when `self`. The one builder of the prompt: the picture and the dry run share it.
 * @param {{ hot: { config: object, prompts: object }, selfName: string, scene: string, self?: boolean, withTime?: boolean, now?: () => number }} args
 * @returns {string}
 */
export function drawPromptOf({ hot, selfName, scene, self = false, withTime = false, now = Date.now }) {
  const timezone = hot.config.bot?.timezone;
  return buildDrawPrompt({
    prompts: hot.prompts,
    selfName,
    request: clampAtBoundary(scene, hot.config.image?.maxPromptChars),
    self: self === true,
    ...(withTime ? { when: timezone ? formatNow(now(), timezone, hot.prompts?.labels?.locale) : '' } : {}),
  });
}

/**
 * One picture: the prompt, the avatar reference, then one generation through the Images client.
 * Resolves the picture and whether a wanted avatar reference was missing; throws what the client throws.
 * @param {object} deps
 * @param {{ generate: Function }} deps.images  src/llm/images.js#createImageGen: the boundary.
 * @param {{ config: object, prompts: object }} deps.hot
 * @param {() => (string|null|Promise<string|null>)} [deps.avatarUrl]  The address of the persona's large avatar
 *   (`memberInfo(self).avatar.largeUrl`), asked only when a picture needs the reference.
 * @param {{ fetchAsDataUrl: Function }|null} [deps.imageFetcher]
 * @param {() => number} [deps.now]
 * @param {DrawInput} deps.input
 * @returns {Promise<{ picture: object, referenceMissing: boolean }>}
 *
 * @typedef {object} DrawInput
 * @property {string} scene  The persona's scene, as she wrote it.
 * @property {string} selfName
 * @property {boolean} [self]  A picture she is in: her appearance in the prompt, her avatar as reference.
 * @property {boolean} [withTime]  The local time in the prompt.
 * @property {string|null} [userId]  The member whose per-member rail counts it (null: nobody's).
 * @property {{ reference?: string|null }|null} [avatar]  A holder the avatar is fetched into once and
 *   reused (a diary set): a `reference` of null counts as fetched, absent as not yet.
 * @property {string|null} [model]  The core model's id when the call is routed to it (src/tools/gateway.ts#callOnRoute),
 *   null for the drawing role's own.
 */
export async function drawPicture({ images, hot, avatarUrl = null, imageFetcher = null, now = Date.now, input }) {
  const { scene, selfName, self = false, withTime = false, userId = null, avatar = null, model = null } = input;
  const prompt = drawPromptOf({ hot, selfName, scene, self, withTime, now });
  let reference = null;
  let referenceMissing = false;
  if (self === true && hot.config.image?.reference === 'avatar') {
    if (avatar && avatar.reference !== undefined) reference = avatar.reference;
    else {
      reference = await avatarReference({
        url: typeof avatarUrl === 'function' ? await avatarUrl() : null,
        imageFetcher,
        config: hot.config,
      });
      referenceMissing = reference === null;
      if (avatar) avatar.reference = reference;
    }
  }
  const picture = await images.generate({ prompt, reference, userId, ...(model ? { model } : {}) });
  return { picture, referenceMissing };
}
