// The private chat: a direct message checked locally with zero tokens (the switch, other bots, the served guild,
// membership, a stored profile and the public attitude), dropped silently when refused, observed like a direct call
// and answered in its own turn; the same gate for a queued direct message and for a recovery turn in a DM. createMessageHandler (src/behavior/pipeline.ts) builds it once with
// createPrivateGate; the live path, the drain of the pending queue and the replay of a held chat call it.

import type { ObserveLine } from './observe.ts';
import { lineOf } from '../behavior/line-of.ts';
import { isLimitNotice } from '../behavior/limits.ts';
import { CLI_GATE, CLI_IFACE, privateChatsOff } from '../behavior/core-pause.ts';
import { privateGate } from '../behavior/private.ts';
import type { Reads } from '../interface/reads.ts';
import { log } from '../log.ts';
import type { ConversationInfo, ConversationRef } from '../protocol/adapter.ts';
import { isOwnerId } from '../tools/impl/grants.ts';
import type { TurnParams } from '../turn/outcome.ts';
import type { MessageReadOptions } from './types.ts';
import type { MessageEvent } from './edits.ts';

/** A normalized line (src/behavior/line-of.ts#lineOf), as the private chat reads it. */
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

/** The private-chat gate's verdict for one author. */
export type GateCheck = { gate: { ok: boolean; reason?: string }; isOwner: boolean };

/** The live config, as far as the private chat reads it (privateGate reads the rest). */
type PrivateConfig = { readonly private?: { readonly enabled?: unknown } } & object;

/** What createPrivateGate reads: the dependencies of createMessageHandler and the functions of its other parts. */
export type PrivateContext = {
  hot: { readonly config: PrivateConfig; readonly prompts?: { readonly labels?: object } | null };
  store: { getUser: (guildId: string, userId: string) => object | null };
  reads: Reads;
  now: () => number;
  getGuildId: () => string | null;
  selfIdOf: () => string;
  activity: { note: (channelId: string, authorId: string, at: number) => void } | null;
  turns: {
    notePost: (channelId: string, ts: number) => void;
    runTurn: (params: TurnParams) => Promise<TurnResultOf>;
  };
  memory: { observe: (guildId: string, line: object, options: object) => void };
  missed: { setPrivateRecovery?: (recovery: object) => void } | null;
  refOf: (channel: ConversationInfo) => ConversationRef;
  infoNow: (iface: string, conversationId: string) => Promise<ConversationInfo | null>;
  observeLine: ObserveLine;
  turnBlocked: (channelId: string, config: object) => boolean;
  holdCall: (
    channel: ConversationInfo,
    trigger: PrivateLine,
    kind: string,
    destination?: ConversationInfo | null,
    superseded?: Array<string>,
    options?: MessageReadOptions
  ) => void;
  queuedFor: (channelId: string, trigger: PrivateLine) => unknown;
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
  dropPrivate: (check: GateCheck) => void;
  onPrivateMessage: (event: MessageEvent, config: PrivateConfig, options?: MessageReadOptions) => Promise<void>;
};

export function createPrivateGate({
  hot,
  store,
  reads,
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
  announceRefusal,
}: PrivateContext): PrivateGate {
  /** After a private turn: a refusal is announced. */
  async function afterPrivateTurn(
    channel: ConversationInfo,
    _guildId: string,
    trigger: PrivateLine,
    result: TurnResultOf
  ): Promise<void> {
    await announceRefusal(channel, trigger, result, 'private');
  }

  /**
   * The private-chat gate for one DM author (src/behavior/private.ts#privateGate),
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
    const input = { config, profile, isOwner };

    const free = privateGate({ ...input, isMember: true });
    if (!free.ok) return { gate: free, isOwner };
    const found = await reads.memberInfo({ communityId: guildId, memberId: String(authorId) });
    const isMember = found?.member != null;
    return { gate: privateGate({ ...input, isMember }), isOwner };
  }

  // A recovery turn of the missed-answer registry in a DM passes the same gate.
  missed?.setPrivateRecovery?.({
    allow: async (_channel: ConversationInfo, trigger: PrivateLine) => {
      const guildId = getGuildId();
      if (!guildId || hot.config.private?.enabled !== true) return false;
      return (await checkPrivateGate(hot.config, guildId, trigger.authorId)).gate.ok === true;
    },
    after: async (channel: ConversationInfo, trigger: PrivateLine, result: TurnResultOf) => {
      const guildId = getGuildId();
      if (guildId) await afterPrivateTurn(channel, guildId, trigger, result);
    },
  });

  /** A DM the gate refused: dropped silently, the reason logged. */
  function dropPrivate({ gate }: GateCheck): void {
    log.info('private: dropped', { reason: gate.reason });
  }

  /**
   * A direct message (private chat). Checked locally with zero tokens: the
   * switch, other bots, the served guild, membership, a stored profile and the
   * public attitude (privateGate). A refused DM is dropped silently. No
   * follow-up window or address classifier here.
   */
  async function onPrivateMessage(
    event: MessageEvent,
    config: PrivateConfig,
    options?: MessageReadOptions
  ): Promise<void> {
    const author = event.message.author;
    if (privateChatsOff(config, event)) return;
    const selfId = selfIdOf();
    if (author.bot && author.id !== selfId) return;
    // When the partner last wrote here (pace.settleMs); the persona's own messages never count.
    if (author.id !== selfId) activity?.note(event.conversation.id, author.id, event.message.at);

    const guildId = getGuildId();
    if (!guildId) return;
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
      memory.observe(guildId, normalized, { private: partnerId });
      const observing = observeLine(
        event,
        false,
        { guildId, privateUserId: String(partnerId) },
        options?.acceptedEvent
      );
      if (observing) await observing;
      return;
    }

    const authorId = author.id;
    const channel = await infoNow(event.iface, event.conversation.id);
    if (!channel) return;
    const check = await checkPrivateGate(config, guildId, authorId, event.iface);
    if (!check.gate.ok) {
      dropPrivate(check);
      return;
    }

    // Observed like a direct call.
    memory.observe(guildId, normalized, { direct: true, private: authorId });
    // A DM without a named partner is deliberately unobserved by the message mapper.
    const observing =
      event.conversation.partnerId != null
        ? observeLine(event, true, { guildId, privateUserId: String(authorId) }, options?.acceptedEvent)
        : null;
    if (observing) await observing;

    // One turn at a time: busy anywhere (or, with oneAtATime off, in this very
    // chat) -> pending, answered by drainPending once the turn frees up.
    if (turnBlocked(channel.id, config)) {
      holdCall(channel, normalized, 'private', null, [], options);
      return;
    }

    turns
      .runTurn({
        conversation: refOf(channel),
        guildId,
        mode: 'reply',
        trigger: normalized,
        triggerKind: 'private',
        memoryContext: options?.memoryContext,
        queued: queuedFor(channel.id, normalized),
      })
      .then((result) => afterPrivateTurn(channel, guildId, normalized, result))
      .catch((err: unknown) => log.error('private: turn failed', { channel: channel.id, error: err }));
  }

  return { afterPrivateTurn, checkPrivateGate, dropPrivate, onPrivateMessage };
}
