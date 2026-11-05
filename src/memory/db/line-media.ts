// What the pictures of stored lines show, for the lines `memory.search` quotes. A line's `media` column holds only kinds,
// so a description is found through an id: the attachment's, which the observation keeps in `extra` (observe-event.ts),
// or, for a line stored before that, the message id a GIF library row or a diary post's row names. An attachment id reads
// its `media` row, then the durable description the media versions keep under the root of the line's place. Every row
// read must be one the context may open. Only rows are read here, never a model; wording is the renderer's.
//
// `sourceDescriptions` gives the same descriptions to the stems (stems.ts), so a word of a description finds the line
// under the line's own audience. It takes only a description at least as open as the line, so a word of a private
// description never makes a shared line findable.

import { mediaDescriptionId, mediaDescriptionOf } from './export.ts';
import { rootPlaceInDb } from './place-tree.ts';
import { canRead } from './scope.ts';
import type { Context } from './scope.ts';
import { placeCollection } from './storage-keys.ts';
import type { Db, Row } from './types.ts';

/** A quoted line as far as this module reads it: its message id, where it is stored, and its attachments. */
type Line = {
  id?: unknown;
  stored?: { placeId?: unknown; iface?: unknown };
  attachments?: ReadonlyArray<Row>;
};

/** One read of descriptions: the connection, the read context and the lines. */
type LineRead = { db: unknown; ctx: unknown; lines: ReadonlyArray<Line> };

const SCOPE_COLUMNS = 'scope_kind, scope_iface, scope_dm, audience_id';
const filled = (value: unknown): value is string => typeof value === 'string' && value !== '';
const parsed = (text: unknown): Row => {
  if (typeof text !== 'string') return {};
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' ? (value as Row) : {};
  } catch {
    return {};
  }
};

/** The attachment ids the observation kept in a source row's `extra`, position for position with its first media kinds. */
export function sourceAttachmentIds(extra: Row): ReadonlyArray<unknown> {
  const inner = extra?.extra;
  const ids = inner !== null && typeof inner === 'object' ? (inner as Row).attachmentIds : null;
  return Array.isArray(ids) ? (ids as ReadonlyArray<unknown>) : [];
}

/**
 * The attachment ids live stored rows link: the ones a live line keeps in its `extra`, and the ones a live diary post's picture
 * names in its `native_ref`. A media row of such an id is never trimmed from the media cache.
 */
export function linkedAttachmentIds(db: Db): Set<string> {
  const rows = db
    .prepare(
      `SELECT j.value AS id FROM sources s, json_each(s.extra, '$.extra.attachmentIds') j
       WHERE s.retired_at IS NULL AND s.extra LIKE '%attachmentIds%' AND json_valid(s.extra)
       UNION
       SELECT json_extract(native_ref, '$.attachmentId') FROM media
       WHERE kind = 'diary' AND retired_at IS NULL AND json_valid(native_ref)`
    )
    .all();
  return new Set(rows.flatMap((row) => (filled(row.id) ? [row.id] : [])));
}

/** The description of one attachment: its live `media` row, then the durable one under the root of `placeId`. */
function describedAttachment(
  db: Db,
  readable: (row: Row) => boolean,
  attachmentId: string,
  placeId: unknown
): string | null {
  const cached = db
    .prepare(`SELECT description, ${SCOPE_COLUMNS} FROM media WHERE id = ? AND retired_at IS NULL`)
    .get(`media:attachment:${attachmentId}`);
  if (cached && filled(cached.description) && readable(cached)) return cached.description;
  const root = filled(placeId) ? rootPlaceInDb(db, placeId) : null;
  if (root === null) return null;
  const key = placeCollection('versions', root, { selector: { versionKind: 'media', itemId: attachmentId } });
  const durable = db
    .prepare(`SELECT ${SCOPE_COLUMNS} FROM descriptions WHERE id = ? AND retired_at IS NULL`)
    .get(mediaDescriptionId(key));
  if (!durable || !readable(durable)) return null;
  const entry = mediaDescriptionOf(db, key);
  return entry && 'text' in entry && filled(entry.text) ? entry.text : null;
}

/** The kind of attachment a joined media row describes: a library row a GIF, a diary post's row its picture. */
const JOINED_KIND: Readonly<Record<string, string>> = { gif: 'gif', diary: 'image' };

/**
 * The rows that name these messages, oldest first, per message: `media` of kind `gif` holds the message id in
 * `native_ref`, a diary post's picture holds it inside its `native_ref` JSON.
 */
function joinedRows(db: Db, ctx: Context, messageIds: ReadonlyArray<string>): Map<string, Array<Row>> {
  const rows = db
    .prepare(
      `SELECT kind, description, native_ref, extra, ${SCOPE_COLUMNS},
        CASE WHEN kind = 'gif' THEN native_ref
             WHEN kind = 'diary' AND json_valid(native_ref) AND mime LIKE 'image/%' THEN json_extract(native_ref, '$.messageId')
        END AS message_id
       FROM media WHERE retired_at IS NULL AND message_id IN (SELECT value FROM json_each(?)) ORDER BY rowid`
    )
    .all(JSON.stringify(messageIds));
  const byMessage = new Map<string, Array<Row>>();
  for (const row of rows) {
    if (!canRead(row, ctx)) continue;
    const list = byMessage.get(String(row.message_id)) ?? [];
    list.push(row);
    byMessage.set(String(row.message_id), list);
  }
  return byMessage;
}

/** What a joined row says about its picture; the name a library row keeps in `description` is not a description. */
function describedJoined(db: Db, ctx: Context, row: Row, placeId: unknown): string | null {
  if (row.kind === 'gif') {
    const itemId = parsed(row.extra).itemId;
    return filled(itemId) ? describedAttachment(db, (found) => canRead(found, ctx), itemId, placeId) : null;
  }
  if (filled(row.description)) return row.description;
  const attachmentId = parsed(row.native_ref).attachmentId;
  return filled(attachmentId) ? describedAttachment(db, (found) => canRead(found, ctx), attachmentId, placeId) : null;
}

/**
 * The descriptions of the attachments whose id the observation kept, by each attachment's rendered id. The memory
 * prefetch reads these alone: it shows a line its word stream found through a description with that description.
 */
export function knownDescriptions({ db, ctx, lines }: LineRead): Map<string, string> {
  const database = db as Db;
  const found = new Map<string, string>();
  for (const line of lines) {
    for (const attachment of line.attachments ?? []) {
      if (!filled(attachment.attachmentId)) continue;
      const text = describedAttachment(
        database,
        (row) => canRead(row, ctx),
        attachment.attachmentId,
        line.stored?.placeId
      );
      if (text !== null) found.set(String(attachment.id), text);
    }
  }
  return found;
}

/** Whether a row of `scope` is at least as open as the source row `line`: nobody can read the line and not the row. */
function opensTo(scope: Row, line: Row): boolean {
  if (scope.scope_kind === 'none') return true;
  if (scope.scope_iface !== line.scope_iface) return false;
  if (scope.scope_kind === 'group') return line.scope_kind === 'group' || line.scope_kind === 'dm';
  return scope.scope_kind === 'dm' && line.scope_kind === 'dm' && scope.scope_dm === line.scope_dm;
}

/** The descriptions known for the attachments of a source row, read for its stems. */
export function sourceDescriptions(db: Db, line: Row): Array<string> {
  if (typeof line.extra !== 'string' || !line.extra.includes('attachmentIds')) return [];
  const texts = sourceAttachmentIds(parsed(line.extra))
    .filter(filled)
    .map((id) => describedAttachment(db, (row) => opensTo(row, line), id, line.place_id));
  return texts.filter((text): text is string => text !== null);
}

/**
 * The descriptions of the pictures on `lines`, by each attachment's rendered id (`attachments[].id`), ready for the
 * renderer's `descriptions`: the known ids, then the rows that name a line stored without ids. An attachment with
 * nothing stored is left out, so it renders bare.
 */
export function lineDescriptions({ db, ctx, lines }: LineRead): Map<string, string> {
  const database = db as Db;
  const context = ctx as Context;
  const found = knownDescriptions({ db, ctx, lines });
  const unknown = lines.flatMap((line) =>
    (line.attachments ?? [])
      .filter((attachment) => !filled(attachment.attachmentId))
      .map((attachment) => ({ line, attachment }))
  );
  if (unknown.length === 0) return found;
  const joined = joinedRows(database, context, [...new Set(unknown.map(({ line }) => String(line.id)))]);
  const taken = new Set<Row>();
  for (const { line, attachment } of unknown) {
    const row = (joined.get(String(line.id)) ?? []).find(
      (candidate) =>
        !taken.has(candidate) &&
        JOINED_KIND[String(candidate.kind)] === attachment.kind &&
        (candidate.scope_iface === null || candidate.scope_iface === line.stored?.iface)
    );
    if (!row) continue;
    taken.add(row);
    const text = describedJoined(database, context, row, line.stored?.placeId);
    if (text !== null) found.set(String(attachment.id), text);
  }
  return found;
}
