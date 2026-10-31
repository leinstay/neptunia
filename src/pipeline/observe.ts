// The live observation of a line: a message event as an observation of the memory database, sent through its writer
// and awaited at most `memoryDb.observeTimeoutMs`. createMessageHandler (src/behavior/pipeline.js) builds it once with
// createObserve; a new line, an edit and a private message observe through it.

import { log } from '../log.js';
import { observationOf } from '../memory/db/observe-event.js';
import type { MessageEvent, Observed } from './edits.ts';
import type { PipelineHot, Thrown } from './types.ts';

/** The record a line belongs to: the guild's, or a private chat's under it. */
export type ObserveWhere = { guildId: string; privateUserId?: string } | null;

/**
 * The timers of the observation's deadline and of the settle waits (setTimeout and clearTimeout by default). A settle
 * wait's timer runs fireSettle, which never rejects, so a callback may answer a promise.
 */
export type Timers = { set: (fn: () => unknown, ms: number) => unknown; clear: (timer: unknown) => void };

/** What createObserve reads: the dependencies of createMessageHandler. */
export type ObserveContext = {
  hot: PipelineHot;
  memoryDb: { observe?: (envelope: object, where: ObserveWhere) => Promise<Observed> | Observed } | null;
  selfIdOf: () => string;
  timers: Timers;
};

/** The logger as the refusal line calls it: a debug level it may lack. */
type DebugLog = { debug?: (msg: string, meta: object) => void };

export type ObserveLine = (event: MessageEvent, direct?: boolean, where?: ObserveWhere) => Promise<Observed> | null;

export function createObserve({ hot, memoryDb, selfIdOf, timers }: ObserveContext): { observeLine: ObserveLine } {
  /**
   * The live observation path: `event` as an observation of the memory database (see
   * deps.memoryDb), with `direct` as memory gets it and `where` (`{ guildId, privateUserId }`)
   * the record the line belongs to: a promise of the observe result (null on a failure or past
   * `memoryDb.observeTimeoutMs`), which the caller awaits; null without a memory database. Codes only.
   */
  function observeLine(event: MessageEvent, direct = false, where: ObserveWhere = null): Promise<Observed> | null {
    if (!memoryDb || typeof memoryDb.observe !== 'function') return null;
    try {
      const envelope = observationOf(event, { selfId: selfIdOf() || null, direct });
      if (!envelope) return null;
      const sent = Promise.resolve(memoryDb.observe(envelope, where))
        .then((done) => {
          // src/log.js has no debug level, so this optional call writes nothing.
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
