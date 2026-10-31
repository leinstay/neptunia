// The typing indicator of a turn: a lease on a channel, shown while a direct call's tool loop runs and, with
// pace.typingWhilePreparing, while the turn prepares and waits for its answer. createTurnRunner (src/behavior/turn.js)
// builds it once per runner with createTyping; the tool loop and the attempt start and stop the leases.

import { startTypingLease } from '../interface/typing.js';
import { log } from '../log.js';
import type { ConversationRef } from '../protocol/adapter.ts';
import { skillsOn } from '../tools/access.ts';
import { portError } from './journal.ts';
import type { PortResult } from './journal.ts';
import { paceSettings } from './settings.ts';
import { PREPARE_TYPING_REFRESH_MS } from './timers.ts';
import { DIRECT_CALLS } from './triggers.ts';
import type { TriggerKind } from './triggers.ts';

/** The live config, as far as the typing indicator reads it. */
export type TypingConfig = { features?: { typingSimulation?: unknown; dryRun?: unknown } | null };

/** A channel the indicator shows in: its id and whether the persona may send there. */
type TypingChannel = { id: string; permissions?: { send?: boolean } | null };

/** What createTyping reads: the live config, the port, the clock and the runner's conversation reference. */
export type TypingContext = {
  hot: { readonly config: TypingConfig };
  iface: { typing: (conversation: ConversationRef) => Promise<PortResult> | PortResult };
  schedule: (run: () => void, ms: number) => (() => void) | null | undefined;
  clock: () => number;
  conversationOf: (channel: TypingChannel) => ConversationRef;
};

export type Typing = {
  typingWhileCalls: (
    channel: TypingChannel,
    triggerKind: TriggerKind | null | undefined,
    draft: { inner?: unknown; diary?: unknown }
  ) => () => void;
  typingWhilePreparing: (
    channel: TypingChannel,
    triggerKind: TriggerKind | null | undefined,
    config: TypingConfig
  ) => () => void;
};

export function createTyping({ hot, iface, schedule, clock, conversationOf }: TypingContext): Typing {
  /**
   * A typing lease on `channel` (src/interface/typing.js): refreshed until stopped, and lapsing on its own if nobody
   * stops it. Sent through the port; one that does not answer `ok` logs `turn: typing failed`. `preparing` tells the
   * log which wait it covers (the preparation, or the tool loop's calls). Answers the function that stops the lease.
   */
  function startChannelTyping(channel: TypingChannel, preparing: boolean): () => void {
    const send = (): Promise<void> =>
      Promise.resolve()
        .then(() => iface.typing(conversationOf(channel)))
        .then((result) => {
          if (result?.status !== 'ok')
            log.warn('turn: typing failed', { channel: channel.id, preparing, error: portError(result) });
        })
        .catch((err: unknown) => log.warn('turn: typing failed', { channel: channel.id, preparing, error: err }));
    return startTypingLease({
      send,
      schedule,
      refreshMs: PREPARE_TYPING_REFRESH_MS,
      now: clock,
      onExpire: () => log.info('turn: typing lease expired', { channel: channel.id }),
    });
  }

  /**
   * The typing indicator while a direct call's tool loop runs: from the first step that has calls until the turn's
   * last speech is posted or the turn ends (runSteps stops it). Only for a turn someone waits for (DIRECT_CALLS), never
   * an inner or a diary turn, with features.typingSimulation on, where the bot can send, in no dry run, with skills on.
   * Not gated by pace.typingWhilePreparing (that one is the preparation's). Answers the function that stops the lease,
   * `() => {}` when it does not show.
   */
  function typingWhileCalls(
    channel: TypingChannel,
    triggerKind: TriggerKind | null | undefined,
    draft: { inner?: unknown; diary?: unknown }
  ): () => void {
    const off = (): void => {};
    if (!DIRECT_CALLS.has(triggerKind) || draft.inner || draft.diary) return off;
    const config = hot.config;
    if (config.features?.typingSimulation === false || config.features?.dryRun === true || !skillsOn(config))
      return off;
    const sendable = channel.permissions?.send === true;
    return sendable ? startChannelTyping(channel, false) : off;
  }

  /**
   * The typing indicator while a turn prepares and waits for its answer:
   * sent once now and again every few seconds until the returned function
   * stops it (the answer is in hand, the turn is dropped or failed). Only for a turn
   * answering a direct call (DIRECT_CALLS: no unprompted turn, no overheard
   * line), with features.typingSimulation and pace.typingWhilePreparing on
   * (`config`, the turn's live config), never in a dry run (read now), never
   * where the bot cannot send, never with features.tools off (read now: she
   * is silent). Sent through the port; one that does not answer `ok` logs
   * `turn: typing failed` and changes nothing else. Answers the function that stops the indicator's refresh.
   */
  function typingWhilePreparing(
    channel: TypingChannel,
    triggerKind: TriggerKind | null | undefined,
    config: TypingConfig
  ): () => void {
    const off = (): void => {};
    if (!DIRECT_CALLS.has(triggerKind) || config.features?.typingSimulation === false) return off;
    if (!paceSettings(config).typingWhilePreparing || hot.config.features?.dryRun === true || !skillsOn(hot.config))
      return off;
    const sendable = channel.permissions?.send === true;
    if (!sendable) return off;
    return startChannelTyping(channel, true);
  }

  return { typingWhileCalls, typingWhilePreparing };
}
