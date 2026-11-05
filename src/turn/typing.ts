// The typing indicator of a turn: a lease on a channel, shown while a direct call's tool loop runs. createTurnRunner
// (src/behavior/turn.ts) builds it once per runner with createTyping; the tool loop starts and stops the lease.

import { startTypingLease } from '../interface/typing.ts';
import { log } from '../log.ts';
import type { ConversationRef } from '../protocol/adapter.ts';
import { portError } from './journal.ts';
import type { PortResult } from './journal.ts';
import { PREPARE_TYPING_REFRESH_MS } from './timers.ts';
import { DIRECT_CALLS } from './triggers.ts';
import type { TriggerKind } from './triggers.ts';

/** A channel the indicator shows in: its id and whether the persona may send there. */
type TypingChannel = { id: string; permissions?: { send?: boolean } | null };

/** What createTyping reads: the port, the clock and the runner's conversation reference. */
export type TypingContext = {
  iface: { typing: (conversation: ConversationRef) => Promise<PortResult> | PortResult };
  schedule: (run: () => void, ms: number) => (() => void) | null | undefined;
  clock: () => number;
  conversationOf: (channel: TypingChannel) => ConversationRef;
};

export type Typing = {
  typingWhileCalls: (
    channel: TypingChannel,
    triggerKind: TriggerKind | null | undefined,
    draft: { inner?: unknown; selfreflection?: unknown }
  ) => () => void;
};

export function createTyping({ iface, schedule, clock, conversationOf }: TypingContext): Typing {
  /**
   * A typing lease on `channel` (src/interface/typing.ts): refreshed until stopped, and lapsing on its own if nobody
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
   * an inner or a selfreflection turn, where the bot can send. Answers the function that stops the lease, `() => {}` when it
   * does not show.
   */
  function typingWhileCalls(
    channel: TypingChannel,
    triggerKind: TriggerKind | null | undefined,
    draft: { inner?: unknown; selfreflection?: unknown }
  ): () => void {
    const off = (): void => {};
    if (!DIRECT_CALLS.has(triggerKind) || draft.inner || draft.selfreflection) return off;
    const sendable = channel.permissions?.send === true;
    return sendable ? startChannelTyping(channel, false) : off;
  }

  return { typingWhileCalls };
}
