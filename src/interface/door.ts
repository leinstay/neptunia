// The event door validates and deduplicates events before dispatching them to their handlers. A handler receives
// a door-owned receipt whose single observation claim tracks the atomic source and ingestion write. Claimed writes
// must succeed before acknowledgement. An unused receipt keeps the standalone ingestion commit. Completed event
// ids occupy a bounded cache scoped by sender, and durable ingestion rows also recognize redelivery after restart.
// Live state kinds use memory deduplication only. Logs carry event kind, status and reason, never event contents.
//
// `receive(envelope, from)` is the same door for the wire form: hello and ping are answered, an event
// envelope goes through `submit` with the principal and `seq` of `from` and is answered by an `ack`,
// every other type is `invalid`.

import { log as defaultLog } from '../log.ts';
import { ackOf, validateEnvelope, validateEvent } from '../protocol/index.ts';
import { objOf } from '../tools/types.ts';
import type { IngestRow } from '../memory/db/ingest.ts';
import type { AuthenticatedSender } from './principals.ts';

/** The ids kept by default. */
export const DEFAULT_CAPACITY = 10_000;

/** The kinds whose handlers set the current state: deduplicated in memory, never written to the ingestion record. */
const DEDUP_IN_MEMORY = new Set(['presence.changed', 'presence.snapshot', 'voice.changed', 'connection.changed']);

/** What the door answers for one event. */
export type SubmitResult = {
  status: 'ok' | 'duplicate' | 'invalid' | 'unhandled' | 'failed';
  id: string | null;
  reason?: string;
  result?: unknown;
};

/** The event door: `submit` an event, `receive` an envelope, ask whether an id was `seen`. */
export type EventDoor = {
  submit: (event: object, from?: From) => Promise<SubmitResult>;
  receive: (
    value: { id: string; type: string; body: object; seq?: number },
    from?: From
  ) => Promise<ReturnType<typeof ackOf>>;
  seen: (id: string) => boolean;
};

/** An event the door has validated: the fields it reads. */
type SubmittedEvent = {
  kind: string;
  id?: unknown;
  errandId?: unknown;
  status?: unknown;
  at?: unknown;
  conversation?: { id?: unknown };
};

/** The ingestion row of an event: who sent it, the number it was sent under, its id, kind and conversation. */
export type { IngestRow } from '../memory/db/ingest.ts';

export type ObservationCommit = { ok: true; sourceId: string; revision?: number } | { ok: false; code?: string };

export type AcceptedEventReceipt = Readonly<{
  eventId: string;
  row: Readonly<IngestRow> | null;
  observe(write: (row: Readonly<IngestRow> | null) => Promise<ObservationCommit>): Promise<ObservationCommit>;
}>;

type ObservationState = 'unused' | 'pending' | 'committed' | 'failed';
type ReceiptTracker = { receipt: AcceptedEventReceipt; state(): ObservationState };

function createReceipt({
  eventId,
  row,
  onCommit,
  onSettled,
}: {
  eventId: string;
  row: IngestRow | null;
  onCommit: () => void;
  onSettled: () => void;
}): ReceiptTracker {
  let state: ObservationState = 'unused';
  const copyRow = (): Readonly<IngestRow> | null => (row ? Object.freeze({ ...row }) : null);
  const receipt: AcceptedEventReceipt = Object.freeze({
    eventId,
    get row() {
      return copyRow();
    },
    observe(write: (row: Readonly<IngestRow> | null) => Promise<ObservationCommit>): Promise<ObservationCommit> {
      if (state !== 'unused') return Promise.resolve({ ok: false, code: 'OBSERVATION_CLAIMED' });
      state = 'pending';
      const capturedRow = copyRow();
      const pending = Promise.resolve()
        .then(() => write(capturedRow))
        .then(
          (result) => {
            state = result.ok ? 'committed' : 'failed';
            if (result.ok) onCommit();
            return result;
          },
          (error: unknown) => {
            state = 'failed';
            throw error;
          }
        )
        .finally(onSettled);
      // The handler may stop awaiting after its deadline. Keep a late rejection handled while returning it to awaiters.
      void pending.catch(() => {});
      return pending;
    },
  });
  return { receipt, state: () => state };
}

/** Who an event came from: the principal's name and the `seq` of its envelope (null for an un-numbered one). */
export type From = {
  principal: string | null;
  seq?: number | null;
  authenticated?: AuthenticatedSender;
};

/** The ingestion identity and verified sender supplied to an event handler. */
export type EventHandlerContext = {
  receipt?: AcceptedEventReceipt;
  ingest: IngestRow | null;
  authenticated: AuthenticatedSender | null;
};

/**
 * The id an event is deduplicated by: its own, else one derived from what makes it that event
 * (the core's own events carry none): an errand's end by task and status, a tick by its time.
 */
export function eventIdOf(event: {
  kind?: string;
  id?: unknown;
  errandId?: unknown;
  status?: unknown;
  at?: unknown;
}): string | null {
  if (typeof event?.id === 'string' && event.id !== '') return event.id;
  if (event?.kind === 'errand.done') return `errand.done:${event.errandId}:${event.status}`;
  if (event?.kind === 'scheduler.tick') return `scheduler.tick:${event.at}`;
  return null;
}

/** @param options.handlers By event kind, each taking the event type of its kind. A kind without one is `unhandled`. */
export function createEventDoor({
  handlers,
  capacity = DEFAULT_CAPACITY,
  log = defaultLog,
  ingest = null,
}: {
  handlers: Record<string, (event: never, context: EventHandlerContext) => unknown>;
  capacity?: number;
  log?: { info(message: string, meta?: unknown): void; warn(message: string, meta?: unknown): void };
  ingest?: { seen(principal: string, eventId: string): boolean; commit(row: IngestRow): Promise<unknown> } | null;
}): EventDoor {
  // Insertion order is the age: the oldest id is the first key.
  const seen = new Set<string>();
  const inFlight = new Map<string, ReceiptTracker>();

  function remember(id: string): void {
    seen.add(id);
    while (seen.size > capacity) {
      const oldest = seen.values().next();
      if (oldest.done) break;
      seen.delete(oldest.value);
    }
  }

  /** The ingestion row of `event` from `from`, or null: the core's own events, and the live state kinds, have none. */
  function rowOf(event: SubmittedEvent, id: string, from: From): IngestRow | null {
    if (!ingest || typeof from?.principal !== 'string' || DEDUP_IN_MEMORY.has(event.kind)) return null;
    const given = event.conversation?.id;
    const conversation = typeof given === 'string' ? given : null;
    const seq = typeof from.seq === 'number' && Number.isInteger(from.seq) ? from.seq : null;
    return { principal: from.principal, seq, eventId: id, kind: event.kind, conversation };
  }

  function duplicateOf({ key, row, id }: { key: string; row: IngestRow | null; id: string }): SubmitResult | null {
    if (seen.has(key)) return { status: 'duplicate', id };
    if (row && ingest?.seen(row.principal, id)) {
      remember(key);
      return { status: 'duplicate', id };
    }
    const active = inFlight.get(key);
    if (active) {
      const state = active.state();
      if (state === 'pending' || state === 'failed') {
        return { status: 'failed', id, reason: state === 'pending' ? 'observation-pending' : 'observation-failed' };
      }
      return { status: 'duplicate', id };
    }
    return null;
  }

  /** One event through the door. */
  async function submit(event: object, from: From = { principal: null }): Promise<SubmitResult> {
    const verdict = validateEvent(event);
    if (!verdict.ok) {
      log.warn('interface: invalid event', { kind: objOf(event).kind ?? null, reason: verdict.reason });
      return { status: 'invalid', id: null, reason: verdict.reason };
    }
    // validateEvent accepted it: the kind is a known string and the fields below have their forms.
    const checked = event as SubmittedEvent;
    const id = eventIdOf(checked);
    if (id === null) {
      log.warn('interface: invalid event', { kind: checked.kind, reason: 'id:required' });
      return { status: 'invalid', id: null, reason: 'id:required' };
    }
    if (from.authenticated && from.authenticated.name !== from.principal) {
      return { status: 'invalid', id, reason: 'sender:mismatch' };
    }
    // An id is one event of one sender: two principals may use the same id.
    const key = typeof from?.principal === 'string' ? `${from.principal}\u0000${id}` : id;
    const row = rowOf(checked, id, from);
    const duplicate = duplicateOf({ key, row, id });
    if (duplicate) return duplicate;
    const handler = handlers?.[checked.kind];
    if (typeof handler !== 'function') {
      log.warn('interface: unhandled event', { kind: checked.kind });
      return { status: 'unhandled', id };
    }
    let hasHandlerFinished = false;
    const tracked = createReceipt({
      eventId: id,
      row,
      onCommit: () => remember(key),
      onSettled: () => {
        if (hasHandlerFinished) inFlight.delete(key);
      },
    });
    inFlight.set(key, tracked);
    try {
      let result: unknown;
      try {
        // A handler takes the event type of its kind, which the door cannot name: it is called with the event as it is.
        result = await Reflect.apply(handler, undefined, [
          event,
          { receipt: tracked.receipt, ingest: row, authenticated: from.authenticated ?? null },
        ]);
      } catch (err) {
        log.warn('interface: event handler failed', { kind: checked.kind, error: err });
        return { status: 'failed', id, reason: 'handler-threw' };
      }
      const state = tracked.state();
      if (state === 'pending' || state === 'failed') {
        return { status: 'failed', id, reason: state === 'pending' ? 'observation-pending' : 'observation-failed' };
      }
      if (state === 'unused' && row && ingest) {
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
      hasHandlerFinished = true;
      if (tracked.state() !== 'pending') inFlight.delete(key);
    }
  }

  /**
   * One envelope through the door; answers an `ack` envelope (never throws). Whatever arrives is checked first.
   * @param from Who sent it, as the link authenticated them; the `seq` is the envelope's.
   */
  async function receive(
    value: { id: string; type: string; body: object; seq?: number },
    from: From = { principal: null }
  ): Promise<ReturnType<typeof ackOf>> {
    const verdict = validateEnvelope(value);
    if (!verdict.ok)
      return ackOf(typeof value?.id === 'string' && value.id !== '' ? value.id : 'unknown', 'invalid', verdict.reason);
    if (value.type === 'hello' || value.type === 'ping') return ackOf(value, 'ok');
    if (value.type !== 'event') return ackOf(value, 'invalid', 'type:not-inbound');
    const answer = await submit(value.body, {
      principal: from?.principal ?? null,
      seq: value.seq ?? null,
      authenticated: from.authenticated,
    });
    return ackOf(value, answer.status, answer.reason);
  }

  return { submit, receive, seen: (id: string) => seen.has(id) };
}
