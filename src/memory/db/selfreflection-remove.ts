// The owner's removal of a selfreflection entry with everything that points at it (`/memory selfreflection remove <id>`,
// src/interface/commands/memory-selfreflection-remove.ts). Two halves:
//
// applySelfreflectionRemove(handle, { entryId, by, turnId?, dryRun?, now? })   the writer kind `selfreflection-remove`,
//     one transaction. It refuses an id that names no live entry (`unknown-entry`), a `turnId` that no line, day row or
//     request names (`unknown-turn`) and an entry with a publication still `sending` or `unknown` (`busy`), and changes
//     nothing then. Otherwise it removes, never retires: the entry; its media links and each media row no other owner
//     links, with its descriptions and vectors (the media's search rows go with the row, through the `media_ad`
//     trigger); its publications, grants and mirror rows; her own lines of every message the entry went out as (the
//     lines of the message's family, a line whose locator names it, and an older `said` line that names it only in
//     `native_id`), with their media links, relations, vectors, external keys, family rows and `ingest` rows; the turn
//     that made it (the entry's `extra.turnId`, the `turnId` given, and the turn of every `answer` line whose
//     `extra.posted` names one of those messages, as an id or as `{ messageId }`): its `answer` lines, `day` rows, the
//     `action` day rows of the `opId`s it posted under, `model_requests` and `turn_reads`; and the graph projection of
//     every row removed. Every other day row of the place loses the removed messages from the message-id lists of its
//     `extra` (`DAY_MESSAGE_LISTS`) and keeps the rest. A line's search rows go with it through `sources_ad`. A
//     relation of another line that pointed at a removed line is left unresolved, and the unit of every other row whose
//     edge touched a removed node is projected again. A mirror whose `backfill_high_water` names the entry gets the newest
//     remaining entry at or before it, or null. The guards that refuse every delete of `publications`,
//     `publication_grants` and `source_relations` are dropped and put back as they were inside the same transaction.
//     `dryRun` runs the whole removal and rolls it back: the answer says what a real run removes, and a row that cannot
//     go (a foreign key from a table this removal does not own) throws here, before anything is deleted on the platform.
//     The answer names the messages to delete, the rows removed by table and the media files whose rows went.
//
// createEntryRemoval({ write, dataDir })   the service's half (MemoryDbService.removeSelfreflectionEntry). It asks the
//     writer for a dry run, deletes every message through the interface's own delete (a message the platform no longer
//     has counts as deleted), then writes the removal and deletes the files. A failed delete stops it before memory
//     changes. The ids of the messages it deletes are kept in this process, the newest `REMEMBERED` of them, so the
//     platform's delete event of one writes nothing (`isRemovedMessage`, read by the service's `deleteMessage`).
//
// Only the owner removes (`OWNER_ONLY`). Logs: none; the answer carries ids and counts, never a text.

import fs from 'node:fs';
import path from 'node:path';
import { graphNodeId, projectRow } from './graph.ts';
import { mirrorPlaces, placeOf } from './mirrors.ts';
import { asText, dbOf } from './types.ts';
import type { Db, MemoryHandle, Row } from './types.ts';
import type { Adapter, MessageRef } from '../../protocol/adapter.ts';
import { CODE, httpCode } from '../../tools/codes.ts';

/** What the removal answers (the fixture of the removal tests holds the same contract). */
export type EntryRemoval =
  | { ok: true; entryId: string; deleted: number; removed: Record<string, number> }
  | { ok: false; code: 'unknown-entry' | 'unknown-turn' | 'busy' | 'interface-down' }
  | { ok: false; code: 'delete-failed'; platformCode: string };

/** The interface's own delete of a message, or null while the interface is down. */
export type DeletePort = (iface: string) => Pick<Adapter, 'delete'> | null;

/** What the owner asks to remove: the entry, and the turn that wrote it when the entry keeps none. */
export type RemovalRequest = { entryId: string; by: string; port: DeletePort; turnId?: string };

/** What the writer answers: a refusal, or what the removal removed (or, in a dry run, would remove). */
type WriterAnswer =
  | { ok: false; code: 'unknown-entry' | 'unknown-turn' | 'busy' }
  | { ok: false; code: 'delete-failed'; platformCode: string }
  | { ok: true; entryId: string; messages: Array<MessageRef>; removed: Record<string, number>; files: Array<string> };

/** How many removed message ids the process keeps for the late delete event: the platform sends it within seconds. */
const REMEMBERED = 500;

/** The guards that refuse every delete of the rows this removal owns, by table. */
const GUARDS = ['publications_no_delete', 'publication_grants_no_delete', 'source_relations_no_delete'];

/** The answer a dry run carries out of the transaction it rolls back. */
class Rehearsal extends Error {
  answer: WriterAnswer;
  constructor(answer: WriterAnswer) {
    super('dry run');
    this.answer = answer;
  }
}

const coded = (code: string): Error & { code: string } => Object.assign(new Error(code), { code });
const keyOf = (ref: MessageRef): string => `${ref.iface}\u0000${ref.conversationId}\u0000${ref.messageId}`;
const marks = (count: number): string => Array.from({ length: count }, () => '?').join(', ');

/** The parsed JSON of a column, or null. */
function parsed(raw: unknown): unknown {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** The ids of a list of strings, or none. */
const idsIn = (value: unknown): Array<string> =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && id !== '') : [];

/** The messages a publication went out as: its message receipts and the message ids of its delivered segments. */
function publicationMessages(row: Row): Array<string> {
  const receipts = parsed(row.receipts);
  const fromReceipts = Array.isArray(receipts)
    ? receipts.flatMap((one: unknown) => {
        const receipt = one as { kind?: unknown; key?: unknown } | null;
        const isMessage = receipt?.kind == null || receipt.kind === 'message';
        return isMessage && typeof receipt?.key === 'string' ? [receipt.key] : [];
      })
    : [];
  const delivery = parsed(row.delivery) as { segments?: unknown } | null;
  const segments = Array.isArray(delivery?.segments) ? (delivery.segments as Array<{ messageIds?: unknown }>) : [];
  return [...fromReceipts, ...segments.flatMap((segment) => idsIn(segment?.messageIds))];
}

/** The place a message of the entry lives in: its row's place, or the first mirror of its interface for an old row. */
function placeFor(db: Db, placeId: unknown, iface: unknown) {
  const named =
    typeof placeId === 'string'
      ? placeOf(db.prepare('SELECT id, iface, native_id, name FROM places WHERE id = ?').get(placeId))
      : null;
  return named ?? mirrorPlaces(db).find((place) => place.iface === iface) ?? null;
}

/** Every message the entry went out as, once each, or the id of one whose place nobody knows. */
function messagesOf(
  db: Db,
  entryId: string
): { refs: Array<MessageRef>; places: Map<string, string>; lost: string | null } {
  const refs = new Map<string, MessageRef>();
  const places = new Map<string, string>();
  const sent: Array<{ placeId: unknown; iface: unknown; ids: Array<string> }> = [
    ...db
      .prepare(
        "SELECT destination_place_id, receipts, delivery FROM publications WHERE row_kind = 'selfreflection' AND row_id = ?"
      )
      .all(entryId)
      .map((row) => ({ placeId: row.destination_place_id, iface: null, ids: publicationMessages(row) })),
    ...db
      .prepare('SELECT iface, place_id, native_ids FROM selfreflection_mirrors WHERE selfreflection_id = ?')
      .all(entryId)
      .map((row) => ({ placeId: row.place_id, iface: row.iface, ids: idsIn(parsed(row.native_ids)) })),
  ];
  for (const { placeId, iface, ids } of sent) {
    if (ids.length === 0) continue;
    const place = placeFor(db, placeId, iface);
    if (!place) return { refs: [], places, lost: ids[0] ?? '' };
    for (const messageId of ids) {
      const ref = { iface: place.iface, conversationId: place.conversationId, messageId };
      refs.set(keyOf(ref), ref);
      places.set(keyOf(ref), place.placeId);
    }
  }
  return { refs: [...refs.values()], places, lost: null };
}

/** The rows removed so far, by table. */
type Tally = Record<string, number>;

function count(tally: Tally, table: string, changes: unknown): void {
  const n = Number(changes);
  if (n > 0) tally[table] = (tally[table] ?? 0) + n;
}

/** `DELETE FROM <table> WHERE <column> IN (...)` over `ids`, counted. */
function deleteIn(db: Db, tally: Tally, table: string, column: string, ids: ReadonlyArray<string | number>): void {
  if (ids.length === 0) return;
  count(
    tally,
    table,
    db.prepare(`DELETE FROM "${table}" WHERE "${column}" IN (${marks(ids.length)})`).run(...ids).changes
  );
}

/**
 * Her own lines of `refs`: every line of each message's family, a line that names the message in its locator, and a
 * `said` line of an older shape that names it only in `native_id`, in the message's place or in none.
 */
function linesOf(db: Db, refs: ReadonlyArray<MessageRef>, places: ReadonlyMap<string, string>): Map<string, number> {
  const lines = new Map<string, number>();
  const family = db.prepare(
    'SELECT authority_id, native_kind, native_key FROM message_families WHERE iface = ? AND conversation_id = ? AND message_id = ?'
  );
  const ofFamily = db.prepare(
    'SELECT rowid, id FROM sources WHERE authority_id = ? AND native_kind = ? AND native_id = ?'
  );
  const located = db.prepare(
    `SELECT rowid, id FROM sources WHERE iface = ? AND json_valid(extra)
      AND json_extract(extra, '$."$messageLocator".conversationId') = ?
      AND json_extract(extra, '$."$messageLocator".messageId') = ?`
  );
  const native = db.prepare(
    `SELECT rowid, id FROM sources WHERE kind = 'said' AND iface = ? AND native_id = ?
      AND (place_id IS NULL OR place_id = ?)`
  );
  for (const ref of refs) {
    const rows = [
      ...native.all(ref.iface, ref.messageId, places.get(keyOf(ref)) ?? null),
      ...family
        .all(ref.iface, ref.conversationId, ref.messageId)
        .flatMap((one) => ofFamily.all(one.authority_id, one.native_kind, one.native_key)),
      ...located.all(ref.iface, ref.conversationId, ref.messageId),
    ];
    for (const row of rows) lines.set(String(row.id), Number(row.rowid));
  }
  return lines;
}

/**
 * The turns that posted `refs`: the turn of every `answer` line whose `extra.posted` names one of the messages, as an
 * id or as an object with a `messageId`.
 */
function turnsOf(db: Db, refs: ReadonlyArray<MessageRef>): Array<string> {
  const answer = db.prepare(
    `SELECT DISTINCT turn_id FROM sources WHERE kind = 'answer' AND iface = ? AND turn_id IS NOT NULL AND json_valid(extra)
      AND EXISTS (SELECT 1 FROM json_each(sources.extra, '$.posted')
        WHERE (CASE WHEN type = 'object' THEN json_extract(value, '$.messageId') ELSE value END) = ?)`
  );
  return [...new Set(refs.flatMap((ref) => answer.all(ref.iface, ref.messageId).map((row) => String(row.turn_id))))];
}

/** The `opId`s the turn's `answer` lines posted under: an `action` day row names its turn only through one. */
function opIdsOf(answers: ReadonlyArray<Row>): Array<string> {
  return answers.flatMap((row) => {
    const posted = (parsed(row.extra) as { posted?: unknown } | null)?.posted;
    if (!Array.isArray(posted)) return [];
    return posted.flatMap((one: unknown) => {
      const opId = (one as { opId?: unknown } | null)?.opId;
      return typeof opId === 'string' && opId !== '' ? [opId] : [];
    });
  });
}

/** Whether any line, `day` row or model request names the turn `turnId`. */
function turnExists(db: Db, turnId: string): boolean {
  return ['sources', 'day', 'model_requests'].some(
    (table) => db.prepare(`SELECT 1 AS ok FROM "${table}" WHERE turn_id = ? LIMIT 1`).get(turnId) !== undefined
  );
}

/**
 * The lists of message ids the journal writes into a `day` row's `extra` (src/memory/journal.ts): the messages a turn
 * drew on, saw and saw replied to, a memory batch's lines and a recovery turn's messages.
 */
const DAY_MESSAGE_LISTS: ReadonlyArray<ReadonlyArray<string>> = [
  ['sourceMessageIds'],
  ['seen', 'messageIds'],
  ['seen', 'parents'],
  ['batch', 'messageIds'],
  ['messageIds'],
];

/** The object at `path` inside `value`, or null. */
function objectAt(value: unknown, path: ReadonlyArray<string>): Row | null {
  let at: unknown = value;
  for (const key of path) at = at !== null && typeof at === 'object' ? (at as Row)[key] : null;
  return at !== null && typeof at === 'object' && !Array.isArray(at) ? (at as Row) : null;
}

/**
 * The removed messages taken out of every message-id list of every other `day` row in their place (or in none), each
 * row keeping every other column and field; a list that held only them stays, empty.
 */
function forgetReads(db: Db, refs: ReadonlyArray<MessageRef>, places: ReadonlyMap<string, string>): void {
  const reading = db.prepare(
    'SELECT rowid, extra FROM day WHERE json_valid(extra) AND (place_id IS NULL OR place_id = ?) AND instr(extra, ?) > 0'
  );
  const write = db.prepare('UPDATE day SET extra = ? WHERE rowid = ?');
  for (const ref of refs)
    for (const row of reading.all(places.get(keyOf(ref)) ?? null, JSON.stringify(ref.messageId))) {
      const extra = parsed(row.extra);
      let changed = false;
      for (const path of DAY_MESSAGE_LISTS) {
        const holder = objectAt(extra, path.slice(0, -1));
        const key = path.at(-1) ?? '';
        const list = holder?.[key];
        if (!holder || !Array.isArray(list) || !list.includes(ref.messageId)) continue;
        holder[key] = list.filter((id: unknown) => id !== ref.messageId);
        changed = true;
      }
      if (changed) write.run(JSON.stringify(extra), row.rowid);
    }
}

/** The media rows that go: those the entry or a removed line linked or the entry owns, once no other owner links them. */
function mediaToRemove(db: Db, entryId: string, lines: ReadonlyArray<string>): Array<{ id: string; path: unknown }> {
  const linked = db
    .prepare(
      `SELECT media_id AS id FROM media_links WHERE (owner_kind = 'selfreflection' AND owner_id = ?)
        OR (owner_kind = 'source' AND owner_id IN (${marks(lines.length) || "''"}))
       UNION SELECT id FROM media WHERE owner = ?`
    )
    .all(entryId, ...lines, entryId)
    .map((row) => String(row.id));
  const elsewhere = db.prepare(
    `SELECT 1 AS ok FROM media_links WHERE media_id = ?
      AND NOT (owner_kind = 'selfreflection' AND owner_id = ?)
      AND NOT (owner_kind = 'source' AND owner_id IN (${marks(lines.length) || "''"})) LIMIT 1`
  );
  const media = db.prepare('SELECT id, path FROM media WHERE id = ?');
  return [...new Set(linked)].flatMap((id) => {
    if (elsewhere.get(id, entryId, ...lines) !== undefined) return [];
    const row = media.get(id);
    return row ? [{ id, path: row.path }] : [];
  });
}

/** The vector rows of the removed items, each month's manifest counting one row less for each of its own that goes. */
function removeVectors(db: Db, tally: Tally, items: ReadonlyArray<string>, rowids: ReadonlyArray<number>): void {
  const where = `item_id IN (${marks(items.length) || "''"}) OR chunk_key IN (${marks(items.length) || "''"})
    OR source_rowid IN (${marks(rowids.length) || 'NULL'})`;
  const params = [...items, ...items.map((id) => `media:${id}`), ...rowids];
  const months = db
    .prepare(
      `SELECT owner_key, COUNT(*) AS n FROM vectors WHERE (${where}) AND retired_at IS NULL AND owner_key IS NOT NULL GROUP BY owner_key`
    )
    .all(...params);
  const manifest = db.prepare(
    "SELECT rowid, value FROM operational WHERE kind = 'vectors' AND owner_key = ? AND retired_at IS NULL"
  );
  for (const month of months) {
    const stored = manifest.get(month.owner_key);
    const value = parsed(stored?.value) as { manifest?: { rows?: unknown; bytes?: unknown; dims?: unknown } } | null;
    const counted = value?.manifest;
    if (!stored || !counted || typeof counted.rows !== 'number') continue;
    const gone = Number(month.n);
    counted.rows = counted.rows - gone;
    if (typeof counted.bytes === 'number' && typeof counted.dims === 'number')
      counted.bytes = counted.bytes - gone * counted.dims;
    db.prepare('UPDATE operational SET value = ? WHERE rowid = ?').run(JSON.stringify(value), stored.rowid);
  }
  count(tally, 'vectors', db.prepare(`DELETE FROM vectors WHERE ${where}`).run(...params).changes);
}

/** The graph rows of the removed `nodes`, after the unit of every other row that had an edge to one is projected again. */
function removeGraph(db: Db, tally: Tally, nodes: ReadonlyArray<string>, at: string): void {
  if (nodes.length === 0) return;
  const owners = new Set(
    nodes.map((node) => node.replace(/^([a-z_]+):/, (_, kind: string) => `${tableOfKind(kind)}:`))
  );
  const touching = db
    .prepare(
      `SELECT id, owner_key FROM graph_edges WHERE src IN (${marks(nodes.length)}) OR dst IN (${marks(nodes.length)})`
    )
    .all(...nodes, ...nodes);
  for (const owner of new Set(touching.map((edge) => asText(edge.owner_key)))) {
    if (owner === '' || owners.has(owner)) continue;
    const split = owner.indexOf(':');
    projectRow(db, owner.slice(0, split), { id: owner.slice(split + 1) }, { at });
  }
  const edges = db
    .prepare(
      `SELECT id FROM graph_edges WHERE src IN (${marks(nodes.length)}) OR dst IN (${marks(nodes.length)})
        OR owner_key IN (${marks(owners.size)})`
    )
    .all(...nodes, ...nodes, ...owners)
    .map((edge) => String(edge.id));
  deleteIn(db, tally, 'node_access', 'evidence_id', edges);
  deleteIn(db, tally, 'node_access', 'node_id', nodes);
  deleteIn(db, tally, 'node_access', 'evidence_id', nodes);
  deleteIn(db, tally, 'graph_edges', 'id', edges);
  deleteIn(db, tally, 'graph_nodes', 'id', nodes);
}

/** The typed table of a graph node kind. */
const KIND_TABLES: Readonly<Record<string, string>> = {
  source: 'sources',
  selfreflection: 'selfreflection',
  media: 'media',
  publication: 'publications',
  description: 'descriptions',
  description_version: 'description_versions',
};
const tableOfKind = (kind: string): string => KIND_TABLES[kind] ?? kind;

/** Runs `change` with the delete guards dropped, and puts them back as they were, in the caller's transaction. */
function withoutGuards<TResult>(db: Db, change: () => TResult): TResult {
  const guards = db
    .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN (${marks(GUARDS.length)})`)
    .all(...GUARDS);
  for (const guard of guards) db.exec(`DROP TRIGGER "${String(guard.name)}"`);
  const done = change();
  for (const guard of guards) db.exec(String(guard.sql));
  return done;
}

/** The mirrors whose backfill boundary is the entry move to the newest entry at or before it, or to none. */
function moveBoundary(db: Db, entry: Row): void {
  const before = db
    .prepare(
      `SELECT id FROM selfreflection WHERE retired_at IS NULL AND id <> ? AND (at_ms, COALESCE(position, 0), id) <= (?, ?, ?)
        ORDER BY at_ms DESC, COALESCE(position, 0) DESC, id DESC LIMIT 1`
    )
    .get(entry.id, entry.at_ms, Number(entry.position ?? 0), entry.id);
  db.prepare('UPDATE mirrors SET backfill_high_water = ? WHERE backfill_high_water = ?').run(
    before?.id ?? null,
    entry.id
  );
}

/** The removal inside the writer's transaction (see the head of this file). */
function removeEntry(db: Db, entryId: string, at: string, named: string | null): WriterAnswer {
  const entry = db
    .prepare('SELECT id, at_ms, position, extra FROM selfreflection WHERE id = ? AND retired_at IS NULL')
    .get(entryId);
  if (!entry) return { ok: false, code: 'unknown-entry' };
  if (named !== null && !turnExists(db, named)) return { ok: false, code: 'unknown-turn' };
  const unsettled = db
    .prepare(
      "SELECT 1 AS ok FROM publications WHERE row_kind = 'selfreflection' AND row_id = ? AND status IN ('sending', 'unknown') LIMIT 1"
    )
    .get(entryId);
  if (unsettled) return { ok: false, code: 'busy' };
  const { refs, places, lost } = messagesOf(db, entryId);
  if (lost !== null) return { ok: false, code: 'delete-failed', platformCode: CODE.UNKNOWN_CONVERSATION };
  const tally: Tally = {};
  const lines = linesOf(db, refs, places);
  const kept = (parsed(entry.extra) as { turnId?: unknown } | null)?.turnId;
  const turns = [
    ...new Set([
      ...turnsOf(db, refs),
      ...(typeof kept === 'string' && kept !== '' ? [kept] : []),
      ...(named !== null ? [named] : []),
    ]),
  ];
  const answers = db
    .prepare(
      `SELECT rowid, id, extra FROM sources WHERE kind = 'answer' AND turn_id IN (${marks(turns.length) || "''"})`
    )
    .all(...turns);
  for (const row of answers) lines.set(String(row.id), Number(row.rowid));
  const opIds = opIdsOf(answers);
  const lineIds = [...lines.keys()];
  const media = mediaToRemove(db, entryId, lineIds);
  const mediaIds = media.map((one) => one.id);
  const publications = db
    .prepare("SELECT id FROM publications WHERE row_kind = 'selfreflection' AND row_id = ?")
    .all(entryId)
    .map((row) => String(row.id));
  const descriptions = db
    .prepare(
      `SELECT id FROM descriptions WHERE subject_kind = 'media' AND subject_id IN (${marks(mediaIds.length) || "''"})`
    )
    .all(...mediaIds)
    .map((row) => String(row.id));
  const versions = db
    .prepare(`SELECT id FROM description_versions WHERE description_id IN (${marks(descriptions.length) || "''"})`)
    .all(...descriptions)
    .map((row) => String(row.id));
  const removedIds = [entryId, ...lineIds, ...mediaIds, ...publications, ...descriptions, ...versions];

  deleteIn(db, tally, 'turn_reads', 'turn_id', turns);
  deleteIn(db, tally, 'turn_reads', 'row_id', removedIds);
  deleteIn(db, tally, 'model_requests', 'turn_id', turns);
  deleteIn(db, tally, 'day', 'turn_id', turns);
  if (opIds.length > 0)
    count(
      tally,
      'day',
      db
        .prepare(
          `DELETE FROM day WHERE what = 'action' AND json_valid(extra)
            AND json_extract(extra, '$.opId') IN (${marks(opIds.length)})`
        )
        .run(...opIds).changes
    );
  forgetReads(db, refs, places);
  count(
    tally,
    'media_links',
    db
      .prepare(
        `DELETE FROM media_links WHERE (owner_kind = 'selfreflection' AND owner_id = ?)
          OR (owner_kind = 'source' AND owner_id IN (${marks(lineIds.length) || "''"}))`
      )
      .run(entryId, ...lineIds).changes
  );
  removeVectors(db, tally, [entryId, ...lineIds, ...mediaIds], [...lines.values()]);
  deleteIn(db, tally, 'description_versions', 'id', versions);
  deleteIn(db, tally, 'descriptions', 'id', descriptions);
  deleteIn(db, tally, 'media', 'id', mediaIds);
  deleteIn(db, tally, 'selfreflection_mirrors', 'selfreflection_id', [entryId]);
  withoutGuards(db, () => {
    deleteIn(db, tally, 'publications', 'id', publications);
    count(
      tally,
      'publication_grants',
      db.prepare("DELETE FROM publication_grants WHERE row_kind = 'selfreflection' AND row_id = ?").run(entryId).changes
    );
    deleteIn(db, tally, 'source_relations', 'source_id', lineIds);
  });
  if (lineIds.length > 0) {
    const ids = marks(lineIds.length);
    db.prepare(
      `UPDATE source_relations SET target_source_id = NULL, resolved_at = NULL WHERE target_source_id IN (${ids})`
    ).run(...lineIds);
    count(tally, 'ingest', db.prepare(`DELETE FROM ingest WHERE source_id IN (${ids})`).run(...lineIds).changes);
  }
  deleteIn(
    db,
    tally,
    'ingest',
    'event_id',
    refs.map((ref) => `${ref.iface}:message:${ref.messageId}`)
  );
  deleteIn(db, tally, 'external_keys', 'node_id', lineIds);
  deleteIn(db, tally, 'co_owners', 'key', removedIds);
  deleteIn(db, tally, 'sources', 'id', lineIds);
  for (const ref of refs)
    count(
      tally,
      'message_families',
      db
        .prepare('DELETE FROM message_families WHERE iface = ? AND conversation_id = ? AND message_id = ?')
        .run(ref.iface, ref.conversationId, ref.messageId).changes
    );
  deleteIn(db, tally, 'selfreflection', 'id', [entryId]);
  moveBoundary(db, entry);
  const nodes = [
    graphNodeId('selfreflection', entryId),
    ...lineIds.map((id) => graphNodeId('source', id)),
    ...mediaIds.map((id) => graphNodeId('media', id)),
    ...publications.map((id) => graphNodeId('publication', id)),
    ...descriptions.map((id) => graphNodeId('description', id)),
    ...versions.map((id) => graphNodeId('description_version', id)),
  ];
  removeGraph(db, tally, nodes, at);
  const files = media.flatMap((one) => (typeof one.path === 'string' && one.path !== '' ? [one.path] : []));
  return { ok: true, entryId, messages: refs, removed: tally, files };
}

/** The writer kind `selfreflection-remove`: `{ entryId, by, turnId?, dryRun?, now? }`, in one transaction. */
export function applySelfreflectionRemove(handle: MemoryHandle, update: Row): WriterAnswer {
  if (update.by !== 'owner') throw coded('OWNER_ONLY');
  const at = new Date(typeof update.now === 'number' ? update.now : Date.now()).toISOString();
  try {
    return handle.transaction(() => {
      const named = typeof update.turnId === 'string' && update.turnId !== '' ? update.turnId : null;
      const answer = removeEntry(dbOf(handle), asText(update.entryId), at, named);
      if (update.dryRun === true && answer.ok) throw new Rehearsal(answer);
      return answer;
    });
  } catch (error) {
    if (error instanceof Rehearsal) return error.answer;
    throw error;
  }
}

/** Whether a delete's answer says the message is gone: deleted now, or no longer on the platform. */
function isGone(result: Awaited<ReturnType<Pick<Adapter, 'delete'>['delete']>>): boolean {
  const code = result.error?.code;
  return result.status === 'ok' || code === CODE.UNKNOWN_MESSAGE || code === httpCode(404);
}

/** The service's half of the removal (see the head of this file). */
// The removal's type is what it returns; the service reads it through `MemoryDbService`.
// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export function createEntryRemoval({ write, dataDir }: { write: (update: Row) => Promise<unknown>; dataDir: string }) {
  const remembered: Array<string> = [];
  const known = new Set<string>();

  function remember(refs: ReadonlyArray<MessageRef>): void {
    for (const ref of refs) {
      const key = keyOf(ref);
      if (known.has(key)) continue;
      known.add(key);
      remembered.push(key);
      if (remembered.length > REMEMBERED) known.delete(remembered.shift() ?? '');
    }
  }

  async function removeSelfreflectionEntry({ entryId, by, port, turnId }: RemovalRequest): Promise<EntryRemoval> {
    const named = turnId === undefined ? {} : { turnId };
    // The writer's answers are this module's own `WriterAnswer`, crossing the worker boundary as plain data.
    const plan = (await write({ kind: 'selfreflection-remove', entryId, by, ...named, dryRun: true })) as WriterAnswer;
    if (!plan.ok) return plan;
    const ports = new Map<string, Pick<Adapter, 'delete'>>();
    for (const ref of plan.messages) {
      const found = ports.get(ref.iface) ?? port(ref.iface);
      if (!found) return { ok: false, code: 'interface-down' };
      ports.set(ref.iface, found);
    }
    // Remembered before the first delete: the platform's event of it may come before the removal is written.
    remember(plan.messages);
    for (const ref of plan.messages) {
      const done = await ports.get(ref.iface)?.delete(ref);
      if (done && !isGone(done))
        return { ok: false, code: 'delete-failed', platformCode: done.error?.code ?? done.status };
    }
    const result = (await write({ kind: 'selfreflection-remove', entryId, by, ...named })) as WriterAnswer;
    if (!result.ok) return result;
    for (const file of result.files) {
      const full = path.resolve(dataDir, file);
      if (full.startsWith(path.resolve(dataDir) + path.sep)) fs.rmSync(full, { force: true });
    }
    return { ok: true, entryId, deleted: plan.messages.length, removed: result.removed };
  }

  /** Whether a delete event names a message the removal deleted: its envelope's `messageLocator`. */
  function isRemovedMessage(envelope: unknown): boolean {
    const locator = (envelope as { messageLocator?: Partial<MessageRef> } | null)?.messageLocator;
    if (typeof locator?.iface !== 'string' || typeof locator.conversationId !== 'string') return false;
    return known.has(
      keyOf({ iface: locator.iface, conversationId: locator.conversationId, messageId: String(locator.messageId) })
    );
  }

  return { removeSelfreflectionEntry, isRemovedMessage };
}
