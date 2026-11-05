// The states of the turns one owner's conversation asks for: accepted, queued, running and the three ends. One runs at a
// time, the rest wait in order under a capacity, and a queued one can be edited, removed or cancelled before it starts. A
// cancel of the running one aborts its signal and waits: only the run says how it ended, so a reply that went out despite the
// cancel ends committed. Every event goes to `emit` with one rising `seq` and stays for `replay`. The control knows nothing of
// a watcher, an errand or another conversation, and calls no model. src/interface/chat-turns.ts holds the one of the owner's
// chat, whose `run` waits for the turn the pipeline runs over a line that already passed the event door.

import type { TurnEvent } from '../protocol/turn-control.ts';

export type { TurnEvent } from '../protocol/turn-control.ts';

/** An image staged with a line. It stays with its turn until the turn runs. */
export type TurnAttachment = { id: string; name: string; contentType: string; reference: string; size?: number };

/** What a run works on. */
export type TurnRun = {
  turnId: string;
  requestId: string;
  text: string;
  attachments: ReadonlyArray<TurnAttachment>;
};

export type TurnOutcome =
  { status: 'committed'; responseId: string } | { status: 'cancelled' } | { status: 'failed'; code: string };

export type Submitted = { status: 'accepted'; turnId: string } | { status: 'refused'; code: 'queue-full' };

export type TurnControl = {
  /** Takes a line. The same `requestId` again is the same turn, run once. */
  submit(line: { requestId: string; text: string; attachments: ReadonlyArray<TurnAttachment> }): Submitted;
  edit(turnId: string, text: string): { status: 'ok' | 'too-late' | 'unknown' };
  remove(turnId: string): { status: 'ok' | 'too-late' | 'unknown' };
  cancel(turnId: string): { status: 'cancelled' | 'cancelling' | 'finished' | 'unknown' };
  queued(): ReadonlyArray<TurnRun>;
  /** What the running turn's tools and tasks did; ignored for any other turn. */
  progress(turnId: string, step: { kind: 'tool' | 'task'; name: string; detail: string }): void;
  /** The events after `after`, in order. */
  replay(after: number): ReadonlyArray<TurnEvent>;
};

/** How many events stay for a replay: a reconnect's gap holds a few turns' worth. Decided 2026-11-05. */
const KEPT_EVENTS = 2000;
/** How many turns are remembered after their end, so a resend or a late cancel still finds its own. Decided 2026-11-05. */
const KEPT_ENDED = 256;

type Phase = 'queued' | 'running' | 'ended';

export function createTurnControl({
  capacity,
  newId,
  now,
  emit,
  run,
  isStreaming = () => false,
}: {
  capacity: number | (() => number);
  newId: () => string;
  now: () => number;
  emit: (event: TurnEvent) => void;
  run: (turn: TurnRun, control: { signal: AbortSignal }) => Promise<TurnOutcome>;
  /** Whether the route sends text as it is made. A route that sends only the completed answer says so to the client. */
  isStreaming?: () => boolean;
}): TurnControl {
  const phases = new Map<string, Phase>();
  const byRequest = new Map<string, string>();
  const events: Array<TurnEvent> = [];
  let queue: ReadonlyArray<TurnRun> = [];
  let active: { turnId: string; abort: AbortController } | null = null;
  let seq = 0;

  function say(turnId: string, type: TurnEvent['type'], fields: Partial<TurnEvent> = {}): void {
    seq += 1;
    const event: TurnEvent = { type, turnId, seq, at: now(), ...fields };
    events.push(event);
    if (events.length > KEPT_EVENTS) events.shift();
    emit(event);
  }

  /** Marks a turn ended and forgets the oldest ended ones past the limit. */
  function end(turnId: string): void {
    phases.set(turnId, 'ended');
    const ended = [...phases].filter(([, phase]) => phase === 'ended');
    for (const [oldest] of ended.slice(0, Math.max(0, ended.length - KEPT_ENDED))) {
      phases.delete(oldest);
      for (const [request, id] of byRequest) if (id === oldest) byRequest.delete(request);
    }
  }

  function finished(turnId: string, outcome: TurnOutcome): void {
    active = null;
    end(turnId);
    if (outcome.status === 'committed') say(turnId, 'committed', { responseId: outcome.responseId });
    else if (outcome.status === 'cancelled') say(turnId, 'cancelled');
    else say(turnId, 'failed', { code: outcome.code });
    startNext();
  }

  function startNext(): void {
    const [next, ...rest] = queue;
    if (active !== null || next === undefined) return;
    queue = rest;
    const abort = new AbortController();
    active = { turnId: next.turnId, abort };
    phases.set(next.turnId, 'running');
    say(next.turnId, 'running', { streaming: isStreaming() });
    // A run that throws, at once or later, is a failed turn: the error's words stay out of the events.
    new Promise<TurnOutcome>((resolve) => resolve(run(next, { signal: abort.signal })))
      .catch((): TurnOutcome => ({ status: 'failed', code: 'run-threw' }))
      .then((outcome) => finished(next.turnId, outcome))
      // Only a throwing `emit` lands here, and the next turn still has to start.
      .catch(() => {
        active = null;
        startNext();
      });
  }

  const limit = (): number => (typeof capacity === 'function' ? capacity() : capacity);

  /** A queued turn out of the queue, with its end told. */
  function dropQueued(turnId: string): void {
    queue = queue.filter((turn) => turn.turnId !== turnId);
    end(turnId);
    say(turnId, 'cancelled');
  }

  return {
    submit({ requestId, text, attachments }) {
      const known = byRequest.get(requestId);
      if (known !== undefined) return { status: 'accepted', turnId: known };
      if (active !== null && queue.length >= limit()) return { status: 'refused', code: 'queue-full' };
      const turnId = newId();
      byRequest.set(requestId, turnId);
      phases.set(turnId, 'queued');
      say(turnId, 'accepted', { text });
      const mustWait = active !== null;
      queue = [...queue, { turnId, requestId, text, attachments }];
      if (mustWait) say(turnId, 'queued');
      else startNext();
      return { status: 'accepted', turnId };
    },
    edit(turnId, text) {
      const phase = phases.get(turnId);
      if (phase === undefined) return { status: 'unknown' };
      if (phase !== 'queued') return { status: 'too-late' };
      queue = queue.map((turn) => (turn.turnId === turnId ? { ...turn, text } : turn));
      say(turnId, 'edited', { text });
      return { status: 'ok' };
    },
    remove(turnId) {
      const phase = phases.get(turnId);
      if (phase === undefined) return { status: 'unknown' };
      if (phase !== 'queued') return { status: 'too-late' };
      dropQueued(turnId);
      return { status: 'ok' };
    },
    cancel(turnId) {
      const phase = phases.get(turnId);
      if (phase === undefined) return { status: 'unknown' };
      if (phase === 'ended') return { status: 'finished' };
      if (phase === 'queued') {
        dropQueued(turnId);
        return { status: 'cancelled' };
      }
      if (active?.turnId === turnId) active.abort.abort();
      return { status: 'cancelling' };
    },
    queued: () => queue,
    progress(turnId, step) {
      if (active?.turnId === turnId) say(turnId, 'progress', step);
    },
    replay: (after) => events.filter((event) => event.seq > after),
  };
}
