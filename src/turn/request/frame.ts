// The turn frame: the facts of one turn, fixed once before any block of its request. What kind of turn it is, where she
// is if anywhere, who she talks to if anyone, which message it answers, why she is awake and which tags the turn may
// hold. `turnKindOf` reads the kind off the three fields the callers still pass, `blocksOf` is the one list of tags per
// kind and `frameOf` builds the value. Pure. The request step (src/turn/phases/request/build.ts) calls it.

import type { WakeKind } from '../../behavior/inner/types.ts';
import type { PlaceChainLink } from '../../memory/db/place-tree.ts';

export type TurnKind =
  | 'reply'
  | 'heartbeat'
  | 'selfimprovement'
  | 'intention'
  | 'feedback'
  | 'errand_result'
  | 'selfreflection_plan'
  | 'selfreflection';

export type AwakeReason = 'message' | 'wake' | 'errand' | 'selfreflection';

/** The root tags of the ordinary turn and of the service template. */
export type BlockName =
  | 'persona'
  | 'self'
  | 'surroundings'
  | 'memory'
  | 'recall'
  | 'inner'
  | 'meanwhile'
  | 'virtual_world'
  | 'spatial_awareness'
  | 'chat'
  | 'task';

/** A place of the frame. `path` runs from the interface down by names, a one-to-one chat's ends in the partner's native id. */
export type FramePlace = {
  readonly id: string;
  readonly name: string | null;
  readonly kind: string | null;
  readonly path: ReadonlyArray<string>;
};

/** Somebody she talks to. A name is null until the interface has given one. */
export type FrameParty = { readonly personId: string; readonly accountId: string; readonly name: string | null };

export type FrameAnswers = { readonly messageId: string; readonly authorId: string };

export type Frame = {
  readonly kind: TurnKind;
  readonly place: FramePlace | null;
  readonly root: FramePlace | null;
  /** The stored chain of `place`, the place first, empty with no place: `<spatial_awareness>` renders it link by link. */
  readonly chain: ReadonlyArray<PlaceChainLink>;
  readonly interface: string;
  readonly scope: 'group' | 'dm' | 'internal';
  readonly counterpart: FrameParty | null;
  readonly answers: FrameAnswers | null;
  readonly now: number;
  readonly timezone: string;
  readonly awake: AwakeReason;
  /** The wake beside `awake: 'wake'`, null on any other turn. */
  readonly wakeKind: string | null;
  readonly blocks: ReadonlyArray<BlockName>;
};

export type FrameInput = {
  readonly mode: string;
  readonly triggerKind: string | null;
  readonly wakeKind: string | null;
  readonly interface: string;
  /** The turn's place as `placeChainInDb` reads it, the place first. Empty when the turn has none. */
  readonly chain: ReadonlyArray<PlaceChainLink>;
  /** What a one-to-one chat adds: the interface's word for it, the partner's native id, the partner when known. */
  readonly dm: { readonly word: string; readonly nativeId: string; readonly partner: FrameParty | null } | null;
  readonly trigger: FrameAnswers | null;
  readonly author: FrameParty | null;
  readonly now: number;
  readonly timezone: string;
};

/** A required fact of a turn is missing. `code` names which. */
export class FrameError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'FrameError';
    this.code = code;
  }
}

/**
 * The kind of an inner turn by its wake. The review keeps an intention's task and whereabouts until slice 5 of the plan
 * deletes it, since `prompts.inner` is its task text today.
 */
const KIND_OF_WAKE: Readonly<Record<WakeKind, TurnKind>> = Object.freeze({
  heartbeat: 'heartbeat',
  selfimprovement: 'selfimprovement',
  feedback: 'feedback',
  intention_due: 'intention',
  attend: 'intention',
  errand_deadline: 'intention',
  review: 'intention',
});

const isWakeKind = (value: string): value is WakeKind => Object.hasOwn(KIND_OF_WAKE, value);

/**
 * The kind of a turn from the fields the callers pass. `reply`, `interject`, `initiate`, `elsewhere` and `auto` give a
 * reply, and an errand's trigger on any of them gives `errand_result`.
 */
export function turnKindOf(mode: string, triggerKind: string | null, wakeKind: string | null): TurnKind {
  if (mode === 'selfreflection') return 'selfreflection';
  if (mode === 'inner') {
    if (wakeKind !== null && isWakeKind(wakeKind)) return KIND_OF_WAKE[wakeKind];
    return triggerKind === 'errand' ? 'errand_result' : 'intention';
  }
  return triggerKind === 'errand' ? 'errand_result' : 'reply';
}

/** The kind of a request: its frame's, or read off its fields when it was built with no frame. */
export function kindOfRequest(given: {
  readonly frame?: Frame | null;
  readonly mode: string;
  readonly triggerKind?: string | null;
  readonly wakeKind?: string | null;
}): TurnKind {
  return given.frame?.kind ?? turnKindOf(given.mode, given.triggerKind ?? null, given.wakeKind ?? null);
}

const ORDINARY: ReadonlyArray<BlockName> = Object.freeze([
  'persona',
  'self',
  'surroundings',
  'memory',
  'recall',
  'inner',
  'meanwhile',
  'spatial_awareness',
  'chat',
  'task',
] as const);

const SERVICE: ReadonlyArray<BlockName> = Object.freeze([
  'persona',
  'self',
  'memory',
  'recall',
  'inner',
  'meanwhile',
  'spatial_awareness',
  'task',
] as const);

const SELFREFLECTION: ReadonlyArray<BlockName> = Object.freeze([
  'persona',
  'self',
  'memory',
  'recall',
  'inner',
  'meanwhile',
  'virtual_world',
  'spatial_awareness',
  'task',
] as const);

/** The tags of a kind. A kind that may have a place reads the ordinary turn there and the service list without one. */
export function blocksOf(kind: TurnKind, place: FramePlace | null): ReadonlyArray<BlockName> {
  switch (kind) {
    case 'reply':
      return ORDINARY;
    case 'intention':
    case 'feedback':
    case 'errand_result':
      return place === null ? SERVICE : ORDINARY;
    case 'heartbeat':
    case 'selfimprovement':
      return SERVICE;
    case 'selfreflection_plan':
    case 'selfreflection':
      return SELFREFLECTION;
  }
}

const ALWAYS: ReadonlyArray<BlockName> = Object.freeze(['persona', 'self', 'spatial_awareness', 'task'] as const);

/** The tags a kind may not omit. */
export const REQUIRED_BY_KIND: Readonly<Record<TurnKind, ReadonlyArray<BlockName>>> = Object.freeze({
  reply: Object.freeze([...ALWAYS, 'chat'] as const),
  heartbeat: ALWAYS,
  selfimprovement: ALWAYS,
  intention: ALWAYS,
  feedback: ALWAYS,
  errand_result: ALWAYS,
  selfreflection_plan: ALWAYS,
  selfreflection: ALWAYS,
});

/** The kinds that are nowhere: whatever place their turn rides in on is transport. */
const NOWHERE: ReadonlySet<TurnKind> = new Set<TurnKind>([
  'heartbeat',
  'selfimprovement',
  'selfreflection_plan',
  'selfreflection',
]);

function placeAndRoot(input: FrameInput, chain: ReadonlyArray<PlaceChainLink>): Pick<Frame, 'place' | 'root'> {
  const [here] = chain;
  if (here === undefined) return { place: null, root: null };
  const { dm } = input;
  if (dm !== null) {
    const path = [input.interface, dm.word, dm.nativeId];
    return { place: { id: here.id, name: null, kind: here.kind, path }, root: null };
  }
  const placeAt = (index: number): FramePlace => {
    const link = chain[index] ?? here;
    const names = chain.slice(index).map((one) => one.name ?? one.id);
    return { id: link.id, name: link.name, kind: link.kind, path: [input.interface, ...names.reverse()] };
  };
  return { place: placeAt(0), root: chain.length > 1 ? placeAt(chain.length - 1) : null };
}

function awakeOf(kind: TurnKind, wakeKind: string | null): AwakeReason {
  if (kind === 'selfreflection' || kind === 'selfreflection_plan') return 'selfreflection';
  if (kind === 'errand_result') return 'errand';
  return wakeKind === null ? 'message' : 'wake';
}

/**
 * The frame of one turn.
 * @throws {FrameError} `PLACE_REQUIRED` for a reply with no place.
 */
export function frameOf(input: FrameInput): Frame {
  const kind = turnKindOf(input.mode, input.triggerKind, input.wakeKind);
  const chain = NOWHERE.has(kind) ? [] : input.chain;
  if (kind === 'reply' && chain.length === 0) throw new FrameError('PLACE_REQUIRED', 'a reply needs a place');
  const { place, root } = placeAndRoot(input, chain);
  const somewhere = place !== null;
  return {
    kind,
    place,
    root,
    chain,
    interface: input.interface,
    scope: !somewhere ? 'internal' : input.dm === null ? 'group' : 'dm',
    counterpart: somewhere ? (input.dm?.partner ?? input.author) : null,
    answers: somewhere ? input.trigger : null,
    now: input.now,
    timezone: input.timezone,
    awake: awakeOf(kind, input.wakeKind),
    wakeKind: input.wakeKind,
    blocks: blocksOf(kind, place),
  };
}

/** The kinds whose request is the frame's: its tags in its order, filtered by `blocks`. The others keep the old emission. */
const FRAMED_KINDS: ReadonlySet<TurnKind> = new Set<TurnKind>(['reply', 'errand_result']);

/** Whether a request built with `frame` is the frame's own (`<memory>`, `<recall>`, `<meanwhile>` and the rest). */
export const framedRequest = (frame: Frame | null | undefined): frame is Frame =>
  frame !== null && frame !== undefined && FRAMED_KINDS.has(frame.kind);

/**
 * Whether a turn of `mode` and `triggerKind` will build the frame's request, known before its frame is: a turn with a
 * `source` (a routed or noticed call) keeps the old emission, so the pulls and the elsewhere pick serve only those.
 */
export const framedTurn = (mode: string, triggerKind: string | null, source: unknown): boolean =>
  !source && FRAMED_KINDS.has(turnKindOf(mode, triggerKind, null));
