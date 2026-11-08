// What the core does with the messages that arrive while it is paused (`/pause`, `/nep pause`), and how the resume
// hands them back. src/core.ts and the message pipeline (pipeline.js) call it.
//
// While paused, the door's handler marks each new message as held: its ingestion row (memory.db's `ingest`) carries
// the whole event in `held` (`holdIfPaused`), committed with the row before the core acknowledges the event, so a
// restart while paused keeps it. The pipeline observes the line into the memory database as the live path would
// (`observeWhilePaused`) and runs no turn. On resume, `resumeHeld` hands each held event, oldest first, once to the
// pipeline's catch-up path as history, with no turn (the owner's no-catch-up policy, 2026-11-02; a direct chat was
// observed while paused and needs nothing more), clears its hold through the writer after it, and then drains the
// queued direct pings. A pause that comes back during the replay stops it, and what is left waits for the next resume.
//
// It also holds the rule of the owner's command line for the direct chats: a direct chat of `iface: 'cli'` is the
// owner's own, so it passes whatever dm.enabled and bot.owners say (`dmChatsOff`, `CLI_GATE`). The private gate, the
// missed-answer recovery, the wake drain and the posting checks all ask `dmChatsOff`.

import type { AcceptedMessageEvent } from '../pipeline/types.ts';
import type { HeldEvent } from '../memory/db/ingest.ts';

type Loose = Record<string, unknown>;
const looseOf = (value: unknown): Loose => (value !== null && typeof value === 'object' ? (value as Loose) : {});

/** The namespace of the owner's command line, which only the `cli` principal may name (src/interface/link.ts). */
export const CLI_IFACE = 'cli';

/** The partner of the owner's own chat: nobody a root's interface knows. */
export const isCliOwner = (iface: unknown, accountId: unknown): boolean => iface === CLI_IFACE && accountId === 'owner';

/**
 * The private-chat gate's answer for the owner's command line (src/pipeline/private-gate.ts#checkPrivateGate): it lets
 * it through.
 */
export const CLI_GATE = Object.freeze({ gate: Object.freeze({ ok: true }), isOwner: true });

/** Whether direct chats are off for `event`: `dm.enabled` is not on and the chat is not the owner's. */
export const dmChatsOff = (config: unknown, event: unknown): boolean =>
  looseOf(looseOf(config).dm).enabled !== true && looseOf(event).iface !== CLI_IFACE;

/** The event without the platform handles an in-process interface attaches: what the hold stores. */
export function heldEventOf(event: unknown): Loose {
  const copy = { ...looseOf(event) };
  delete copy.raw;
  delete copy.rawPrevious;
  return copy;
}

/** Whether the store's state says the core is paused (`state.data.paused`, src/memory/store.ts). */
export const isPausedIn = (store: unknown): boolean => looseOf(looseOf(looseOf(store).state).data).paused === true;

/**
 * Marks the ingestion row (`context.ingest`, the door's) of a new message as held while the store says the core is
 * paused; an edit, a deletion and another kind pass.
 */
export function holdIfPaused(event: unknown, context: unknown, store: unknown): void {
  const fields = looseOf(event);
  const row = looseOf(context).ingest;
  if (!isPausedIn(store) || row === null || typeof row !== 'object') return;
  if (fields.kind !== 'message.received' || fields.edit === true || fields.deleted === true) return;
  (row as Loose).held = heldEventOf(event);
}

/** Where the pipeline is when a line arrives while paused. */
type PausedPlace = {
  selfId: string;
  isServed: (placeId: string | null | undefined) => boolean;
  sharedPlaceOf?: (chat: never, iface: string) => string;
};

/** The place of a paused line's record, as the store names it; the native id with no store at hand. */
function placeOf(place: PausedPlace, chat: Record<string, unknown>, iface: unknown): string {
  return place.sharedPlaceOf ? place.sharedPlaceOf(chat as never, String(iface)) : String(chat.rootId ?? chat.id);
}

/**
 * How a line that arrives while paused is observed: `direct` and the record it belongs to, or null for a line the live
 * path would not observe now. A line of the served place outside threads is observed, hers or a
 * member's, another bot's not. A direct chat is observed only from the owner's command line: any other waits for its
 * private-chat gate at the resume.
 */
function pausedObservation(
  event: unknown,
  place: PausedPlace
): { direct: boolean; where: { placeId?: string } } | null {
  const fields = looseOf(event);
  const message = looseOf(fields.message);
  const author = looseOf(message.author);
  const chat = looseOf(fields.chat);
  if (fields.edit === true || fields.deleted === true || message.system === true) return null;
  if (chat.rootId === null || chat.rootId === undefined) {
    if (fields.iface !== CLI_IFACE || author.self === true || typeof author.id !== 'string') return null;
    if (chat.partnerId === undefined || chat.partnerId === null) return null;
    return { direct: true, where: { placeId: placeOf(place, chat, fields.iface) } };
  }
  if (!place.isServed(chat.rootId as string | null | undefined)) return null;
  if (author.bot === true && author.id !== place.selfId) return null;
  return {
    direct: looseOf(fields.addressing).mentioned === true,
    where: { placeId: placeOf(place, chat, fields.iface) },
  };
}

/** What the pipeline observes a paused line with: the hot config, the served place, her id and its observe path. */
export type PausedDeps = {
  hot: unknown;
  isServed: (placeId: string | null | undefined) => boolean;
  sharedPlaceOf?: (chat: never, iface: string) => string;
  selfIdOf: () => unknown;
  observeLine: (
    event: never,
    direct: boolean,
    where: object,
    acceptedEvent?: AcceptedMessageEvent
  ) => Promise<unknown> | null;
};

/** Observes a line that arrives while paused into the memory database, awaited; nothing else happens to it here. */
export async function observeWhilePaused(
  event: unknown,
  deps: PausedDeps,
  acceptedEvent?: AcceptedMessageEvent
): Promise<void> {
  const selfId = deps.selfIdOf();
  const observed = pausedObservation(event, {
    selfId: typeof selfId === 'string' ? selfId : '',
    isServed: deps.isServed,
    ...(deps.sharedPlaceOf === undefined ? {} : { sharedPlaceOf: deps.sharedPlaceOf }),
  });
  // The pipeline's observe path takes the event the door validated.
  if (observed !== null) await deps.observeLine(event as never, observed.direct, observed.where, acceptedEvent);
}

/**
 * What the resume needs from the core: the ingestion record, the message handler (pipeline.js, with `catchUp`,
 * `onPrivate` and `drainPending`), the hot config and the store, read at the call.
 */
export type ResumeDeps = {
  ingest: { held(): Array<HeldEvent>; release(principal: string, eventId: string): Promise<unknown> };
  handler: unknown;
  hot: unknown;
  store: unknown;
  now(): number;
  log: { info(msg: string, meta?: unknown): void };
};

/** `owner.name(...args)` when `owner` has that method, else nothing. */
async function callOn(owner: unknown, name: string, args: Array<unknown>): Promise<void> {
  // The message handler is a function that carries its methods.
  const method: unknown =
    owner !== null && (typeof owner === 'object' || typeof owner === 'function') ? Reflect.get(owner, name) : null;
  if (typeof method === 'function') await Reflect.apply(method, owner, args);
}

/** The resume's hand-back of the held messages, then of the queued direct pings. Answers how many were replayed. */
export async function resumeHeld(deps: ResumeDeps): Promise<number> {
  const isPaused = (): boolean => isPausedIn(deps.store);
  let replayed = 0;
  for (const held of deps.ingest.held()) {
    if (isPaused()) break;
    if (looseOf(held.event.chat).rootId !== null)
      await callOn(deps.handler, 'catchUp', [held.event, { trigger: false }]);
    await deps.ingest.release(held.principal, held.eventId);
    replayed += 1;
  }
  deps.log.info('index: resume replayed', { messages: replayed });
  if (!isPaused()) await callOn(deps.handler, 'drainPending', []);
  return replayed;
}
