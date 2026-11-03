// The live observation of a line: a message event as an observation of the memory database, sent through its writer
// and awaited at most `memoryDb.observeTimeoutMs`. createMessageHandler (src/behavior/pipeline.ts) builds it once with
// createObserve; a new line, an edit and a private message observe through it.

import { log } from '../log.ts';
import { observationOf } from '../memory/db/observe-event.ts';
import { DEFAULT_KEEP_DAYS, withIngestRow } from '../memory/db/ingest.ts';
import { objOf } from '../tools/types.ts';
import type { ObservationCommit } from '../interface/door.ts';
import type { Envelope } from '../memory/db/observe.ts';
import type { MessageEvent, Observed } from './edits.ts';
import type { AcceptedMessageEvent, Thrown } from './types.ts';

/** The record a line belongs to: the guild's, or a private chat's under it. */
export type ObserveWhere = { guildId: string; privateUserId?: string } | null;

/**
 * The timers of the observation's deadline and of the settle waits (setTimeout and clearTimeout by default). A settle
 * wait's timer runs fireSettle, which never rejects, so a callback may answer a promise.
 */
export type Timers = { set: (fn: () => unknown, ms: number) => unknown; clear: (timer: unknown) => void };

/** What createObserve reads: the dependencies of createMessageHandler. */
export type ObserveContext = {
  hot: { readonly config: { readonly memoryDb?: Readonly<Record<string, unknown>> } };
  memoryDb: {
    observe?: (envelope: object, where: ObserveWhere) => Promise<Observed> | Observed;
    observeMessage?: (envelope: object, where: ObserveWhere) => Promise<object> | object | null;
  } | null;
  selfIdOf: () => string;
  timers: Timers;
};

/** The logger as the refusal line calls it: a debug level it may lack. */
type DebugLog = { debug?: (msg: string, meta: object) => void };

export type ObserveLine = (
  event: MessageEvent,
  direct?: boolean,
  where?: ObserveWhere,
  acceptedEvent?: AcceptedMessageEvent
) => Promise<Observed> | null;

function acceptedObservation({
  envelope,
  accepted,
  memoryDb,
  hot,
  where,
}: {
  envelope: () => Envelope | null;
  accepted: AcceptedMessageEvent;
  memoryDb: ObserveContext['memoryDb'];
  hot: ObserveContext['hot'];
  where: ObserveWhere;
}): Promise<ObservationCommit> {
  return accepted.receipt.observe(async (row) => {
    const mappedEnvelope = envelope();
    const mapped = mappedEnvelope?.messageLocator;
    if (
      !mapped ||
      accepted.eventId !== accepted.receipt.eventId ||
      mapped.iface !== accepted.locator.iface ||
      mapped.conversationId !== accepted.locator.conversationId ||
      mapped.messageId !== accepted.locator.messageId
    )
      return { ok: false, code: 'BAD_NATIVE' };
    if (!memoryDb?.observeMessage || !mappedEnvelope) return { ok: false, code: 'DB_CLOSED' };
    const days = hot.config.memoryDb?.ingestKeepDays;
    const keepDays = typeof days === 'number' && days > 0 ? days : DEFAULT_KEEP_DAYS;
    const done = objOf(await memoryDb.observeMessage(withIngestRow(mappedEnvelope, row, keepDays), where));
    if (done.ok !== true || typeof done.sourceId !== 'string')
      return { ok: false, ...(typeof done.code === 'string' ? { code: done.code } : {}) };
    return {
      ok: true,
      sourceId: done.sourceId,
      ...(typeof done.revision === 'number' ? { revision: done.revision } : {}),
    };
  });
}

export function createObserve({ hot, memoryDb, selfIdOf, timers }: ObserveContext): { observeLine: ObserveLine } {
  /**
   * The live observation path: `event` as an observation of the memory database (see
   * deps.memoryDb), with `direct` as memory gets it and `where` (`{ guildId, privateUserId }`)
   * the record the line belongs to: a promise of the observe result (null on a failure or past
   * `memoryDb.observeTimeoutMs`), which the caller awaits; null without a memory database. Codes only.
   */
  function observeLine(
    event: MessageEvent,
    direct = false,
    where: ObserveWhere = null,
    acceptedEvent?: AcceptedMessageEvent
  ): Promise<Observed> | null {
    if (!acceptedEvent && (!memoryDb || typeof memoryDb.observe !== 'function')) return null;
    try {
      const mapEnvelope = (): Envelope | null => observationOf(event, { selfId: selfIdOf() || null, direct });
      const envelope = acceptedEvent ? null : mapEnvelope();
      if (!acceptedEvent && !envelope) return null;
      const write = acceptedEvent
        ? acceptedObservation({ envelope: mapEnvelope, accepted: acceptedEvent, memoryDb, hot, where })
        : memoryDb?.observe?.(envelope ?? {}, where);
      const sent = Promise.resolve(write)
        .then((done) => {
          // src/log.ts has no debug level, so this optional call writes nothing.
          if (done && done.ok === false) (log as DebugLog).debug?.('events: observe refused', { code: done.code });
          return done ?? null;
        })
        .catch((err: Thrown) => {
          log.warn('events: observe failed', { code: err?.code ?? null });
          return null;
        });
      const limit = hot.config?.memoryDb?.observeTimeoutMs;
      const ms = Number.isFinite(limit) && (limit as number) > 0 ? (limit as number) : 5000;
      let timer: unknown;
      const late = new Promise<null>((resolve) => {
        timer = timers.set(() => {
          log.warn('events: observe slow', { code: 'OBSERVE_TIMEOUT' });
          resolve(null);
        }, ms);
      });
      return Promise.race([sent, late]).finally(() => timers.clear(timer));
    } catch (err) {
      log.warn('events: observe failed', { code: (err as Thrown)?.code ?? null });
      return null;
    }
  }

  return { observeLine };
}
