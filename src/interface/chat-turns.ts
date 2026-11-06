// The turns of the owner's command line, as the client sees them. A line goes through the event door the moment it arrives,
// like a message of any other interface, so memory observes it at once and the pipeline's own queue (src/pipeline/pending-queue.ts)
// decides when its turn runs. The turn control (src/turn/control.ts) holds only the states and the order the client shows: its
// `run` waits for the end of the turn over the message. A said line cannot be unsaid, so its text cannot be edited, and a
// cancel takes back its turn and leaves its source: the runner reads the line's signal by the message id (`cancelOf`) and ends
// an aborted turn before any request. No other interface's line comes here, so a turn over one has no signal and runs as it
// always did. The pipeline may answer a line inside another line's turn or drop one it saw answered, so a line can have no turn
// of its own: a later line's turn starting, or a stretch with no turn running anywhere, ends its wait. The states live in this
// process, and `turn.replay` names the core's instance so a client learns of a restart. src/interface/neptunia-cli.ts holds one.

import { randomUUID } from 'node:crypto';
import { ackOf } from '../protocol/index.ts';
import type { Logger } from '../protocol/serve.ts';
import { TURN_EVENT_STATUS, readTurnAction } from '../protocol/turn-control.ts';
import type { Envelope } from '../protocol/wire.ts';
import { createTurnControl } from '../turn/control.ts';
import type { TurnAttachment, TurnOutcome, TurnRun } from '../turn/control.ts';
import type { AdapterLink, From, LinkDoor } from './link.ts';

/** How often a line with no turn yet is looked at. Decided 2026-11-05: the row above the input is all that waits on it. */
const WATCH_MS = 5000;
/**
 * How long nothing may run before a line counts as having no turn: past the drain's longest pause of 9 seconds and a turn's
 * wait for its author. Decided 2026-11-05.
 */
const NO_TURN_WAIT_MS = 30_000;
/** How many lines the row above the input tracks: far past a screen. The pipeline's queue bounds what actually waits. */
const SHOWN_QUEUE = 64;
/** How many lines stay known, so a resend and a late turn end find their own. Decided 2026-11-05. */
const KEPT_LINES = 256;

/** The turn outcomes that answer the line: she spoke, or chose silence. */
const ANSWERED: ReadonlySet<string> = new Set(['spoke', 'skip']);

type Loose = Record<string, unknown>;
const looseOf = (value: unknown): Loose => (value !== null && typeof value === 'object' ? (value as Loose) : {});
const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');

/** One line on its way: the cancel the runner reads, whether its turn began, and how it ended once that is known. */
type TrackedLine = {
  id: string;
  turnId: string | null;
  controller: AbortController;
  hasStarted: boolean;
  outcome: TurnOutcome | null;
  settled: ((outcome: TurnOutcome) => void) | null;
  onNoTurn: () => void;
};

/** The turn's end as src/core.ts hears it. */
type TurnEnd = {
  trigger: { id: string | null } | null;
  outcome: string;
  reason: string | null;
  turnId?: unknown;
};

type Answer = { text: string; status: string };

/** The images of a message, as the control carries them to the client's picture. */
function attachmentsOf(message: Loose): Array<TurnAttachment> {
  const list = Array.isArray(message.attachments) ? (message.attachments as Array<unknown>) : [];
  return list.map((raw) => {
    const one = looseOf(raw);
    return {
      id: textOf(one.id),
      name: textOf(one.name),
      contentType: textOf(one.contentType),
      reference: textOf(one.url),
      ...(typeof one.size === 'number' ? { size: one.size } : {}),
    };
  });
}

export type ChatTurns = {
  /** A line of the command line, through the door at once. The answer is the door's. */
  take(line: {
    id: string;
    value: Envelope;
    message: Loose;
    from?: From;
    onHeld: () => void;
    onNoTurn: () => void;
  }): Promise<Envelope>;
  turnEnded(end: TurnEnd): void;
  /** The cancel of the turn over the message `triggerId`, or null for any other turn. Its reading marks the turn begun. */
  cancelOf(triggerId: string | null): AbortSignal | null;
  noteProgress(triggerId: string | null, step: { name: string; detail: string }): void;
  /** A `turn.*` command of the owner on `link`. */
  command(link: AdapterLink, name: string, args: Record<string, unknown>): Answer;
};

export function createChatTurns({
  door,
  linesHeld,
  isAnyTurnRunning,
  log,
  now = Date.now,
  newId = randomUUID,
  watchMs = WATCH_MS,
  noTurnWaitMs = NO_TURN_WAIT_MS,
}: {
  door: LinkDoor;
  linesHeld: () => boolean;
  isAnyTurnRunning: () => boolean;
  log: Logger;
  now?: () => number;
  newId?: () => string;
  watchMs?: number;
  noTurnWaitMs?: number;
}): ChatTurns {
  const instance = newId();
  // Insertion order is the arrival order.
  const lines = new Map<string, TrackedLine>();
  const subscribers = new Set<AdapterLink>();

  function settle(line: TrackedLine, outcome: TurnOutcome): void {
    line.outcome ??= outcome;
    line.settled?.(line.outcome);
  }

  /** A line with no turn: the client hears it, and whoever waits on the line. */
  function noOwnTurn(line: TrackedLine): void {
    if (line.outcome !== null) return;
    settle(line, { status: 'failed', code: 'no-own-turn' });
    line.onNoTurn();
  }

  /** The line's turn began or ended: every line before it that never had one will have none. */
  function endEarlierThan(line: TrackedLine): void {
    for (const earlier of lines.values()) {
      if (earlier === line) return;
      if (!earlier.hasStarted) noOwnTurn(earlier);
    }
  }

  /** Waits until the line's turn begins, and counts only time with no turn running anywhere: another turn may hold it up. */
  function watch(line: TrackedLine): void {
    let idleMs = 0;
    const timer = setInterval(() => {
      if (line.hasStarted || line.outcome !== null) {
        clearInterval(timer);
        return;
      }
      idleMs = isAnyTurnRunning() ? 0 : idleMs + watchMs;
      if (idleMs < noTurnWaitMs) return;
      clearInterval(timer);
      noOwnTurn(line);
    }, watchMs);
    timer.unref();
  }

  async function waitForLine(turn: TurnRun, signal: AbortSignal): Promise<TurnOutcome> {
    const line = lines.get(turn.requestId);
    if (line === undefined) return { status: 'failed', code: 'line-lost' };
    signal.addEventListener('abort', () => line.controller.abort(), { once: true });
    if (line.outcome !== null) return line.outcome;
    watch(line);
    return new Promise<TurnOutcome>((resolve) => {
      line.settled = resolve;
    });
  }

  const control = createTurnControl({
    capacity: SHOWN_QUEUE,
    newId,
    now,
    emit(event) {
      for (const link of subscribers) {
        if (link.isClosed()) {
          subscribers.delete(link);
          continue;
        }
        void link
          .answerCommand({ replyRef: TURN_EVENT_STATUS, text: JSON.stringify(event), status: TURN_EVENT_STATUS })
          .catch((err: unknown) => log.warn('commands: turn event not sent', { error: err }));
      }
    },
    run: (turn, { signal }) => waitForLine(turn, signal),
  });

  const queueRows = (): string =>
    JSON.stringify(control.queued().map((turn) => ({ turnId: turn.turnId, text: turn.text })));

  const lineOfTurn = (turnId: string): TrackedLine | null =>
    [...lines.values()].find((line) => line.turnId === turnId) ?? null;

  /** What the control says of a cancel or a removal, with the line's own turn taken back when the line still waits. */
  function takeBack(turnId: string, status: string): Answer {
    if (status === 'cancelled' || status === 'ok') lineOfTurn(turnId)?.controller.abort();
    return { text: status, status: 'ok' };
  }

  return {
    async take({ id, value, message, from, onHeld, onNoTurn }) {
      if (lines.has(id)) return ackOf(value, 'duplicate');
      const line: TrackedLine = {
        id,
        turnId: null,
        controller: new AbortController(),
        hasStarted: false,
        outcome: null,
        settled: null,
        onNoTurn,
      };
      lines.set(id, line);
      for (const oldest of lines.keys()) {
        if (lines.size <= KEPT_LINES) break;
        lines.delete(oldest);
      }
      const answer = control.submit({
        requestId: id,
        text: textOf(message.content),
        attachments: attachmentsOf(message),
      });
      // Past what the row shows the line simply is not tracked: it still goes to her.
      if (answer.status === 'accepted') line.turnId = answer.turnId;
      const ack = await door.receive(value, from);
      const status = looseOf(ack.body).status;
      if (status !== 'ok') settle(line, { status: 'failed', code: `door-${String(status)}` });
      else if (linesHeld()) {
        onHeld();
        settle(line, { status: 'failed', code: 'paused' });
      }
      return ack;
    },
    turnEnded(end) {
      const id = end.trigger?.id;
      const line = typeof id === 'string' ? lines.get(id) : undefined;
      // A busy turn never began: the pipeline holds its line, and the line's watch goes on.
      if (line === undefined || end.outcome === 'busy') return;
      line.hasStarted = true;
      endEarlierThan(line);
      if (ANSWERED.has(end.outcome))
        settle(line, {
          status: 'committed',
          responseId: typeof end.turnId === 'string' ? end.turnId : (line.turnId ?? line.id),
        });
      else if (end.outcome === 'cancelled') settle(line, { status: 'cancelled' });
      else settle(line, { status: 'failed', code: end.reason ?? end.outcome });
    },
    cancelOf(triggerId) {
      const line = triggerId === null ? undefined : lines.get(triggerId);
      if (line === undefined) return null;
      line.hasStarted = true;
      endEarlierThan(line);
      return line.controller.signal;
    },
    noteProgress(triggerId, step) {
      const turnId = triggerId === null ? null : (lines.get(triggerId)?.turnId ?? null);
      if (turnId === null) return;
      control.progress(turnId, { kind: step.name.startsWith('task.') ? 'task' : 'tool', ...step });
    },
    command(link, name, args) {
      const read = readTurnAction({ ...args, kind: name });
      if (!read.ok) return { text: `not a turn action (${read.reason})`, status: 'invalid' };
      const { action } = read;
      switch (action.kind) {
        case 'turn.cancel':
          return takeBack(action.turnId, control.cancel(action.turnId).status);
        case 'turn.remove':
          return takeBack(action.turnId, control.remove(action.turnId).status);
        case 'turn.queue':
          return { text: queueRows(), status: 'ok' };
        case 'turn.replay':
          subscribers.add(link);
          return { text: JSON.stringify({ instance, events: control.replay(action.after) }), status: 'ok' };
      }
    },
  };
}
