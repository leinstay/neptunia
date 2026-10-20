// Operations: `/nep draw`: one picture through the turn's drawing prompt.
// The handler bodies moved here from src/admin.js unchanged; each `run` calls one of them with
// the operation's `ctx` as the command context.

import { createDrawingTool, drawPicture } from '../errands/tools.js';
import { imageFileName } from '../behavior/turn.js';
import { ImageCapError, ImageGenError, UnsupportedImageModelError } from '../llm/images.js';
import { roleModel } from '../llm/roles.js';
import { log } from '../log.js';
import { postingConversation } from './shared.js';
import { defineOp, perEnv, invalid } from './registry.js';
import { CODE } from '../skills/codes.js';

const handlers = perEnv((env) => {
  const { hot, client, discord, images, imageFetcher, errands, port, assertNotPaused, resolvedGuildId } = env;

  /**
   * `/nep draw`: one picture through the drawing agent (src/errands/tools.js), the same prompt
   * a turn builds (prompts read now, the request clamped to `image.maxPromptChars`, the avatar as
   * reference for `self` when `image.reference` is `'avatar'`; no local time), counted
   * against `image.maxPerDay` only (no member). Answers `{ text, files }`:
   * one line with the model, seconds and cost, plus the picture. A rail or
   * generation failure throws with its reason and HTTP status; the prompt is
   * never logged. With `channelId` the picture is posted there as the persona, through her
   * interface (`env.port`), the channel being the one the command runs in or a text channel of
   * the served guild where the bot may send files (src/ops/shared.js#postingConversation, checked
   * before anything is generated); the answer is then the line alone, or a `failed` result when the post did not go
   * through (`data.unknown` when it may have: never generated again).
   */
  async function cmdDraw(args, context) {
    if (!images) return { status: 'failed', code: CODE.NOT_CONFIGURED, summary: 'image generation is not available' };
    assertNotPaused();
    const request = String(args?.text ?? '').trim();
    if (!request) throw invalid('text is required');
    const postTo = args?.channelId ? await postingConversation({ client, discord, guildId: resolvedGuildId(context), channelId: args.channelId, context, need: 'attach' }) : null;
    if (postTo && (!port || typeof port.send !== 'function')) throw Object.assign(new Error('the persona\'s interface is not available'), { code: CODE.NOT_CONFIGURED });

    const model = roleModel(hot.config, 'drawing');
    if (!images.familyOf(model)) {
      return { status: 'failed', code: CODE.NOT_CONFIGURED, summary: `unsupported image model: ${model ?? '-'} (no supported family); nothing was generated` };
    }

    const self = args?.self === true;
    const guildId = resolvedGuildId(context);
    const selfName = client?.guilds?.cache?.get(guildId)?.members?.me?.displayName ?? client?.user?.username ?? '';

    let picture;
    let referenceMissing = false;
    try {
      const tool = createDrawingTool({ images, hot, client, imageFetcher });
      ({ picture, referenceMissing } = await drawPicture({
        tool,
        errands,
        guildId,
        input: { scene: request, selfName, self, withTime: false, userId: null },
        requester: { userId: null, kind: 'owner' },
        origin: { channelId: context?.channelId ? String(context.channelId) : null },
      }));
      if (referenceMissing) log.warn('admin: draw avatar reference unavailable', {});
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
    const file = { attachment: picture.buffer, name: imageFileName(picture.mediaType) };
    if (!postTo) return { text: parts.join(' · '), files: [file] };
    const sent = await port.send({ iface: port.iface, conversationId: postTo }, { attachments: [{ name: file.name, data: file.attachment, contentType: picture.mediaType }] });
    if (sent?.status === 'ok') return { text: `${parts.join(' · ')} · posted in ${postTo}`, ref: sent.ref ?? null, at: sent.at };
    const code = String(sent?.error?.code ?? sent?.status ?? CODE.ERROR);
    const unknown = sent?.status === 'unknown';
    return { status: 'failed', code, summary: `draw: ${unknown ? 'unclear whether the picture was posted' : 'the picture was not posted'} (${code})`, data: { unknown, portStatus: sent?.status ?? null } };
  }

  return { cmdDraw };
});

defineOp({
  name: 'draw.create',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).cmdDraw(args, ctx),
});
