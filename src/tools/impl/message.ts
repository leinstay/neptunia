// Operations: `/nep message create|edit|delete|react`: the persona's own messages and reactions.
// `message.create` is one operation with two modes, chosen by the server from who acts, never by
// an argument: when a person runs it, she gets one turn in that channel now, bypassing the
// schedule -- an answer to the named message, else she reads the channel and joins the
// conversation or starts a topic herself (src/behavior/spontaneous.js#force); when she calls it
// (`context.actor` 'persona', her skills, src/tools/), her own text -- the call's body -- is
// posted through her interface (src/interface/port.js, `env.port`), replying to a message when
// one is named, and a reply notifies the replied author unless they turned pings off. Her text
// (a post or an edit) arrives rendered as a `<msg>` of hers (src/tools/executors.ts#executeCall);
// only the members it mentions (`context.mentionUserIds`) are notified, none with pings off. Edit,
// delete and react go through the interface too. The rules live here, for every caller: a post,
// an edit, a deletion or a reaction in the conversation the command runs in, or in any text
// channel of the served guild where the bot holds the Discord permissions it needs
// (src/tools/impl/shared.ts#postingConversation; a person may ask for her turn in any channel); edit and
// delete reach only her own messages (the port refuses anyone else's). A message is named by its
// id or its link; for an edit or a deletion also by `last`, her own most recent message in that
// channel. A port answer that may have taken effect is `failed` with `data.unknown` true:
// never retried. Her post may carry one file an errand of hers brought back (`file`, a handle
// `file:<task id>/<name>`, src/errands/store.js): read from the agent's out directory, refused
// when unknown here (`unknown-file`: a private chat's file goes only back to that chat), larger
// than the interface takes (`attachment-too-large`) or unreadable (`file-unreadable`). It may also
// carry one GIF of her library (`gif`, a handle), posted after the text or alone, counted like a
// reply's `<gif>` (`unknown-gif`; over `gifs.maxPerDay` `gif-cap`; both refuse before anything is posted).
// Instead of either, it may repost a picture of one of HER OWN earlier messages (`media`, a message id or
// link, `item` picking one of several attachments): the message is fetched, its attachment downloaded and
// uploaded as a real file (never a link). Refused: another's message (`not-own-message`), an unknown or
// deleted one (`unknown-message`, `message-deleted`), no such attachment (`no-media`), over the interface's
// byte cap (`attachment-too-large`), a failed download (`file-unreadable`), or together with `file`/`gif`.

import fsp from 'node:fs/promises';
import { messageRefOf, portAnswer, postingConversation } from './shared.ts';
import { lineOf } from '../../behavior/line-of.js';
import { defineOp, perEnv, invalid } from './registry.ts';
import { freshAttachmentUrl, gifPostUrl, countGifPost } from '../../media/gif-post.js';
import { gifPostsToday } from '../../memory/gif-watch.js';
import { utcDay } from '../../time.js';
import { CODE } from '../codes.ts';

/** How far back `last` looks for her own message: Discord's most messages per history request. */
const LAST_LOOKBACK = 100;

/** True when a message reference is `last`: the persona's own most recent message (any case). */
function isLast(value) {
  return typeof value === 'string' && value.trim().toLowerCase() === 'last';
}

const handlers = perEnv((env) => {
  const { hot, store, spontaneous, turns, port, errands, assertNotPaused, resolvedGuildId } = env;
  /** @type {import('../../interface/reads.ts').Reads} */
  const reads = env.reads;
  const fetchImpl = typeof env.fetchImpl === 'function' ? env.fetchImpl : fetch;
  const clock = typeof env.now === 'function' ? env.now : Date.now;

  /** True when member `userId` turned pings off here. */
  function pingsOff(context, userId) {
    if (!userId || typeof store?.isPingsOff !== 'function') return false;
    return store.isPingsOff(resolvedGuildId(context), String(userId)) === true;
  }

  /** The members her rendered text mentions (`context.mentionUserIds`, her own calls only), less those with pings off. */
  function mentionedUsers(context) {
    if (context?.actor !== 'persona' || !Array.isArray(context.mentionUserIds)) return [];
    return context.mentionUserIds.map(String).filter((id) => id && !pingsOff(context, id));
  }

  /**
   * The attachment of a post's `file` handle bound for `channelId`, or null without one: the
   * errand's file (src/errands/service.js#fileOf), its size checked against the interface's
   * `maxFileBytes` before it is read.
   */
  async function errandFile(args, context, channelId, p) {
    const handle = String(args?.file ?? '').trim();
    if (!handle) return null;
    const file =
      typeof errands?.fileOf === 'function'
        ? errands.fileOf({ guildId: resolvedGuildId(context), handle, privateChannelId: channelId })
        : null;
    if (file?.expired) throw invalid(`files of ${handle} have expired`, CODE.FILE_EXPIRED);
    if (!file) throw invalid(`no file ${handle}`, CODE.UNKNOWN_FILE);
    const limit = p.capabilities?.()?.maxFileBytes;
    const stat = await fsp.stat(file.path).catch(() => null);
    if (!stat?.isFile()) throw Object.assign(new Error(`cannot read ${handle}`), { code: CODE.FILE_UNREADABLE });
    if (Number.isFinite(limit) && stat.size > limit)
      throw Object.assign(new Error(`${handle} is ${stat.size} bytes, over the ${limit} this interface takes`), {
        code: CODE.ATTACHMENT_TOO_LARGE,
      });
    const data = await fsp.readFile(file.path).catch(() => null);
    if (!data) throw Object.assign(new Error(`cannot read ${handle}`), { code: CODE.FILE_UNREADABLE });
    return { name: file.name, data, ...(file.contentType ? { contentType: file.contentType } : {}) };
  }

  /**
   * The attachment of a post's `media` (a picture of one of her own messages, `args.item` picking
   * one of several; 1 is the first), downloaded for upload, or null without `media`. The message is
   * fetched again, so its attachment URL is fresh. Refusals are listed in this module's header;
   * nothing is posted before they are told.
   */
  async function mediaFile(args, context, p) {
    const raw = String(args?.media ?? '').trim();
    if (!raw) return null;
    if (String(args?.file ?? '').trim() || String(args?.gif ?? '').trim())
      throw invalid('one attachment per post', CODE.INVALID_ARGS);
    const ref = await messageRefOf(raw, reads);
    const sourceId = await postingConversation({
      reads,
      iface: port?.iface,
      guildId: resolvedGuildId(context),
      channelId: ref.channelId,
      context,
      need: 'read',
    });
    const found = await reads.fetchMessages({ iface: port.iface, conversationId: sourceId }, [ref.messageId]);
    const message = found?.messages[0] ?? null;
    if (message?.missing === true) throw invalid(`message ${ref.messageId} was deleted`, CODE.MESSAGE_DELETED);
    if (!message?.event) throw invalid(`no message ${ref.messageId} in ${sourceId}`, CODE.UNKNOWN_MESSAGE);
    if (message.event.message.author.self !== true) throw invalid('that message is not hers', CODE.NOT_OWN_MESSAGE);
    const attachments = [...(message.attachments ?? [])];
    const given = args?.item === undefined || args?.item === null || args?.item === '' ? 1 : Number(args.item);
    if (attachments.length === 0) throw invalid('that message holds no attachment', CODE.NO_MEDIA);
    if (!Number.isInteger(given) || given < 1 || given > attachments.length)
      throw invalid('item is out of range', CODE.NO_MEDIA);
    const item = attachments[given - 1];
    if (!item?.url) throw invalid('that attachment has no address', CODE.NO_MEDIA);
    const limit = p.capabilities?.()?.maxFileBytes;
    const tooLarge = (size) => Number.isFinite(limit) && size > limit;
    const large = (size) =>
      Object.assign(new Error(`the picture is ${size} bytes, over the ${limit} this interface takes`), {
        code: CODE.ATTACHMENT_TOO_LARGE,
      });
    if (tooLarge(Number(item.size))) throw large(Number(item.size));
    const unreadable = () => Object.assign(new Error('cannot download the picture'), { code: CODE.FILE_UNREADABLE });
    let data = null;
    try {
      const response = await fetchImpl(item.url, { method: 'GET', signal: AbortSignal.timeout(30_000) });
      if (!response?.ok) throw unreadable();
      const declared = Number(response.headers?.get?.('content-length'));
      if (tooLarge(declared)) throw large(declared);
      data = Buffer.from(await response.arrayBuffer());
    } catch (err) {
      throw err?.code === CODE.ATTACHMENT_TOO_LARGE ? err : unreadable();
    }
    if (tooLarge(data.byteLength)) throw large(data.byteLength);
    return {
      name: String(item.name || 'picture'),
      data,
      ...(item.contentType ? { contentType: String(item.contentType).split(';')[0] } : {}),
    };
  }

  /**
   * The library entry of a post's `gif` handle in `guildId`, or null without a handle: unknown
   * here (or `features.gifs` off) is `invalid` with `unknown-gif`, checked before anything is posted.
   */
  function gifEntry(args, guildId) {
    const handle = String(args?.gif ?? '').trim();
    if (!handle) return null;
    const entry =
      hot.config.features?.gifs === false || typeof store?.findGif !== 'function'
        ? null
        : store.findGif(guildId, handle);
    if (!entry) throw invalid(`no GIF ${handle} in the library`, CODE.UNKNOWN_GIF);
    return entry;
  }

  /** Whether today's GIF posts are spent against `gifs.maxPerDay` (read now). */
  function gifCapSpent() {
    const posts = gifPostsToday(store.state.data, hot.config, utcDay(clock()));
    return posts.used >= posts.cap;
  }

  /**
   * The persona's own text posted as hers: the channel checked, the reply target in it. A `gif`
   * (her library's handle) follows the text, or goes alone when the text is empty, as a `<gif>`
   * of a reply turn does (src/media/gif-post.js): the entry's URL as the text of a message of
   * hers, counted against `gifs.maxPerDay` and stamped on its entry. The day's cap spent: refused
   * `gif-cap` before anything is posted.
   */
  async function post(args, context) {
    const p = requirePort();
    const text = String(args?.text ?? '').trim();
    // A file-only or GIF-only post: an errand's file or a GIF of hers with no text.
    if (
      !text &&
      !String(args?.file ?? '').trim() &&
      !String(args?.gif ?? '').trim() &&
      !String(args?.media ?? '').trim()
    )
      throw invalid('text is required');
    const reply = args?.replyTo ? await messageRefOf(args.replyTo, reads) : null;
    const given = args?.channelId ? String(args.channelId) : null;
    if (given && reply?.channelId && given !== reply.channelId)
      throw invalid('the message is not in that channel', CODE.UNKNOWN_MESSAGE);
    const channelId = await postingConversation({
      reads,
      iface: p.iface,
      guildId: resolvedGuildId(context),
      channelId: given ?? reply?.channelId ?? null,
      context,
      need: reply ? 'reply' : 'send',
    });
    const repliedUser = Boolean(reply) && !pingsOff(context, context?.repliedAuthorId);
    const guildId = resolvedGuildId(context);
    const entry = gifEntry(args, guildId);
    const capped = entry ? gifCapSpent() : false;
    // Over the day's cap nothing is posted, the text included: she may call again without the GIF.
    if (capped) throw invalid('the GIF limit for today is used up', CODE.GIF_CAP);
    const attachment = (await errandFile(args, context, channelId, p)) ?? (await mediaFile(args, context, p));
    const to = { iface: p.iface, conversationId: channelId };
    const content = {
      text,
      ...(attachment ? { attachments: [attachment] } : {}),
      ...(reply ? { replyTo: { iface: p.iface, conversationId: channelId, messageId: reply.messageId } } : {}),
      mentions: { users: mentionedUsers(context), repliedUser },
    };
    let result = null;
    if (text || attachment) {
      result = await p.send(to, content);
      if (result?.status !== 'ok' || !entry)
        return portAnswer('message.create', result, `sent in ${channelId} (message ${result?.ref?.messageId ?? '?'})`);
    }
    const sent = await postGif(p, to, entry, guildId, channelId, text || attachment ? null : content);
    if (sent?.status !== 'ok')
      return text || attachment
        ? {
            status: 'partial',
            code: CODE.GIF_FAILED,
            summary: 'message.create: the text went out, the GIF did not',
            data: {
              gifUnknown: sent?.status === 'unknown',
              portStatus: sent?.status ?? null,
              ref: result?.ref ?? null,
            },
          }
        : portAnswer('message.create', sent, '');
    const ref = result?.ref ?? sent.ref;
    return {
      text: `sent in ${channelId} (message ${ref?.messageId ?? '?'})${text || attachment ? ' and a GIF' : ''}`,
      ref: ref ?? null,
      at: (result ?? sent).at,
    };
  }

  /**
   * One library GIF as a message of hers: its stored URL, a fresh one first when it is an
   * attachment. Counted once sent and stamped on its entry. A GIF-only post carries the reply
   * and mentions (`lead`); one after a text carries none.
   */
  async function postGif(p, to, entry, guildId, channelId, lead) {
    const fresh =
      entry.kind === 'attachment'
        ? await freshAttachmentUrl({ reads, channel: { iface: p.iface, conversationId: channelId }, entry })
        : null;
    const content = lead
      ? { ...lead, text: gifPostUrl(entry, fresh) }
      : { text: gifPostUrl(entry, fresh), mentions: { users: [], repliedUser: false } };
    const sent = await p.send(to, content);
    if (sent?.status === 'ok') {
      countGifPost(store.state.data, clock());
      store.state.markDirty();
      if (entry.key && typeof store.recordOwnGif === 'function') store.recordOwnGif(guildId, entry.key, clock());
    }
    return sent;
  }

  /** One turn of hers in the channel, now, for a person: an answer to the named message, else her own pick. */
  async function turn(args, context) {
    const channelId = args?.channelId || context?.channelId;
    if (!channelId) throw invalid('a channel is required');
    const ref = { iface: port.iface, conversationId: String(channelId) };
    if ((await reads.conversationInfo(ref)) === null) throw invalid(`no channel ${channelId}`, CODE.NOT_FOUND);
    // The person who ran the command is the requester of what she does in that turn.
    const requester = context?.userId
      ? { id: String(context.userId), roleIds: Array.isArray(context.roleIds) ? context.roleIds.map(String) : [] }
      : null;
    if (!args?.replyTo) {
      const result = await spontaneous.force(ref, null, { requester });
      return `message create on ${ref.conversationId}: ${JSON.stringify(result) ?? 'ok'}`;
    }
    const reply = await messageRefOf(args.replyTo, reads);
    if (reply.channelId && reply.channelId !== ref.conversationId)
      throw invalid('the message is not in that channel', CODE.UNKNOWN_MESSAGE);
    const fetched = await reads.fetchMessages(ref, [reply.messageId]);
    const event = fetched?.messages[0]?.event;
    if (!event) throw invalid(`no message ${reply.messageId} in ${ref.conversationId}`, CODE.UNKNOWN_MESSAGE);
    const trigger = lineOf(event);
    const result = await turns.runTurn({
      conversation: ref,
      mode: 'reply',
      trigger,
      triggerKind: 'mention',
      forced: true,
      ...(requester ? { requester } : {}),
    });
    return `message create on ${ref.conversationId}: ${JSON.stringify(result) ?? 'ok'}`;
  }

  /** `/nep message create [channel] [reply]`: her turn for a person, her own text when she acts. */
  async function cmdCreate(args, context) {
    assertNotPaused();
    return context?.actor === 'persona' ? post(args, context) : turn(args, context);
  }

  /** The port, or an Error naming what is missing. */
  function requirePort() {
    if (!port || typeof port.edit !== 'function')
      throw Object.assign(new Error("the persona's interface is not available"), { code: CODE.NOT_CONFIGURED });
    return port;
  }

  /**
   * The message `args.messageId` names, in the conversation it may be acted on in -- the bot
   * holding there the permissions `need` names (src/tools/impl/shared.ts#CHANNEL_NEEDS): `{ channelId, ref }`.
   */
  async function target(args, context, need, { last = false } = {}) {
    if (last && isLast(args?.messageId)) return lastTarget(args, context, need);
    const message = await messageRefOf(args?.messageId, reads);
    const given = args?.channelId ? String(args.channelId) : null;
    if (given && message.channelId && given !== message.channelId)
      throw invalid('the message is not in that channel', CODE.UNKNOWN_MESSAGE);
    const channelId = await postingConversation({
      reads,
      iface: port?.iface,
      guildId: resolvedGuildId(context),
      channelId: given ?? message.channelId,
      context,
      need,
    });
    return {
      channelId,
      messageId: message.messageId,
      ref: { iface: port.iface, conversationId: channelId, messageId: message.messageId },
    };
  }

  /**
   * `last`'s target: the persona's own most recent message among the last LAST_LOOKBACK of the
   * conversation (`args.channelId`, else the one the command runs in), read through the interface;
   * none of hers there is `invalid` with `no-own-message`.
   */
  async function lastTarget(args, context, need) {
    const channelId = await postingConversation({
      reads,
      iface: port?.iface,
      guildId: resolvedGuildId(context),
      channelId: args?.channelId ? String(args.channelId) : null,
      context,
      need,
    });
    const page = await reads.history({ iface: port.iface, conversationId: channelId }, { limit: LAST_LOOKBACK });
    let newest = null;
    for (const event of page?.events ?? []) {
      if (event.message.author.self !== true) continue;
      if (!newest || event.message.at >= newest.message.at) newest = event;
    }
    if (!newest)
      throw invalid(`no message of the persona among the last ${LAST_LOOKBACK} in ${channelId}`, CODE.NO_OWN_MESSAGE);
    const messageId = String(newest.message.id);
    return { channelId, messageId, ref: { iface: port.iface, conversationId: channelId, messageId } };
  }

  /** `/nep message edit`: one of the persona's own messages gets `text`. */
  async function cmdEdit(args, context) {
    assertNotPaused();
    const p = requirePort();
    const text = String(args?.text ?? '').trim();
    if (!text) throw invalid('text is required');
    const { channelId, messageId, ref } = await target(args, context, 'read', { last: true });
    const users = mentionedUsers(context);
    const content = { text, ...(users.length > 0 ? { mentions: { users, repliedUser: false } } : {}) };
    return portAnswer('message.edit', await p.edit(ref, content), `edited message ${messageId} in ${channelId}`);
  }

  /** `/nep message delete`: one of the persona's own messages, deleted. */
  async function cmdDelete(args, context) {
    assertNotPaused();
    const p = requirePort();
    const { channelId, messageId, ref } = await target(args, context, 'read', { last: true });
    return portAnswer('message.delete', await p.delete(ref), `deleted message ${messageId} in ${channelId}`);
  }

  /** `/nep message react action:add|remove`: the persona's reaction `emoji` on a message, put or taken back. */
  async function cmdReact(add, args, context) {
    assertNotPaused();
    const p = requirePort();
    const emoji = String(args?.emoji ?? '').trim();
    if (!emoji) throw invalid('an emoji is required');
    const { channelId, messageId, ref } = await target(args, context, add ? 'react' : 'read');
    const result = add ? await p.react(ref, emoji) : await p.unreact(ref, emoji);
    return portAnswer(
      add ? 'message.react.add' : 'message.react.remove',
      result,
      `${add ? 'reacted to' : 'took back the reaction on'} message ${messageId} in ${channelId}`
    );
  }

  return { cmdCreate, cmdEdit, cmdDelete, cmdReact };
});

defineOp({
  name: 'message.create',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).cmdCreate(args, ctx),
});

defineOp({
  name: 'message.edit',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).cmdEdit(args, ctx),
});
defineOp({
  name: 'message.delete',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).cmdDelete(args, ctx),
});
defineOp({
  name: 'message.react.add',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).cmdReact(true, args, ctx),
});
defineOp({
  name: 'message.react.remove',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).cmdReact(false, args, ctx),
});
