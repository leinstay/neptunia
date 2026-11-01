// The turn someone asks her for in a channel (`message.create` without a message to answer, her own call or the
// owner's command): she reads the channel and joins the conversation or starts a topic herself (forcedMode). The
// pure decision takes the history and the time; the factory below runs the turn.

import { MINUTE_MS } from '../time.js';

/** How long a channel's last message must be quiet before a forced turn starts a topic rather than joins in (minutes). */
// production value, config cut of 2026-10-31 (`spontaneous.deadAfterMinutes`)
const DEAD_AFTER_MINUTES = 90;

/**
 * Whether a forced turn would start a topic on `history`: the channel is empty, or its last message is at least
 * DEAD_AFTER_MINUTES old.
 * @param {object[]} history
 * @param {number} now
 * @returns {boolean}
 */
function channelQuiet(history, now) {
  if (history.length === 0) return true;
  return now - history[history.length - 1].ts >= DEAD_AFTER_MINUTES * MINUTE_MS;
}

/**
 * What a turn someone asked for (`/nep message create`) does in a channel, from the same
 * history a spontaneous turn reads: start a topic ('initiate') when the channel is empty or has
 * been quiet for DEAD_AFTER_MINUTES, else join the conversation ('interject'). Never null:
 * she was asked to speak; no chance is rolled.
 * @param {object[]} history
 * @param {number} now
 * @returns {'interject'|'initiate'}
 */
export function forcedMode(history, now) {
  return channelQuiet(history, now) ? 'initiate' : 'interject';
}

/**
 * The forced turns over the turn runner `turns`.
 * @param {{ turns: { runTurn: (params: object) => Promise<unknown> } }} deps
 */
export function createSpontaneous({ turns }) {
  /**
   * Run a turn right now (`message.create`), in the conversation `conversation` (a reference
   * `{ iface, conversationId }`): in `mode` when given, else the turn reads the channel and joins it or starts a topic
   * (forcedMode). `requester`: the person who asked, the requester of her skill calls in that turn.
   */
  function force(conversation, mode = null, { requester = null } = {}) {
    const asked = requester ? { requester } : {};
    if (mode) return turns.runTurn({ conversation, mode, forced: true, ...asked });
    return turns.runTurn({
      conversation,
      mode: 'auto',
      forced: true,
      chooseMode: (history, ts) => forcedMode(history, ts),
      ...asked,
    });
  }

  return { force };
}
