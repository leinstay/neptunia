// Operations: `/nep draw`: one picture through the turn's drawing prompt.
// The handler bodies moved here from src/admin.js unchanged; each `run` calls one of them with
// the operation's `ctx` as the command context.

import { drawPicture } from '../media/draw.js';
import { imageFileName } from '../behavior/turn.js';
import { ImageCapError, ImageGenError, UnsupportedImageModelError } from '../llm/images.js';
import { roleModel } from '../llm/roles.js';
import { log } from '../log.js';
import { messageRefOf, postingConversation } from './shared.js';
import { defineOp, perEnv, invalid } from './registry.js';
import { CODE } from '../skills/codes.js';

const handlers = perEnv((env) => {
  const { hot, client, images, imageFetcher, assertNotPaused, resolvedGuildId } = env;
  /** @type {import('../interface/reads.ts').Reads} */
  const reads = env.reads;
  /** @type {import('../protocol/adapter.ts').Adapter|null|undefined} */
  const port = env.port;

  /**
   * `/nep draw`: one picture (src/media/draw.js), the same prompt
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
    // A reply is a message to quote: it follows that message's channel, as message.create does.
    const reply = args?.replyTo ? messageRefOf(args.replyTo) : null;
    const given = args?.channelId ? String(args.channelId) : null;
    if (given && reply?.channelId && given !== reply.channelId)
      throw invalid('the message is not in that channel', CODE.UNKNOWN_MESSAGE);
    const target = given ?? reply?.channelId ?? null;
    const postTo =
      target || reply
        ? await postingConversation({
            reads,
            iface: port?.iface,
            guildId: resolvedGuildId(context),
            channelId: target,
            context,
            need: 'attach',
          })
        : null;
    if (postTo && (!port || typeof port.send !== 'function'))
      throw Object.assign(new Error("the persona's interface is not available"), { code: CODE.NOT_CONFIGURED });

    const model = roleModel(hot.config, 'drawing');
    if (!images.familyOf(model)) {
      return {
        status: 'failed',
        code: CODE.NOT_CONFIGURED,
        summary: `unsupported image model: ${model ?? '-'} (no supported family); nothing was generated`,
      };
    }

    const self = args?.self === true;
    const guildId = resolvedGuildId(context);
    const selfName = client?.guilds?.cache?.get(guildId)?.members?.me?.displayName ?? client?.user?.username ?? '';

    let picture;
    let referenceMissing = false;
    try {
      ({ picture, referenceMissing } = await drawPicture({
        images,
        hot,
        // The persona's large avatar, asked of the interface only when the picture needs the reference.
        avatarUrl: async () => {
          const found = await reads.memberInfo({ communityId: guildId, memberId: String(client?.user?.id ?? '') });
          return found?.member?.avatar.largeUrl ?? null;
        },
        imageFetcher,
        input: { scene: request, selfName, self, withTime: false, userId: null },
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

    log.info('admin: drew', {
      model: picture.model,
      seconds: picture.seconds,
      cost: picture.cost,
      self,
      bytes: picture.buffer?.length ?? 0,
    });

    const cost = picture.cost == null ? 'cost unknown' : `cost ${picture.cost}`;
    const parts = [picture.model, `${picture.seconds}s`, cost];
    if (referenceMissing) parts.push('no avatar reference');
    const file = { attachment: picture.buffer, name: imageFileName(picture.mediaType) };
    if (!postTo) return { text: parts.join(' · '), files: [file] };
    const sent = await port.send(
      { iface: port.iface, conversationId: postTo },
      {
        attachments: [{ name: file.name, data: file.attachment, contentType: picture.mediaType }],
        ...(reply ? { replyTo: { iface: port.iface, conversationId: postTo, messageId: reply.messageId } } : {}),
      }
    );
    if (sent?.status === 'ok')
      return { text: `${parts.join(' · ')} · posted in ${postTo}`, ref: sent.ref ?? null, at: sent.at };
    const code = String(sent?.error?.code ?? sent?.status ?? CODE.ERROR);
    const unknown = sent?.status === 'unknown';
    return {
      status: 'failed',
      code,
      summary: `draw: ${unknown ? 'unclear whether the picture was posted' : 'the picture was not posted'} (${code})`,
      data: { unknown, portStatus: sent?.status ?? null },
    };
  }

  return { cmdDraw };
});

defineOp({
  name: 'draw.create',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).cmdDraw(args, ctx),
});
