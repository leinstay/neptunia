// The hold of a wake turn's sends (docs/inner-life.md "A wake's sends"). The drain (src/behavior/inner/drain.ts) gives
// a live wake turn one `SendHold`; her calls carry it in their operation context (`context.hold`), and `heldPort`
// wraps the port each posting operation sends through (message.create, draw.create, voice.say, and the files
// src/tools/executors.ts#executeCall posts) so that a send is kept in the hold instead of reaching the interface. A
// kept send answers `ok` with no message: it has no id until the inner life sends it after the wake's completion
// (src/behavior/inner/deliveries.ts). Each send keeps the idempotency key it was given, else the call's key
// (`context.idempotencyKey`, then `<key>:<n>` for the next send of the same call); a second send under a key the hold
// already keeps is the same send again (another attempt of the turn) and is not kept twice.

import type { ConversationRef, Delivery, SendOptions } from '../protocol/adapter.ts';
import type { Content } from '../protocol/actions.js';

/** One send a wake turn held: its effect key, where it goes and what it carries. */
export type HeldSend = { key: string; conversation: ConversationRef; content: Content };

/** The sends of one wake turn, in the order she made them. */
export type SendHold = {
  readonly sends: ReadonlyArray<HeldSend>;
  keep(send: HeldSend): void;
  /** Whether a send is held for `conversationId`. */
  holdsIn(conversationId: string): boolean;
  /** How many sends are held under `key` (the key itself or `<key>:<n>`). */
  countUnder(key: string): number;
};

/** An empty hold for one wake turn. */
export function createSendHold(): SendHold {
  const sends: Array<HeldSend> = [];
  return {
    sends,
    keep(send) {
      if (!sends.some((held) => held.key === send.key)) sends.push(send);
    },
    holdsIn: (conversationId) => sends.some((held) => held.conversation.conversationId === conversationId),
    countUnder: (key) => sends.filter((held) => held.key === key || held.key.startsWith(`${key}:`)).length,
  };
}

/** Whether `value` is a hold createSendHold made. */
export function isSendHold(value: unknown): value is SendHold {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof Reflect.get(value, 'keep') === 'function' &&
    typeof Reflect.get(value, 'countUnder') === 'function'
  );
}

/** The part of an operation's context the hold reads. */
type HoldContext = Readonly<Record<string, unknown>> | null | undefined;

/**
 * `real` whose `send` keeps each send in `context.hold` and answers `ok` with no message; `real` itself when the
 * context carries no hold.
 */
export function heldPort<TPort extends object>(real: TPort, context: HoldContext): TPort {
  const hold = context?.hold;
  if (!isSendHold(hold)) return real;
  const callKey = typeof context?.idempotencyKey === 'string' ? context.idempotencyKey : 'held';
  let unkeyed = 0;
  const send = (conversation: ConversationRef, content: Content, options: SendOptions = {}): Promise<Delivery> => {
    const given = typeof options.idempotencyKey === 'string' ? options.idempotencyKey : '';
    const key = given || (unkeyed === 0 ? callKey : `${callKey}:${unkeyed}`);
    if (!given) unkeyed += 1;
    hold.keep({ key, conversation: { ...conversation }, content });
    return Promise.resolve({ status: 'ok', ref: null, parts: [], at: null, idempotencyKey: key, error: null });
  };
  // The ports a post goes through differ in how they type `send`; the held one takes and answers what an adapter's does.
  const held = Object.create(real) as TPort;
  Reflect.set(held, 'send', send);
  return held;
}
