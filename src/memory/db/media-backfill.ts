// The historical backfill of media: every old line whose linked items are placeholders gets its message read through the
// interface's history and written in the one format, through the one writer. `backfillMedia` is the core: it lists the lines,
// asks `read` for pages of their conversations, hands each result to `write` (`applyMediaBackfill` on the writer) and missing
// text forms to `describe`. Nothing here knows a platform. A run is resumable: what is done holds a reference or the state
// `missing`, so the next run lists only the rest, along with a voice or an audio file whose download failed.
//
// A line's message id is the one of its locator, else `native_id`, because `native_id` can be a key of the family catalog
// (message-families.ts), which no platform knows. A DM line that stored no conversation is read through the one
// `dmConversationOf` answers for its partner, which the place keeps in `extra.dmConversation`.
//
// A place whose read failed gets one more read in the run. A read the platform refuses (any status but `failed`, or a failure it
// marks not worth another try) gets none. Either way the place's lines wait for the next run.
//
// Report: `linked` lines got their items, `gone` the platform no longer returns the message or refuses the partner, `bare` the line
// cannot be read at all, each counted with its reason in `classes`; `told` text forms it held, `reembedded` items waiting for a
// vector; `failedPlaces` places a read gave up on, with `linesLeft` lines waiting, and `read-failed` or `read-refused`, each also
// with its code after a colon, in `classes`.

import {
  collectEmojiItems,
  collectPictures,
  collectTextFiles,
  collectAudio,
  isDescribable,
} from '../../media/classify.ts';
import { nativeOf } from './ids.ts';
import { itemTold, mediaItemsOf, sourceLine, writeLineMedia } from './media-store.ts';
import { messageLocator } from './message-locator.ts';
import { observationOf } from './observe-event.ts';
import { rootPlaceInDb } from './place-tree.ts';
import { addRelation } from './rows.ts';
import { asText, dbOf } from './types.ts';
import type { Connection, Db, Row } from './types.ts';
import type { HistoryQuery } from '../../protocol/adapter.ts';
import type { Reads } from '../../interface/reads.ts';

type FieldPlan = { how: 'kept' | 'read' | 'derived' | 'none'; why: string };

const kept = (why: string): FieldPlan => ({ how: 'kept', why });
const readIt = (why: string): FieldPlan => ({ how: 'read', why });
const derived = (why: string): FieldPlan => ({ how: 'derived', why });
const none = (why: string): FieldPlan => ({ how: 'none', why });

/** Every field a new line carries, and how an old line comes to hold it. */
export const BACKFILL_FIELDS: Readonly<Record<string, FieldPlan>> = {
  'sources.id': kept('the row keeps its id'),
  'sources.kind': kept('the line kept its kind'),
  'sources.iface': kept('every old row names its interface'),
  'sources.native_id': kept('the message id, or a key of the family catalog with the message id in the locator'),
  'sources.native_kind': kept('the family catalog filled it'),
  'sources.generation': kept('the family catalog filled it'),
  'sources.revision': kept('every line has one'),
  'sources.place_id': kept('every old row names its place'),
  'sources.author_account': kept('the author, on every old row'),
  'sources.author_participant': none('a thread-local poster is known only to its own interface'),
  'sources.author_kind': kept('the family catalog filled it'),
  'sources.reply_to': readIt('from the message read'),
  'sources.occurred_at': kept('the message time'),
  'sources.recorded_at': kept('when it was stored'),
  'sources.seen_at': kept('an old line holds its recorded time'),
  'sources.observed_at': kept('an old line holds its recorded time'),
  'sources.text': kept('the words stored; an edit since then is a later revision'),
  'sources.stems': derived('the stems job'),
  'sources.mentions': readIt('from the message read'),
  'sources.direct': kept('it was stored when the line arrived'),
  'sources.turn_id': none('only her own lines of a turn hold one'),
  'sources.op_id': none('only her own lines of a turn hold one'),
  'sources.think': none('only a session row holds one'),
  'sources.connection_id': none('the connection a message came by is not recorded in its history'),
  'sources.authority_id': kept('the family catalog filled it'),
  'sources.scope_kind': kept('the audience of the line'),
  'sources.scope_iface': kept('the audience of the line'),
  'sources.scope_dm': kept('the audience of the line'),
  'sources.audience_id': kept('the audience of the line'),
  'sources.origin': kept('how the row came to be, which stays true'),
  'sources.owner_key': kept('the unit the row belongs to'),
  'sources.owner_file': none('a frozen path of the historical import'),
  'sources.position': kept('its place in its unit'),
  'sources.tier': derived('the index policy'),
  'sources.retired_at': none('a line the record retired stays retired'),
  'sources.extra.$messageLocator': derived('the stored conversation and message id, with no read'),
  'sources.extra.$messageReply': readIt('from the message read'),
  'sources.extra.subtype': derived('the kind of the line'),
  'sources.extra.dmChannel': kept('held by the old rows that had it'),
  'media.id': kept('the item takes the placeholder or the row its reference names'),
  'media.kind': readIt('from the message read'),
  'media.native_ref': readIt('from the message read'),
  'media.description': kept('from the item the reference names; else the describe path'),
  'media.described_at': kept('with its description'),
  'media.availability': derived('present with a text form, missing with a message gone'),
  'media.sha1': none('set where the bytes were read: a selfreflection file'),
  'media.path': none('set where a file is kept: a selfreflection file or a library GIF'),
  'media.bytes': none('set where the bytes were read'),
  'media.mime': none('set where the bytes were read'),
  'media.stems': derived('the stems job and the writer of a text form'),
  'media.scope_kind': derived('from the line, on a row it creates'),
  'media.scope_iface': derived('from the line, on a row it creates'),
  'media.scope_dm': derived('from the line, on a row it creates'),
  'media.audience_id': derived('from the line, on a row it creates'),
  'media.owner': none('names a selfreflection entry or a delivery on their own rows'),
  'media.owner_key': kept('the unit of the describer cache or the library'),
  'media.extra.fileName': readIt('from the message read'),
  'media.extra.durationSec': readIt('from the message read'),
  'media.extra.url': readIt('a link as posted'),
  'media.extra.title': readIt('from the message read'),
  'media.extra.site': readIt('from the message read'),
  'media.extra.name': readIt('from the message read'),
  'media.extra.textOrigin': derived('with its description'),
  'media.extra.cache': kept('what the describer cache kept beside the text'),
};

/** Why a read of the port came to nothing, as far as the port said. */
type Reason = { status: string; code?: string; retryable?: boolean };

/** One history read: as the interface's port answers it. */
type Read = (conversationId: string, query: HistoryQuery) => Promise<Reason & { events?: ReadonlyArray<Row> }>;

/** The private conversation with an account, by the account's native id. */
type OpenDm = (accountId: string) => Promise<Reason & { conversationId?: string }>;

/** What a run came to. */
export type BackfillReport = {
  linked: number;
  bare: number;
  gone: number;
  told: number;
  reembedded: number;
  reads: number;
  described: number;
  failedPlaces: number;
  linesLeft: number;
  stopped: boolean;
  classes: Record<string, number>;
};

/** A line the backfill works on, as it lists them. */
type Pending = Row & { id: string; native_id: string };

/** A row of `media` as `m` that a run reads again: a sound with a reference, no text form and a download that failed. */
const FAILED_DOWNLOAD_SQL = `(m.native_ref IS NOT NULL AND m.kind IN ('voice', 'audio') AND COALESCE(m.description, '') = ''
  AND json_extract(m.extra, '$.cache.' || json_quote(m.native_ref) || '.miss') = 1
  AND json_extract(m.extra, '$.cache.' || json_quote(m.native_ref) || '.reason') = 'download')`;

/**
 * The old lines a run works on: linked items still placeholders, a reference missing and no state said about it, and sounds
 * whose download failed. A sound refused for its size is left alone, and one told since is no longer listed.
 */
function pendingLines(db: Db): Array<Pending> {
  return db
    .prepare(
      `SELECT DISTINCT s.id AS id, s.native_id AS native_id, s.place_id AS place_id, s.iface AS iface, s.extra AS extra,
         s.scope_kind AS scope_kind, s.scope_iface AS scope_iface, s.kind AS kind, p.extra AS place_extra
       FROM media_links l JOIN media m ON m.id = l.media_id JOIN sources s ON s.id = l.owner_id
         LEFT JOIN places p ON p.id = s.place_id
       WHERE l.owner_kind = 'source' AND m.availability = 'unknown' AND m.retired_at IS NULL
         AND (m.native_ref IS NULL OR ${FAILED_DOWNLOAD_SQL})
         AND s.kind IN ('seen', 'said') AND s.retired_at IS NULL
       ORDER BY s.occurred_at, s.rowid`
    )
    .all() as Array<Pending>;
}

const parsed = (text: unknown): Row => {
  try {
    const value: unknown = JSON.parse(asText(text ?? '{}'));
    return value !== null && typeof value === 'object' ? (value as Row) : {};
  } catch {
    return {};
  }
};

/** The conversation a line is read through: its locator, the DM channel it or its place stored, a place's own id. Null when none is stored. */
function conversationOf(line: Pending): string | null {
  const extra = parsed(line.extra);
  const locator = extra.$messageLocator as { conversationId?: unknown } | undefined;
  if (typeof locator?.conversationId === 'string' && locator.conversationId) return locator.conversationId;
  if (typeof extra.dmChannel === 'string' && extra.dmChannel) return extra.dmChannel;
  const kept = parsed(line.place_extra).dmConversation;
  if (typeof kept === 'string' && kept) return kept;
  return line.scope_kind === 'dm' ? null : nativeOf(line.place_id);
}

/** The platform's id of a line's message: the locator's, else `native_id`, which can be a key of the family catalog. */
function messageIdOf(line: Pending): string {
  const locator = parsed(line.extra).$messageLocator as { messageId?: unknown } | undefined;
  return typeof locator?.messageId === 'string' && locator.messageId ? locator.messageId : line.native_id;
}

/** The native id of a DM place's partner: its account's, else what its key or its own id spell. Null for any other place. */
function partnerOf(db: Db, placeId: unknown): string | null {
  const row = db
    .prepare(
      `SELECT a.native_id AS native, p.native_key AS key FROM places p LEFT JOIN accounts a ON a.id = p.partner_account
       WHERE p.id = ? AND (p.kind = 'dm' OR p.conversation = 'dm')`
    )
    .get(placeId);
  if (typeof row?.native === 'string' && row.native) return row.native;
  return /^dm:(.+)$/.exec(asText(row?.key ?? ''))?.[1] ?? /^[^:]+:dm:(.+)$/.exec(asText(placeId))?.[1] ?? null;
}

/** Whether the platform said no, so that asking again in this run would change nothing. */
const isRefusal = (answer: Reason): boolean => answer.status !== 'failed' || answer.retryable === false;

/** Message ids in the platform's order: a shorter id is older, then by characters, as src/memory/chunks.ts compares them. */
const compareIds = (a: string, b: string): number =>
  a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0;

/** The library's and the selfreflection's rows by the message they name: what links a line whose message is gone. */
function rowsNamingMessages(db: Db): Map<string, Array<Row>> {
  const named = new Map<string, Array<Row>>();
  for (const row of db
    .prepare(
      `SELECT id, kind, native_ref, description, extra, scope_iface FROM media
       WHERE retired_at IS NULL AND id NOT LIKE 'media:bare:%' AND (kind = 'gif' OR json_type(extra, '$.messageId') = 'text')`
    )
    .all()) {
    const extra = parsed(row.extra);
    const key = typeof extra.messageId === 'string' ? extra.messageId : asText(row.native_ref ?? '');
    if (key) named.set(key, [...(named.get(key) ?? []), row]);
  }
  return named;
}

/** The describable items of a message that the store holds no text form for, each with the address the read gave. */
function itemsToDescribe(db: Db, iface: unknown, event: Row): Array<Row> {
  const message = event.message as Row;
  const items = [
    ...collectPictures(message),
    ...collectAudio(message),
    ...collectTextFiles(message),
    ...collectEmojiItems(message),
  ] as Array<Row>;
  return items.filter((item) => isDescribable(item) && !itemTold(db, iface, asText(item.itemId)));
}

/** What the writer needs to bring a line to the format, from its message or from what is stored of it. */
function updateFor(line: Pending, conversationId: string | null, event: Row | null, at: number): Row {
  const iface = line.iface ?? null;
  const locator =
    messageLocator(parsed(line.extra).$messageLocator, iface) ??
    (conversationId === null
      ? null
      : messageLocator({ v: 1, origin: 'record-v1', iface, conversationId, messageId: messageIdOf(line) }, iface));
  const envelope = event ? observationOf({ ...event, iface }) : null;
  return {
    sourceId: line.id,
    state: event ? 'linked' : conversationId === null ? 'bare' : 'gone',
    at,
    locator,
    ...(event
      ? {
          items: mediaItemsOf(event.message as Row),
          replyTo: asText((event.message as Row).replyToId ?? '') || null,
          messageReply: envelope?.messageReply ?? null,
          mentions: envelope?.mentions ?? [],
          relations: envelope?.relations ?? [],
          authority: envelope?.authority ?? null,
        }
      : {}),
  };
}

/** The fields of a line an update fills, and its `extra` with what it now knows. */
function fillLine(db: Db, line: Row, update: Row): void {
  const extra = { ...parsed(db.prepare('SELECT extra FROM sources WHERE id = ?').get(line.id)?.extra) };
  if (update.locator) extra.$messageLocator = update.locator;
  if (update.messageReply) extra.$messageReply = update.messageReply;
  if (!extra.subtype) extra.subtype = db.prepare('SELECT kind FROM sources WHERE id = ?').get(line.id)?.kind;
  db.prepare('UPDATE sources SET extra = ? WHERE id = ?').run(JSON.stringify(extra), line.id);
  if (typeof update.replyTo === 'string') {
    db.prepare('UPDATE sources SET reply_to = COALESCE(reply_to, ?) WHERE id = ?').run(update.replyTo, line.id);
  }
  if (Array.isArray(update.mentions) && update.mentions.length > 0) {
    db.prepare('UPDATE sources SET mentions = ? WHERE id = ?').run(JSON.stringify(update.mentions), line.id);
  }
  for (const relation of Array.isArray(update.relations) ? (update.relations as Array<Row>) : []) {
    const target = { authority: update.authority, ...(relation.target as Row) };
    addRelation(db, asText(line.id), asText(relation.predicate), target, {
      at: new Date(Number(update.at)).toISOString(),
    });
  }
}

/** Marks a line's placeholders: the message is no more, or it cannot be read, and neither is asked again. */
function markPlaceholders(db: Db, sourceId: unknown): void {
  db.prepare(
    `UPDATE media SET availability = 'missing' WHERE native_ref IS NULL AND availability = 'unknown'
       AND id IN (SELECT media_id FROM media_links WHERE owner_kind = 'source' AND owner_id = ?)`
  ).run(sourceId);
}

/** Keeps on a DM place the conversation the interface opened for its partner. */
function keepDmConversation(db: Db, placeId: unknown, dmConversation: unknown): void {
  const extra = parsed(db.prepare('SELECT extra FROM places WHERE id = ?').get(placeId)?.extra);
  db.prepare('UPDATE places SET extra = ? WHERE id = ?').run(JSON.stringify({ ...extra, dmConversation }), placeId);
}

/** Links a line's placeholder to a row that names its message, and tells the writer's caller whether any changed. */
function linkNamedRows(db: Db, sourceId: unknown, rows: ReadonlyArray<Row>): number {
  const places = db
    .prepare(
      `SELECT l.position AS position, l.media_id AS media_id, m.kind AS kind FROM media_links l JOIN media m ON m.id = l.media_id
       WHERE l.owner_kind = 'source' AND l.owner_id = ? AND m.native_ref IS NULL AND m.id LIKE 'media:bare:%' ORDER BY l.position`
    )
    .all(sourceId);
  const taken = new Set<Row>();
  let linked = 0;
  for (const place of places) {
    const row = rows.find((one) => !taken.has(one) && (one.kind === place.kind || place.kind === 'image'));
    if (!row) continue;
    taken.add(row);
    db.prepare('UPDATE media_links SET media_id = ? WHERE owner_kind = ? AND owner_id = ? AND position = ?').run(
      row.id,
      'source',
      sourceId,
      place.position
    );
    db.prepare("DELETE FROM media WHERE id = ? AND id LIKE 'media:bare:%'").run(place.media_id);
    linked += 1;
  }
  return linked;
}

/** One update on the writer's connection. Answers what it did. */
export function applyMediaBackfill(connection: Connection, update: Row): { told: number; queued: number } {
  const db = dbOf(connection);
  const at = update.at;
  const write = (): { told: number; queued: number } => {
    if (update.dmConversation !== undefined) {
      keepDmConversation(db, update.placeId, update.dmConversation);
      return { told: 0, queued: 0 };
    }
    const line = sourceLine(db, asText(update.sourceId));
    if (!line) return { told: 0, queued: 0 };
    fillLine(db, line, update);
    if (Array.isArray(update.named)) linkNamedRows(db, line.id, update.named as Array<Row>);
    if (update.state !== 'linked') {
      markPlaceholders(db, line.id);
      return { told: 0, queued: 0 };
    }
    if (!Array.isArray(update.named))
      writeLineMedia(db, line, update.items as Parameters<typeof writeLineMedia>[2], { at });
    return waitingOn(db, line.id);
  };
  return 'transaction' in connection ? connection.transaction(write) : write();
}

/** The items of a line holding a text form, and those of them with no vector yet. */
function waitingOn(db: Db, sourceId: unknown): { told: number; queued: number } {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS told, COALESCE(SUM(NOT EXISTS (SELECT 1 FROM vectors v WHERE v.chunk_key = 'media:' || m.id)), 0) AS queued
       FROM media_links l JOIN media m ON m.id = l.media_id
       WHERE l.owner_kind = 'source' AND l.owner_id = ? AND m.description IS NOT NULL AND m.description <> ''`
    )
    .get(sourceId);
  return { told: Number(row?.told ?? 0), queued: Number(row?.queued ?? 0) };
}

/** The run: see the head of this file. `dryRun` lists and counts, with no read and no write. */
// health: allow complexity until 2027-04-01 -- the one loop of a run: list, read, match, write and describe, each a short step
export async function backfillMedia({
  db,
  read,
  dmConversationOf,
  write,
  describe,
  now,
  pageSize = 100,
  signal,
  pauseMs = 0,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  dryRun = false,
}: {
  db: Db;
  read: Read;
  /** Absent where no interface can open a conversation: a DM line with none stored is then `bare`. */
  dmConversationOf?: OpenDm;
  write: (update: Row) => Promise<unknown>;
  describe: (placeId: string, items: Array<Row>) => Promise<unknown>;
  now: number;
  pageSize?: number;
  signal?: AbortSignal;
  /** The pause between two reads, so a long history stays under the platform's rate. */
  pauseMs?: number;
  sleep?: (ms: number) => Promise<unknown>;
  dryRun?: boolean;
}): Promise<BackfillReport> {
  const report: BackfillReport = {
    linked: 0,
    bare: 0,
    gone: 0,
    told: 0,
    reembedded: 0,
    reads: 0,
    described: 0,
    failedPlaces: 0,
    linesLeft: 0,
    stopped: false,
    classes: {},
  };
  const count = (name: string): void => {
    report.classes[name] = (report.classes[name] ?? 0) + 1;
  };
  const apply = async (update: Row): Promise<void> => {
    const done = (await write(update)) as { told?: number; queued?: number } | undefined;
    report.told += done?.told ?? 0;
    report.reembedded += done?.queued ?? 0;
  };
  const named = rowsNamingMessages(db);
  const lines = pendingLines(db);
  const byConversation = new Map<string, Array<Pending>>();
  const toRead = (conversationId: string, line: Pending): void => {
    byConversation.set(conversationId, [...(byConversation.get(conversationId) ?? []), line]);
  };
  const bare = async (line: Pending): Promise<void> => {
    report.bare += 1;
    count('no-conversation');
    if (!dryRun) await apply(updateFor(line, null, null, now));
  };
  const toOpen = new Map<string, { partner: string; lines: Array<Pending> }>();
  for (const line of lines) {
    const conversationId = conversationOf(line);
    const rows = named.get(messageIdOf(line));
    if (rows && !dryRun) {
      await apply({ ...updateFor(line, conversationId, null, now), named: rows, state: 'linked', items: [] });
      report.linked += 1;
      count('named');
      continue;
    }
    if (conversationId !== null) {
      toRead(conversationId, line);
      continue;
    }
    const partner = dmConversationOf ? partnerOf(db, line.place_id) : null;
    if (partner === null) {
      await bare(line);
      continue;
    }
    const placeId = asText(line.place_id);
    toOpen.set(placeId, { partner, lines: [...(toOpen.get(placeId)?.lines ?? []), line] });
  }
  if (dryRun) {
    for (const list of byConversation.values()) report.classes.toRead = (report.classes.toRead ?? 0) + list.length;
    for (const { lines: waiting } of toOpen.values())
      report.classes.toOpen = (report.classes.toOpen ?? 0) + waiting.length;
    return report;
  }

  let first = true;
  /** One round trip to the platform: paced, and counted as a read. */
  const asking = async <T>(ask: () => Promise<T>): Promise<T> => {
    if (!first && pauseMs > 0) await sleep(pauseMs);
    first = false;
    report.reads += 1;
    return ask();
  };
  const giveUp = (answer: Reason, left: number): void => {
    const name = isRefusal(answer) ? 'read-refused' : 'read-failed';
    report.failedPlaces += 1;
    report.linesLeft += left;
    count(name);
    if (answer.code) count(`${name}:${answer.code}`);
  };

  for (const [placeId, { partner, lines: waiting }] of toOpen) {
    if (signal?.aborted) {
      report.stopped = true;
      return report;
    }
    const open = (): ReturnType<OpenDm> => (dmConversationOf as OpenDm)(partner);
    let answer = await asking(open);
    if (answer.status !== 'ok' && !isRefusal(answer)) answer = await asking(open);
    if (answer.conversationId) {
      await apply({ placeId, dmConversation: answer.conversationId, at: now });
      for (const line of waiting) toRead(answer.conversationId, line);
    } else if (answer.status === 'unsupported') {
      for (const line of waiting) await bare(line);
    } else if (isRefusal(answer)) {
      for (const line of waiting) {
        report.gone += 1;
        count('partner-refused');
        await apply({ ...updateFor(line, null, null, now), state: 'gone' });
      }
    } else {
      giveUp(answer, waiting.length);
    }
  }

  for (const [conversationId, held] of byConversation) {
    const pending = [...held].sort((a, b) => compareIds(messageIdOf(a), messageIdOf(b)));
    let secondRead = true;
    while (pending.length > 0) {
      if (signal?.aborted) {
        report.stopped = true;
        return report;
      }
      const asked = messageIdOf(pending[0]);
      const page = await asking(() => read(conversationId, { around: asked, limit: pageSize }));
      if (page.status !== 'ok') {
        if (secondRead && !isRefusal(page)) {
          secondRead = false;
          continue;
        }
        giveUp(page, pending.length);
        break;
      }
      const events = new Map((page.events ?? []).map((event) => [asText((event.message as Row).id), event]));
      const ids = [...events.keys()].sort(compareIds);
      const inPage = (id: string): boolean =>
        id === asked || (ids.length > 0 && compareIds(id, ids[0]) >= 0 && compareIds(id, ids[ids.length - 1]) <= 0);
      const answered = pending.filter((line) => inPage(messageIdOf(line)));
      for (const line of answered) {
        pending.splice(pending.indexOf(line), 1);
        const event = events.get(messageIdOf(line)) ?? null;
        await apply(updateFor(line, conversationId, event, now));
        if (!event) {
          report.gone += 1;
          count('deleted');
          continue;
        }
        report.linked += 1;
        count('read');
        const items = itemsToDescribe(db, line.scope_iface ?? line.iface ?? null, event);
        if (items.length > 0) {
          report.described += items.length;
          const place = asText(line.place_id ?? '');
          await describe(rootPlaceInDb(db, place) ?? place, items);
        }
      }
    }
  }
  return report;
}

/** What a run looks like from the owner's command. */
export type BackfillDeskState = {
  state: 'idle' | 'running' | 'done' | 'failed';
  report: BackfillReport | null;
  code?: string;
};

/** The pause between two reads of a live run: well under a platform's history rate. Decided 2026-11-05. */
const LIVE_PAUSE_MS = 1000;

/**
 * The owner's command over a run: one at a time, in the background, its last counts held for `status`. A run asked while
 * one goes answers that one's state; the next run takes up what the last one left.
 */
export function createMediaBackfillDesk({
  database,
  read,
  dmConversationOf,
  write,
  describe,
  now,
  log,
}: {
  database: () => Db | null;
  read: Read;
  dmConversationOf?: OpenDm;
  write: (update: Row) => Promise<unknown>;
  describe: (placeId: string, items: Array<Row>) => Promise<unknown>;
  now: () => number;
  log: { warn(message: string, fields?: Row): void };
}): { start(options: { dryRun: boolean }): Promise<BackfillDeskState>; status(): BackfillDeskState } {
  let current: BackfillDeskState = { state: 'idle', report: null };
  return {
    status: () => current,
    async start({ dryRun }) {
      const db = database();
      if (db === null) return { state: 'failed', report: null, code: 'DB_CLOSED' };
      const run = (dry: boolean): Promise<BackfillReport> =>
        backfillMedia({
          db,
          read,
          ...(dmConversationOf ? { dmConversationOf } : {}),
          write: (update) => write({ kind: 'media-backfill', ...update }),
          describe,
          now: now(),
          pauseMs: LIVE_PAUSE_MS,
          dryRun: dry,
        });
      if (dryRun) return { state: 'done', report: await run(true) };
      if (current.state === 'running') return current;
      current = { state: 'running', report: null };
      run(false)
        .then((report) => {
          current = { state: 'done', report };
        })
        .catch((error: unknown) => {
          const code = (error as { code?: string } | null)?.code ?? 'FAILED';
          log.warn('memory db: media backfill failed', { code });
          current = { state: 'failed', report: null, code };
        });
      return current;
    },
  };
}

/** The desk over the running core: the memory writer, the interface's history reads and the describer. */
export function mediaBackfillDesk({
  memoryDb,
  reads,
  iface,
  describer,
  now,
  log,
}: {
  memoryDb: { database(): unknown; memoryWrite(update: unknown): Promise<unknown> };
  /** `answer`, where the reads have it, keeps why a read came to nothing and lets a DM's conversation be opened. */
  reads: {
    history(where: { iface: string; conversationId: string }, query: HistoryQuery): Promise<unknown>;
    answer?: Reads['answer'];
  };
  iface: () => string;
  describer: {
    describeMany(
      placeId: string,
      items: Array<never>,
      options: { concurrency: number; retryMisses: boolean }
    ): Promise<unknown>;
  };
  now: () => number;
  log: { warn(message: string, fields?: Row): void };
}): ReturnType<typeof createMediaBackfillDesk> {
  const { answer } = reads;
  return createMediaBackfillDesk({
    database: () => memoryDb.database() as Db | null,
    read: async (conversationId, query) => {
      const where = { iface: iface(), conversationId };
      if (answer) return await answer('history', where, query);
      const found = (await reads.history(where, query)) as Row | null;
      return found === null ? { status: 'failed' } : { status: 'ok', ...found };
    },
    ...(answer
      ? { dmConversationOf: (accountId: string) => answer('dmConversationOf', { iface: iface(), accountId }) }
      : {}),
    write: (update) => memoryDb.memoryWrite(update),
    // The backfill names items as the media collectors list them, which is what the describer reads. The owner asked for this
    // run, so a download that failed minutes ago is tried now.
    describe: (placeId, items) =>
      describer.describeMany(placeId, items as Array<never>, { concurrency: 1, retryMisses: true }),
    now,
    log,
  });
}
