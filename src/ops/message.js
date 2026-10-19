// Operations: `/nep message create|edit|delete|react`: the persona's own messages and reactions.
// `message.create` is one operation with two modes, chosen by the server from who acts, never by
// an argument: when a person runs it, she gets one turn in that channel now, bypassing the
// schedule -- an answer to the named message, else she reads the channel and joins the
// conversation or starts a topic herself (src/behavior/spontaneous.js#force); when she calls it
// (`context.actor` 'persona', her skills, src/skills/), her own text -- the call's body -- is
// posted through her interface (src/interface/port.js, `env.port`), replying to a message when
// one is named, and a reply notifies the replied author unless they turned pings off. Her text
// (a post or an edit) arrives rendered as a `<msg>` of hers (src/skills/executors.js#executeCall);
// only the members it mentions (`context.mentionUserIds`) are notified, none with pings off. Edit,
// delete and react go through the interface too. The rules live here, for every caller: a post,
// an edit, a deletion or a reaction in the conversation the command runs in, or in any text
// channel of the served guild where the bot holds the Discord permissions it needs
// (src/ops/shared.js#postingConversation; a person may ask for her turn in any channel); edit and
// delete reach only her own messages (the port refuses anyone else's). A message is named by its
// id or its link; for an edit or a deletion also by `last`, her own most recent message in that
// channel. A port answer that may have taken effect is `failed` with `data.unknown` true:
// never retried. Her post may carry one file an errand of hers brought back (`file`, a handle
// `file:<task id>/<name>`, src/errands/store.js): read from the agent's out directory, refused
// when unknown here (`unknown-file`: a private chat's file goes only back to that chat), larger
// than the interface takes (`attachment-too-large`) or unreadable (`file-unreadable`). It may also
// carry one GIF of her library (`gif`, a handle), posted after the text or alone, counted like a
// reply's `<gif>` (`unknown-gif`; over `gifs.maxPerDay` `gif-cap`; both refuse before anything is posted).

import fsp from 'node:fs/promises';
import { channelById, messageRefOf, portAnswer, postingConversation } from './shared.js';
import { defineOp, perEnv, invalid } from './registry.js';
import { freshAttachmentUrl, gifPostUrl, countGifPost } from '../media/gif-post.js';
import { gifPostsToday } from '../memory/gif-watch.js';
import { utcDay } from '../time.js';

/** How far back `last` looks for her own message: Discord's most messages per history request. */
const LAST_LOOKBACK = 100;

/** True when a message reference is `last`: the persona's own most recent message (any case). */
function isLast(value) {
  return typeof value === 'string' && value.trim().toLowerCase() === 'last';
}

const handlers = perEnv((env) => {
  const { hot, store, client, discord, spontaneous, turns, port, errands, assertNotPaused, resolvedGuildId } = env;
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
   * `maxAttachmentBytes` before it is read.
   */
  async function errandFile(args, context, channelId, p) {
    const handle = String(args?.file ?? '').trim();
    if (!handle) return null;
    const file = typeof errands?.fileOf === 'function' ? errands.fileOf({ guildId: resolvedGuildId(context), handle, privateChannelId: channelId }) : null;
    if (!file) throw invalid(`no file ${handle}`, 'unknown-file');
    const limit = p.capabilities?.()?.limits?.maxAttachmentBytes;
    const stat = await fsp.stat(file.path).catch(() => null);
    if (!stat?.isFile()) throw Object.assign(new Error(`cannot read ${handle}`), { code: 'file-unreadable' });
    if (Number.isFinite(limit) && stat.size > limit) throw Object.assign(new Error(`${handle} is ${stat.size} bytes, over the ${limit} this interface takes`), { code: 'attachment-too-large' });
    const data = await fsp.readFile(file.path).catch(() => null);
    if (!data) throw Object.assign(new Error(`cannot read ${handle}`), { code: 'file-unreadable' });
    return { name: file.name, data, ...(file.contentType ? { contentType: file.contentType } : {}) };
  }

  /**
   * The library entry of a post's `gif` handle in `guildId`, or null without a handle: unknown
   * here (or `features.gifs` off) is `invalid` with `unknown-gif`, checked before anything is posted.
   */
  function gifEntry(args, guildId) {
    const handle = String(args?.gif ?? '').trim();
    if (!handle) return null;
    const entry = hot.config.features?.gifs === false || typeof store?.findGif !== 'function' ? null : store.findGif(guildId, handle);
    if (!entry) throw invalid(`no GIF ${handle} in the library`, 'unknown-gif');
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
    if (!text && !String(args?.file ?? '').trim() && !String(args?.gif ?? '').trim()) throw invalid('text is required');
    const reply = args?.replyTo ? messageRefOf(args.replyTo) : null;
    const given = args?.channelId ? String(args.channelId) : null;
    if (given && reply?.channelId && given !== reply.channelId) throw invalid('the message is not in that channel', 'unknown-message');
    const channelId = await postingConversation({ client, discord, guildId: resolvedGuildId(context), channelId: given ?? reply?.channelId ?? null, context, need: reply ? 'reply' : 'send' });
    const repliedUser = Boolean(reply) && !pingsOff(context, context?.repliedAuthorId);
    const guildId = resolvedGuildId(context);
    const entry = gifEntry(args, guildId);
    const capped = entry ? gifCapSpent() : false;
    // Over the day's cap nothing is posted, the text included: she may call again without the GIF.
    if (capped) throw invalid('the GIF limit for today is used up', 'gif-cap');
    const attachment = await errandFile(args, context, channelId, p);
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
      if (result?.status !== 'ok' || !entry) return portAnswer('message.create', result, `sent in ${channelId} (message ${result?.ref?.messageId ?? '?'})`);
    }
    const sent = await postGif(p, to, entry, guildId, channelId, text || attachment ? null : content);
    if (sent?.status !== 'ok') return text || attachment ? { status: 'failed', code: String(sent?.error?.code ?? sent?.status ?? 'error'), summary: 'message.create: the text went out, the GIF did not', data: { unknown: sent?.status === 'unknown', portStatus: sent?.status ?? null, ref: result?.ref ?? null } } : portAnswer('message.create', sent, '');
    const ref = result?.ref ?? sent.ref;
    return { text: `sent in ${channelId} (message ${ref?.messageId ?? '?'})${text || attachment ? ' and a GIF' : ''}`, ref: ref ?? null, at: (result ?? sent).at };
  }

  /**
   * One library GIF as a message of hers: its stored URL, a fresh one first when it is an
   * attachment. Counted once sent and stamped on its entry. A GIF-only post carries the reply
   * and mentions (`lead`); one after a text carries none.
   */
  async function postGif(p, to, entry, guildId, channelId, lead) {
    const fresh = entry.kind === 'attachment' ? await freshAttachmentUrl({ client, channel: (await channelById(client, channelId)) ?? { id: channelId }, entry }) : null;
    const content = lead ? { ...lead, text: gifPostUrl(entry, fresh) } : { text: gifPostUrl(entry, fresh), mentions: { users: [], repliedUser: false } };
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
    const channel = await client.channels.fetch(channelId);
    if (!channel) throw invalid(`no channel ${channelId}`, 'not-found');
    // The person who ran the command is the requester of what she does in that turn.
    const requester = context?.userId ? { id: String(context.userId), roleIds: Array.isArray(context.roleIds) ? context.roleIds.map(String) : [] } : null;
    if (!args?.replyTo) {
      const result = await spontaneous.force(channel, null, { requester });
      return `message create on ${channel.id}: ${JSON.stringify(result) ?? 'ok'}`;
    }
    const reply = messageRefOf(args.replyTo);
    if (reply.channelId && reply.channelId !== String(channel.id)) throw invalid('the message is not in that channel', 'unknown-message');
    const message = await channel.messages?.fetch?.(reply.messageId).catch(() => null);
    if (!message) throw invalid(`no message ${reply.messageId} in ${channel.id}`, 'unknown-message');
    const media = hot.config.media ?? {};
    const trigger = discord.normalizeMessage(message, client.user?.id, { embedTextChars: media.embedTextChars, videoSites: media.video?.sites, maxUrlChars: hot.config.context?.maxUrlChars });
    const result = await turns.runTurn({ channel, mode: 'reply', trigger, triggerKind: 'mention', forced: true, ...(requester ? { requester } : {}) });
    return `message create on ${channel.id}: ${JSON.stringify(result) ?? 'ok'}`;
  }

  /** `/nep message create [channel] [reply]`: her turn for a person, her own text when she acts. */
  async function cmdCreate(args, context) {
    assertNotPaused();
    return context?.actor === 'persona' ? post(args, context) : turn(args, context);
  }

  /** The port, or an Error naming what is missing. */
  function requirePort() {
    if (!port || typeof port.edit !== 'function') throw Object.assign(new Error('the persona\'s interface is not available'), { code: 'not-configured' });
    return port;
  }

  /**
   * The message `args.messageId` names, in the conversation it may be acted on in -- the bot
   * holding there the permissions `need` names (src/ops/shared.js#CHANNEL_NEEDS): `{ channelId, ref }`.
   */
  async function target(args, context, need, { last = false } = {}) {
    if (last && isLast(args?.messageId)) return lastTarget(args, context, need);
    const message = messageRefOf(args?.messageId);
    const given = args?.channelId ? String(args.channelId) : null;
    if (given && message.channelId && given !== message.channelId) throw invalid('the message is not in that channel', 'unknown-message');
    const channelId = await postingConversation({ client, discord, guildId: resolvedGuildId(context), channelId: given ?? message.channelId, context, need });
    return { channelId, messageId: message.messageId, ref: { iface: port.iface, conversationId: channelId, messageId: message.messageId } };
  }

  /**
   * `last`'s target: the persona's own most recent message among the last LAST_LOOKBACK of the
   * conversation (`args.channelId`, else the one the command runs in), read through the client;
   * none of hers there is `invalid` with `no-own-message`.
   */
  async function lastTarget(args, context, need) {
    const channelId = await postingConversation({ client, discord, guildId: resolvedGuildId(context), channelId: args?.channelId ? String(args.channelId) : null, context, need });
    const channel = await channelById(client, channelId);
    const fetched = await Promise.resolve(channel?.messages?.fetch?.({ limit: LAST_LOOKBACK })).catch(() => null);
    const selfId = client?.user?.id ? String(client.user.id) : null;
    let newest = null;
    for (const message of fetched?.values?.() ?? []) {
      if (!selfId || String(message?.author?.id ?? '') !== selfId) continue;
      if (!newest || (message.createdTimestamp ?? 0) > (newest.createdTimestamp ?? 0)) newest = message;
    }
    if (!newest) throw invalid(`no message of the persona among the last ${LAST_LOOKBACK} in ${channelId}`, 'no-own-message');
    const messageId = String(newest.id);
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
    return portAnswer('message.edit', await p.edit(ref, content),`edited message ${messageId} in ${channelId}`);
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
    return portAnswer(add ? 'message.react.add' : 'message.react.remove', result, `${add ? 'reacted to' : 'took back the reaction on'} message ${messageId} in ${channelId}`);
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
