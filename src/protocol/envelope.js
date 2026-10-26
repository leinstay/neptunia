// The wire envelope of the protocol: what an interface and the core exchange once they are two
// processes (north star 7 G); in process the same objects pass the event door
// (src/interface/door.js). `{ v, id, type, replyTo, body }`: `v` the envelope version, `id` an
// opaque string unique to the sender (an event's envelope carries the event's own id, so a
// redelivery is the same envelope: delivery is at-least-once and the receiver deduplicates by
// id), `type` one of ENVELOPE_TYPES, `replyTo` the id of the envelope this one answers (null for
// the first of a conversation), `body` the type's payload:
//   hello          { iface, self: { id, name }, community: { id, name }|null, capabilities?: string[]|object, resume?: string|null, token?: string }  who is speaking, who the persona is there, the community it serves, what it offers
//   event          an inbound event (events.js)                           interface -> core
//   ack            { status: 'ok'|'duplicate'|'invalid'|'unhandled'|'failed', reason? }  the event is taken (or not)
//   action         an outbound action (actions.js)                        core -> interface
//   action_result  a port result (actions.js#PortResult)                  interface -> core
//   ping           { at? }                                                liveness, answered by an ack
// Shapes only, like validate.js: the answer is `{ ok: true }` or `{ ok: false, reason }`; never throws.

import { validateAction, validateEvent } from './validate.js';

export const ENVELOPE_VERSION = 1;
export const ENVELOPE_TYPES = Object.freeze(['hello', 'event', 'ack', 'action', 'action_result', 'ping']);
/** The statuses of an `ack`: `ok` taken, `duplicate` taken before, `invalid` malformed, `unhandled` no one handles the kind, `failed` the handler failed (send it again). */
export const ACK_STATUSES = Object.freeze(['ok', 'duplicate', 'invalid', 'unhandled', 'failed']);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isId = (value) => typeof value === 'string' && value !== '';
/** An id with a display name: `{ id, name }`. */
/** @param {unknown} value */
const isNamed = (value) =>
  isObject(value) &&
  isId(/** @type {Record<string, unknown>} */ (value).id) &&
  typeof (/** @type {Record<string, unknown>} */ (value).name) === 'string';

/**
 * An envelope. `replyTo` defaults to null.
 * @param {string} type
 * @param {object} body
 * @param {{ id: string, replyTo?: string|null }} options
 */
export function envelope(type, body, { id, replyTo = null }) {
  return { v: ENVELOPE_VERSION, id, type, replyTo, body };
}

/**
 * The `ack` envelope answering `of` (an envelope or its id).
 * @param {string | { id: string }} of
 * @param {string} status
 * @param {string} [reason]
 */
export function ackOf(of, status, reason = undefined) {
  const replyTo = typeof of === 'string' ? of : of.id;
  return envelope('ack', reason === undefined ? { status } : { status, reason }, { id: `ack:${replyTo}`, replyTo });
}

/**
 * The shape of a `hello` body: who speaks, the persona's account on that interface (`self`, always given), the
 * community the interface serves (`community`, an id and a name, or null when it serves none), what it offers (a list
 * of names or a capabilities object), the token and the resume point.
 * @param {Record<string, any>} body
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function checkHello(body) {
  if (!isId(body.iface)) return { ok: false, reason: 'body.iface:type' };
  if (body.self === undefined) return { ok: false, reason: 'body.self:required' };
  if (!isNamed(body.self)) return { ok: false, reason: 'body.self:type' };
  if (body.community !== undefined && body.community !== null && !isNamed(body.community))
    return { ok: false, reason: 'body.community:type' };
  const offers = body.capabilities;
  if (offers !== undefined && !isObject(offers) && !(Array.isArray(offers) && offers.every(isId)))
    return { ok: false, reason: 'body.capabilities:type' };
  if (body.token !== undefined && typeof body.token !== 'string') return { ok: false, reason: 'body.token:type' };
  if (body.resume !== undefined && body.resume !== null && !isId(body.resume))
    return { ok: false, reason: 'body.resume:type' };
  return { ok: true };
}

/**
 * Whether `value` is a well-formed envelope: version, id, a known type, `replyTo` a string or null
 * (required for `ack` and `action_result`, which answer something) and a body valid for its type.
 * @param {unknown} value
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function validateEnvelope(value) {
  if (!isObject(value)) return { ok: false, reason: 'envelope:type' };
  if (value.v !== ENVELOPE_VERSION) return { ok: false, reason: 'v:unsupported' };
  if (!isId(value.id)) return { ok: false, reason: 'id:type' };
  if (!ENVELOPE_TYPES.includes(value.type)) return { ok: false, reason: 'type:unknown' };
  if (value.replyTo !== null && value.replyTo !== undefined && !isId(value.replyTo))
    return { ok: false, reason: 'replyTo:type' };
  const answers = value.type === 'ack' || value.type === 'action_result';
  if (answers && !isId(value.replyTo)) return { ok: false, reason: 'replyTo:required' };
  if (!isObject(value.body)) return { ok: false, reason: 'body:type' };
  /** @type {Record<string, any>} */
  const body = value.body;
  switch (value.type) {
    case 'hello':
      return checkHello(body);
    case 'event': {
      const verdict = validateEvent(body);
      return verdict.ok ? { ok: true } : { ok: false, reason: `body.${verdict.reason}` };
    }
    case 'ack':
      if (!ACK_STATUSES.includes(body.status)) return { ok: false, reason: 'body.status:unknown' };
      return { ok: true };
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
