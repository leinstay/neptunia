// One storage format for the media of a chat line, whatever the interface: the table `source_media`, one row per item at
// its position in the message. `kind` is the closed list `MEDIA_KINDS`, `native_ref` the interface's reference, opaque here,
// and `text` the item's text form with its `text_origin` (`MEDIA_TEXT_ORIGINS`) and `availability` (`MEDIA_AVAILABILITY`). A
// file address is never stored; a link keeps its `url`, the address the person posted.
//
// `sourceMedia` is the one read, `mediaText` the one text of a line and `tellSourceMedia` the one write of a text form: every
// reader of a line (recall, the memory session, a task's lines, the owner's browser, the embedding queue) goes through them
// and none reads the describer's cache, the `media` table. The writers here read that cache, once: a text form held for an
// item is copied when the row is written, under the rule that a description narrower than the line stays out of the row.
// A text form told after its line stamps the line's stems again and queues it, with the two lines after it, for embedding
// (`media_embed_queue`, drained by media-backfill.ts#embedMediaLines).
//
// `migrateSourceMedia` moves a database forward: it fills the table from `sources.media`, `extra.extra.attachmentIds` and
// `extra.links`, removes both and drops the column. A second run changes nothing. docs/memory.md describes the format.

import { mediaDescriptionId, mediaDescriptionOf } from './export.ts';
import { rootPlaceInDb } from './place-tree.ts';
import { scopeWhere } from './scope.ts';
import type { Scope } from './scope.ts';
import { restampSource } from './stems.ts';
import { placeCollection } from './storage-keys.ts';
import { asText, dbOf, transactionOf } from './types.ts';
import type { Connection, Db, Row } from './types.ts';

export const MEDIA_KINDS = ['image', 'gif', 'video', 'sticker', 'emoji', 'voice', 'audio', 'file', 'link'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];
export const MEDIA_TEXT_ORIGINS = ['retelling', 'frame', 'transcript', 'voiced', 'embed', 'preview'] as const;
export type MediaTextOrigin = (typeof MEDIA_TEXT_ORIGINS)[number];
export const MEDIA_AVAILABILITY = ['told', 'unread', 'unreadable', 'gone'] as const;
export type MediaAvailability = (typeof MEDIA_AVAILABILITY)[number];

const quoted = (list: ReadonlyArray<string>): string => list.map((one) => `'${one}'`).join(', ');

/** The statements of the format. `IF NOT EXISTS` because a forward run on a database that holds them changes nothing. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS source_media (
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (${quoted(MEDIA_KINDS)})),
  native_ref TEXT,
  name TEXT,
  duration_sec REAL,
  site TEXT,
  title TEXT,
  url TEXT,
  text TEXT,
  text_origin TEXT CHECK (text_origin IN (${quoted(MEDIA_TEXT_ORIGINS)})),
  availability TEXT NOT NULL CHECK (availability IN (${quoted(MEDIA_AVAILABILITY)})),
  told_at TEXT,
  PRIMARY KEY (source_id, position)
);
CREATE INDEX IF NOT EXISTS source_media_ref ON source_media(native_ref) WHERE native_ref IS NOT NULL;
CREATE VIRTUAL TABLE IF NOT EXISTS source_media_tri USING fts5(text, content='source_media', content_rowid='rowid', tokenize='trigram');
CREATE TRIGGER IF NOT EXISTS source_media_ai AFTER INSERT ON source_media BEGIN
  INSERT INTO source_media_tri(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS source_media_ad AFTER DELETE ON source_media BEGIN
  INSERT INTO source_media_tri(source_media_tri, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS source_media_au AFTER UPDATE OF text ON source_media BEGIN
  INSERT INTO source_media_tri(source_media_tri, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO source_media_tri(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TABLE IF NOT EXISTS media_embed_queue (source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE);
`;

/** One media item of a line as a read gives it. */
export type MediaRow = {
  sourceId: string;
  position: number;
  kind: MediaKind;
  nativeRef: string | null;
  name: string | null;
  durationSec: number | null;
  site: string | null;
  title: string | null;
  url: string | null;
  text: string | null;
  textOrigin: MediaTextOrigin | null;
  availability: MediaAvailability;
};

/** One media item as a writer hands it in: what an interface's message or a record line knows of it. */
export type MediaItem = {
  kind: MediaKind;
  nativeRef: string | null;
  name: string | null;
  durationSec: number | null;
  site: string | null;
  title: string | null;
  url: string | null;
  text: string | null;
  textOrigin: MediaTextOrigin | null;
  availability: MediaAvailability;
};

const filled = (value: unknown): value is string => typeof value === 'string' && value !== '';
const orNull = (value: unknown): string | null => (filled(value) ? value : null);
const secondsOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const parsedObject = (text: unknown): Row => {
  if (typeof text !== 'string') return {};
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' ? (value as Row) : {};
  } catch {
    return {};
  }
};
const parsedList = (text: string): Array<unknown> => {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? (value as Array<unknown>) : [];
  } catch {
    return [];
  }
};
const listOf = (value: unknown): ReadonlyArray<Row> =>
  Array.isArray(value)
    ? (value as Array<unknown>).filter((one): one is Row => one !== null && typeof one === 'object')
    : [];

const BARE: Omit<MediaItem, 'kind' | 'availability'> = {
  nativeRef: null,
  name: null,
  durationSec: null,
  site: null,
  title: null,
  url: null,
  text: null,
  textOrigin: null,
};

const READABLE_AS_THEMSELVES = new Set<unknown>([
  'image',
  'gif',
  'video',
  'sticker',
  'emoji',
  'voice',
  'audio',
  'link',
]);

/**
 * The closed kind of an interface's or an old column's kind: `text` is a file a preview can read, and `file` or a kind
 * the list does not hold is a file no model can read.
 */
function closedKind(given: unknown): Pick<MediaItem, 'kind' | 'availability'> {
  if (READABLE_AS_THEMSELVES.has(given)) return { kind: given as MediaKind, availability: 'unread' };
  return { kind: 'file', availability: given === 'text' ? 'unread' : 'unreadable' };
}

/** The items of an interface's normalized message: attachments, links, stickers, then custom emoji. Pure. */
export function mediaItemsOf(message: Row): Array<MediaItem> {
  const items: Array<MediaItem> = [];
  for (const attachment of listOf(message.attachments)) {
    if (!filled(attachment.kind)) continue;
    items.push({
      ...BARE,
      ...closedKind(attachment.kind),
      nativeRef: orNull(attachment.id),
      name: orNull(attachment.name),
      durationSec: secondsOrNull(attachment.durationSec),
    });
  }
  for (const link of listOf(message.links)) {
    if (!filled(link.kind)) continue;
    const text = link.kind === 'link' ? orNull(link.text) : null;
    items.push({
      ...BARE,
      ...closedKind(link.kind),
      nativeRef: orNull(link.id),
      name: orNull(link.title) ?? orNull(link.site),
      site: orNull(link.site),
      title: orNull(link.title),
      url: link.kind === 'link' ? orNull(link.url) : null,
      text,
      textOrigin: text === null ? null : 'embed',
      ...(text === null ? {} : { availability: 'told' as const }),
    });
  }
  for (const sticker of listOf(message.stickers)) {
    items.push({
      ...BARE,
      kind: 'sticker',
      availability: filled(sticker.url) ? 'unread' : 'unreadable',
      nativeRef: orNull(sticker.id),
      name: orNull(sticker.name),
    });
  }
  for (const emoji of listOf(message.emojis)) {
    items.push({
      ...BARE,
      kind: 'emoji',
      availability: 'unread',
      nativeRef: orNull(emoji.id),
      name: orNull(emoji.name),
    });
  }
  return items;
}

/** The media of an observation's envelope: its items, a plain kind standing for a bare item of that kind. Pure. */
export function envelopeItems(media: ReadonlyArray<unknown> | null | undefined): Array<MediaItem> {
  return (media ?? []).flatMap((item): Array<MediaItem> => {
    if (typeof item === 'string') return item === '' ? [] : [{ ...BARE, ...closedKind(item) }];
    return item !== null && typeof item === 'object' ? [item as MediaItem] : [];
  });
}

/** The items of a record line: its kinds, a link item with what the line's preview card holds. Pure. */
function recordItems(line: Row): Array<MediaItem> {
  const cards = [...listOf(line.links)];
  const kinds = Array.isArray(line.media) ? (line.media as Array<unknown>).filter(filled) : [];
  const items = kinds.map((kind): MediaItem => ({ ...BARE, ...closedKind(kind) }));
  for (const item of items) {
    if (item.kind === 'link' && cards.length > 0) Object.assign(item, linkFields(cards.shift()!));
  }
  return [
    ...items,
    ...cards.map((card): MediaItem => ({ ...BARE, kind: 'link', availability: 'unread', ...linkFields(card) })),
  ];
}

/** A stored link card (`{ id, title, description, site, url }`) as the fields of its item. */
function linkFields(card: Row): Partial<MediaItem> {
  const text = orNull(card.description);
  return {
    nativeRef: orNull(card.id),
    name: orNull(card.title) ?? orNull(card.site),
    site: orNull(card.site),
    title: orNull(card.title),
    url: orNull(card.url),
    text,
    textOrigin: text === null ? null : 'embed',
    ...(text === null ? {} : { availability: 'told' as const }),
  };
}

// ---------- the read ----------

const rowOf = (row: Row): MediaRow => ({
  sourceId: String(row.source_id),
  position: Number(row.position),
  // The table's CHECK constraints hold these three to their lists.
  kind: row.kind as MediaKind,
  nativeRef: orNull(row.native_ref),
  name: orNull(row.name),
  durationSec: secondsOrNull(row.duration_sec),
  site: orNull(row.site),
  title: orNull(row.title),
  url: orNull(row.url),
  text: orNull(row.text),
  textOrigin: (row.text_origin as MediaTextOrigin | null) ?? null,
  availability: row.availability as MediaAvailability,
});

/** The media of these lines by source id, in position order. A line the context may not open has no entry. */
export function sourceMedia(db: Db, sourceIds: ReadonlyArray<string>, ctx: unknown): Map<string, Array<MediaRow>> {
  const found = new Map<string, Array<MediaRow>>();
  if (sourceIds.length === 0) return found;
  const scope = scopeWhere(ctx, 's');
  const rows = db
    .prepare(
      `SELECT m.* FROM source_media m JOIN sources s ON s.id = m.source_id
       WHERE m.source_id IN (SELECT value FROM json_each(?)) AND ${scope.sql} ORDER BY m.source_id, m.position`
    )
    .all(JSON.stringify(sourceIds), ...scope.params);
  for (const row of rows) {
    const item = rowOf(row);
    const list = found.get(item.sourceId);
    if (list) list.push(item);
    else found.set(item.sourceId, [item]);
  }
  return found;
}

/** The text of a line's media: the told text forms in position order, nothing of a bare one. */
export function mediaText(rows: ReadonlyArray<MediaRow>): string {
  return rows
    .map((row) => row.text ?? '')
    .filter(Boolean)
    .join(' ');
}

/** The kinds of a line's media, one per position, for what still reads a record line's `media`. */
export function sourceMediaKinds(db: Db, sourceId: string): Array<string> {
  return db
    .prepare('SELECT kind FROM source_media WHERE source_id = ? ORDER BY position')
    .all(sourceId)
    .map((row) => String(row.kind));
}

/** A stored line's media in the fields of a normalized message, as src/format.ts renders them. Pure. */
export function mediaMessageParts(
  rows: ReadonlyArray<MediaRow>,
  lineId: unknown
): { attachments: Array<Row>; links: Array<Row>; stickers: Array<Row>; emojis: Array<Row> } {
  const parts = {
    attachments: [] as Array<Row>,
    links: [] as Array<Row>,
    stickers: [] as Array<Row>,
    emojis: [] as Array<Row>,
  };
  for (const row of rows) {
    const id = row.nativeRef ?? `${asText(lineId)}#m${row.position}`;
    const told = row.text === null ? {} : { told: { text: row.text, origin: row.textOrigin } };
    switch (row.kind) {
      case 'link':
        parts.links.push({
          id,
          kind: 'link',
          site: row.site ?? '',
          title: row.title ?? '',
          text: row.text ?? '',
          url: row.url,
          thumbnailUrl: null,
        });
        break;
      case 'sticker':
        parts.stickers.push({
          id,
          name: row.name ?? '',
          // A stored sticker keeps no address: what the renderer asks is whether a picture exists.
          url: row.availability === 'unreadable' ? null : id,
          ...told,
        });
        break;
      case 'emoji':
        parts.emojis.push({ id, name: row.name ?? '', stored: true, ...told });
        break;
      case 'file':
        parts.attachments.push({
          id,
          kind: row.availability === 'unreadable' ? 'file' : 'text',
          name: row.name ?? row.kind,
          ...(row.text === null ? {} : { previewText: row.text }),
        });
        break;
      case 'image':
      case 'gif':
      case 'video':
      case 'voice':
      case 'audio':
        parts.attachments.push({
          id,
          kind: row.kind,
          name: row.name ?? row.kind,
          durationSec: row.durationSec,
          ...told,
        });
        break;
    }
  }
  return parts;
}

// ---------- what the cache holds ----------

const SCOPE_COLUMNS = 'scope_kind, scope_iface, scope_dm, audience_id';

/** Whether a row of `scope` is at least as open as the source row `line`: nobody can read the line and not the row. */
function opensTo(scope: Scope | Row, line: Row): boolean {
  if (scope.scope_kind === 'none') return true;
  if (scope.scope_iface !== line.scope_iface) return false;
  if (scope.scope_kind === 'group') return line.scope_kind === 'group' || line.scope_kind === 'dm';
  return scope.scope_kind === 'dm' && line.scope_kind === 'dm' && scope.scope_dm === line.scope_dm;
}

/** The description of one cache key: its live `media` row, then the durable one under the root of the line's place. */
function describedKey(db: Db, line: Row, root: string | null, key: string): string | null {
  const cached = db
    .prepare(`SELECT description, ${SCOPE_COLUMNS} FROM media WHERE id = ? AND retired_at IS NULL`)
    .get(`media:attachment:${key}`);
  if (cached && filled(cached.description) && opensTo(cached, line)) return cached.description;
  if (root === null) return null;
  const unit = placeCollection('versions', root, { selector: { versionKind: 'media', itemId: key } });
  const durable = db
    .prepare(`SELECT ${SCOPE_COLUMNS} FROM descriptions WHERE id = ? AND retired_at IS NULL`)
    .get(mediaDescriptionId(unit));
  if (!durable || !opensTo(durable, line)) return null;
  const entry = mediaDescriptionOf(db, unit);
  return entry && 'text' in entry && filled(entry.text) ? entry.text : null;
}

/** The cache keys of an item, best first, each with the origin its text has. */
function cacheKeysOf(kind: MediaKind, ref: string): ReadonlyArray<readonly [string, MediaTextOrigin]> {
  switch (kind) {
    case 'video':
      return [
        [`video:${ref}`, 'retelling'],
        [ref, 'frame'],
      ];
    case 'link':
      return [
        [`video:${ref}`, 'retelling'],
        [ref, 'retelling'],
      ];
    case 'sticker':
      return [[`sticker:${ref}`, 'retelling']];
    case 'emoji':
      return [[`emoji:${ref}`, 'retelling']];
    case 'voice':
    case 'audio':
      return [[ref, 'transcript']];
    case 'file':
      return [[ref, 'preview']];
    case 'image':
    case 'gif':
      return [[ref, 'retelling']];
  }
}

/** The root of a line's place. */
function rootOf(db: Db, line: Row): string | null {
  return filled(line.place_id) ? rootPlaceInDb(db, line.place_id) : null;
}

/** The text form the describer's cache holds for an item of `line`, when it is at least as open as the line. */
export function heldText(
  db: Db,
  line: Row,
  kind: MediaKind,
  ref: string,
  root: string | null = rootOf(db, line)
): { text: string; origin: MediaTextOrigin } | null {
  for (const [key, origin] of cacheKeysOf(kind, ref)) {
    const text = describedKey(db, line, root, key);
    if (text !== null) return { text, origin };
  }
  return null;
}

// ---------- the writes ----------

/** What a later text form may replace: a watched retelling outranks a still frame and an embed; nothing replaces what she voiced. */
const ORIGIN_RANK: Readonly<Record<MediaTextOrigin, number>> = {
  frame: 0,
  embed: 1,
  preview: 2,
  retelling: 3,
  transcript: 3,
  voiced: 4,
};

/** The line, its current neighbour lines after it, queued for embedding: their chunks hold this line's text form. */
export function queueMediaEmbed(db: Db, line: Row): void {
  const queue = db.prepare('INSERT OR IGNORE INTO media_embed_queue (source_id) VALUES (?)');
  queue.run(line.id);
  const after = db
    .prepare(
      `SELECT id FROM sources WHERE place_id IS ? AND occurred_at > ? AND kind IN ('seen', 'said') AND retired_at IS NULL
         AND scope_kind IS ? AND scope_iface IS ? AND scope_dm IS ? ORDER BY occurred_at, rowid LIMIT ${EMBED_NEIGHBOURS}`
    )
    .all(line.place_id, line.occurred_at, line.scope_kind, line.scope_iface, line.scope_dm);
  for (const row of after) queue.run(row.id);
}

/** The lines after a told line whose chunks carry it: src/memory/chunks.ts#CHUNK_CONTEXT_LINES. */
const EMBED_NEIGHBOURS = 2;

const LINE_COLUMNS = 'id, place_id, occurred_at, stems, scope_kind, scope_iface, scope_dm';
const isoNow = (at: unknown): string =>
  typeof at === 'string' ? at : new Date(typeof at === 'number' ? at : Date.now()).toISOString();

/** Sets a row's text form, when nothing better is held, and everything that follows from a changed text. */
function writeText(
  db: Db,
  line: Row,
  position: unknown,
  held: Row | undefined,
  { text, origin, at }: { text: string; origin: MediaTextOrigin; at: unknown }
): boolean {
  if (held?.text === text && held.text_origin === origin) return false;
  const heldOrigin = held?.text_origin as MediaTextOrigin | null | undefined;
  if (held?.text !== null && heldOrigin && ORIGIN_RANK[heldOrigin] > ORIGIN_RANK[origin]) return false;
  db.prepare(
    "UPDATE source_media SET text = ?, text_origin = ?, availability = 'told', told_at = ? WHERE source_id = ? AND position = ?"
  ).run(text, origin, isoNow(at), line.id, position);
  afterTold(db, line);
  return true;
}

function afterTold(db: Db, line: Row): void {
  restampSource(db, String(line.id));
  queueMediaEmbed(db, line);
}

/**
 * Tells every row holding this reference on this interface its text form. A text form narrower than a row's line stays out
 * of that row, so the row stays unread. Returns how many rows changed. Runs on the writer.
 */
export function tellSourceMedia(
  connection: Connection,
  {
    iface,
    nativeRef,
    text,
    origin,
    scope,
    at = null,
  }: { iface: string | null; nativeRef: string; text: string; origin: MediaTextOrigin; scope: Scope; at?: unknown }
): number {
  const db = dbOf(connection);
  return transactionOf(connection)(() => tellRows(db, { iface, nativeRef, text, origin, scope, at }));
}

function tellRows(
  db: Db,
  {
    iface,
    nativeRef,
    text,
    origin,
    scope,
    at = null,
    kinds = null,
  }: {
    iface: string | null;
    nativeRef: string;
    text: string;
    origin: MediaTextOrigin;
    scope: Scope | Row;
    at?: unknown;
    kinds?: ReadonlySet<string> | null;
  }
): number {
  const rows = db
    .prepare(
      `SELECT m.position AS at_position, m.text AS held_text, m.text_origin AS held_origin, m.kind AS row_kind, ${LINE_COLUMNS.split(
        ', '
      )
        .map((column) => `s.${column}`)
        .join(', ')}
       FROM source_media m JOIN sources s ON s.id = m.source_id WHERE m.native_ref = ?`
    )
    .all(nativeRef);
  let changed = 0;
  for (const row of rows) {
    if (iface !== null && row.scope_iface !== iface && row.scope_iface !== null) continue;
    if (kinds && !kinds.has(String(row.row_kind))) continue;
    if (!opensTo(scope, row)) continue;
    const held = { text: row.held_text, text_origin: row.held_origin };
    if (writeText(db, row, row.at_position, held, { text, origin, at })) changed += 1;
  }
  return changed;
}

/**
 * The describer's write reaching the lines: its cache key names a reference and, for a prefixed key, the kinds the prefix
 * belongs to. A plain key is the reference as it came, so a reference that looks like a key is still only a reference.
 */
export function tellFromCacheKey(
  db: Db,
  { iface, key, text, scope, at }: { iface: string | null; key: string; text: string; scope: Scope | Row; at: unknown }
): number {
  const originOf = (kind: string, prefixed: boolean): MediaTextOrigin => {
    if (kind === 'video') return prefixed ? 'retelling' : 'frame';
    if (kind === 'voice' || kind === 'audio') return 'transcript';
    if (kind === 'file') return 'preview';
    return 'retelling';
  };
  let changed = 0;
  const each = (nativeRef: string, kinds: ReadonlyArray<string>, prefixed: boolean): void => {
    for (const kind of kinds) {
      changed += tellRows(db, {
        iface,
        nativeRef,
        text,
        origin: originOf(kind, prefixed),
        scope,
        at,
        kinds: new Set([kind]),
      });
    }
  };
  each(key, ['image', 'gif', 'video', 'voice', 'audio', 'file', 'link'], false);
  const prefix = /^(video|sticker|emoji):(.+)$/s.exec(key);
  if (prefix) each(prefix[2], prefix[1] === 'video' ? ['video', 'link'] : [prefix[1]], true);
  return changed;
}

/** The fields an item's row takes from what a writer knows now; a field the writer does not know stays as it is. */
const ITEM_FIELDS = [
  ['native_ref', 'nativeRef'],
  ['name', 'name'],
  ['duration_sec', 'durationSec'],
  ['site', 'site'],
  ['title', 'title'],
  ['url', 'url'],
] as const;

/**
 * Writes a line's items position by position: a new row, or the fields a stored row lacks and a kind that changed. A text
 * form the item brings or the cache holds is told, and a row that holds one keeps it.
 */
export function writeSourceMedia(
  db: Db,
  line: Row,
  items: ReadonlyArray<MediaItem>,
  { at }: { at: unknown }
): { told: number } {
  let told = 0;
  const root = items.length > 0 ? rootOf(db, line) : null;
  const stored = db.prepare('SELECT * FROM source_media WHERE source_id = ? AND position = ?');
  const insert = db.prepare(
    `INSERT INTO source_media (source_id, position, kind, native_ref, name, duration_sec, site, title, url, availability)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  items.forEach((item, position) => {
    let held = stored.get(line.id, position);
    if (held) {
      const sets = ITEM_FIELDS.filter(([column, field]) => held![column] === null && item[field] !== null);
      const statement = sets.map(([column]) => `${column} = ?`);
      const values = sets.map(([, field]) => item[field]);
      if (held.kind !== item.kind) {
        statement.push('kind = ?');
        values.push(item.kind);
      }
      if (held.text === null && held.availability !== item.availability) {
        statement.push('availability = ?');
        values.push(item.availability === 'told' ? 'unread' : item.availability);
      }
      if (statement.length > 0)
        db.prepare(`UPDATE source_media SET ${statement.join(', ')} WHERE source_id = ? AND position = ?`).run(
          ...values,
          line.id,
          position
        );
      held = stored.get(line.id, position);
    } else {
      insert.run(
        line.id,
        position,
        item.kind,
        item.nativeRef,
        item.name,
        item.durationSec,
        item.site,
        item.title,
        item.url,
        item.availability === 'told' ? 'unread' : item.availability
      );
    }
    const given =
      item.text !== null && item.textOrigin !== null
        ? { text: item.text, origin: item.textOrigin }
        : item.nativeRef !== null && item.availability !== 'unreadable'
          ? heldText(db, line, item.kind, item.nativeRef, root)
          : null;
    if (given && writeText(db, line, position, held, { ...given, at })) told += 1;
  });
  return { told };
}

/** The row columns `writeSourceMedia` needs of a line. */
export const sourceLine = (db: Db, sourceId: string): Row | undefined =>
  db.prepare(`SELECT ${LINE_COLUMNS} FROM sources WHERE id = ?`).get(sourceId);

/**
 * What a source row made from a record line holds of its media, taken out of the row: its `media` kinds, the link cards and
 * the voiced words its `extra` carries. Null when it holds none. Edits `row`, which is the writer's own copy.
 */
export function takeRecordMedia(row: Row): Row | null {
  const kinds: unknown = row.media;
  delete row.media;
  const extra = typeof row.extra === 'string' ? parsedObject(row.extra) : {};
  const hasCards = 'links' in extra;
  const hasVoiced = 'voiced' in extra;
  const media: Row = {
    media: typeof kinds === 'string' ? parsedList(kinds) : kinds,
    links: extra.links,
    voiced: extra.voiced,
  };
  if (hasCards || hasVoiced) {
    delete extra.links;
    delete extra.voiced;
    row.extra = Object.keys(extra).length > 0 ? JSON.stringify(extra) : null;
  }
  return (Array.isArray(media.media) && media.media.length > 0) || hasCards || hasVoiced ? media : null;
}

/** What a record line brings for its source row: its kinds and cards, and the words of her voice message. */
export function writeRecordMedia(db: Db, sourceId: string, line: Row, at: unknown): void {
  const items = recordItems(line);
  if (items.length === 0) return;
  const source = sourceLine(db, sourceId);
  if (!source) return;
  const stored = db.prepare('SELECT COUNT(*) AS n FROM source_media WHERE source_id = ?').get(sourceId)?.n as number;
  // An observation that came first knows more than the record line: it stays, and the line only tells what it voiced.
  if (stored === 0) writeSourceMedia(db, source, items, { at });
  if (!filled(line.voiced)) return;
  const voice = db
    .prepare(
      "SELECT position, text, text_origin FROM source_media WHERE source_id = ? AND kind = 'voice' ORDER BY position"
    )
    .get(sourceId);
  if (voice) writeText(db, source, voice.position, voice, { text: line.voiced, origin: 'voiced', at });
}

// ---------- the migration ----------

/** The rows of the media table that name a message: a GIF library row in `native_ref`, a post's in its JSON. */
function joinedRows(db: Db): Map<string, Array<Row>> {
  const rows = db
    .prepare(
      `SELECT kind, description, native_ref, extra, mime, ${SCOPE_COLUMNS},
        CASE WHEN kind = 'gif' THEN native_ref
             WHEN kind = 'diary' AND json_valid(native_ref) THEN json_extract(native_ref, '$.messageId')
        END AS message_id
       FROM media WHERE retired_at IS NULL AND message_id IS NOT NULL ORDER BY rowid`
    )
    .all();
  const byMessage = new Map<string, Array<Row>>();
  for (const row of rows) {
    const key = String(row.message_id);
    const list = byMessage.get(key);
    if (list) list.push(row);
    else byMessage.set(key, [row]);
  }
  return byMessage;
}

/** What a media row that names a line's message says of one of its items: the reference and the text form. */
function fromJoined(
  db: Db,
  line: Row,
  root: string | null,
  row: Row
): { nativeRef: string | null; text: string | null; origin: MediaTextOrigin | null } | null {
  const opens = opensTo(row, line);
  if (row.kind === 'gif') {
    const itemId = orNull(parsedObject(row.extra).itemId);
    const told = itemId !== null ? heldText(db, line, 'gif', itemId, root) : null;
    return { nativeRef: itemId, text: told?.text ?? null, origin: told?.origin ?? null };
  }
  const nativeRef = orNull(parsedObject(row.native_ref).attachmentId);
  if (asText(row.mime ?? '').startsWith('audio/')) {
    const text = opens ? orNull(parsedObject(row.extra).text) : null;
    return { nativeRef, text, origin: text === null ? null : 'voiced' };
  }
  if (opens && filled(row.description)) return { nativeRef, text: row.description, origin: 'retelling' };
  const told = nativeRef !== null ? heldText(db, line, 'image', nativeRef, root) : null;
  return { nativeRef, text: told?.text ?? null, origin: told?.origin ?? null };
}

/** The kind a joined row can stand for: a library row a GIF, a post's row its picture or its voice message. */
function joinedKind(row: Row): MediaKind {
  if (row.kind === 'gif') return 'gif';
  return asText(row.mime ?? '').startsWith('audio/') ? 'voice' : 'image';
}

/** A line whose rows hold no reference tells them through the media rows that name its message. Returns how many it told. */
export function tellThroughJoined(
  db: Db,
  line: Row,
  nativeId: string,
  joined: ReadonlyArray<Row>,
  at: unknown
): number {
  if (joined.length === 0) return 0;
  const root = rootOf(db, line);
  const bare = db
    .prepare(
      'SELECT position, kind, text, text_origin FROM source_media WHERE source_id = ? AND native_ref IS NULL ORDER BY position'
    )
    .all(line.id);
  const taken = new Set<Row>();
  let told = 0;
  for (const item of bare) {
    const candidate = joined.find(
      (row) =>
        !taken.has(row) &&
        joinedKind(row) === item.kind &&
        (row.scope_iface === null || row.scope_iface === line.scope_iface)
    );
    if (!candidate) continue;
    taken.add(candidate);
    const found = fromJoined(db, line, root, candidate);
    if (!found) continue;
    if (found.nativeRef !== null)
      db.prepare('UPDATE source_media SET native_ref = ? WHERE source_id = ? AND position = ?').run(
        found.nativeRef,
        line.id,
        item.position
      );
    if (
      found.text !== null &&
      found.origin !== null &&
      writeText(db, line, item.position, item, { text: found.text, origin: found.origin, at })
    )
      told += 1;
  }
  return told;
}

/** The rows of one old source row and what is left of its `extra`. Pure. */
function oldItems(kinds: ReadonlyArray<unknown>, extra: Row): { items: Array<MediaItem>; rest: Row | null } {
  const inner = extra.extra !== null && typeof extra.extra === 'object' ? (extra.extra as Row) : null;
  const ids = inner && Array.isArray(inner.attachmentIds) ? (inner.attachmentIds as Array<unknown>) : [];
  const cards = [...listOf(extra.links)];
  const items = kinds.filter(filled).map((kind, position): MediaItem => {
    const item: MediaItem = { ...BARE, ...closedKind(kind) };
    if (kind === 'link' && cards.length > 0) return { ...item, ...linkFields(cards.shift()!) };
    return { ...item, nativeRef: orNull(ids[position]) };
  });
  items.push(
    ...cards.map((card): MediaItem => ({ ...BARE, kind: 'link', availability: 'unread', ...linkFields(card) }))
  );
  const hasOld = inner !== null ? 'attachmentIds' in inner : false;
  if (!hasOld && !('links' in extra)) return { items, rest: null };
  const rest = { ...extra };
  delete rest.links;
  if (inner) {
    const others = { ...inner };
    delete others.attachmentIds;
    if (Object.keys(others).length > 0) rest.extra = others;
    else delete rest.extra;
  }
  return { items, rest };
}

const hasColumn = (db: Db, table: string, column: string): boolean =>
  db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((row) => row.name === column);

/**
 * Moves the database to the one format and leaves no second place for a line's media: `sources.media`,
 * `extra.extra.attachmentIds` and `extra.links` become rows and are removed. Text forms come from the cache under the
 * line's audience; a line stored without ids takes them through the media rows that name its message. A database with no
 * `sources.media` is already there, and a run changes nothing.
 */
export function migrateSourceMedia(db: Db): void {
  db.exec(SCHEMA);
  if (!hasColumn(db, 'sources', 'media')) return;
  const joined = joinedRows(db);
  const select = db.prepare(
    `SELECT rowid AS source_rowid, native_id, media, extra, ${LINE_COLUMNS} FROM sources
     WHERE media IS NOT NULL OR (extra IS NOT NULL AND (instr(extra, '"attachmentIds"') > 0 OR instr(extra, '"links"') > 0))`
  );
  const writeExtra = db.prepare('UPDATE sources SET extra = ? WHERE id = ?');
  const at = new Date(0).toISOString();
  for (const line of select.all()) {
    const extra = parsedObject(line.extra);
    const kinds = parsedList(asText(line.media ?? '[]'));
    const { items, rest } = oldItems(kinds, extra);
    if (rest !== null) writeExtra.run(JSON.stringify(rest), line.id);
    if (items.length === 0) continue;
    writeSourceMedia(db, line, items, { at });
    if (items.some((item) => item.nativeRef === null) && filled(line.native_id)) {
      tellThroughJoined(db, line, line.native_id, joined.get(line.native_id) ?? [], at);
    }
    // A name and a title are words of the line too.
    restampSource(db, String(line.id));
  }
  db.exec('ALTER TABLE sources DROP COLUMN media');
}
