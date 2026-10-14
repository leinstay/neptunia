// Operations: `/nep message create|edit|delete|react`: the persona's own messages and reactions.
// `message.create` is one operation with two modes, chosen by the server from who acts, never by
// an argument: when a person runs it, she gets one turn in that channel now, bypassing the
// schedule -- an answer to the named message, else she reads the channel and joins the
// conversation or starts a topic herself (src/behavior/spontaneous.js#force); when she calls it
// (`context.actor` 'persona', her skills, src/skills/), her own text -- the call's body -- is
// posted through her interface (src/interface/port.js, `env.port`), replying to a message when
// one is named, and a reply notifies the replied author unless they turned pings off. Edit,
// delete and react go through the interface too. The rules live here, for every caller: a post,
// an edit, a deletion or a reaction only in the conversation the command runs in or one of
// `skills.conversations` (read now; a person may ask for her turn in any channel); edit and
// delete reach only her own messages (the port refuses anyone else's). A message is named by its
// id or its link. A port answer that may have taken effect is `failed` with `data.unknown` true:
// never retried.

import { normalizeMessage } from '../discord/collect.js';
import { messageRefOf, portAnswer, postingConversation } from './shared.js';
import { defineOp, perEnv, invalid } from './registry.js';

const handlers = perEnv((env) => {
  const { hot, store, client, spontaneous, turns, port, assertNotPaused, resolvedGuildId } = env;

  /** True when member `userId` turned pings off here. */
  function pingsOff(context, userId) {
    if (!userId || typeof store?.isPingsOff !== 'function') return false;
    return store.isPingsOff(resolvedGuildId(context), String(userId)) === true;
  }

  /** The persona's own text posted as hers: the channel checked, the reply target in it. */
  async function post(args, context) {
    const p = requirePort();
    const text = String(args?.text ?? '').trim();
    if (!text) throw invalid('text is required');
    const reply = args?.replyTo ? messageRefOf(args.replyTo) : null;
    const given = args?.channelId ? String(args.channelId) : null;
    if (given && reply?.channelId && given !== reply.channelId) throw invalid('the message is not in that channel', 'unknown-message');
    const channelId = postingConversation(hot.config, given ?? reply?.channelId ?? null, context);
    const repliedUser = Boolean(reply) && !pingsOff(context, context?.repliedAuthorId);
    const content = {
      text,
      ...(reply ? { replyTo: { iface: p.iface, conversationId: channelId, messageId: reply.messageId } } : {}),
      mentions: { users: [], repliedUser },
    };
    const result = await p.send({ iface: p.iface, conversationId: channelId }, content);
    return portAnswer('message.create', result, `sent in ${channelId} (message ${result?.ref?.messageId ?? '?'})`);
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
    const trigger = normalizeMessage(message, client.user?.id, { embedTextChars: media.embedTextChars, videoSites: media.video?.sites });
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

  /** The message `args.messageId` names, in the conversation it may be acted on in: `{ channelId, ref }`. */
  function target(args, context) {
    const message = messageRefOf(args?.messageId);
    const given = args?.channelId ? String(args.channelId) : null;
    if (given && message.channelId && given !== message.channelId) throw invalid('the message is not in that channel', 'unknown-message');
    const channelId = postingConversation(hot.config, given ?? message.channelId, context);
    return { channelId, messageId: message.messageId, ref: { iface: port.iface, conversationId: channelId, messageId: message.messageId } };
  }

  /** `/nep message edit`: one of the persona's own messages gets `text`. */
  async function cmdEdit(args, context) {
    assertNotPaused();
    const p = requirePort();
    const text = String(args?.text ?? '').trim();
    if (!text) throw invalid('text is required');
    const { channelId, messageId, ref } = target(args, context);
    return portAnswer('message.edit', await p.edit(ref, { text }), `edited message ${messageId} in ${channelId}`);
  }

  /** `/nep message delete`: one of the persona's own messages, deleted. */
  async function cmdDelete(args, context) {
    assertNotPaused();
    const p = requirePort();
    const { channelId, messageId, ref } = target(args, context);
    return portAnswer('message.delete', await p.delete(ref), `deleted message ${messageId} in ${channelId}`);
  }

  /** `/nep message react action:add|remove`: the persona's reaction `emoji` on a message, put or taken back. */
  async function cmdReact(add, args, context) {
    assertNotPaused();
    const p = requirePort();
    const emoji = String(args?.emoji ?? '').trim();
    if (!emoji) throw invalid('an emoji is required');
    const { channelId, messageId, ref } = target(args, context);
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
