// The turn someone asks her for in a channel (`message.create` without a message to answer, her own call or the
// owner's command): she reads the channel and joins the conversation or starts a topic herself (forcedMode). The
// pure decision takes the history and the time; the factory below runs the turn.

import { MINUTE_MS } from '../time.ts';
import type { Untyped } from '../tools/types.ts';

/** How long a channel's last message must be quiet before a forced turn starts a topic rather than joins in (minutes). */
// production value, config cut of 2026-10-31 (`spontaneous.deadAfterMinutes`)
const DEAD_AFTER_MINUTES = 90;

/**
 * Whether a forced turn would start a topic on `history`: the channel is empty, or its last message is at least
 * DEAD_AFTER_MINUTES old.
 */
function channelQuiet(history: Array<Record<string, Untyped>>, now: number): boolean {
  if (history.length === 0) return true;
  return now - history[history.length - 1].ts >= DEAD_AFTER_MINUTES * MINUTE_MS;
}

/**
 * What a turn someone asked for (`/nep message create`) does in a channel, from the same
 * history a spontaneous turn reads: start a topic ('initiate') when the channel is empty or has
 * been quiet for DEAD_AFTER_MINUTES, else join the conversation ('interject'). Never null:
 * she was asked to speak; no chance is rolled.
 */
export function forcedMode(history: Array<Record<string, Untyped>>, now: number): 'interject' | 'initiate' {
  return channelQuiet(history, now) ? 'initiate' : 'interject';
}

/**
 * The forced turns over the turn runner `turns`.
 */
export function createSpontaneous({
  turns,
}: {
  turns: { runTurn: (params: Record<string, Untyped>) => Promise<unknown> };
}): {
  force: (
    conversation: Untyped,
    mode?: string | null,
    options?: { requester?: { id?: string | null; roleIds?: Array<string> } | null }
  ) => Promise<unknown>;
} {
  /**
   * Run a turn right now (`message.create`), in the conversation `conversation` (a reference
   * `{ iface, conversationId }`): in `mode` when given, else the turn reads the channel and joins it or starts a topic
   * (forcedMode). `requester`: the person who asked, the requester of her skill calls in that turn.
   */
  function force(
    conversation: Untyped,
    mode: string | null = null,
    { requester = null }: { requester?: { id?: string | null; roleIds?: Array<string> } | null } = {}
  ) {
    const asked = requester ? { requester } : {};
    if (mode) return turns.runTurn({ conversation, mode, forced: true, ...asked });
    return turns.runTurn({
      conversation,
      mode: 'auto',
      forced: true,
      chooseMode: (history: Untyped, ts: Untyped) => forcedMode(history, ts),
      ...asked,
    });
  }

  return { force };
}
