// Operations: `/nep draw`: one picture through the turn's drawing prompt.
// The handler bodies moved here from src/admin.js unchanged; each `run` calls one of them with
// the operation's `ctx` as the command context.

import { avatarReference } from '../discord/fetch-image.js';
import { buildDrawPrompt } from '../behavior/prompt.js';
import { imageFileName } from '../behavior/turn.js';
import { ImageCapError, ImageGenError, UnsupportedImageModelError } from '../llm/images.js';
import { roleModel } from '../llm/roles.js';
import { log } from '../log.js';
import { clampAtBoundary } from '../memory/clamp.js';
import { defineOp, perEnv, invalid } from './registry.js';

const handlers = perEnv((env) => {
  const { hot, client, images, imageFetcher, assertNotPaused, resolvedGuildId } = env;

  /**
   * `/nep draw`: one picture through the same prompt a turn builds (prompts
   * read now, the request clamped to `image.maxPromptChars`, the avatar as
   * reference for `self` when `image.reference` is `'avatar'`), counted
   * against `image.maxPerDay` only (no member). Answers `{ text, files }`:
   * one line with the model, seconds and cost, plus the picture. A rail or
   * generation failure throws with its reason and HTTP status; the prompt is
   * never logged.
   */
  async function cmdDraw(args, context) {
    if (!images) return 'image generation is not available';
    assertNotPaused();
    const request = String(args?.text ?? '').trim();
    if (!request) throw invalid('text is required');

    const imageCfg = hot.config.image ?? {};
    const model = roleModel(hot.config, 'drawing');
    if (!images.familyOf(model)) {
      return `unsupported image model: ${model ?? '-'} (no supported family); nothing was generated`;
    }

    const self = args?.self === true;
    const guildId = resolvedGuildId(context);
    const selfName = client?.guilds?.cache?.get(guildId)?.members?.me?.displayName ?? client?.user?.username ?? '';
    const clamped = clampAtBoundary(request, imageCfg.maxPromptChars);
    const prompt = buildDrawPrompt({ prompts: hot.prompts, selfName, request: clamped, self });

    let reference = null;
    let referenceMissing = false;
    if (self && imageCfg.reference === 'avatar') {
      reference = await avatarReference({ client, imageFetcher, config: hot.config });
      referenceMissing = reference === null;
      if (referenceMissing) log.warn('admin: draw avatar reference unavailable', {});
    }

    let picture;
    try {
      picture = await images.generate({ prompt, reference, userId: null });
    } catch (err) {
      if (err instanceof ImageCapError || err instanceof ImageGenError) {
        const status = err.statusCode ? `, HTTP ${err.statusCode}` : '';
        throw new Error(`draw failed (${err.reason}${status}): ${err.message}`);
      }
      if (err instanceof UnsupportedImageModelError) throw new Error(`draw failed: ${err.message}`);
      throw err;
    }

    log.info('admin: drew', { model: picture.model, seconds: picture.seconds, cost: picture.cost, self, bytes: picture.buffer?.length ?? 0 });

    const cost = picture.cost == null ? 'cost unknown' : `cost ${picture.cost}`;
    const parts = [picture.model, `${picture.seconds}s`, cost];
    if (referenceMissing) parts.push('no avatar reference');
    return {
      text: parts.join(' · '),
      files: [{ attachment: picture.buffer, name: imageFileName(picture.mediaType) }],
    };
  }

  return { cmdDraw };
});

defineOp({
  name: 'draw.create',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).cmdDraw(args, ctx),
});
