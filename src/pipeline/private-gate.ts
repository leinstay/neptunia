// The private chat: a direct message checked locally with zero tokens (the switch, other bots, the served guild,
// membership, a stored profile, the public attitude and today's reply cap), dropped silently when refused but for the
// daily-cap notice, observed like a direct call and answered in its own turn; the same gate and count for a queued
// direct message and for a recovery turn in a DM. createMessageHandler (src/behavior/pipeline.js) builds it once with
// createPrivateGate; the live path, the drain of the pending queue and the replay of a held chat call it.

import { lineOf } from '../behavior/line-of.js';
import { isLimitNotice } from '../behavior/limits.js';
import { CLI_GATE, CLI_IFACE, privateChatsOff } from '../behavior/core-pause.ts';
import { privateGate } from '../behavior/private.js';
import type { Reads } from '../interface/reads.ts';
import { log } from '../log.js';
import type { ConversationInfo, ConversationRef } from '../protocol/adapter.ts';
import { isOwnerId } from '../tools/impl/grants.ts';
import { utcDay } from '../time.js';
import type { MessageEvent, Observed } from './edits.ts';

/** A normalized line (src/behavior/line-of.js#lineOf), as the private chat reads it. */
export type PrivateLine = {
  readonly id: string;
  readonly channelId: string;
  readonly authorId: string;
  readonly ts: number;
  readonly content?: string;
  readonly self?: boolean;
};

/** A turn's result as the private chat reads it (src/turn/outcome.ts). */
type TurnResultOf = { outcome?: string; limit?: object | null } | undefined;

/** The private-chat gate's verdict for one author, with what the cap notice needs. */
export type GateCheck = {
  gate: { ok: boolean; reason?: string; cap?: number; used?: number };
  isOwner: boolean;
  replies: { day?: string; count?: number; noticedDay?: string } | null;
  today: string;
};

/** The live config, as far as the private chat reads it (privateGate reads the rest). */
type PrivateConfig = { readonly features?: { readonly memory?: unknown; readonly privateMessages?: unknown } } & object;

/** What createPrivateGate reads: the dependencies of createMessageHandler and the functions of its other parts. */
export type PrivateContext = {
  hot: { readonly config: PrivateConfig; readonly prompts?: { readonly labels?: object } | null };
  store: {
    bumpPrivateReplies: (guildId: string, userId: string, day: string) => void;
    getUser: (guildId: string, userId: string) => object | null;
    getPrivate: (guildId: string, userId: string) => { replies?: GateCheck['replies'] } | null;
    markPrivateNoticed: (guildId: string, userId: string, day: string) => void;
  };
  reads: Reads;
  now: () => number;
  getGuildId: () => string | null;
  selfIdOf: () => string;
  activity: { note: (channelId: string, authorId: string, at: number) => void } | null;
  turns: {
    notePost: (channelId: string, ts: number) => void;
    runTurn: (params: object) => Promise<TurnResultOf>;
  };
  memory: { observe: (guildId: string, line: object, options: object) => void };
  missed: { setPrivateRecovery?: (recovery: object) => void } | null;
  refOf: (channel: ConversationInfo) => ConversationRef;
  infoNow: (iface: string, conversationId: string) => Promise<ConversationInfo | null>;
  observeLine: (
    event: MessageEvent,
    direct?: boolean,
    where?: { guildId: string; privateUserId?: string } | null
  ) => Promise<Observed> | null;
  turnBlocked: (channelId: string, config: object) => boolean;
  holdCall: (channel: ConversationInfo, trigger: PrivateLine, kind: string) => void;
  queuedFor: (channelId: string, trigger: PrivateLine) => unknown;
  notifyLimit: (
    channel: ConversationInfo,
    trigger: PrivateLine,
    limit: { key: string; used?: number; cap?: number },
    triggerKind: string
  ) => Promise<void>;
  announceRefusal: (
    channel: ConversationInfo,
    trigger: PrivateLine,
    result: TurnResultOf,
    triggerKind: string
  ) => Promise<void>;
};

export type PrivateGate = {
  afterPrivateTurn: (
    channel: ConversationInfo,
    guildId: string,
    trigger: PrivateLine,
    result: TurnResultOf
  ) => Promise<void>;
  checkPrivateGate: (config: PrivateConfig, guildId: string, authorId: string, iface?: string) => Promise<GateCheck>;
  dropPrivate: (
    channel: ConversationInfo,
    guildId: string,
    authorId: string,
    trigger: PrivateLine,
    check: GateCheck
  ) => Promise<void>;
  onPrivateMessage: (event: MessageEvent, config: PrivateConfig) => Promise<void>;
};

export function createPrivateGate({
  hot,
  store,
  reads,
  now,
  getGuildId,
  selfIdOf,
  activity,
  turns,
  memory,
  missed,
  refOf,
  infoNow,
  observeLine,
  turnBlocked,
  holdCall,
  queuedFor,
  notifyLimit,
  announceRefusal,
}: PrivateContext): PrivateGate {
  /**
   * After a private turn: every turn that reached the model (it spoke, or it
   * chose to stay silent -- `skip`) counts toward today's cap; a refusal is
   * announced. A refused, busy, paused, error or not-now turn is not counted.
   */
  async function afterPrivateTurn(
    channel: ConversationInfo,
    guildId: string,
    trigger: PrivateLine,
    result: TurnResultOf
  ): Promise<void> {
    if (result?.outcome === 'spoke' || result?.outcome === 'skip') {
      store.bumpPrivateReplies(guildId, trigger.authorId, utcDay(now()));
    }
    await announceRefusal(channel, trigger, result, 'private');
  }

  /**
   * The private-chat gate for one DM author (src/behavior/private.js#privateGate),
   * shared by a live DM and a queued one at drain time. The free checks (a
   * stored profile, the owner flag, the attitude threshold) run before any
   * read: `memberInfo` is only asked when those checks would let the author through. The owner's command line passes.
   */
  async function checkPrivateGate(
    config: PrivateConfig,
    guildId: string,
    authorId: string,
    iface: string = ''
  ): Promise<GateCheck> {
    if (iface === CLI_IFACE) return CLI_GATE;
    const profile = store.getUser(guildId, authorId);
    const isOwner = isOwnerId(config, authorId);
    const replies = store.getPrivate(guildId, authorId)?.replies ?? null;
    const today = utcDay(now());
    const input = { config, profile, isOwner, replies, today };

    const free = privateGate({ ...input, isMember: true });
    if (!free.ok && free.reason !== 'cap') return { gate: free, isOwner, replies, today };
    const found = await reads.memberInfo({ communityId: guildId, memberId: String(authorId) });
    const isMember = found?.member != null;
    return { gate: privateGate({ ...input, isMember }), isOwner, replies, today };
  }

  // A recovery turn of the missed-answer registry in a DM passes the same gate, and counts toward the same cap.
  missed?.setPrivateRecovery?.({
    allow: async (_channel: ConversationInfo, trigger: PrivateLine) => {
      const guildId = getGuildId();
      if (!guildId || hot.config.features?.privateMessages !== true) return false;
      return (await checkPrivateGate(hot.config, guildId, trigger.authorId)).gate.ok === true;
    },
    after: async (channel: ConversationInfo, trigger: PrivateLine, result: TurnResultOf) => {
      const guildId = getGuildId();
      if (guildId) await afterPrivateTurn(channel, guildId, trigger, result);
    },
  });

  /**
   * A DM the gate refused: dropped silently (the reason is logged), except
   * the daily-cap notice, posted at most once a day per person.
   */
  async function dropPrivate(
    channel: ConversationInfo,
    guildId: string,
    authorId: string,
    trigger: PrivateLine,
    { gate, isOwner, replies, today }: GateCheck
  ): Promise<void> {
    log.info('private: dropped', { reason: gate.reason });
    if (gate.reason === 'cap' && replies?.noticedDay !== today) {
      store.markPrivateNoticed(guildId, authorId, today);
      const key = isOwner ? 'private.maxPerOwnerPerDay' : 'private.maxPerUserPerDay';
      await notifyLimit(channel, trigger, { key, used: gate.used, cap: gate.cap }, 'private');
    }
  }

  /**
   * A direct message (private chat). Checked locally with zero tokens: the
   * switch, other bots, the served guild, membership, a stored profile, the
   * public attitude and today's reply cap (privateGate). A refused DM is
   * dropped silently, except the daily-cap notice once a day per person. No
   * ignore roll, follow-up window, eavesdrop or address classifier here.
   */
  async function onPrivateMessage(event: MessageEvent, config: PrivateConfig): Promise<void> {
    const author = event.message.author;
    const features = config.features ?? {};
    if (privateChatsOff(features, event)) return;
    const selfId = selfIdOf();
    if (author.bot && author.id !== selfId) return;
    // When the partner last wrote here (pace.settleMs); the persona's own messages never count.
    if (author.id !== selfId) activity?.note(event.conversation.id, author.id, event.message.at);

    const guildId = getGuildId();
    if (!guildId) return;
    const memoryOn = features.memory !== false;
    // lineOf gives the normalized line of a message event.
    const normalized = lineOf(event) as PrivateLine;

    // The persona's own DM message: bookkeeping, remembered under the
    // partner's id. Without a usable partner id, or for a limit notice (not
    // the persona's speech), only the post is noted.
    if (normalized.self) {
      turns.notePost(normalized.channelId, normalized.ts);
      // The partner of the private chat, as the event's conversation names it.
      const partnerId = event.conversation?.partnerId ?? null;
      if (!partnerId || String(partnerId) === String(selfId)) return;
      // isLimitNotice reads the labels it is given, a missing labels file as none.
      if (isLimitNotice(hot.prompts?.labels as object, normalized.content)) return;
      if (memoryOn) {
        memory.observe(guildId, normalized, { private: partnerId });
        const observing = observeLine(event, false, { guildId, privateUserId: String(partnerId) });
        if (observing) await observing;
      }
      return;
    }

    const authorId = author.id;
    const channel = await infoNow(event.iface, event.conversation.id);
    if (!channel) return;
    const check = await checkPrivateGate(config, guildId, authorId, event.iface);
    if (!check.gate.ok) {
      await dropPrivate(channel, guildId, authorId, normalized, check);
      return;
    }

    // Observed like a direct call.
    if (memoryOn) {
      memory.observe(guildId, normalized, { direct: true, private: authorId });
      const observing = observeLine(event, true, { guildId, privateUserId: String(authorId) });
      if (observing) await observing;
    }

    // One turn at a time: busy anywhere (or, with oneAtATime off, in this very
    // chat) -> pending, answered by drainPending once the turn frees up.
    if (turnBlocked(channel.id, config)) {
      holdCall(channel, normalized, 'private');
      return;
    }

    turns
      .runTurn({
        conversation: refOf(channel),
        guildId,
        mode: 'reply',
        trigger: normalized,
        triggerKind: 'private',
        queued: queuedFor(channel.id, normalized),
      })
      .then((result) => afterPrivateTurn(channel, guildId, normalized, result))
      .catch((err: unknown) => log.error('private: turn failed', { channel: channel.id, error: err }));
  }

  return { afterPrivateTurn, checkPrivateGate, dropPrivate, onPrivateMessage };
}
