// The act of a turn: her reactions, messages and GIF posted for real, each checked by the gateway right before it, typed
// out like a person would, journaled and recorded; and a diary post's speech held where the act would send it.
// createTurnRunner (src/behavior/turn.js) builds it once per runner with createAct; the attempt and her calls call act
// and holdSpeech.

import { setSettings } from '../behavior/diary.ts';
import { chunkPictures, filesPerMessage } from '../behavior/mirror.ts';
import type { EntryPicture } from '../behavior/mirror.ts';
import { between, typingMs } from '../behavior/random.js';
import type { Snapshot } from '../behavior/snapshot.ts';
import type { Reads } from '../interface/reads.ts';
import { sleep } from '../llm/openrouter.js';
import { log } from '../log.js';
import type { ConversationInfo, ConversationRef, MessageRef } from '../protocol/adapter.ts';
import { CODE } from '../tools/codes.ts';
import type { DrawGif, ResolvedGif } from './draw-gif.ts';
import { closeResult, portError, postedOf, sendHash } from './journal.ts';
import type { JournalOp, PortResult } from './journal.ts';
import type { JournalNotes } from './journal-notes.ts';
import type { Participation } from './participation.ts';
import { snapshotOfDraft } from './routing.ts';
import type { Sends } from './sends.ts';
import { reactionChannel, replyTarget, sendArgs } from './targets.ts';
import type { TriggerKind } from './triggers.ts';

/** The typing imitation's settings (`typing`): the pauses before a reaction and between messages, the typing speed. */
type TypingSettings = Parameters<typeof typingMs>[1] & {
  reactionDelayMs: [number, number];
  betweenMessagesMs: [number, number];
};

/** The live config, as far as the act reads it. */
export type ActConfig = {
  typing: TypingSettings;
  features?: { typingSimulation?: unknown } | null;
  diary?: unknown;
};

/** An answer of the interface port: its result, and a platform's own code for a refused send. */
type ActResult = NonNullable<PortResult> & { code?: unknown };

/** The interface port (src/interface/port.js), as the act posts, reacts and types through it. */
type ActPort = {
  typing: (conversation: ConversationRef) => Promise<ActResult>;
  react: (message: MessageRef, emoji: string) => Promise<ActResult>;
  send: (conversation: ConversationRef, content: object) => Promise<ActResult>;
};

/** The gateway's verdict on one effect of her reply. */
type EffectVerdict = { ok: boolean };

/** What createAct reads: the dependencies and the functions of the other topic modules it calls. */
export type ActContext = {
  hot: { readonly config: ActConfig };
  store: { isPingsOff?: (guildId: string, userId: string | null | undefined) => boolean };
  rng: () => number;
  clock: () => number;
  selfIdOf: () => string;
  ifaceReads: Reads;
  iface: ActPort;
  conversationOf: (channel: { id: string }) => ConversationRef;
  messageOf: (channel: { id: string }, messageId: string) => MessageRef;
  checkEffect: (skill: string, args: unknown, at: { channel: ConversationInfo; trigger: unknown }) => EffectVerdict;
  lastPostAt: Map<string, number>;
  noteTrigger: JournalNotes['noteTrigger'];
  noteLineSources: JournalNotes['noteLineSources'];
  recordSaid: JournalNotes['recordSaid'];
  journalOp: JournalNotes['journalOp'];
  renderPost: Sends['renderPost'];
  postGif: DrawGif['postGif'];
  pickedInTime: DrawGif['pickedInTime'];
  pickGifSafely: DrawGif['pickGifSafely'];
  recordOwnParticipation: Participation['recordOwnParticipation'];
};

type RenderArgs = Parameters<Sends['renderPost']>[1];

/** The parsed answer of the model, as the act reads it. */
type ActParsed = {
  reactions: ReadonlyArray<{ to: number; emoji: string }>;
  messages: ReadonlyArray<{ text: string; replyTo?: number | null }>;
  /** The turn's own `<gif>`, which the attempt resolved against the library (resolveGif) before the act. */
  gif: ResolvedGif | null | undefined;
};

/** A line of the history or of a pulled channel, as the act reads it. */
type ActLine = { id?: string; authorId?: string | null; authorName?: string | null };

/** The trigger of the turn, as the act reads it. */
type ActTrigger = { id?: string; authorId?: string | null } | null;

/** What an attempt's draft holds that the act reads and writes. */
type ActDraft = NonNullable<Parameters<JournalNotes['journalOp']>[0]> &
  NonNullable<Parameters<JournalNotes['noteLineSources']>[0]> & {
    snapshot?: Snapshot | null;
    ownPosts?: Array<string>;
    deliveredIn?: Set<string>;
    sendFailure?: { code: unknown; n: number; total: number; unknown?: true; hash?: string };
    gifFailure?: boolean;
    limits?: { add: (limit: { kind: string; where: string }) => void } | null;
    unseenFailed?: Array<{ kind: string; skill: string; status: string; code: string }>;
  };

/** A message of hers as the next history read will give it. */
type OwnLine = {
  id: string | null;
  ts: number;
  channelId: string;
  self: true;
  authorId: string;
  content: string;
  replyToId: string | null;
};

export type ActArgs = {
  channel: ConversationInfo;
  guildId: string;
  privateChat: boolean;
  parsed: ActParsed;
  idByIndex: ReadonlyMap<number, string>;
  history: Parameters<Participation['recordOwnParticipation']>[0]['history'] &
    Parameters<DrawGif['pickGifSafely']>[0]['history'];
  startedAt: number;
  mode: string;
  triggerKind: TriggerKind | null;
  plain: boolean;
  trigger: ActTrigger;
  selfName: string;
  pulledIds: ReadonlyMap<string, string>;
  lines: NonNullable<RenderArgs['lines']> & ReadonlyArray<ActLine>;
  knownNames: RenderArgs['knownNames'];
  directory?: RenderArgs['directory'];
  handles?: RenderArgs['handles'];
  channelHandles?: RenderArgs['channelHandles'];
  linkFor: (pulledId: string | null) => string | null;
  sourceId: string | null;
  gifPick?: boolean;
  participation?: { descriptions: unknown } | null;
  draft?: ActDraft | null;
};

/** One post that reached the chat, for the journal. */
type PostNote = { opId?: string; messageId: string; replyTo: string | null };

/** One reaction put, for the journal. */
type ReactNote = { opId?: string; to: string; emoji: string };

export type ActOutcome = {
  delivered: boolean;
  answered: Set<string>;
  messageIds: Array<string>;
  texts: Array<string>;
  lines: Array<OwnLine>;
  gifs: Array<string>;
  drew: false;
  posts: Array<PostNote>;
  reacted: Array<ReactNote>;
};

/** A diary set's picture as the turn staged it, with what its generation logged. */
type HeldPicture = EntryPicture & { text: string; seconds?: unknown; cost?: unknown; self?: unknown };

export type HoldArgs = Omit<RenderArgs, 'channel' | 'snapshot' | 'guildId' | 'privateChat' | 'link'> & {
  channel: ConversationInfo;
  guildId: string;
  privateChat: boolean;
  parsed: { messages: ReadonlyArray<{ text: string }> };
  set: { pictures: Array<HeldPicture> } | null;
  draft?: ActDraft | null;
};

export type HeldSpeech = {
  held: true;
  delivered: false;
  answered: Set<string>;
  texts: Array<string>;
  rendered: Array<{ text: string; userIds: Array<string | undefined> }>;
  staged: Array<HeldPicture>;
  posts: Array<PostNote>;
  reacted: Array<ReactNote>;
};

export type Act = {
  holdSpeech: (args: HoldArgs) => HeldSpeech;
  act: (args: ActArgs) => Promise<ActOutcome>;
};

// health: allow function-length until 2027-04-01 -- the act shares the runner state of src/behavior/turn.js, moved whole in stage 5b
export function createAct(ctx: ActContext): Act {
  const {
    hot,
    store,
    rng,
    clock,
    selfIdOf,
    ifaceReads,
    iface,
    conversationOf,
    messageOf,
    checkEffect,
    lastPostAt,
    noteTrigger,
    noteLineSources,
    recordSaid,
    journalOp,
    renderPost,
    postGif,
    pickedInTime,
    pickGifSafely,
    recordOwnParticipation,
  } = ctx;

  /**
   * A diary post's speech held where act would send it: her messages as written and as renderPost renders them (pings
   * off left out) and the staged pictures; the turn records the entry (diary-turn.ts#recordEntry), its mirrors post it.
   */
  function holdSpeech({ channel, guildId, privateChat, parsed, set, draft = null, ...routing }: HoldArgs): HeldSpeech {
    const options = { channel, snapshot: snapshotOfDraft(draft), guildId, privateChat, ...routing, link: null };
    const rendered = parsed.messages.map((message) => {
      const { text, userIds } = renderPost(message.text, options);
      return { text, userIds: userIds.filter((id) => !store.isPingsOff?.(guildId, id)) };
    });
    const texts = parsed.messages.map((message) => message.text);
    const staged = set?.pictures ?? [];
    for (const picture of staged) {
      const { seconds, cost, self, buffer } = picture;
      log.info('turn: drew', { channel: channel.id, seconds, cost, self, bytes: buffer?.length ?? 0, set: true });
    }
    const files = chunkPictures(staged, setSettings(hot.config.diary).maxMessageBytes, filesPerMessage(iface)).length;
    if (files > 0) log.info('turn: set posted', { channel: channel.id, pictures: staged.length, messages: files });
    return { held: true, delivered: false, answered: new Set(), texts, rendered, staged, posts: [], reacted: [] };
  }

  /**
   * Post the turn for real. Resolves `{ delivered, answered }` -- whether
   * anything reached the chat (a reaction put, a message, the GIF or the
   * picture posted; a limit notice is not the persona's answer), and the ids
   * of the pulled lines what reached it answered (a reaction put on one, a
   * message, the GIF or a diary set's pictures posted answering one: stampShownCalls).
   *
   * Everything is posted in `channel`. A reaction on a pulled line
   * (`pulledIds`) is put in that line's channel when the bot may react there,
   * else dropped (`turn: reaction dropped`); a message, the GIF or the picture
   * answering a pulled line posts plain, never as a platform reply across
   * channels, and each post carries the jump link `linkFor` gives it (a message
   * and the GIF through `labels.elsewhere.link`, read now; the picture as its
   * content). `@name` resolves over `lines`, then `knownNames`. A message longer than the interface
   * holds is split by its adapter, never cut here.
   *
   * A message whose send fails ends the posting: `turn: send failed`
   * (`channel`, `index` -- 0-based among the turn's messages --, `error`), no
   * later message, GIF or picture, and the turn resolves what reached the chat
   * before it. So does a message the skill gateway refuses (checkEffect, before
   * its typing and again right before its send; `skill: refused`); a refused
   * reaction or GIF is skipped alone. Every effect goes through the port
   * (`iface`): a send it answers `unknown` is journaled so and never sent again.
   *
   * The messages are posted as the model wrote them: nothing rewrites them.
   * A member with pings off (store.isPingsOff) is mentioned and replied to
   * without a notification: only allowedMentions changes, never the text.
   * After the reactions, the GIF picker (pickGif) runs alongside the first
   * message's typing imitation: both start together, the first message waits
   * for both, the picker at most `gifs.pick.graceMs` (read now; 0 by default,
   * `null` = as long as it takes) past the end of that typing: a picker still
   * out then is left behind for this turn (its answer is ignored; `gifs: pick
   * late` with `graceMs`, a `helper-timeout` limit on `gif-pick` in the turn's
   * journal) and the first message goes as written. Without that typing (the
   * imitation off, or the first message refused) it waits for the answer as
   * before. A GIF it picks is posted in place of the first message (that
   * text is not sent), replying where it would have,
   * and the other messages follow in order, each waited for and typed; a
   * picked GIF that fails to send (`turn: gif failed`) leaves every message to
   * be posted as written, so nothing is lost.
   *
   * `plain`: the turn quotes no chat line (postsPlain); `lines`: the lines shown of the
   * pulled channels, then `history` (a chat author wins a display name both share);
   * `knownNames`: the stored names `@name` resolves by too (storedNames); `directory`: the
   * fallback behind them (mentionDirectory, a thunk); `handles`: the request's handle -> member
   * id map, in place of all three (renderPost);
   * `sourceId`: the channel the turn is about (its `source`), logged on every message sent;
   * with it a refused drawing's limit notice quotes nothing (the trigger of a routed turn
   * lives in that channel); `gifPick`: false keeps the GIF picker from replacing the first
   * message (a diary post); `participation` (`{ descriptions }`: the captions the turn had, or
   * null): each message sent in a server channel is recorded in the participation store
   * (recordOwnParticipation) with the lines of `history` before it.
   * Resolves `delivered`, `answered`, `messageIds` (the ids of the messages posted, in order), `texts` (the messages
   * posted, as the persona wrote them), `lines` (each message posted as a transcript line of hers: its id, time and
   * text as written), `gifs` (the handles of the GIFs posted) and `drew` (false: a picture goes out through its call).
   */
  // health: allow function-length until 2027-04-01 -- moved whole from src/behavior/turn.js in stage 5b, a pure move
  // health: allow complexity until 2027-04-01 -- moved whole from src/behavior/turn.js in stage 5b, a pure move
  async function act({
    channel,
    guildId,
    privateChat,
    parsed,
    idByIndex,
    history,
    startedAt,
    triggerKind,
    plain,
    trigger,
    selfName,
    pulledIds,
    lines,
    knownNames,
    directory = null,
    handles = null,
    channelHandles = null,
    linkFor,
    sourceId,
    gifPick = true,
    participation = null,
    draft = null,
  }: ActArgs): Promise<ActOutcome> {
    const cfg = hot.config.typing;
    const typingOn = hot.config.features?.typingSimulation !== false;
    // The typing imitation of one message: the indicator, then the time its text takes to type.
    // Typed only once the message it precedes passed its check (checkEffect).
    const typeFor = async (spoken: string): Promise<void> => {
      // Only the indicator: a missing Send Messages shows up here first, so it is logged.
      const typed = await iface.typing(conversationOf(channel));
      if (typed.status !== 'ok') log.warn('turn: typing failed', { channel: channel.id, error: portError(typed) });
      await sleep(typingMs(spoken, cfg, rng));
    };
    // Every effect's skill call names the turn's channel and its trigger's author.
    const effect = { channel, trigger };
    // Whether anything reached the chat (a routed turn's caller marks its call by it) and the pulled lines it answered.
    let delivered = false;
    const answered = new Set<string>();
    // For the journal: every post that reached the chat with the message it answers, every
    // reaction put with its target, each with the operation that made it (journalOp).
    const posts: Array<PostNote> = [];
    const reacted: Array<ReactNote> = [];
    const opField = (op: { opId?: string | null } | null): { opId?: string } => (op?.opId ? { opId: op.opId } : {});
    // Every post also remembers the message that started this turn (none on a turn without one).
    const notePost = (
      sent: { id?: string | null } | null | undefined,
      replyTo: string | null = null,
      op: { opId?: string | null } | null = null
    ): void => {
      if (typeof sent?.id === 'string' && sent.id) {
        posts.push({ ...opField(op), messageId: sent.id, replyTo: replyTo ?? null });
        noteTrigger(sent.id, trigger?.id);
        if (draft) {
          (draft.ownPosts ??= []).push(sent.id);
          (draft.deliveredIn ??= new Set()).add(String(channel.id));
        }
      }
    };

    for (const reaction of parsed.reactions) {
      const targetId = idByIndex.get(reaction.to);
      if (!targetId) continue;
      const route = await reactionChannel(ifaceReads, channel, targetId, pulledIds);
      if (!route.target) {
        log.info('turn: reaction dropped', { channel: channel.id, source: route.source, reason: route.reason });
        continue;
      }
      if (typingOn) await sleep(between(cfg.reactionDelayMs, rng));
      // A reaction on a pulled line is checked as one of this turn's carried-over tags: she saw
      // that line in this turn's request.
      if (!checkEffect('message.react.add', { messageId: targetId, emoji: reaction.emoji }, effect).ok) continue;
      const op = journalOp(draft, 'react', 'persona', {
        input: { to: targetId, emoji: reaction.emoji },
        sourceMessageIds: [targetId],
      });
      if (op.opId) await op.started();
      const result = await iface.react(messageOf(route.target, targetId), reaction.emoji);
      if (result.status === 'ok') {
        delivered = true;
        reacted.push({ ...opField(op), to: targetId, emoji: reaction.emoji });
        if (route.source) answered.add(targetId);
        if (op.opId) await op.succeeded({ to: targetId, emoji: reaction.emoji });
      } else {
        if (op.opId) await closeResult(op, result);
        log.warn('turn: reaction failed', {
          channel: channel.id,
          ...(route.source ? { source: route.source } : {}),
          emoji: reaction.emoji,
          error: portError(result),
        });
      }
    }

    // Each posted message as the next history read will give it (its own id and time, her text as written).
    const ownPosted: Array<OwnLine> = [];
    // The texts posted, as the persona wrote them, and the handles of the GIFs posted.
    const postedTexts: Array<string> = [];
    const postedGifs: Array<string> = [];
    let sendFailed = false;
    // The GIF picker starts first (its request is sent at once), then the first message's typing.
    // `pickDone` once it answered (null included): an answer already there needs no grace timer.
    let pickDone = false;
    const picking = (
      gifPick
        ? pickGifSafely({
            channelId: channel.id,
            guildId,
            messages: parsed.messages,
            gif: parsed.gif,
            history,
            selfName,
            idByIndex,
            trigger,
          })
        : Promise.resolve(null)
    ).then((value) => {
      pickDone = true;
      return value;
    });
    // The first message's typing waits for its check, made on its text before any jump link
    // (linkFor is asked once, when it is sent; no cut is told to the limits here). A refusal is
    // not checked again below: that message ends the posting.
    let firstRefused = false;
    let firstTyped = false;
    if (typingOn && parsed.messages.length > 0) {
      const head = parsed.messages[0];
      const { replyId } = replyTarget(head.replyTo, { plain, idByIndex, pulledIds });
      const { spoken: first, text: firstText } = renderPost(head.text, {
        channel,
        snapshot: snapshotOfDraft(draft),
        guildId,
        privateChat,
        idByIndex,
        pulledIds,
        lines,
        knownNames,
        directory,
        handles,
        channelHandles,
        quiet: true,
      });
      firstRefused = !checkEffect('message.create', sendArgs({ text: firstText, replyId }), effect).ok;
      if (!firstRefused) {
        await typeFor(first);
        firstTyped = true;
      }
    }
    // Once that typing is over, a picker still out gets `gifs.pick.graceMs` more at most (pickedInTime).
    const picked =
      gifPick && firstTyped && !pickDone
        ? await pickedInTime(picking, { channelId: channel.id, draft })
        : await picking;
    // One GIF post (the turn's own or the picked one), recorded like a message.
    const sendGif = async (gif: ResolvedGif): Promise<ReturnType<typeof postedOf> | null> => {
      const { replyId, pulledId } = replyTarget(gif.replyTo, { plain, idByIndex, pulledIds });
      const openOp = (): JournalOp | Readonly<JournalOp> =>
        journalOp(draft, 'gif', 'persona', {
          input: { gif: gif.entry?.id ?? null },
          sourceMessageIds: replyId ? [replyId] : [],
        });
      const sent = await postGif(channel, guildId, gif, replyId, linkFor(pulledId), { openOp, trigger });
      if (sent) {
        delivered = true;
        if (pulledId) answered.add(pulledId);
        notePost(sent.message, replyId, sent.op);
        if (gif.entry?.id) postedGifs.push(gif.entry.id);
      }
      return sent?.message ?? null;
    };
    // A picked GIF is posted in place of the first message (typed above); the rest follow as written.
    // When it fails to send (`turn: gif failed`), the first message goes as written after all.
    const replaced = picked ? Boolean(await sendGif(picked)) : false;
    const messages = replaced ? parsed.messages.slice(1) : parsed.messages;
    const gif = picked ? null : parsed.gif;
    // Every message but the first one as written waits and is typed here; that one was typed alongside the picker.
    const typedAbove = (index: number): boolean => index === 0 && !replaced;
    // Members who turned the persona's notifications off (`/nep pings off`), read from the store at
    // each send: their `<@id>` stays in the text but notifies nobody, and a reply to their line
    // does not ping them (server channels only).
    const pingsOff = (userId: string | null | undefined): boolean =>
      !privateChat && Boolean(userId) && typeof store.isPingsOff === 'function' && store.isPingsOff(guildId, userId);
    // A message that did not go out ends the posting; the turn then ends `partial` with a `sendFailed` fact (its code, how many of how many went out).
    // A send whose answer never came (`unknown`: a timeout, a network error) may have gone out: it keeps the hash of its text, and her next turn here looks for it before telling.
    const failSend = (code: unknown, { unknown = false, text: sentText = '' } = {}): void => {
      sendFailed = true;
      if (draft)
        draft.sendFailure = {
          code,
          n: ownPosted.length,
          total: messages.length,
          ...(unknown ? { unknown: true as const, hash: sendHash(sentText) } : {}),
        };
    };
    for (const [index, message] of messages.entries()) {
      if (!typedAbove(index) && typingOn) await sleep(between(cfg.betweenMessagesMs, rng));

      const { replyId, pulledId } = replyTarget(message.replyTo, { plain, idByIndex, pulledIds });
      const link = linkFor(pulledId);
      const repliedAuthorId = replyId
        ? (lines.find((line) => line.id === replyId)?.authorId ?? (trigger?.id === replyId ? trigger.authorId : null))
        : null;
      // Links on the text sent; the typing time stays on the text before them.
      const { text, spoken, userIds } = renderPost(message.text, {
        channel,
        snapshot: snapshotOfDraft(draft),
        guildId,
        privateChat,
        idByIndex,
        pulledIds,
        lines,
        knownNames,
        directory,
        handles,
        channelHandles,
        link,
      });
      const args = sendArgs({ text, replyId });
      // A first message refused before its typing above ends the posting (already logged).
      if (typedAbove(index) && firstRefused) {
        failSend(CODE.REFUSED);
        break;
      }
      // The first message was typed alongside the GIF picker, above; any other is checked before its typing.
      if (typingOn && !typedAbove(index)) {
        if (!checkEffect('message.create', args, effect).ok) {
          failSend(CODE.REFUSED);
          break;
        }
        await typeFor(spoken);
      }
      // Checked (again) right before the send: the owner's switch may have moved while she typed.
      if (!checkEffect('message.create', args, effect).ok) {
        failSend(CODE.REFUSED);
        break;
      }

      // The journal: the post's operation, with what the reconciliation after a restart looks for.
      const op = journalOp(draft, 'post', 'persona', {
        intent: { replyTo: replyId, text },
        participants: repliedAuthorId ? [repliedAuthorId] : [],
        sourceMessageIds: replyId ? [replyId] : [],
      });
      if (op.opId) await op.started();
      const result = await iface.send(conversationOf(channel), {
        text,
        ...(replyId ? { replyTo: messageOf(channel, replyId) } : {}),
        mentions: { users: userIds.filter((id) => !pingsOff(id)), repliedUser: !pingsOff(repliedAuthorId) },
      });
      if (result.status !== 'ok') {
        if (op.opId) await closeResult(op, result);
        log.warn('turn: send failed', {
          channel: channel.id,
          index: replaced ? index + 1 : index,
          error: portError(result),
        });
        failSend(
          typeof result.code === 'string' && result.code ? result.code : (result.error?.code ?? CODE.SEND_FAILED),
          { unknown: result.status === 'unknown', text }
        );
        break;
      }
      const posted = postedOf(result);
      if (op.opId) await op.succeeded({ messageId: posted.id });
      recordSaid({
        guildId,
        channel,
        privateChat,
        trigger,
        draft,
        op,
        posted,
        text: message.text,
        replyId,
        repliedAuthorId,
        userIds,
      });
      noteLineSources(draft, posted?.id, message.text);
      delivered = true;
      if (pulledId) answered.add(pulledId);
      lastPostAt.set(channel.id, clock());
      notePost(posted, replyId, op);
      postedTexts.push(message.text);
      const ownLine: OwnLine = {
        id: posted?.id ?? null,
        // Number.isFinite is true only for a number.
        ts: Number.isFinite(posted?.createdTimestamp) ? (posted.createdTimestamp as number) : clock(),
        channelId: channel.id,
        self: true,
        authorId: selfIdOf(),
        content: message.text,
        replyToId: replyId,
      };
      // The persona's own exchange on this channel, kept for her turns elsewhere (a server channel only).
      if (participation && !privateChat) {
        recordOwnParticipation({
          channel,
          guildId,
          history,
          earlier: ownPosted,
          own: ownLine,
          replyId,
          selfName,
          descriptions: participation.descriptions,
        });
      }
      ownPosted.push(ownLine);
      log.info('turn: sent', {
        channel: channel.id,
        chars: text.length,
        secondsSinceTrigger: Math.round((clock() - startedAt) / 100) / 10,
        ...(triggerKind === 'followUp' ? { followUp: true } : {}),
        ...(triggerKind === 'overheard' ? { overheard: true } : {}),
        ...(sourceId ? { source: sourceId } : {}),
        ...(link ? { link: true } : {}),
      });
    }
    const messageIds = ownPosted
      .map((line) => line.id)
      .filter((id): id is string => typeof id === 'string' && Boolean(id));
    const posted = {
      messageIds,
      texts: postedTexts,
      lines: ownPosted,
      gifs: postedGifs,
      drew: false as const,
      posts,
      reacted,
    };
    if (sendFailed) return { delivered, answered, ...posted };

    // The turn's own GIF right after the messages. One that did not go out is a call that failed with nobody
    // to read it: a fact for her next request here, and the turn ends partial (the text, if any, was said).
    if (gif) {
      if (messages.length > 0 && typingOn) await sleep(between(cfg.betweenMessagesMs, rng));
      const sentGif = await sendGif(gif);
      if (!sentGif && draft) {
        draft.gifFailure = true;
        (draft.unseenFailed ??= []).push({
          kind: 'callFailed',
          skill: 'message.create',
          status: messages.length > 0 ? 'partial' : 'failed',
          code: CODE.GIF_FAILED,
        });
      }
    }

    return { delivered, answered, ...posted };
  }

  return { holdSpeech, act };
}
