// The lines of the owner's command line on their way to her turns. Each line takes its place in the turn control
// (src/turn/control.ts), and when its turn comes it goes through the event door like any other interface's message, so what
// happens to it after the door is what happens on every interface. The run ends when the core's turn over that message ends,
// and the runner reads the run's signal by the message's id (`cancelOf`). No other interface's line comes here, so a turn
// over one has no signal and runs as it always did. The queue lives in this process: a core that restarts holds none of it,
// and `turn.replay` names the core's instance so a client learns that. src/interface/neptunia-cli.ts holds one of these.

import { randomUUID } from 'node:crypto';
import { ackOf } from '../protocol/index.ts';
import type { Logger } from '../protocol/serve.ts';
import { TURN_EVENT_STATUS, readTurnAction } from '../protocol/turn-control.ts';
import type { Envelope } from '../protocol/wire.ts';
import { createTurnControl } from '../turn/control.ts';
import type { TurnAttachment, TurnOutcome, TurnRun } from '../turn/control.ts';
import type { AdapterLink, From, LinkDoor } from './link.ts';

/** How long a line's turn may take to end: the same 15 minutes `neptunia -p` waits for one. Decided 2026-11-05. */
const TURN_END_WAIT_MS = 15 * 60 * 1000;

/** The turn outcomes that answer the line: she spoke, or chose silence. */
const ANSWERED: ReadonlySet<string> = new Set(['spoke', 'skip']);

type Loose = Record<string, unknown>;
const looseOf = (value: unknown): Loose => (value !== null && typeof value === 'object' ? (value as Loose) : {});
const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');

/** One line the control holds: its envelope as it came, and the door's answer once it went through. */
type HeldLine = { value: unknown; from: From | undefined; ack: Promise<Envelope> | null; onHeld: () => void };

/** The turn's end as src/core.ts hears it. */
type TurnEnd = {
  trigger: { id: string | null } | null;
  outcome: string;
  reason: string | null;
  turnId?: unknown;
};

type Answer = { text: string; status: string };

/** The images of a message, as the control carries them to the turn. */
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

/** The envelope `value` with the text of a line edited in the queue. */
function withText(value: unknown, text: string): unknown {
  const envelope = looseOf(value);
  const body = looseOf(envelope.body);
  const message = looseOf(body.message);
  if (message.content === text) return value;
  return { ...envelope, body: { ...body, message: { ...message, content: text, sourceText: text } } };
}

export type ChatTurns = {
  /** A line of the command line. The answer is the door's when it runs at once, else that the core took it. */
  take(line: { id: string; value: Envelope; message: Loose; from?: From; onHeld: () => void }): Promise<Envelope>;
  turnEnded(end: TurnEnd): void;
  /** The signal of the run over the message `triggerId`, or null when no run of the chat is over it. */
  cancelOf(triggerId: string | null): AbortSignal | null;
  noteProgress(triggerId: string | null, step: { name: string; detail: string }): void;
  /** A `turn.*` command of the owner on `link`. */
  command(link: AdapterLink, name: string, args: Record<string, unknown>): Answer;
};

export function createChatTurns({
  door,
  linesHeld,
  capacity,
  log,
  now = Date.now,
  newId = randomUUID,
  endWaitMs = TURN_END_WAIT_MS,
}: {
  door: LinkDoor;
  linesHeld: () => boolean;
  capacity: () => number;
  log: Logger;
  now?: () => number;
  newId?: () => string;
  endWaitMs?: number;
}): ChatTurns {
  const instance = newId();
  const lines = new Map<string, HeldLine>();
  const running = new Map<string, { turnId: string; signal: AbortSignal; end: (outcome: TurnOutcome) => void }>();
  const subscribers = new Set<AdapterLink>();

  /** The door's answer and the end of the turn over one line. A line that opens no turn fails at the wait's end. */
  async function runLine(turn: TurnRun, signal: AbortSignal): Promise<TurnOutcome> {
    const line = lines.get(turn.requestId);
    if (line === undefined) return { status: 'failed', code: 'line-lost' };
    let timer: NodeJS.Timeout | undefined;
    const ended = new Promise<TurnOutcome>((resolve) => {
      running.set(turn.requestId, { turnId: turn.turnId, signal, end: resolve });
      timer = setTimeout(() => resolve({ status: 'failed', code: 'no-turn-end' }), endWaitMs);
      timer.unref();
    });
    try {
      line.ack = door.receive(withText(line.value, turn.text), line.from);
      const status = looseOf((await line.ack).body).status;
      if (status !== 'ok') return { status: 'failed', code: `door-${String(status)}` };
      if (linesHeld()) {
        line.onHeld();
        return { status: 'failed', code: 'paused' };
      }
      return await ended;
    } finally {
      clearTimeout(timer);
      running.delete(turn.requestId);
      lines.delete(turn.requestId);
    }
  }

  const control = createTurnControl({
    capacity,
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
    run: (turn, { signal }) => runLine(turn, signal),
  });

  const queueRows = (): string =>
    JSON.stringify(control.queued().map((turn) => ({ turnId: turn.turnId, text: turn.text })));

  return {
    async take({ id, value, message, from, onHeld }) {
      if (lines.has(id)) return ackOf(value, 'duplicate');
      const line: HeldLine = { value, from, ack: null, onHeld };
      lines.set(id, line);
      const answer = control.submit({
        requestId: id,
        text: textOf(message.content),
        attachments: attachmentsOf(message),
      });
      if (answer.status === 'refused') {
        lines.delete(id);
        return ackOf(value, 'invalid', answer.code);
      }
      if (line.ack !== null) return line.ack;
      if (control.queued().some((turn) => turn.requestId === id)) return ackOf(value, 'ok');
      // The control knows this request from a turn that ended: nothing will run it again.
      lines.delete(id);
      return ackOf(value, 'duplicate');
    },
    turnEnded(end) {
      const id = end.trigger?.id;
      if (typeof id !== 'string') return;
      const run = running.get(id);
      if (run === undefined) return;
      if (ANSWERED.has(end.outcome))
        run.end({ status: 'committed', responseId: typeof end.turnId === 'string' ? end.turnId : run.turnId });
      else if (end.outcome === 'cancelled') run.end({ status: 'cancelled' });
      else run.end({ status: 'failed', code: end.reason ?? end.outcome });
    },
    cancelOf: (triggerId) => (triggerId === null ? null : (running.get(triggerId)?.signal ?? null)),
    noteProgress(triggerId, step) {
      const run = triggerId === null ? undefined : running.get(triggerId);
      if (run === undefined) return;
      control.progress(run.turnId, { kind: step.name.startsWith('task.') ? 'task' : 'tool', ...step });
    },
    command(link, name, args) {
      const read = readTurnAction({ ...args, kind: name });
      if (!read.ok) return { text: `not a turn action (${read.reason})`, status: 'invalid' };
      const { action } = read;
      switch (action.kind) {
        case 'turn.cancel':
          return { text: control.cancel(action.turnId).status, status: 'ok' };
        case 'turn.remove':
          return { text: control.remove(action.turnId).status, status: 'ok' };
        case 'turn.edit':
          return { text: control.edit(action.turnId, action.text).status, status: 'ok' };
        case 'turn.queue':
          return { text: queueRows(), status: 'ok' };
        case 'turn.replay':
          subscribers.add(link);
          return { text: JSON.stringify({ instance, events: control.replay(action.after) }), status: 'ok' };
      }
    },
  };
}
