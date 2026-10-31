// The event door: the one entry through which anything that happens reaches the mind -- a
// message or a reaction an interface reports, an errand that ended, a clock
// tick. Every event is validated at the boundary (src/protocol/validate.js), deduplicated
// by its id and handed to the handler of its kind. Delivery is at-least-once, so the door is
// idempotent: an id that was handled is `duplicate` the second time and its handler does not run
// again; an id whose handler threw is not remembered (`failed`), so the sender's redelivery gets
// another try; an id being handled right now is `duplicate` too. Nothing here throws: the answer
// is `{ status, id, reason?, result? }` with the statuses of an ack (envelope.js#ACK_STATUSES).
// The ids seen are kept in memory, the newest `capacity` of them, scoped by the principal that sent
// the event (src/interface/principals.ts). With `ingest` (the memory database's ingestion record,
// src/memory/db/ingest.ts) an event of a principal is also looked up there, so a restart still
// knows it, and once its handler succeeds its row is committed before the answer goes back: the
// handler gets the row (`{ ingest }`, its second argument) to commit it together with the
// observation it makes, and the door's own commit of the same row then changes nothing. The live
// state kinds (DEDUP_IN_MEMORY: presence, voice, connection) are deduplicated in memory only,
// because their handlers set what is current and a repeat changes nothing. A commit that fails is
// `failed` with `ingest-failed`, and the id is not remembered. Logs carry the kind, the status and
// the reason, never the content of an event.
//
// `receive(envelope, from)` is the same door for the wire form: hello and ping are answered, an event
// envelope goes through `submit` with the principal and `seq` of `from` and is answered by an `ack`,
// every other type is `invalid`.

import { log as defaultLog } from '../log.js';
import { ackOf, validateEnvelope, validateEvent } from '../protocol/index.js';

/** The ids kept by default. */
export const DEFAULT_CAPACITY = 10_000;

/** The kinds whose handlers set the current state: deduplicated in memory, never written to the ingestion record. */
const DEDUP_IN_MEMORY = new Set(['presence.changed', 'presence.snapshot', 'voice.changed', 'connection.changed']);

/**
 * The ingestion row of an event: who sent it, the number it was sent under, its id, kind and conversation.
 * @typedef {{ principal: string, seq: number | null, eventId: string, kind: string, conversation: string | null }} IngestRow
 */

/**
 * Who an event came from: the principal's name and the `seq` of its envelope (null for an un-numbered one).
 * @typedef {{ principal: string | null, seq?: number | null }} From
 */

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
 * @param {Record<string, (event: never, context: { ingest: IngestRow | null }) => unknown>} options.handlers  By event kind, each taking the event type of its kind. A kind without one is `unhandled`.
 * @param {number} [options.capacity]
 * @param {{ info(message: string, meta?: unknown): void, warn(message: string, meta?: unknown): void }} [options.log]
 * @param {{ seen(principal: string, eventId: string): boolean, commit(row: IngestRow): Promise<unknown> } | null} [options.ingest]
 */
export function createEventDoor({ handlers, capacity = DEFAULT_CAPACITY, log = defaultLog, ingest = null }) {
  // Insertion order is the age: the oldest id is the first key.
  const seen = new Set();
  const inFlight = new Set();

  function remember(id) {
    seen.add(id);
    while (seen.size > capacity) seen.delete(seen.values().next().value);
  }

  /**
   * The ingestion row of `event` from `from`, or null: the core's own events, and the live state kinds, have none.
   * @param {{ kind: string, conversation?: { id?: unknown } }} event
   * @param {string} id
   * @param {From} from
   * @returns {IngestRow | null}
   */
  function rowOf(event, id, from) {
    if (!ingest || typeof from?.principal !== 'string' || DEDUP_IN_MEMORY.has(event.kind)) return null;
    const given = event.conversation?.id;
    const conversation = typeof given === 'string' ? given : null;
    const seq = typeof from.seq === 'number' && Number.isInteger(from.seq) ? from.seq : null;
    return { principal: from.principal, seq, eventId: id, kind: event.kind, conversation };
  }

  /**
   * One event through the door.
   * @param {object} event
   * @param {From} [from]
   * @returns {Promise<{ status: 'ok'|'duplicate'|'invalid'|'unhandled'|'failed', id: string|null, reason?: string, result?: unknown }>}
   */
  async function submit(event, from = { principal: null }) {
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
    // An id is one event of one sender: two principals may use the same id.
    const key = typeof from?.principal === 'string' ? `${from.principal}\u0000${id}` : id;
    const row = rowOf(/** @type {{ kind: string, conversation?: { id?: unknown } }} */ (event), id, from);
    if (seen.has(key) || inFlight.has(key)) return { status: 'duplicate', id };
    if (row && ingest?.seen(row.principal, id)) {
      remember(key);
      return { status: 'duplicate', id };
    }
    const handler = handlers?.[event.kind];
    if (typeof handler !== 'function') {
      log.warn('interface: unhandled event', { kind: event.kind });
      return { status: 'unhandled', id };
    }
    inFlight.add(key);
    try {
      let result;
      try {
        result = await handler(event, { ingest: row });
      } catch (err) {
        log.warn('interface: event handler failed', { kind: event.kind, error: err });
        return { status: 'failed', id, reason: 'handler-threw' };
      }
      if (row && ingest) {
        try {
          await ingest.commit(row);
        } catch (err) {
          log.warn('interface: ingest commit failed', { kind: row.kind, error: err });
          return { status: 'failed', id, reason: 'ingest-failed' };
        }
      }
      remember(key);
      return { status: 'ok', id, result };
    } finally {
      inFlight.delete(key);
    }
  }

  /**
   * One envelope through the door; answers an `ack` envelope (never throws). Whatever arrives is checked first.
   * @param {{ id: string, type: string, body: object, seq?: number }} value
   * @param {From} [from]  Who sent it, as the link authenticated them; the `seq` is the envelope's.
   */
  async function receive(value, from = { principal: null }) {
    const verdict = validateEnvelope(value);
    if (!verdict.ok)
      return ackOf(typeof value?.id === 'string' && value.id !== '' ? value.id : 'unknown', 'invalid', verdict.reason);
    if (value.type === 'hello' || value.type === 'ping') return ackOf(value, 'ok');
    if (value.type !== 'event') return ackOf(value, 'invalid', 'type:not-inbound');
    const answer = await submit(value.body, { principal: from?.principal ?? null, seq: value.seq ?? null });
    return ackOf(value, answer.status, answer.reason);
  }

  return { submit, receive, seen: (id) => seen.has(id) };
}
