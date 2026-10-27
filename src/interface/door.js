// The event door: the one entry through which anything that happens reaches the mind -- a
// message or a reaction an interface reports, an errand that ended, a ledger answer, a clock
// tick. Every event is validated at the boundary (src/protocol/validate.js), deduplicated
// by its id and handed to the handler of its kind. Delivery is at-least-once, so the door is
// idempotent: an id that was handled is `duplicate` the second time and its handler does not run
// again; an id whose handler threw is not remembered (`failed`), so the sender's redelivery gets
// another try; an id being handled right now is `duplicate` too. Nothing here throws: the answer
// is `{ status, id, reason?, result? }` with the statuses of an ack (envelope.js#ACK_STATUSES).
// The ids seen are kept in memory, the newest `capacity` of them (a restart forgets them: the
// interface resumes from what it last had acknowledged). Logs carry the kind, the status and the
// reason, never the content of an event.
//
// `receive(envelope)` is the same door for the wire form: hello and ping are answered, an event
// envelope goes through `submit` and is answered by an `ack`, every other type is `invalid`.

import { log as defaultLog } from '../log.js';
import { ackOf, validateEnvelope, validateEvent } from '../protocol/index.js';

/** The ids kept by default. */
export const DEFAULT_CAPACITY = 10_000;

/**
 * The id an event is deduplicated by: its own, else one derived from what makes it that event
 * (the core's own events carry none): an errand's end by task and status, a tick by its time.
 * @param {{ kind?: string, id?: unknown, errandId?: unknown, status?: unknown, at?: unknown }} event
 * @returns {string|null}
 */
export function eventIdOf(event) {
  if (typeof event?.id === 'string' && event.id !== '') return event.id;
  if (event?.kind === 'errand.done') return `errand.done:${event.errandId}:${event.status}`;
  if (event?.kind === 'scheduler.tick') return `scheduler.tick:${event.at}`;
  return null;
}

/**
 * @param {object} options
 * @param {Record<string, (event: never) => unknown>} options.handlers  By event kind, each taking the event type of its kind. A kind without one is `unhandled`.
 * @param {number} [options.capacity]
 * @param {{ info: Function, warn: Function }} [options.log]
 */
export function createEventDoor({ handlers, capacity = DEFAULT_CAPACITY, log = defaultLog }) {
  // Insertion order is the age: the oldest id is the first key.
  const seen = new Set();
  const inFlight = new Set();

  function remember(id) {
    seen.add(id);
    while (seen.size > capacity) seen.delete(seen.values().next().value);
  }

  /**
   * One event through the door.
   * @param {object} event
   * @returns {Promise<{ status: 'ok'|'duplicate'|'invalid'|'unhandled'|'failed', id: string|null, reason?: string, result?: unknown }>}
   */
  async function submit(event) {
    const verdict = validateEvent(event);
    if (!verdict.ok) {
      log.warn('interface: invalid event', { kind: event?.kind ?? null, reason: verdict.reason });
      return { status: 'invalid', id: null, reason: verdict.reason };
    }
    const id = eventIdOf(event);
    if (id === null) {
      log.warn('interface: invalid event', { kind: event.kind, reason: 'id:required' });
      return { status: 'invalid', id: null, reason: 'id:required' };
    }
    if (seen.has(id) || inFlight.has(id)) return { status: 'duplicate', id };
    const handler = handlers?.[event.kind];
    if (typeof handler !== 'function') {
      log.warn('interface: unhandled event', { kind: event.kind });
      return { status: 'unhandled', id };
    }
    inFlight.add(id);
    try {
      const result = await handler(event);
      remember(id);
      return { status: 'ok', id, result };
    } catch (err) {
      log.warn('interface: event handler failed', { kind: event.kind, error: err });
      return { status: 'failed', id, reason: 'handler-threw' };
    } finally {
      inFlight.delete(id);
    }
  }

  /**
   * One envelope through the door; answers an `ack` envelope (never throws). Whatever arrives is checked first.
   * @param {{ id: string, type: string, body: object }} value
   */
  async function receive(value) {
    const verdict = validateEnvelope(value);
    if (!verdict.ok)
      return ackOf(typeof value?.id === 'string' && value.id !== '' ? value.id : 'unknown', 'invalid', verdict.reason);
    if (value.type === 'hello' || value.type === 'ping') return ackOf(value, 'ok');
    if (value.type !== 'event') return ackOf(value, 'invalid', 'type:not-inbound');
    const answer = await submit(value.body);
    return ackOf(value, answer.status, answer.reason);
  }

  return { submit, receive, seen: (id) => seen.has(id) };
}
