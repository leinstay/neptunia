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
// channel of the served guild where the bot holds the platform permissions it needs
// (src/tools/impl/shared.ts#postingConversation; a person may ask for her turn in any channel); edit and
// delete reach only her own messages (the port refuses anyone else's). A message is named by its
// id or its link; for an edit or a deletion also by `last`, her own most recent message in that
// channel. A port answer that may have taken effect is `failed` with `data.unknown` true:
// never retried. Her post may carry one file an errand of hers brought back (`file`, a handle
// `file:<task id>/<name>`, src/errands/store.ts): read from the agent's out directory, refused
// when unknown here (`unknown-file`: a private chat's file goes only back to that chat), larger
// than the interface takes (`attachment-too-large`) or unreadable (`file-unreadable`). It may also
// carry one GIF of her library (`gif`, a handle), posted after the text or alone, counted like a
// reply's `<gif>` (`unknown-gif`; over `gifs.maxPerDay` `gif-cap`; both refuse before anything is posted).
// Instead of either, it may repost a picture of one of HER OWN earlier messages (`media`, a message id or
// link, `item` picking one of several attachments): the message is fetched, its attachment downloaded and
// uploaded as a real file (never a link). Refused: another's message (`not-own-message`), an unknown or
// deleted one (`unknown-message`, `message-deleted`), no such attachment (`no-media`), over the interface's
// byte cap (`attachment-too-large`), a failed download (`file-unreadable`), or together with `file`/`gif`.
// With `diary` the post goes to her diary in place of a channel, everything above included (diaryPort).

import fsp from 'node:fs/promises';
import { messageRefOf, portAnswer, postingConversation } from './shared.ts';
import { lineOf } from '../../behavior/line-of.js';
import { defineOp, perEnv, invalid, denied } from './registry.ts';
import { DIARY_DAILY } from '../../behavior/diary.ts';
import type { createMirrors } from '../../behavior/mirror.ts';
import { writeDiaryMessage } from '../../behavior/diary-turn.ts';
import { freshAttachmentUrl, gifPostUrl, countGifPost } from '../../media/gif-post.js';
import { gifPostsToday } from '../../memory/gif-watch.js';
import { countToday, utcDay } from '../../time.js';
import { CODE } from '../codes.ts';
import { idText, objOf, textOf } from '../types.ts';
import type { Obj, OpContext, Untyped } from '../types.ts';
import type { Adapter, ConversationRef, Delivery } from '../../protocol/adapter.ts';
import type { Content } from '../../protocol/actions.js';
import type { Reads } from '../../interface/reads.ts';
import type { Env } from './env.ts';

/** The conversation a diary post names where a channel post names its channel. */
const DIARY_TARGET = 'diary';
const DEFAULT_DIARY_PER_DAY = 12; // diary.maxPerDay

/** The ports that hold what is sent for her diary (diaryPort). */
const DIARY_PORTS = new WeakSet<Adapter>();

/** The diary hold of the mirrors' publisher (src/behavior/mirror.ts). */
type DiaryHold = Pick<ReturnType<typeof createMirrors>, 'holdDiary' | 'heldDiary'>;

/** A positive whole number setting, else `fallback`. */
function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * The port her post to her diary (`diary`) goes through: `real` whose `send` holds each message for the turn's one
 * entry (`env.mirrors`, src/behavior/mirror.ts#holdDiary), which the turn records and the mirrors publish when it ends
 * (src/behavior/diary-turn.ts#publishHeldDiary). Refused: a channel or a reply beside it (`invalid-args`), and the
 * turn's first diary message when `diary.maxPerDay` (default 12) entries are counted today (`cap-diary`).
 */
function diaryPort(env: Env, args: Obj, context: OpContext, real: Adapter): Adapter {
  if (args.channelId || args.replyTo) throw invalid('a diary message goes to your diary, with no channel or reply');
  const hold = env.mirrors as DiaryHold | null | undefined;
  const turnId = textOf(context.turnId);
  const guildId = env.resolvedGuildId(context);
  if (typeof hold?.holdDiary !== 'function' || !turnId || !guildId)
    throw Object.assign(new Error('your diary is not available here'), { code: CODE.NOT_CONFIGURED });
  // The live config and the store's counters, untyped in the env.
  const config = objOf(env.hot as unknown).config;
  const counters = objOf(objOf(objOf(env.store as unknown).state).data);
  const cap = positive(objOf(objOf(config).diary).maxPerDay, DEFAULT_DIARY_PER_DAY);
  const clock = typeof env.now === 'function' ? env.now : Date.now;
  if (hold.heldDiary(turnId) === 0 && countToday(counters, DIARY_DAILY, clock()) >= cap)
    throw denied(`your diary holds ${cap} entries a day at most`, CODE.CAP_DIARY);
  const held = Object.create(real) as Adapter;
  // Each send is one message of the turn's entry, kept in memory before the call answers.
  held.send = async (_to: ConversationRef, content: Content): Promise<Delivery> => {
    // A file the port would fetch by its address has no bytes to keep: only files with their bytes go in.
    const files = (content.attachments ?? []).flatMap((file) =>
      file.data ? [{ name: file.name, data: file.data, contentType: file.contentType ?? null }] : []
    );
    const message = { text: content.text ?? '', mentions: [...(content.mentions?.users ?? [])], files };
    await writeDiaryMessage({
      mirrors: hold,
      store: env.store as unknown,
      config: objOf(config),
      turnId,
      guildId,
      message,
    });
    return { status: 'ok', ref: null, parts: [], at: clock(), idempotencyKey: '', error: null };
  };
  DIARY_PORTS.add(held);
  return held;
}

/**
 * Where a post of hers through `p` goes: her diary for a diary port (no channel), else the conversation `channelId`
 * names, checked for what a post (a reply when `reply`) needs there (src/tools/impl/shared.ts#postingConversation).
 */
async function postTarget(
  env: Env,
  p: Adapter,
  context: OpContext,
  channelId: string | null,
  reply: boolean
): Promise<string> {
  if (DIARY_PORTS.has(p)) return DIARY_TARGET;
  const iface = p.iface;
  const guildId = env.resolvedGuildId(context);
  const need = reply ? 'reply' : 'send';
  return postingConversation({ reads: env.reads, iface, guildId, channelId, context, need });
}

/**
 * `real` whose sends carry her turn's key of this call (`context.idempotencyKey`, src/behavior/turn.js), so a repeat
 * of the call posts nothing new: the first send under the key itself, a later one of the same call (a GIF after her
 * text) under `<key>:<n>`. `real` itself when the call has no key.
 */
function keyedPort(real: Adapter, context: OpContext): Adapter {
  const key = typeof context.idempotencyKey === 'string' ? context.idempotencyKey : '';
  if (key === '') return real;
  const keyed = Object.create(real) as Adapter;
  let sends = 0;
  keyed.send = (to, content, options = {}) => {
    const idempotencyKey = sends === 0 ? key : `${key}:${sends}`;
    sends += 1;
    return real.send(to, content, { ...options, idempotencyKey });
  };
  return keyed;
}

/** Her post through `real`, or with `diary` to her diary through its port (diaryPort), answered as diaryAnswer words it. */
async function postOf(
  env: Env,
  args: Obj,
  context: OpContext,
  real: Adapter,
  post: (args: Obj, context: OpContext, p: Adapter) => Promise<unknown>
): Promise<unknown> {
  if (args.diary !== true) return post(args, context, keyedPort(real, context));
  return diaryAnswer(env, await post(args, context, diaryPort(env, args, context, real)));
}

/**
 * The answer of a post to her diary: a refusal or a failure as `post` gave it, else `ok` worded by
 * `labels.tools.result.diaryWritten` (no message is posted yet: the mirrors post the entry when the turn ends).
 */
function diaryAnswer(env: Env, answer: unknown): unknown {
  const given = objOf(answer);
  if (typeof given.status === 'string' && given.status !== 'ok') return answer;
  const result = objOf(objOf(objOf(objOf(objOf(env.hot as unknown).prompts).labels).tools).result);
  return { text: textOf(result.diaryWritten) };
}

/** How far back `last` looks for her own message: the most messages one history read returns on the platform (100). */
const LAST_LOOKBACK = 100;

/** True when a message reference is `last`: the persona's own most recent message (any case). */
function isLast(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'last';
}

/** A file a post carries, read for upload. */
type Upload = { name: string; data: Uint8Array; contentType?: string };

/** What the bot needs to be allowed in the conversation an operation acts in (src/tools/impl/shared.ts#CHANNEL_NEEDS). */
type Need = Parameters<typeof postingConversation>[0]['need'];

/** The message an operation acts on and the conversation it is in. */
type Target = {
  channelId: string;
  messageId: string;
  ref: { iface: string; conversationId: string; messageId: string };
};

/** The core's reads of the interface, or an Error naming what is missing. */
function needReads(reads: Reads | null): Reads {
  if (!reads) throw Object.assign(new Error("the persona's interface is not available"), { code: CODE.NOT_CONFIGURED });
  return reads;
}

/**
 * The attachment of a post's `file` handle bound for `channelId`, or null without one: the
 * errand's file (src/errands/service.ts#fileOf), its size checked against the interface's
 * `maxFileBytes` before it is read.
 */
async function errandFile(
  env: Env,
  args: Obj,
  context: OpContext,
  channelId: string,
  p: Adapter
): Promise<Upload | null> {
  const handle = textOf(args.file).trim();
  if (!handle) return null;
  const file =
    typeof env.errands?.fileOf === 'function'
      ? env.errands.fileOf({ guildId: env.resolvedGuildId(context), handle, privateChannelId: channelId })
      : null;
  if (file?.expired) throw invalid(`files of ${handle} have expired`, CODE.FILE_EXPIRED);
  if (!file) throw invalid(`no file ${handle}`, CODE.UNKNOWN_FILE);
  const limit = p.capabilities?.()?.maxFileBytes ?? Infinity;
  const stat = await fsp.stat(file.path as string).catch(() => null);
  if (!stat?.isFile()) throw Object.assign(new Error(`cannot read ${handle}`), { code: CODE.FILE_UNREADABLE });
  if (Number.isFinite(limit) && stat.size > limit)
    throw Object.assign(new Error(`${handle} is ${stat.size} bytes, over the ${limit} this interface takes`), {
      code: CODE.ATTACHMENT_TOO_LARGE,
    });
  const data = await fsp.readFile(file.path as string).catch(() => null);
  if (!data) throw Object.assign(new Error(`cannot read ${handle}`), { code: CODE.FILE_UNREADABLE });
  return { name: file.name, data, ...(file.contentType ? { contentType: file.contentType } : {}) };
}

/**
 * The library entry of a post's `gif` handle in `guildId`, or null without a handle: unknown
 * here (or `features.gifs` off) is `invalid` with `unknown-gif`, checked before anything is posted.
 */
function gifEntry(env: Env, args: Obj, guildId: string | null): Untyped {
  const handle = textOf(args.gif).trim();
  if (!handle) return null;
  const entry =
    env.hot.config.features?.gifs === false || typeof env.store?.findGif !== 'function'
      ? null
      : env.store.findGif(guildId, handle);
  if (!entry) throw invalid(`no GIF ${handle} in the library`, CODE.UNKNOWN_GIF);
  return entry;
}

const handlers = perEnv((env) => {
  const { hot, store, spontaneous, turns, assertNotPaused, resolvedGuildId } = env;
  const { reads } = env;
  const port = env.port as Adapter | null | undefined;
  const fetchImpl = typeof env.fetchImpl === 'function' ? env.fetchImpl : fetch;
  const clock = typeof env.now === 'function' ? env.now : Date.now;

  /** True when member `userId` turned pings off here. */
  function pingsOff(context: OpContext, userId: unknown): boolean {
    if (!userId || typeof store?.isPingsOff !== 'function') return false;
    return store.isPingsOff(resolvedGuildId(context), idText(userId)) === true;
  }

  /** The members her rendered text mentions (`context.mentionUserIds`, her own calls only), less those with pings off. */
  function mentionedUsers(context: OpContext) {
    if (context?.actor !== 'persona' || !Array.isArray(context.mentionUserIds)) return [];
    return (context.mentionUserIds as Array<unknown>).map(idText).filter((id) => id && !pingsOff(context, id));
  }

  /**
   * The attachment of a post's `media` (a picture of one of her own messages, `args.item` picking
   * one of several; 1 is the first), downloaded for upload, or null without `media`. The message is
   * fetched again, so its attachment URL is fresh. Refusals are listed in this module's header;
   * nothing is posted before they are told.
   */
  async function mediaFile(args: Obj, context: OpContext, p: Adapter): Promise<Upload | null> {
    const raw = textOf(args.media).trim();
    if (!raw) return null;
    if (textOf(args.file).trim() || textOf(args.gif).trim())
      throw invalid('one attachment per post', CODE.INVALID_ARGS);
    const ref = await messageRefOf(raw, reads);
    const sourceId = await postingConversation({
      reads,
      iface: p.iface,
      guildId: resolvedGuildId(context),
      channelId: ref.channelId,
      context,
      need: 'read',
    });
    const found = await needReads(reads).fetchMessages({ iface: p.iface, conversationId: sourceId }, [ref.messageId]);
    const message = found?.messages[0] ?? null;
    if (message?.missing === true) throw invalid(`message ${ref.messageId} was deleted`, CODE.MESSAGE_DELETED);
    if (!message?.event) throw invalid(`no message ${ref.messageId} in ${sourceId}`, CODE.UNKNOWN_MESSAGE);
    if (message.event.message.author?.self !== true) throw invalid('that message is not hers', CODE.NOT_OWN_MESSAGE);
    const attachments: Array<Untyped> = [...(message.attachments ?? [])];
    const given = args.item === undefined || args.item === null || args.item === '' ? 1 : Number(args.item);
    if (attachments.length === 0) throw invalid('that message holds no attachment', CODE.NO_MEDIA);
    if (!Number.isInteger(given) || given < 1 || given > attachments.length)
      throw invalid('item is out of range', CODE.NO_MEDIA);
    const item = attachments[given - 1];
    if (!item?.url) throw invalid('that attachment has no address', CODE.NO_MEDIA);
    const limit = p.capabilities?.()?.maxFileBytes ?? Infinity;
    const tooLarge = (size: number): boolean => Number.isFinite(limit) && size > limit;
    const large = (size: number): Error =>
      Object.assign(new Error(`the picture is ${size} bytes, over the ${limit} this interface takes`), {
        code: CODE.ATTACHMENT_TOO_LARGE,
      });
    if (tooLarge(Number(item.size))) throw large(Number(item.size));
    const unreadable = () => Object.assign(new Error('cannot download the picture'), { code: CODE.FILE_UNREADABLE });
    let data: Buffer | null = null;
    try {
      const response = await fetchImpl(item.url, { method: 'GET', signal: AbortSignal.timeout(30_000) });
      if (!response?.ok) throw unreadable();
      const declared = Number(response.headers?.get?.('content-length'));
      if (tooLarge(declared)) throw large(declared);
      data = Buffer.from(await response.arrayBuffer());
    } catch (err) {
      throw objOf(err).code === CODE.ATTACHMENT_TOO_LARGE ? err : unreadable();
    }
    if (tooLarge(data.byteLength)) throw large(data.byteLength);
    return {
      name: String(item.name || 'picture'),
      data,
      ...(item.contentType ? { contentType: String(item.contentType).split(';')[0] } : {}),
    };
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
  async function post(args: Obj, context: OpContext, p: Adapter) {
    const text = textOf(args.text).trim();
    // A file-only or GIF-only post: an errand's file or a GIF of hers with no text.
    if (!text && !textOf(args.file).trim() && !textOf(args.gif).trim() && !textOf(args.media).trim())
      throw invalid('text is required');
    const reply = args.replyTo ? await messageRefOf(args.replyTo, reads) : null;
    const given = args.channelId ? idText(args.channelId) : null;
    if (given && reply?.channelId && given !== reply.channelId)
      throw invalid('the message is not in that channel', CODE.UNKNOWN_MESSAGE);
    const channelId = await postTarget(env, p, context, given ?? reply?.channelId ?? null, reply !== null);
    const repliedUser = Boolean(reply) && !pingsOff(context, context?.repliedAuthorId);
    const guildId = resolvedGuildId(context);
    const entry = gifEntry(env, args, guildId);
    const capped = entry ? gifCapSpent() : false;
    // Over the day's cap nothing is posted, the text included: she may call again without the GIF.
    if (capped) throw invalid('the GIF limit for today is used up', CODE.GIF_CAP);
    const attachment = (await errandFile(env, args, context, channelId, p)) ?? (await mediaFile(args, context, p));
    const to = { iface: p.iface, conversationId: channelId };
    const content: Content = {
      text,
      ...(attachment ? { attachments: [attachment] } : {}),
      ...(reply ? { replyTo: { iface: p.iface, conversationId: channelId, messageId: reply.messageId } } : {}),
      mentions: { users: mentionedUsers(context), repliedUser },
    };
    let result: Untyped = null;
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
  async function postGif(
    p: Adapter,
    to: ConversationRef,
    entry: Untyped,
    guildId: string | null,
    channelId: string,
    lead: Content | null
  ): Promise<Untyped> {
    const fresh =
      entry.kind === 'attachment'
        ? await freshAttachmentUrl({
            reads: needReads(reads),
            channel: { iface: p.iface, conversationId: channelId },
            entry,
          })
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
  async function turn(args: Obj, context: OpContext) {
    const channelId = idText(args.channelId) || context.channelId;
    if (!channelId) throw invalid('a channel is required');
    const p = requirePort();
    const ref = { iface: p.iface, conversationId: channelId };
    if ((await needReads(reads).conversationInfo(ref)) === null)
      throw invalid(`no channel ${channelId}`, CODE.NOT_FOUND);
    // The person who ran the command is the requester of what she does in that turn.
    const requester = context.userId
      ? { id: context.userId, roleIds: Array.isArray(context.roleIds) ? context.roleIds.map(idText) : [] }
      : null;
    if (!args.replyTo) {
      const result = await spontaneous.force(ref, null, { requester });
      return `message create on ${ref.conversationId}: ${JSON.stringify(result) ?? 'ok'}`;
    }
    const reply = await messageRefOf(args.replyTo, reads);
    if (reply.channelId && reply.channelId !== ref.conversationId)
      throw invalid('the message is not in that channel', CODE.UNKNOWN_MESSAGE);
    const fetched = await needReads(reads).fetchMessages(ref, [reply.messageId]);
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
  async function cmdCreate(args: Obj, context: OpContext) {
    assertNotPaused();
    return context?.actor === 'persona' ? postOf(env, args, context, requirePort(), post) : turn(args, context);
  }

  /** The port, or an Error naming what is missing. */
  function requirePort(): Adapter {
    if (!port || typeof port.edit !== 'function')
      throw Object.assign(new Error("the persona's interface is not available"), { code: CODE.NOT_CONFIGURED });
    return port;
  }

  /**
   * The message `args.messageId` names, in the conversation it may be acted on in -- the bot
   * holding there the permissions `need` names (src/tools/impl/shared.ts#CHANNEL_NEEDS): `{ channelId, ref }`.
   */
  async function target(
    args: Obj,
    context: OpContext,
    need: Need,
    { last = false }: { last?: boolean } = {}
  ): Promise<Target> {
    const p = requirePort();
    if (last && isLast(args.messageId)) return lastTarget(args, context, need);
    const message = await messageRefOf(args.messageId, reads);
    const given = args.channelId ? idText(args.channelId) : null;
    if (given && message.channelId && given !== message.channelId)
      throw invalid('the message is not in that channel', CODE.UNKNOWN_MESSAGE);
    const channelId = await postingConversation({
      reads,
      iface: p.iface,
      guildId: resolvedGuildId(context),
      channelId: given ?? message.channelId,
      context,
      need,
    });
    return {
      channelId,
      messageId: message.messageId,
      ref: { iface: p.iface, conversationId: channelId, messageId: message.messageId },
    };
  }

  /**
   * `last`'s target: the persona's own most recent message among the last LAST_LOOKBACK of the
   * conversation (`args.channelId`, else the one the command runs in), read through the interface;
   * none of hers there is `invalid` with `no-own-message`.
   */
  async function lastTarget(args: Obj, context: OpContext, need: Need): Promise<Target> {
    const p = requirePort();
    const channelId = await postingConversation({
      reads,
      iface: p.iface,
      guildId: resolvedGuildId(context),
      channelId: args.channelId ? idText(args.channelId) : null,
      context,
      need,
    });
    const page = await needReads(reads).history(
      { iface: p.iface, conversationId: channelId },
      { limit: LAST_LOOKBACK }
    );
    let newest: NonNullable<typeof page>['events'][number] | null = null;
    for (const event of page?.events ?? []) {
      if (event.message?.author?.self !== true) continue;
      if (!newest || (event.message.at ?? 0) >= (newest.message?.at ?? 0)) newest = event;
    }
    if (!newest)
      throw invalid(`no message of the persona among the last ${LAST_LOOKBACK} in ${channelId}`, CODE.NO_OWN_MESSAGE);
    const messageId = idText(newest.message?.id);
    return { channelId, messageId, ref: { iface: p.iface, conversationId: channelId, messageId } };
  }

  /** `/nep message edit`: one of the persona's own messages gets `text`. */
  async function cmdEdit(args: Obj, context: OpContext) {
    assertNotPaused();
    const p = requirePort();
    const text = textOf(args.text).trim();
    if (!text) throw invalid('text is required');
    const { channelId, messageId, ref } = await target(args, context, 'read', { last: true });
    const users = mentionedUsers(context);
    const content = { text, ...(users.length > 0 ? { mentions: { users, repliedUser: false } } : {}) };
    return portAnswer('message.edit', await p.edit(ref, content), `edited message ${messageId} in ${channelId}`);
  }

  /** `/nep message delete`: one of the persona's own messages, deleted. */
  async function cmdDelete(args: Obj, context: OpContext) {
    assertNotPaused();
    const p = requirePort();
    const { channelId, messageId, ref } = await target(args, context, 'read', { last: true });
    return portAnswer('message.delete', await p.delete(ref), `deleted message ${messageId} in ${channelId}`);
  }

  /** `/nep message react action:add|remove`: the persona's reaction `emoji` on a message, put or taken back. */
  async function cmdReact(add: boolean, args: Obj, context: OpContext): Promise<Obj> {
    assertNotPaused();
    const p = requirePort();
    const emoji = textOf(args.emoji).trim();
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
