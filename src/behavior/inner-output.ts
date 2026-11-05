import { CODE } from '../tools/codes.ts';
import type { Untyped } from '../tools/types.ts';
// What an inner turn's speech tags become (src/behavior/turn.ts, docs/inner-life.md): in an
// inner turn `<react>` and `<msg>` are public actions in the turn's current channel,
// lowered here into the same call objects her own tool calls are -- `message.react.add` and
// `message.create` -- so they are planned, gated (the kill
// switch in live mode, shadow proposals), journalled and counted by the one path every call of
// hers takes. A picture is not lowered: it is the `draw.create` tool, called like any other. A tag
// that cannot act carries a `refuse` (`{ code, reason }`) the planner turns into a refusal result
// she reads like any other: `target-required` for a reaction with no message named,
// `destination-required` for a post when the turn has no current channel. The order is the one an
// addressed turn acts in: reactions, messages. Pure.

/** The refusal of a reaction that names no message (never "the latest message"). */
export const TARGET_REQUIRED = Object.freeze({ code: CODE.TARGET_REQUIRED, reason: 'react:to' });
/** The refusal of a post when the turn has no current channel. */
export const DESTINATION_REQUIRED = Object.freeze({ code: CODE.DESTINATION_REQUIRED, reason: 'inner:currentChannel' });

/**
 * The call objects (`{ skill, args }`, plus `refuse` on one that must be refused) of the
 * output tags in `parsed` (src/llm/parse.ts's, after the turn's own shaping), in the order they
 * are acted on.
 * @param where  `current`: the id of the current channel,
 *   null when the turn has none; `turnChannel`: the id of the channel the turn runs in (the channel
 *   argument is left out for it: a call without one posts there).
 */
export function innerOutputCalls(
  parsed: {
    messages?: Array<Record<string, Untyped>>;
    reactions?: Array<Record<string, Untyped>>;
    untargetedReactions?: Array<Record<string, Untyped>>;
  },
  { current, turnChannel }: { current: string | null; turnChannel: string }
): Array<{ skill: string; args: Record<string, string>; refuse?: { code: string; reason: string } }> {
  const calls: Array<{ skill: string; args: Record<string, string>; refuse?: { code: string; reason: string } }> = [];
  const refuse = current ? {} : { refuse: DESTINATION_REQUIRED };
  const place: Record<string, string> =
    current && String(current) !== String(turnChannel) ? { channel: String(current) } : {};
  const reply = (replyTo: Untyped): Record<string, string> =>
    Number.isInteger(replyTo) ? { reply: `#${replyTo}` } : {};
  for (const reaction of parsed?.reactions ?? []) {
    calls.push({ skill: 'message.react.add', args: { message: `#${reaction.to}`, emoji: String(reaction.emoji) } });
  }
  for (const reaction of parsed?.untargetedReactions ?? []) {
    calls.push({ skill: 'message.react.add', args: { emoji: String(reaction.emoji) }, refuse: TARGET_REQUIRED });
  }
  for (const message of parsed?.messages ?? []) {
    calls.push({
      skill: 'message.create',
      args: { ...place, ...reply(message.replyTo), text: String(message.text ?? '') },
      ...refuse,
    });
  }
  return calls;
}
