// The turn control's messages between the core and the owner's client: the events the core sends about a line it took, and
// the actions the client sends about one. Every one names its turn, so an acknowledgement can only ever be about the turn
// it names. An event travels as a `command.result` of status `turn`, its text the event's JSON, and an action as a
// `command.requested` whose name is the action's kind. src/turn/control.ts makes the events, src/interface/chat-turns.ts
// sends them and takes the actions, and bin/cli-link.ts reads them.

/** The status of a `command.result` that carries a turn event. */
export const TURN_EVENT_STATUS = 'turn';

const EVENT_TYPES = [
  'accepted',
  'queued',
  'edited',
  'running',
  'text',
  'progress',
  'committed',
  'cancelled',
  'failed',
] as const;
export type TurnEventType = (typeof EVENT_TYPES)[number];

/**
 * One event of a turn. `seq` rises by one over everything the core's control emits. The optional fields belong to their
 * types: `text` to `accepted`, `edited` and `text`, `streaming` to `running`, `kind`, `name` and `detail` to `progress`,
 * `responseId` to `committed` and `code` to `failed`.
 */
export type TurnEvent = {
  type: TurnEventType;
  turnId: string;
  seq: number;
  at: number;
  text?: string;
  streaming?: boolean;
  kind?: 'tool' | 'task';
  name?: string;
  detail?: string;
  responseId?: string;
  code?: string;
};

/** What the client asks of the core about its turns. `turn.replay` also subscribes the link that sends it. */
export type TurnAction =
  | { kind: 'turn.cancel'; turnId: string }
  | { kind: 'turn.remove'; turnId: string }
  | { kind: 'turn.edit'; turnId: string; text: string }
  | { kind: 'turn.replay'; after: number }
  | { kind: 'turn.queue' };

export type TurnEventReading = { ok: true; event: TurnEvent } | { ok: false; reason: string };
export type TurnActionReading = { ok: true; action: TurnAction } | { ok: false; reason: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isFilled = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** The event in `value`, or why it is none. */
export function readTurnEvent(value: unknown): TurnEventReading {
  if (!isObject(value)) return { ok: false, reason: 'event:type' };
  if (!EVENT_TYPES.some((type) => type === value.type)) return { ok: false, reason: 'type:unknown' };
  if (!isFilled(value.turnId)) return { ok: false, reason: 'turnId:required' };
  if (typeof value.seq !== 'number' || !Number.isInteger(value.seq)) return { ok: false, reason: 'seq:required' };
  if (typeof value.at !== 'number') return { ok: false, reason: 'at:required' };
  // Every field the checks above leave open is optional, and a reader of one checks it where it uses it.
  return { ok: true, event: value as TurnEvent };
}

/** The action in `value`, or why it is none. A chat action reaches the turns alone, never an errand or the watcher. */
export function readTurnAction(value: unknown): TurnActionReading {
  if (!isObject(value)) return { ok: false, reason: 'action:type' };
  const { kind, turnId, text, after } = value;
  if (kind === 'turn.queue') return { ok: true, action: { kind } };
  if (kind === 'turn.replay') {
    if (typeof after !== 'number' || !Number.isInteger(after)) return { ok: false, reason: 'after:required' };
    return { ok: true, action: { kind, after } };
  }
  if (kind !== 'turn.cancel' && kind !== 'turn.remove' && kind !== 'turn.edit')
    return { ok: false, reason: 'kind:unknown' };
  if (!isFilled(turnId)) return { ok: false, reason: 'turnId:required' };
  if (kind !== 'turn.edit') return { ok: true, action: { kind, turnId } };
  if (typeof text !== 'string') return { ok: false, reason: 'text:required' };
  return { ok: true, action: { kind, turnId, text } };
}
