// Drawing, a built-in ability of the core: the persona's scene goes into the drawing prompt exactly
// as she wrote it (prompts `draw` + `appearance` + the local time around it, the request only cut
// to `image.maxPromptChars`), the bot's avatar rides along as the reference for a picture she is in
// (`image.reference: 'avatar'`), and the Images client (src/llm/images.ts, injected as `images`:
// the boundary every picture crosses, its rails and `image.timeoutMs` included) makes the picture.
// Nothing else touches her scene: no model rewrites, summarizes or "improves" it.
//
// Every call site goes through `drawPicture`: her `draw.create` tool (a diary post's pictures
// included) and `/nep draw`. A failure is the Images client's own error, unwrapped:
// `ImageCapError` (a rail), `ImageGenError` (a generation that was sent and failed) and
// `UnsupportedImageModelError`, which the call sites map to their result codes.
//
// Settings and prompts are read at the moment of use. Logs carry codes and counts, never a scene.

import { buildDrawPrompt } from '../behavior/prompt.ts';
import { formatNow } from '../format.ts';
import { avatarReference } from './fetch-image.ts';
import { clampAtBoundary } from '../memory/clamp.ts';
import { objOf } from '../tools/types.ts';
import type { GeneratedPicture } from '../llm/images.ts';

/** What a caller hands over of the live state: the config and the prompt files, each read at the moment of use. */
type DrawHot = { config: unknown; prompts: object };

/**
 * The drawing prompt of `scene`: prompts `draw` and `appearance` (read now) around the request,
 * cut to `image.maxPromptChars` at a boundary, with `{{when}}` the local date and time now
 * (`bot.timezone`) when `withTime` and a timezone is set (the owner's command carries none), and
 * the appearance only when `self`. The one builder of the prompt.
 */
export function drawPromptOf({
  hot,
  selfName,
  scene,
  self = false,
  withTime = false,
  now = Date.now,
}: {
  hot: DrawHot;
  selfName: string;
  scene: string;
  self?: boolean;
  withTime?: boolean;
  now?: () => number;
}): string {
  const timezone = objOf(objOf(hot.config).bot).timezone;
  const maxChars = objOf(objOf(hot.config).image).maxPromptChars;
  const locale = objOf(objOf(hot.prompts).labels).locale;
  return buildDrawPrompt({
    prompts: hot.prompts,
    selfName,
    // A limit that is not a number leaves the scene whole (clampAtBoundary).
    request: clampAtBoundary(scene, typeof maxChars === 'number' ? maxChars : Number.NaN),
    self: self === true,
    ...(withTime
      ? {
          when:
            typeof timezone === 'string' && timezone
              ? formatNow(now(), timezone, typeof locale === 'string' ? locale : undefined)
              : '',
        }
      : {}),
  });
}

/**
 * One picture: the prompt, the avatar reference, then one generation through the Images client.
 * Resolves the picture and whether a wanted avatar reference was missing; throws what the client throws.
 */
export type DrawInput = {
  /** The persona's scene, as she wrote it. */
  scene: string;
  selfName: string;
  /** A picture she is in: her appearance in the prompt, her avatar as reference. */
  self?: boolean;
  /** The local time in the prompt. */
  withTime?: boolean;
  /** The member whose per-member rail counts it (null: nobody's). */
  accountId?: string | null;
  /** A holder the avatar is fetched into once and reused (a diary set): a `reference` of null counts as fetched, absent as not yet. */
  avatar?: { reference?: string | null } | null;
  /** The core model's id when the call is routed to it (src/tools/gateway.ts#callOnRoute), null for the drawing role's own. */
  model?: string | null;
};
export async function drawPicture({
  images,
  hot,
  avatarUrl = null,
  imageFetcher = null,
  now = Date.now,
  input,
}: {
  images: {
    generate: (request: {
      prompt: string;
      reference: string | null;
      accountId: string | null;
      model?: string;
    }) => Promise<GeneratedPicture>;
  };
  hot: DrawHot;
  avatarUrl?: (() => Promise<string | null | undefined>) | null;
  imageFetcher?: Parameters<typeof avatarReference>[0]['imageFetcher'];
  now?: () => number;
  input: DrawInput;
}): Promise<{ picture: GeneratedPicture; referenceMissing: boolean }> {
  const { scene, selfName, self = false, withTime = false, accountId = null, avatar = null, model = null } = input;
  const prompt = drawPromptOf({ hot, selfName, scene, self, withTime, now });
  let reference: string | null = null;
  let referenceMissing = false;
  if (self === true && objOf(objOf(hot.config).image).reference === 'avatar') {
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
  const picture = await images.generate({ prompt, reference, accountId, ...(model ? { model } : {}) });
  return { picture, referenceMissing };
}
