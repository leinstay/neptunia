// Drawing, a built-in ability of the core: the persona's scene goes into the drawing prompt exactly
// as they wrote it (prompts `draw` + `appearance` + the local time around it), `appearance.png` of the data folder rides
// along as the reference for a picture they are in, and the Images client (src/llm/images.ts, injected as `images`:
// the boundary every picture crosses, its rails and `image.timeoutMs` included) makes the picture.
// Nothing else touches their scene: no model rewrites, summarizes or "improves" it.
//
// Every call site goes through `drawPicture`: their `draw.create` tool (a diary post's pictures
// included) and `/nep draw`. A failure is the Images client's own error, unwrapped:
// `ImageCapError` (a rail), `ImageGenError` (a generation that was sent and failed) and
// `UnsupportedImageModelError`, which the call sites map to their result codes.
//
// Settings and prompts are read at the moment of use. Logs carry codes and counts, never a scene.

import { buildDrawPrompt } from '../behavior/prompt.ts';
import { formatNow } from '../format.ts';
import fs from 'node:fs';
import path from 'node:path';
import { objOf } from '../tools/types.ts';
import type { GeneratedPicture } from '../llm/images.ts';

/** What a caller hands over of the live state: the config and the prompt files, each read at the moment of use. */
type DrawHot = { config: unknown; prompts: object };

/**
 * The drawing prompt of `scene`: prompts `draw` and `appearance` (read now) around the request,
 * with `{{when}}` the local date and time now
 * (`bot.timezone`) when `withTime` and a timezone is set (`/nep draw` carries none), and
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
  const locale = objOf(objOf(hot.prompts).labels).locale;
  return buildDrawPrompt({
    prompts: hot.prompts,
    selfName,
    request: scene,
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

/** The picture that shows how the persona looks, the reference of a picture they are in. */
const APPEARANCE_FILE = 'appearance.png';

/** `appearance.png` of `dataDir` as a `data:` URL; null when there is no data folder or no file. */
function appearanceReference(dataDir: string | null): string | null {
  if (!dataDir) return null;
  try {
    return `data:image/png;base64,${fs.readFileSync(path.join(dataDir, APPEARANCE_FILE)).toString('base64')}`;
  } catch (err) {
    // The deployment keeps no picture of the persona: the picture is drawn from the appearance text alone.
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * One picture: the prompt, the reference, then one generation through the Images client.
 * Resolves the picture; throws what the client throws.
 */
export type DrawInput = {
  /** The persona's scene, as they wrote it. */
  scene: string;
  selfName: string;
  /** A picture the persona is in: their appearance in the prompt, `appearance.png` as reference. */
  self?: boolean;
  /** The local time in the prompt. */
  withTime?: boolean;
  /** The member whose per-member rail counts it (null: nobody's). */
  accountId?: string | null;
  /** The core model's id when the call is routed to it (src/tools/gateway.ts#callOnRoute), null for the drawing role's own. */
  model?: string | null;
};
export async function drawPicture({
  images,
  hot,
  dataDir,
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
  /** The data folder that holds `appearance.png`; null: no reference. */
  dataDir: string | null;
  now?: () => number;
  input: DrawInput;
}): Promise<{ picture: GeneratedPicture }> {
  const { scene, selfName, self = false, withTime = false, accountId = null, model = null } = input;
  const prompt = drawPromptOf({ hot, selfName, scene, self, withTime, now });
  const reference = self === true ? appearanceReference(dataDir) : null;
  const picture = await images.generate({ prompt, reference, accountId, ...(model ? { model } : {}) });
  return { picture };
}
