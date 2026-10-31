// What the core does with the messages that arrive while it is paused (`/pause`, `/nep pause`), and how the resume
// hands them back. src/core.js and the message pipeline (pipeline.js) call it.
//
// While paused, the door's handler marks each new message as held: its ingestion row (memory.db's `ingest`) carries
// the whole event in `held` (`holdIfPaused`), committed with the row before the core acknowledges the event, so a
// restart while paused keeps it. The pipeline observes the line into the memory database as the live path would
// (`observeWhilePaused`) and runs no turn. On resume, `resumeHeld` hands each held event, oldest first, once to the
// pipeline's catch-up path (a direct chat to its private-chat path), answered as a live call when
// `features.offlineCatchUp` is on and the message is younger than `offlineCatchUp.windowMinutes`, clears its hold
// through the writer after it, and then drains the queued direct pings. A pause that comes back during the replay
// stops it, and what is left waits for the next resume.
//
// It also holds the rule of the owner's command line in the private-chat gate: a direct chat of `iface: 'cli'` is the
// owner's own, so it passes whatever features.privateMessages and bot.owners say (`privateChatsOff`, `CLI_GATE`).

import { MINUTE_MS } from '../time.js';
import { catchUpSettings } from './catch-up.js';
import type { HeldEvent } from '../memory/db/ingest.ts';

type Loose = Record<string, unknown>;
const looseOf = (value: unknown): Loose => (value !== null && typeof value === 'object' ? (value as Loose) : {});

/** The namespace of the owner's command line, which only the `cli` principal may name (src/interface/link.ts). */
export const CLI_IFACE = 'cli';

/**
 * The private-chat gate's answer for the owner's command line (src/pipeline/private-gate.ts#checkPrivateGate): it lets
 * it through.
 */
export const CLI_GATE = Object.freeze({ gate: Object.freeze({ ok: true }), isOwner: true, replies: null, today: '' });

/** Whether direct chats are off for `event`: `features.privateMessages` is not on and the chat is not the owner's. */
export const privateChatsOff = (features: unknown, event: unknown): boolean =>
  looseOf(features).privateMessages !== true && looseOf(event).iface !== CLI_IFACE;

/** The event without the platform handles an in-process interface attaches: what the hold stores. */
export function heldEventOf(event: unknown): Loose {
  const copy = { ...looseOf(event) };
  delete copy.raw;
  delete copy.rawPrevious;
  return copy;
}

/** Whether the store's state says the core is paused (`state.data.paused`, src/memory/store.js). */
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
type PausedPlace = { guildId: string | null; selfId: string; dryRunChannelId: string; memoryOn: boolean };

/**
 * How a line that arrives while paused is observed: `direct` and the record it belongs to, or null for a line the live
 * path would not observe now. A line of the served guild outside threads and the dry-run mirror is observed, hers or a
 * member's, another bot's not. A direct chat is observed only from the owner's command line: any other waits for its
 * private-chat gate at the resume.
 */
function pausedObservation(
  event: unknown,
  place: PausedPlace
): { direct: boolean; where: { guildId: string; privateUserId?: string } } | null {
  const fields = looseOf(event);
  const message = looseOf(fields.message);
  const author = looseOf(message.author);
  const conversation = looseOf(fields.conversation);
  const { guildId } = place;
  if (!place.memoryOn || guildId === null || guildId === '') return null;
  if (fields.edit === true || fields.deleted === true || message.system === true) return null;
  if (conversation.communityId === null || conversation.communityId === undefined) {
    if (fields.iface !== CLI_IFACE || author.self === true || typeof author.id !== 'string') return null;
    return { direct: true, where: { guildId, privateUserId: author.id } };
  }
  if (conversation.communityId !== guildId || conversation.kind === 'thread') return null;
  if (place.dryRunChannelId !== '' && conversation.id === place.dryRunChannelId) return null;
  if (author.bot === true && author.id !== place.selfId) return null;
  return { direct: looseOf(fields.addressing).mentioned === true, where: { guildId } };
}

/** What the pipeline observes a paused line with: the hot config, the served guild, her id and its observe path. */
export type PausedDeps = {
  hot: unknown;
  getGuildId: () => unknown;
  selfIdOf: () => unknown;
  observeLine: (event: never, direct: boolean, where: object) => Promise<unknown> | null;
};

/** Observes a line that arrives while paused into the memory database, awaited; nothing else happens to it here. */
export async function observeWhilePaused(event: unknown, deps: PausedDeps): Promise<void> {
  const config = looseOf(looseOf(deps.hot).config);
  const guildId = deps.getGuildId();
  const selfId = deps.selfIdOf();
  const dryRun = looseOf(config.bot).dryRunChannelId;
  const observed = pausedObservation(event, {
    guildId: typeof guildId === 'string' ? guildId : null,
    selfId: typeof selfId === 'string' ? selfId : '',
    dryRunChannelId: typeof dryRun === 'string' ? dryRun : '',
    memoryOn: looseOf(config.features).memory !== false,
  });
  // The pipeline's observe path takes the event the door validated.
  if (observed !== null) await deps.observeLine(event as never, observed.direct, observed.where);
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
  const config = looseOf(deps.hot).config;
  const isPaused = (): boolean => isPausedIn(deps.store);
  const answer = looseOf(looseOf(config).features).offlineCatchUp !== false;
  const windowMs = catchUpSettings(looseOf(config)).windowMinutes * MINUTE_MS;
  let replayed = 0;
  for (const held of deps.ingest.held()) {
    if (isPaused()) break;
    const at = held.event.at;
    const trigger = answer && typeof at === 'number' && deps.now() - at <= windowMs;
    // A direct chat that calls for an answer goes through the private-chat path; it was observed while paused.
    if (looseOf(held.event.conversation).communityId !== null)
      await callOn(deps.handler, 'catchUp', [held.event, { trigger }]);
    else if (trigger) await callOn(deps.handler, 'onPrivate', [held.event]);
    await deps.ingest.release(held.principal, held.eventId);
    replayed += 1;
  }
  deps.log.info('index: resume replayed', { messages: replayed });
  if (!isPaused()) await callOn(deps.handler, 'drainPending', []);
  return replayed;
}
