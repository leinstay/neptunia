// The wire envelope of the protocol: what an interface and the core exchange once they are two
// processes (north star 7 G); in process the same objects pass the event door
// (src/interface/door.ts). `{ v, id, type, replyTo, body, seq? }`: `v` the envelope version, `id` an
// opaque string unique to the sender (an event's envelope carries the event's own id, so a
// redelivery is the same envelope: delivery is at-least-once and the receiver deduplicates by
// id), `type` one of ENVELOPE_TYPES, `replyTo` the id of the envelope this one answers (null for
// the first of a chat), `body` the type's payload, and `seq` the number an interface with an
// outbox gives each event it sends (src/protocol/outbox.ts), counted per client from 1:
//   hello          { iface, self: { id, name }, root: { id, name }|null, roots?: [{ id, name }], names?: { interface, nouns: { [kind]: noun }, dm }, capabilities?: string[]|object, resume?: string|null, token?: string }  who is speaking, who the persona is there, the root it serves, what the interface calls itself and its places, what it offers
//   event          an inbound event (events.ts)                           interface -> core
//   ack            { status: 'ok'|'duplicate'|'invalid'|'unhandled'|'failed', reason?, ackedSeq? }  the event is taken (or not); the answer to hello carries the client's watermark
//   action         an outbound action (actions.ts)                        core -> interface
//   action_result  a port result (actions.ts#PortResult)                  interface -> core
//   ping           { at? }                                                liveness, answered by an ack
//   cancel         {}, `replyTo` the action's id                          core -> interface
// Shapes only, like validate.ts: the answer is `{ ok: true }` or `{ ok: false, reason }`; never throws.
// `validateFrame` checks everything but the body, which is what a transport checks before it hands an
// envelope on: the receiver checks the body with `validateEnvelope` and answers a bad one.

import { validateAction, validateEvent } from './validate.ts';

export const ENVELOPE_VERSION = 1;
export const ENVELOPE_TYPES = Object.freeze(['hello', 'event', 'ack', 'action', 'action_result', 'ping', 'cancel']);
/** The statuses of an `ack`: `ok` taken, `duplicate` taken before, `invalid` malformed, `unhandled` no one handles the kind, `failed` the handler failed (send it again). */
export const ACK_STATUSES = Object.freeze(['ok', 'duplicate', 'invalid', 'unhandled', 'failed']);

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isId = (value: unknown): value is string => typeof value === 'string' && value !== '';
const isEnvelopeType = (value: unknown): boolean => ENVELOPE_TYPES.some((type) => type === value);
const isAckStatus = (value: unknown): boolean => ACK_STATUSES.some((status) => status === value);
/** An id with a display name: `{ id, name }`. */
const isNamed = (value: unknown): boolean => isObject(value) && isId(value.id) && typeof value.name === 'string';

/** An interface's own names: a name, a noun per kind of place and a word for a direct chat, all strings. */
const isNames = (value: unknown): boolean =>
  isObject(value) &&
  typeof value.interface === 'string' &&
  typeof value.dm === 'string' &&
  isObject(value.nouns) &&
  Object.values(value.nouns).every((noun) => typeof noun === 'string');

/** An envelope. `replyTo` defaults to null; `seq` is written only when given. */
export function envelope(
  type: string,
  body: object,
  { id, replyTo = null, seq = undefined }: { id: string; replyTo?: string | null; seq?: number }
): { v: number; id: string; type: string; replyTo: string | null; body: object; seq?: number } {
  const plain = { v: ENVELOPE_VERSION, id, type, replyTo, body };
  return seq === undefined ? plain : { ...plain, seq };
}

/** The `ack` envelope answering `of` (an envelope or its id). */
export function ackOf(of: string | { id: string }, status: string, reason?: string): ReturnType<typeof envelope> {
  const replyTo = typeof of === 'string' ? of : of.id;
  return envelope('ack', reason === undefined ? { status } : { status, reason }, { id: `ack:${replyTo}`, replyTo });
}

/** The names a `hello` body gives: the root it serves, the others it serves, and the interface's own names. */
function checkHelloNames(body: Record<string, unknown>): { ok: true } | { ok: false; reason: string } {
  if (body.root !== undefined && body.root !== null && !isNamed(body.root))
    return { ok: false, reason: 'body.root:type' };
  if (body.roots !== undefined && !(Array.isArray(body.roots) && body.roots.every(isNamed)))
    return { ok: false, reason: 'body.roots:type' };
  if (body.names !== undefined && !isNames(body.names)) return { ok: false, reason: 'body.names:type' };
  return { ok: true };
}

/**
 * The shape of a `hello` body: who speaks, the persona's account on that interface (`self`, always given), the
 * root the interface serves (`root`, an id and a name, or null when it serves none), what it offers (a list
 * of names or a capabilities object), the token and the resume point.
 */
function checkHello(body: Record<string, unknown>): { ok: true } | { ok: false; reason: string } {
  if (!isId(body.iface)) return { ok: false, reason: 'body.iface:type' };
  if (body.self === undefined) return { ok: false, reason: 'body.self:required' };
  if (!isNamed(body.self)) return { ok: false, reason: 'body.self:type' };
  const named = checkHelloNames(body);
  if (!named.ok) return named;
  const offers = body.capabilities;
  if (offers !== undefined && !isObject(offers) && !(Array.isArray(offers) && offers.every(isId)))
    return { ok: false, reason: 'body.capabilities:type' };
  if (body.token !== undefined && typeof body.token !== 'string') return { ok: false, reason: 'body.token:type' };
  if (body.resume !== undefined && body.resume !== null && !isId(body.resume))
    return { ok: false, reason: 'body.resume:type' };
  return { ok: true };
}

/**
 * Whether `value` is a well-formed envelope apart from its body: version, id, a known type, `replyTo` a
 * string or null (required for `ack`, `action_result` and `cancel`, which answer something), `seq` a
 * positive whole number when present, and a body that is an object.
 */
export function validateFrame(value: unknown): { ok: true } | { ok: false; reason: string } {
  if (!isObject(value)) return { ok: false, reason: 'envelope:type' };
  if (value.v !== ENVELOPE_VERSION) return { ok: false, reason: 'v:unsupported' };
  if (!isId(value.id)) return { ok: false, reason: 'id:type' };
  if (!isEnvelopeType(value.type)) return { ok: false, reason: 'type:unknown' };
  if (value.replyTo !== null && value.replyTo !== undefined && !isId(value.replyTo))
    return { ok: false, reason: 'replyTo:type' };
  const answers = value.type === 'ack' || value.type === 'action_result' || value.type === 'cancel';
  if (answers && !isId(value.replyTo)) return { ok: false, reason: 'replyTo:required' };
  if (value.seq !== undefined && !(typeof value.seq === 'number' && Number.isInteger(value.seq) && value.seq > 0))
    return { ok: false, reason: 'seq:type' };
  if (!isObject(value.body)) return { ok: false, reason: 'body:type' };
  return { ok: true };
}

/** The shape of an `ack` body: a known status and, when present, a whole watermark from 0. */
function checkAck(body: Record<string, unknown>): { ok: true } | { ok: false; reason: string } {
  if (!isAckStatus(body.status)) return { ok: false, reason: 'body.status:unknown' };
  const seq = body.ackedSeq;
  if (seq !== undefined && !(typeof seq === 'number' && Number.isInteger(seq) && seq >= 0))
    return { ok: false, reason: 'body.ackedSeq:type' };
  return { ok: true };
}

/** Whether `value` is a well-formed envelope: its frame (validateFrame) and a body valid for its type. */
export function validateEnvelope(value: unknown): { ok: true } | { ok: false; reason: string } {
  const frame = validateFrame(value);
  if (!frame.ok) return frame;
  // validateFrame has checked that `value` is an object whose body is an object.
  const { body, type } = value as { body: Record<string, unknown>; type: unknown };
  switch (type) {
    case 'hello':
      return checkHello(body);
    case 'event': {
      const verdict = validateEvent(body);
      return verdict.ok ? { ok: true } : { ok: false, reason: `body.${verdict.reason}` };
    }
    case 'ack':
      return checkAck(body);
    case 'action': {
      const verdict = validateAction(body);
      return verdict.ok ? { ok: true } : { ok: false, reason: `body.${verdict.reason}` };
    }
    case 'action_result':
      if (typeof body.status !== 'string' || body.status === '') return { ok: false, reason: 'body.status:type' };
      return { ok: true };
    default:
      if (body.at !== undefined && !(typeof body.at === 'number' && Number.isFinite(body.at)))
        return { ok: false, reason: 'body.at:type' };
      return { ok: true };
  }
}
