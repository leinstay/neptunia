// What changes to a message after it arrived: an edit of its text is a `seen` line of the record with its next
// revision, the media a platform attached late is linked to the line's current revision, counted into the GIF library
// and warmed, and a deleted message is a `deleted` line of the record. createMessageHandler (src/behavior/pipeline.js) builds it once with createEdits and
// hands the two handlers to the interface's edit and deletion events.

import { sharedPlaceOf } from '../memory/addresses.ts';
import type { ObserveLine, DeleteLine } from './observe.ts';
import { lineOf } from '../behavior/line-of.ts';
import type { Reads } from '../interface/reads.ts';
import { log } from '../log.ts';
import { appendRevision, gifOpts, slimMessage, toRecordLine } from '../memory/index.ts';
import type { Message, MessageReceived } from '../protocol/events.ts';
import { utcDay } from '../time.ts';
import type { MessageReadOptions } from './types.ts';

/** A `message.received` event of a whole message, with the message as it was before an edit. */
export type MessageEvent = Omit<MessageReceived, 'message' | 'previous'> & {
  message: Message;
  previous?: Message | null;
};

/** One media item of a normalized line: an attachment or a link, with its item id. */
type MediaItem = { readonly id?: unknown };

/** One part of a normalized line (the line itself or a forwarded snapshot), as far as its media go. */
type MediaPart = { readonly attachments?: Array<MediaItem>; readonly links?: Array<MediaItem> };

/** A normalized line (src/behavior/line-of.js#lineOf), as the edit handlers read it. */
type Line = MediaPart & { readonly id: string; readonly placeId: string; readonly forwarded?: Array<MediaPart> };

/** What the memory database answered an observation (src/memory/db/service.ts#observe). */
export type Observed = { ok?: boolean; code?: unknown; revision?: unknown; sourceId?: unknown } | null;

/** The live config, as far as the edit handlers read it. */
type EditsConfig = Record<string, unknown>;

/** The record (src/memory/record.ts#createRecord): its append and its newest revision. */
type EditsRecord = {
  append: (placeId: string, lines: Array<object>, options?: object) => Promise<unknown>;
  newestRevision?: (...args: Array<never>) => unknown;
};

/** What createEdits reads: the dependencies of createMessageHandler and two of its own functions. */
export type EditsContext = {
  hot: { readonly config: EditsConfig };
  store: {
    state?: { data?: { paused?: unknown } };
    recordGifs: (placeId: string, messages: Array<object>, opts: unknown) => number;
  } | null;
  reads: Reads;
  /** A root some connected interface serves. */
  isServedRoot: (placeId: string | null | undefined) => boolean;
  selfIdOf: () => string;
  record: EditsRecord | null;
  now: () => number;
  /** The keeper of the GIF library (src/memory/gif-keeper.ts), absent in a run without one. */
  gifKeeper?: { keep: (placeId: string, message: Record<string, unknown>) => unknown } | null;
  /** The media prefill of an observed message (createMessageHandler's warmMediaCache), never awaited here. */
  warmMediaCache: (placeId: string, message: object) => Promise<void> | null;
  /** The live observation of a line in the memory database (createMessageHandler's observeLine). */
  observeLine: ObserveLine;
  deleteLine?: DeleteLine;
};

export type Edits = {
  onMessageUpdate: (event: MessageReceived, options?: MessageReadOptions) => Promise<void>;
  onMessageDelete: (event: MessageReceived, options?: MessageReadOptions) => Promise<void>;
};

/**
 * The media of `normalized` the message as it was did not carry yet (`known`: the item ids of every
 * attachment and link of the earlier copy and its forwarded snapshots): what an embed the platform
 * attached after the message arrived brought. Stickers and custom emoji always come with the
 * message itself, so none is late. Pure; never mutates `normalized`.
 * Answers `normalized` with only the late attachments and links in each part.
 */
function lateMedia(normalized: Line, known: Set<string>): Line {
  const fresh = (items: Array<MediaItem> | undefined) =>
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- an item id as the platform gave it, read as text
    (items ?? []).filter((item) => item?.id != null && !known.has(String(item.id)));
  const part = <P extends MediaPart>(p: P) => ({
    ...p,
    attachments: fresh(p.attachments),
    links: fresh(p.links),
    stickers: [],
    emojis: [],
  });
  return { ...part(normalized), forwarded: (normalized.forwarded ?? []).map(part) };
}

/** The attachment and link item ids of a normalized message and its forwarded snapshots. */
function mediaIdsOf(message: Line): Set<string> {
  const ids = new Set<string>();
  for (const p of [message, ...(Array.isArray(message.forwarded) ? message.forwarded : [])]) {
    for (const item of [...(p?.attachments ?? []), ...(p?.links ?? [])]) {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- an item id as the platform gave it, read as text
      if (item?.id != null) ids.add(String(item.id));
    }
  }
  return ids;
}

/** The code of a thrown error, or null. */
const codeOf = (err: unknown): unknown => (err as { code?: unknown } | null | undefined)?.code ?? null;

export function createEdits({
  store,
  reads,
  isServedRoot,
  selfIdOf,
  record,
  now,
  gifKeeper = null,
  warmMediaCache,
  observeLine,
  deleteLine,
}: EditsContext): Edits {
  // The record's edits (recordEdit): messageId -> the last revision written, for the UTC day
  // `revisionsDay`; cleared when the day turns, so it stays small. An edit of a message not in
  // it is revision 2 (the message itself was revision 1); one the record already holds moves
  // past the record's newest (src/memory/record.ts#appendRevision) and the count continues there.
  const revisions = new Map<string, number>();
  let revisionsDay: string | null = null;

  /**
   * A message changed after it arrived (an edit event): an edit of its text is a `seen` line of the
   * record with its next revision (`recordEdit`). Some platforms attach embeds late -- a Tenor link's
   * `gifv` embed comes in an update, not with the message -- so the media the message as it was
   * (`previous` of the event) did not carry is counted into the GIF library
   * and handed to the media prefill under the same switches as on arrival
   * (warmMediaCache). Nothing else: no trigger, no turn, no counters, no channel map,
   * no affinity. Without the earlier message (the interface did not hold it) what it carried is unknown: an
   * accepted miss, logged with counts only. Off with features.embedUpdates (a missing key counts as
   * on), with features.memory off and while paused. Only the served root, a chat outside threads
   * and a human author's message with media. Config read now. Never throws.
   * The edit event, a partial one read whole here.
   */
  // health: allow complexity until 2027-04-01 -- moved whole from src/behavior/pipeline.js in stage 5d, a pure move
  async function onMessageUpdate(event: MessageReceived, options?: MessageReadOptions): Promise<void> {
    // An edit event carries the whole message unless it is partial; recordEdit leaves a partial one alone.
    await recordEdit(event as MessageEvent, options);
    try {
      const stateData = store?.state?.data;
      if (stateData?.paused) return;
      const root = event.chat.rootId ?? null;
      if (!root || !isServedRoot(root)) return;
      const placeId = sharedPlaceOf(store, event.chat, event.iface);
      let edited = event as MessageEvent;
      if (event.partial) {
        const fetched = await reads.fetchMessages({ iface: event.iface, chatId: event.chat.id }, [event.message.id]);
        const message = fetched?.messages[0];
        const whole = message?.event;
        if (!whole) return;
        // The interface's event of the message, fetched whole.
        edited = { ...(whole as MessageEvent), chat: event.chat, previous: event.previous ?? null };
      }
      const message = edited.message;
      if (message.system === true) return;
      const selfId = selfIdOf();
      if (!message.author || message.author.bot || message.author.id === selfId) return;

      // lineOf gives the normalized line of a message event.
      const normalized = lineOf(edited) as Line;
      const previous = edited.previous ? (lineOf({ ...edited, message: edited.previous }) as Line) : null;
      const late = lateMedia(normalized, previous ? mediaIdsOf(previous) : new Set());
      const items = [late, ...(late.forwarded ?? [])].flatMap((part) => [
        ...(part.attachments ?? []),
        ...(part.links ?? []),
      ]).length;
      if (items === 0) return;
      const fields = { placeId: normalized.placeId, messageId: normalized.id, items };
      if (!previous) {
        log.info('events: embeds late', fields);
        return;
      }
      const gifs = store ? store.recordGifs(placeId, [late], gifOpts()) : 0;
      if (gifs > 0) void gifKeeper?.keep(placeId, late);
      // Fire-and-forget, as on arrival: the prefill never rejects.
      void warmMediaCache(placeId, late);
      log.info('events: embeds folded', { ...fields, gifs });
    } catch (err) {
      log.error('events: update handler failed', { error: err });
    }
  }

  /**
   * Whether the message of `event` may enter the record: a record injected, the served root, no system or other
   * bot's message, a chat outside threads.
   */
  function recordable(event: MessageReceived): boolean {
    if (!record) return false;
    const root = event.chat?.rootId ?? null;
    if (!root || !isServedRoot(root)) return false;
    const message = event.message;
    if ('system' in message && message.system === true) return false;
    if (message?.author?.bot && message.author.self !== true) return false;
    return true;
  }

  /** The text of a message as written (`sourceText`, else what the chat shows), for telling an edit from an embed update. */
  const sourceTextOf = (message: Message | null | undefined) =>
    typeof message?.sourceText === 'string' ? message.sourceText : (message?.content ?? '');

  /** Whether `event` carries an attachment or link item its `previous` message did not. */
  function bringsMedia(event: MessageEvent, previous: Message): boolean {
    // lineOf gives the normalized line of a message event.
    const known = mediaIdsOf(lineOf({ ...event, message: previous }) as Line);
    return [...mediaIdsOf(lineOf(event) as Line)].some((id) => !known.has(id));
  }

  /**
   * An edited message (its text changed between `oldMessage` and `newMessage`) as a `seen`
   * line of the record with the next revision of the day (`revisions`). An update that keeps the
   * text and brings media (an embed the platform unfurled late) is no edit: its observation lands on
   * the line's current revision, which links the items it lacks, and the record gets no line. Never
   * throws: a refused append is logged as `events: record failed` (counts only).
   */
  async function recordEdit(event: MessageEvent, options?: MessageReadOptions): Promise<void> {
    try {
      if (event.partial || !recordable(event)) return;
      // recordable holds only for the served root.
      const placeId = sharedPlaceOf(store, event.chat, event.iface);
      if (event.previous && sourceTextOf(event.previous) === sourceTextOf(event.message)) {
        if (bringsMedia(event, event.previous)) await observeLine(event, false, { placeId }, options?.acceptedEvent);
        return;
      }
      // lineOf gives the normalized line of a message event.
      const normalized = lineOf(event) as Line;
      const day = utcDay(now());
      if (day !== revisionsDay) {
        revisions.clear();
        revisionsDay = day;
      }
      const key = JSON.stringify([event.iface, event.chat.id, normalized.id]);
      const revision = (revisions.get(key) ?? 1) + 1;
      revisions.set(key, revision);
      const slim = slimMessage(normalized, false);
      // A normalized observation owns the source and revision. Record adoption keeps both unchanged.
      // Direct callers without a source result retain appendRevision's duplicate handling.
      const observed = observeLine(event, false, { placeId }, options?.acceptedEvent);
      let start = revision;
      if (observed) {
        const done = await observed;
        if (!done || done.ok !== true || typeof done.revision !== 'number' || !Number.isInteger(done.revision)) return;
        if (typeof done.sourceId === 'string') {
          // The descriptor names the record line by the line's own id, which is no message id.
          const line = toRecordLine(slim, { revision: done.revision, now }) as { id: string };
          await record!.append(placeId, [line], {
            messages: [
              {
                lineId: line.id,
                locator: { iface: event.iface, chatId: event.chat.id, messageId: normalized.id },
                observedSourceId: done.sourceId,
              },
            ],
          });
          return;
        }
        start = done.revision;
      }
      // recordable holds only with a record.
      const landed = await appendRevision(
        record!,
        placeId,
        (next) => toRecordLine(slim, { revision: next, now }),
        start
      );
      if (landed.revision > (revisions.get(key) ?? 0)) revisions.set(key, landed.revision);
    } catch (err) {
      log.warn('events: record failed', { kind: 'seen', lines: 1, code: codeOf(err) });
    }
  }

  /**
   * A message of the served place deleted on the platform as a `deleted` line of
   * the record, dated by the message's own creation time (`createdTimestamp`, which a partial
   * message has too; now when missing) so a window can place it; the envelope's `recordedAt`
   * keeps the deletion time. The message's recorded text stays (a deletion is not a forget
   * request). Only what `recordable` lets in. Never throws: a refused append is logged as
   * `events: record failed` (counts only).
   * The deletion event.
   */
  async function onMessageDelete(event: MessageReceived, options?: MessageReadOptions): Promise<void> {
    try {
      const message = event?.message;
      const id = message?.id;
      if (!id || !recordable(event)) return;
      // recordable holds only for the served root.
      const placeId = sharedPlaceOf(store, event.chat, event.iface);
      const line = toRecordLine(
        {
          id: String(id),
          placeId: event.chat.id,
          authorId: message.author?.id ?? null,
          ts: typeof message.at === 'number' && Number.isFinite(message.at) && message.at > 0 ? message.at : now(),
        },
        { kind: 'deleted', now }
      ) as { id: string };
      // recordable holds only with a record.
      const observed = deleteLine?.(event, { placeId }, options?.acceptedEvent);
      const done = observed ? await observed : null;
      if (observed && done?.ok !== true) return;
      await record!.append(
        placeId,
        [line],
        typeof done?.sourceId === 'string'
          ? {
              messages: [
                {
                  lineId: line.id,
                  locator: { iface: event.iface, chatId: event.chat.id, messageId: String(id) },
                  observedSourceId: done.sourceId,
                },
              ],
            }
          : undefined
      );
    } catch (err) {
      log.warn('events: record failed', { kind: 'deleted', lines: 1, code: codeOf(err) });
    }
  }

  return { onMessageUpdate, onMessageDelete };
}
