// The client's picture of the turns, built only from the core's events: a turn is running because the core said so, and it
// has stopped only when the core says that too. A mark says the owner asked for a cancel, and it changes no state. An event
// at or below a turn's newest `seq` is a replay and adds nothing. cli/chat-controller.ts holds the state and draws from it.

export type TurnProgress = { kind: 'tool' | 'task'; name: string; detail: string };

/** One event as the core sends it (src/protocol/turn-control.ts). This package imports nothing of the engine. */
export type ClientTurnEvent = {
  type: 'accepted' | 'queued' | 'edited' | 'running' | 'text' | 'progress' | 'committed' | 'cancelled' | 'failed';
  turnId: string;
  seq: number;
  at: number;
  text?: string;
  streaming?: boolean;
  kind?: TurnProgress['kind'];
  name?: string;
  detail?: string;
  responseId?: string;
  code?: string;
};

type TurnPhase = 'accepted' | 'queued' | 'running' | 'committed' | 'cancelled' | 'failed';

export type ClientTurn = {
  turnId: string;
  state: TurnPhase;
  /** the line as the core holds it */
  line: string;
  /** what the route streamed so far, or the final text the core sent */
  text: string;
  /** whether the route sends text as it is made; a route that sends only the answer shows none before it */
  streaming: boolean;
  progress: ReadonlyArray<TurnProgress>;
  responseId: string | null;
  code: string | null;
  cancelRequested: boolean;
  lastSeq: number;
};

export type TurnsState = { order: ReadonlyArray<string>; turns: ReadonlyMap<string, ClientTurn> };

/** How many ended turns the picture keeps: nothing reads further back than the last few. */
const ENDED_KEPT = 32;
const ENDED: ReadonlySet<TurnPhase> = new Set(['committed', 'cancelled', 'failed']);

export const emptyTurns = (): TurnsState => ({ order: [], turns: new Map() });

export const turnOf = (state: TurnsState, turnId: string): ClientTurn | null => state.turns.get(turnId) ?? null;

export const activeTurn = (state: TurnsState): ClientTurn | null =>
  [...state.turns.values()].find((turn) => turn.state === 'running') ?? null;

/** The turns that wait, in the order the core took them. */
export const queuedTurns = (state: TurnsState): Array<ClientTurn> =>
  state.order.flatMap((id) => {
    const turn = state.turns.get(id);
    return turn?.state === 'queued' ? [turn] : [];
  });

function withTurn(state: TurnsState, turn: ClientTurn): TurnsState {
  const turns = new Map(state.turns).set(turn.turnId, turn);
  const order = state.order.includes(turn.turnId) ? state.order : [...state.order, turn.turnId];
  const ended = order.filter((id) => ENDED.has(turns.get(id)?.state ?? 'queued'));
  const gone = new Set(ended.slice(0, Math.max(0, ended.length - ENDED_KEPT)));
  for (const id of gone) turns.delete(id);
  return { order: order.filter((id) => !gone.has(id)), turns };
}

/** The turn after `event`, which is newer than anything it holds. */
function nextTurn(turn: ClientTurn, event: ClientTurnEvent): ClientTurn {
  const moved = { ...turn, lastSeq: event.seq };
  switch (event.type) {
    case 'accepted':
      return { ...moved, state: 'accepted', line: event.text ?? turn.line };
    case 'queued':
      return { ...moved, state: 'queued' };
    case 'edited':
      return { ...moved, line: event.text ?? turn.line };
    case 'running':
      return { ...moved, state: 'running', streaming: event.streaming === true };
    case 'text':
      return { ...moved, text: turn.text + (event.text ?? '') };
    case 'progress':
      return {
        ...moved,
        progress: [
          ...turn.progress,
          { kind: event.kind ?? 'tool', name: event.name ?? '', detail: event.detail ?? '' },
        ],
      };
    case 'committed':
      // The core's text stands exactly as it came, and a turn with none keeps what it showed.
      return { ...moved, state: 'committed', text: event.text ?? turn.text, responseId: event.responseId ?? null };
    case 'cancelled':
      return { ...moved, state: 'cancelled' };
    case 'failed':
      return { ...moved, state: 'failed', code: event.code ?? null };
  }
}

const blankTurn = (turnId: string): ClientTurn => ({
  turnId,
  state: 'accepted',
  line: '',
  text: '',
  streaming: false,
  progress: [],
  responseId: null,
  code: null,
  cancelRequested: false,
  lastSeq: 0,
});

export function reduceTurns(state: TurnsState, event: ClientTurnEvent): TurnsState {
  const turn = state.turns.get(event.turnId) ?? blankTurn(event.turnId);
  // A replayed event, or a late word about a turn whose end is known: the end is final.
  if (event.seq <= turn.lastSeq || ENDED.has(turn.state)) return state;
  return withTurn(state, nextTurn(turn, event));
}

/** Marks that the owner asked to cancel `turnId`. Nothing else changes, and an unknown or ended turn gives the same state. */
export function requestCancel(state: TurnsState, turnId: string): TurnsState {
  const turn = state.turns.get(turnId);
  if (turn === undefined || ENDED.has(turn.state) || turn.cancelRequested) return state;
  return withTurn(state, { ...turn, cancelRequested: true });
}
