// The one store of media: the table `media`, one row per item, and `media_links(owner_kind, owner_id, position, media_id)`, which
// ties an item to the messages and diary entries that show it. `kind` is the closed list `MEDIA_KINDS`, `native_ref` the
// interface's reference, opaque here, and `path` null or a file under `media/`. An item's text form is `description`, in English
// with speech and on-screen text quoted, and its origin `extra.textOrigin` (`MEDIA_ORIGINS`); what else a kind has sits in
// `extra`. Audience comes only from a link: an item is read through an owner the reader may open.
//
// `lineMedia` is the one read of a line's or an entry's media, `writeText` the one write of a text form, and the describer's
// cache (`src/memory/describe.ts`, through the write kind `media-entry`) keeps its entries on the same rows. A text form is
// stemmed and embedded once on its row: `media_fts`, `media_tri` and a vector whose `chunk_key` names the row. `mediaHits` turns
// the rows a search finds into one hit per item, with its use count and its latest visible use, grouping re-uploads by `sha1`.

import fs from 'node:fs';
import path from 'node:path';
import { projectRow } from './graph.ts';
import { audienceOf, groupScope, scopeWhere } from './scope.ts';
import { ensureAudience } from './rows.ts';
import { CURRENT_SOURCE, LINE_MOMENT, LINE_ROWID } from './source-current.ts';
import { safeFileName } from '../../media/classify.ts';
import { keptPathOf } from '../../media/kept-files.ts';
import { mediaStamp } from './media-stems.ts';
import { preparedPlace } from './place-owner.ts';
import { loadStemmer } from './stems.ts';
import { SELF_PERSON } from './ids.ts';
import { personOfAccount } from './meta-person.ts';
import { handleOf } from '../../behavior/handles.ts';
import { accountOfMember } from './native-rows.ts';
import { asText, dbOf, isFiniteNumber, transactionOf } from './types.ts';
import type { Connection, Db, Row } from './types.ts';

/** The prefix of the id of a picture of a diary entry, `media:diary:<entry>-<n>`. */
export const ENTRY_MEDIA = 'media:diary:';

export const MEDIA_KINDS = [
  'image',
  'gif',
  'video',
  'sticker',
  'emoji',
  'voice',
  'audio',
  'link',
  'text',
  'file',
] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];
export const MEDIA_ORIGINS = ['retelling', 'frame', 'transcript', 'voiced', 'embed', 'preview', 'page'] as const;
export type MediaOrigin = (typeof MEDIA_ORIGINS)[number];
export const MEDIA_STATES = ['present', 'missing', 'unknown', 'unreadable'] as const;
export type MediaState = (typeof MEDIA_STATES)[number];
export type MediaOwnerKind = 'source' | 'diary';

/** What a later text form may replace: a watched retelling outranks a still frame and an embed; nothing replaces what she voiced. */
const ORIGIN_RANK: Readonly<Record<MediaOrigin, number>> = {
  frame: 0,
  embed: 1,
  preview: 2,
  page: 3,
  retelling: 3,
  transcript: 3,
  voiced: 4,
};

/** One media item of an owner, as the read gives it. */
export type MediaRow = {
  mediaId: string;
  position: number;
  kind: MediaKind;
  nativeRef: string | null;
  path: string | null;
  description: string | null;
  describedAt: string | null;
  availability: MediaState;
  sha1: string | null;
  extra: Row;
  /** The marks of an item she made (marksOf), absent or null on anyone else's. */
  marks?: MediaMarks | null;
};

/**
 * The marks of an item she made, as a reader shows them: that she made it, and the people a picture shows, her own
 * person as `self` and anyone else by `@` and the person's handle.
 */
export type MediaMarks = { made: 'self' | null; depicted: Array<{ self: boolean; handle?: string }> };

/** One media item as a writer hands it in: what an interface's message or a record line knows of it. */
export type MediaItem = {
  kind: MediaKind;
  nativeRef: string | null;
  availability: MediaState;
  description: string | null;
  origin: MediaOrigin | null;
  extra: Row;
  /** The kept file under `media/` of the data folder, for an item whose file the core copied (src/media/kept-files.ts). */
  path?: string;
};

const filled = (value: unknown): value is string => typeof value === 'string' && value !== '';
const orNull = (value: unknown): string | null => (filled(value) ? value : null);
const iso = (at: unknown): string =>
  typeof at === 'string' ? at : new Date(isFiniteNumber(at) ? at : Date.now()).toISOString();
function parsedObject(text: unknown): Row {
  if (typeof text !== 'string') return {};
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
  } catch {
    return {};
  }
}
function parsedList(text: string): Array<unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? (value as Array<unknown>) : [];
  } catch {
    return [];
  }
}
const listOf = (value: unknown): ReadonlyArray<Row> =>
  Array.isArray(value)
    ? (value as Array<unknown>).filter((one): one is Row => one !== null && typeof one === 'object')
    : [];
const defined = (fields: Row): Row =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null && value !== undefined));

const KNOWN_KINDS = new Set<unknown>(MEDIA_KINDS);
/** The closed kind of an interface's or an old column's kind: a kind the list does not hold is a file no model can read. */
function closedKind(given: unknown): { kind: MediaKind; availability: MediaState } {
  if (given !== 'file' && KNOWN_KINDS.has(given)) return { kind: given as MediaKind, availability: 'unknown' };
  return { kind: 'file', availability: 'unreadable' };
}

const BARE = { nativeRef: null, description: null, origin: null, extra: {} };

/** A link's reference: the interface's `link:` key is the kind, already stated by the row. */
const linkRef = (id: unknown): string | null => {
  const ref = orNull(id);
  return ref?.startsWith('link:') ? ref.slice('link:'.length) || null : ref;
};

/** A card or an embed as its item: the title, the site and the posted address in `extra`, its text its text form. */
function linkItem(fields: { id: unknown; title: unknown; site: unknown; url: unknown; text: unknown }): MediaItem {
  const text = orNull(fields.text);
  return {
    kind: 'link',
    availability: text === null ? 'unknown' : 'present',
    nativeRef: linkRef(fields.id),
    description: text,
    origin: text === null ? null : 'embed',
    extra: defined({ title: orNull(fields.title), site: orNull(fields.site), url: orNull(fields.url) }),
  };
}

/** The items of an interface's normalized message: attachments, links, stickers, then custom emoji. Pure. */
export function mediaItemsOf(message: Row): Array<MediaItem> {
  const items: Array<MediaItem> = [];
  for (const attachment of listOf(message.attachments)) {
    if (!filled(attachment.kind)) continue;
    const kept = filled(attachment.url) ? keptPathOf(attachment.url) : null;
    items.push({
      ...(kept === null ? {} : { path: kept }),
      ...BARE,
      ...closedKind(attachment.kind),
      nativeRef: orNull(attachment.id),
      extra: defined({
        fileName: filled(attachment.name) ? safeFileName(attachment.name) : null,
        durationSec: isFiniteNumber(attachment.durationSec) ? attachment.durationSec : null,
      }),
    });
  }
  for (const link of listOf(message.links)) {
    if (!filled(link.kind)) continue;
    if (link.kind === 'link')
      items.push(
        linkItem({ ...link, id: link.id, title: link.title, site: link.site, url: link.url, text: link.text })
      );
    else
      items.push({
        ...BARE,
        ...closedKind(link.kind),
        nativeRef: orNull(link.id),
        extra: defined({ name: orNull(link.title) ?? orNull(link.site), site: orNull(link.site) }),
      });
  }
  for (const sticker of listOf(message.stickers)) {
    items.push({
      ...BARE,
      kind: 'sticker',
      availability: filled(sticker.url) ? 'unknown' : 'unreadable',
      nativeRef: orNull(sticker.id),
      extra: defined({ name: orNull(sticker.name) }),
    });
  }
  for (const emoji of listOf(message.emojis)) {
    items.push({
      ...BARE,
      kind: 'emoji',
      availability: 'unknown',
      nativeRef: orNull(emoji.id),
      extra: defined({
        name: orNull(emoji.name),
        ...(emoji.animated === true ? { animated: true, animationUrl: orNull(emoji.animationUrl) } : {}),
      }),
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

/**
 * The items of a record line: its kinds, a link item with what the line's preview card holds, and the sticker and emoji
 * items `mediaItemsOf` made for it. Pure.
 */
function recordItems(line: Row): Array<MediaItem> {
  const cards = [...listOf(line.links)];
  const fromCard = (card: Row): MediaItem =>
    linkItem({ ...card, id: card.id, title: card.title, site: card.site, url: card.url, text: card.description });
  const media: Array<unknown> = Array.isArray(line.media) ? line.media : [];
  const items = envelopeItems(media).map((item): MediaItem => {
    if (item.kind === 'link' && item.nativeRef === null && cards.length > 0) return fromCard(cards.shift()!);
    return item;
  });
  return [...items, ...cards.map(fromCard)];
}

// ---------- the read ----------

const OWNER_TABLE: Readonly<Record<MediaOwnerKind, string>> = { source: 'sources', diary: 'diary' };

/** The media of these owners by owner id, in position order. An owner the context may not open has no entry. */
export function lineMedia(
  db: Db,
  ownerIds: ReadonlyArray<string>,
  ctx: unknown,
  ownerKind: MediaOwnerKind = 'source'
): Map<string, Array<MediaRow>> {
  const found = new Map<string, Array<MediaRow>>();
  if (ownerIds.length === 0) return found;
  const scope = scopeWhere(ctx, 'o');
  const rows = db
    .prepare(
      `SELECT l.owner_id AS owner_id, l.position AS at_position, m.id AS media_id, m.kind AS kind, m.native_ref AS native_ref,
         m.path AS path, CASE WHEN m.retired_at IS NULL THEN m.description END AS description,
         m.described_at AS described_at, m.availability AS availability,
         m.sha1 AS sha1, m.extra AS extra
       FROM media_links l JOIN media m ON m.id = l.media_id JOIN ${OWNER_TABLE[ownerKind]} o ON o.id = l.owner_id
       WHERE l.owner_kind = ? AND l.owner_id IN (SELECT value FROM json_each(?)) AND ${scope.sql}
       ORDER BY l.owner_id, l.position`
    )
    .all(ownerKind, JSON.stringify(ownerIds), ...scope.params);
  for (const row of rows) {
    const item: MediaRow = {
      mediaId: String(row.media_id),
      position: Number(row.at_position),
      // The table's CHECK constraints hold these two to their lists.
      kind: row.kind as MediaKind,
      nativeRef: orNull(row.native_ref),
      path: orNull(row.path),
      description: orNull(row.description),
      describedAt: orNull(row.described_at),
      availability: row.availability as MediaState,
      sha1: orNull(row.sha1),
      extra: parsedObject(row.extra),
    };
    item.marks = marksOf(item.extra);
    const list = found.get(String(row.owner_id));
    if (list) list.push(item);
    else found.set(String(row.owner_id), [item]);
  }
  return found;
}

/**
 * The marks the `extra` of a media row holds (`made`, `depicts`), each person but her own written by `@` and the person's
 * handle; null when it holds none.
 */
export function marksOf(extra: Row): MediaMarks | null {
  const made = extra.made === 'self' ? 'self' : null;
  const ids = Array.isArray(extra.depicts) ? (extra.depicts as Array<unknown>).filter(filled) : [];
  if (made === null && ids.length === 0) return null;
  const depicted = ids.map((id) => (id === SELF_PERSON ? { self: true } : { self: false, handle: `@${handleOf(id)}` }));
  return { made, depicted };
}

/**
 * A line's media item as a request reads it: its kind and its text form, null while it has none. A sticker adds its
 * stable name and whether it has no picture, for the legend (src/turn/request/legend.ts).
 */
export type LineMediaItem = {
  kind: string;
  text: string | null;
  name?: string | null;
  unreadable?: boolean;
  marks?: MediaMarks;
};

/** A line's media rows as a request reads them, in position order. Pure. */
export const lineMediaItems = (rows: ReadonlyArray<MediaRow>): Array<LineMediaItem> =>
  rows.map((row) =>
    row.kind === 'sticker'
      ? {
          kind: row.kind,
          text: row.description,
          name: orNull(row.extra.name),
          unreadable: row.availability === 'unreadable',
        }
      : { kind: row.kind, text: row.description, ...(row.marks ? { marks: row.marks } : {}) }
  );

/** A request's media items of a line in the fields of a normalized message, through mediaMessageParts. Pure. */
export function lineItemParts(
  items: ReadonlyArray<LineMediaItem>,
  lineId: unknown
): ReturnType<typeof mediaMessageParts> {
  return mediaMessageParts(
    items.map((item, position) => ({
      kind: item.kind as MediaKind,
      position,
      nativeRef: null,
      description: item.text,
      availability: item.unreadable ? 'unreadable' : item.text === null ? 'unknown' : 'present',
      extra: item.name ? { name: item.name } : {},
      marks: item.marks ?? null,
    })),
    lineId
  );
}

/** The kinds and link cards of a line, for what reads a record line's `media` and `links`. */
export function recordFieldsOf(db: Db, sourceId: string): { media: Array<string>; links: Array<Row> } {
  const rows = db
    .prepare(
      `SELECT m.kind AS kind, m.native_ref AS native_ref, m.description AS description, m.extra AS extra
       FROM media_links l JOIN media m ON m.id = l.media_id
       WHERE l.owner_kind = 'source' AND l.owner_id = ? ORDER BY l.position`
    )
    .all(sourceId);
  const links = rows.flatMap((row): Array<Row> => {
    const extra = parsedObject(row.extra);
    if (row.kind !== 'link' || (!filled(extra.title) && !filled(row.description))) return [];
    return [
      defined({
        id: row.native_ref,
        url: extra.url,
        title: extra.title ?? '',
        description: extra.textOrigin === 'embed' ? row.description : '',
        site: extra.site ?? '',
      }),
    ];
  });
  return { media: rows.map((row) => String(row.kind)), links };
}

/** A stored line's media in the fields of a normalized message, as src/format.ts renders them. Pure. */
// health: allow complexity until 2027-04-01 -- one switch over the closed kinds
export function mediaMessageParts(
  rows: ReadonlyArray<
    Pick<MediaRow, 'kind' | 'position' | 'nativeRef' | 'description' | 'availability' | 'extra' | 'marks'>
  >,
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
    const name = orNull(row.extra.fileName) ?? orNull(row.extra.name);
    const told =
      row.description === null ? {} : { told: { text: row.description, origin: row.extra.textOrigin ?? null } };
    // The marks of an item she made follow its tag (src/format.ts#mediaTags).
    const marked = row.marks ? { marks: row.marks } : {};
    const held = { ...told, ...marked };
    switch (row.kind) {
      case 'link':
        parts.links.push({
          id,
          kind: 'link',
          site: orNull(row.extra.site) ?? '',
          title: orNull(row.extra.title) ?? '',
          text: row.description ?? '',
          url: orNull(row.extra.url),
          thumbnailUrl: null,
        });
        break;
      case 'sticker':
        // A stored sticker keeps no address: what the renderer asks is whether a picture exists.
        parts.stickers.push({ id, name: name ?? '', url: row.availability === 'unreadable' ? null : id, ...held });
        break;
      case 'emoji':
        // An animated emoji keeps its animation address, so the describer watches it as a GIF again.
        parts.emojis.push({
          id,
          name: name ?? '',
          ...(row.extra.animated === true ? { animated: true, animationUrl: orNull(row.extra.animationUrl) } : {}),
          ...held,
        });
        break;
      case 'text':
        parts.attachments.push({
          id,
          kind: 'text',
          name: name ?? row.kind,
          ...(row.description === null ? {} : { previewText: row.description }),
          ...marked,
        });
        break;
      case 'file':
        parts.attachments.push({ id, kind: 'file', name: name ?? row.kind, ...marked });
        break;
      case 'image':
      case 'gif':
      case 'video':
      case 'voice':
      case 'audio':
        parts.attachments.push({
          id,
          kind: row.kind,
          name: name ?? row.kind,
          ...(isFiniteNumber(row.extra.durationSec) ? { durationSec: row.extra.durationSec } : {}),
          ...held,
        });
        break;
    }
  }
  return parts;
}

/** The items of a diary entry in its order, with what its post keeps of each. */
export function entryMedia(db: Db, entryId: string): Array<Row> {
  return db
    .prepare(
      `SELECT l.position AS position, m.id AS id, m.kind AS kind, m.native_ref AS native_ref, m.path AS path, m.mime AS mime,
         m.bytes AS bytes, m.extra AS extra
       FROM media_links l JOIN media m ON m.id = l.media_id
       WHERE l.owner_kind = 'diary' AND l.owner_id = ? AND m.retired_at IS NULL ORDER BY l.position`
    )
    .all(entryId);
}

/** Whether a file of a media row is where its row says, for scripts/memory-db.ts `media-check`. */
export function checkMediaFiles(
  connection: Connection,
  { dataDir, apply = false }: { dataDir: string; apply?: unknown }
): { present: number; missing: number; unknown: number; changed: number } {
  const db = dbOf(connection);
  const counts = { present: 0, missing: 0, unknown: 0, changed: 0 };
  const marks: Array<[string, unknown]> = [];
  for (const row of db
    .prepare(
      `SELECT m.id AS id, m.path AS path, m.bytes AS bytes, m.availability AS availability, EXISTS
         (SELECT 1 FROM media_links l WHERE l.media_id = m.id AND l.owner_kind = 'diary') AS in_diary
       FROM media m WHERE m.retired_at IS NULL`
    )
    .iterate()) {
    if (!row.in_diary || !filled(row.path)) {
      counts.unknown += 1;
      continue;
    }
    let state: 'present' | 'missing' = 'missing';
    try {
      const stat = fs.statSync(path.join(dataDir, row.path));
      if (stat.isFile() && (!Number.isInteger(row.bytes) || stat.size === row.bytes)) state = 'present';
    } catch {
      /* no file */
    }
    counts[state] += 1;
    if (state !== row.availability) marks.push([state, row.id]);
  }
  counts.changed = marks.length;
  if (apply && marks.length > 0) {
    transactionOf(connection)(() => {
      const mark = db.prepare('UPDATE media SET availability = ? WHERE id = ?');
      for (const [state, id] of marks) mark.run(state, id);
    });
  }
  return counts;
}

// ---------- the writes ----------

const itemByRef = (db: Db, iface: unknown, ref: string): Row | undefined =>
  db
    .prepare(
      'SELECT * FROM media WHERE native_ref = ? AND scope_iface IS ? AND retired_at IS NULL ORDER BY rowid LIMIT 1'
    )
    .get(ref, iface);

/** The stems of a row, under the stemmer the database holds. */
const stampOf = (db: Db, row: { kind: unknown; description: unknown; extra: Row }): string =>
  mediaStamp(loadStemmer(db).stem, row);

/** Sets a row's text form when nothing better is held, and drops the vector of the text it replaces. */
function writeText(
  db: Db,
  row: Row,
  { text, origin, at }: { text: string; origin: MediaOrigin; at: unknown }
): boolean {
  const extra = parsedObject(row.extra);
  const heldOrigin = extra.textOrigin as MediaOrigin | undefined;
  if (row.description === text && heldOrigin === origin) return false;
  if (filled(row.description) && heldOrigin && ORIGIN_RANK[heldOrigin] > ORIGIN_RANK[origin]) return false;
  const next = { ...extra, textOrigin: origin };
  db.prepare(
    "UPDATE media SET description = ?, described_at = ?, availability = 'present', extra = ?, stems = ? WHERE id = ?"
  ).run(text, iso(at), JSON.stringify(next), stampOf(db, { kind: row.kind, description: text, extra: next }), row.id);
  // A vector stays valid while the text it was made from stays.
  if (row.description !== text) db.prepare('DELETE FROM vectors WHERE chunk_key = ?').run(vectorKey(row.id));
  return true;
}

/** What a cache key of the describer names: a reference, and the kinds and origin its prefix gives. Pure. */
export function cacheKeyParts(key: string): { ref: string; kinds: ReadonlyArray<MediaKind> | null; watched: boolean } {
  // A video site's link is itself `video:url:<hash>`: that prefix is part of its reference.
  if (key.startsWith('video:url:')) return { ref: key, kinds: null, watched: false };
  const prefix = /^(video|sticker|emoji|link):(.+)$/s.exec(key);
  if (!prefix) return { ref: key, kinds: null, watched: false };
  switch (prefix[1]) {
    case 'video':
      return { ref: prefix[2], kinds: ['video', 'link'], watched: true };
    case 'sticker':
      return { ref: prefix[2], kinds: ['sticker'], watched: false };
    case 'emoji':
      return { ref: prefix[2], kinds: ['emoji'], watched: false };
    default:
      return { ref: prefix[2], kinds: ['link'], watched: false };
  }
}

const originOf = (kind: unknown, watched: boolean): MediaOrigin => {
  if (kind === 'video') return watched ? 'retelling' : 'frame';
  if (kind === 'voice' || kind === 'audio') return 'transcript';
  if (kind === 'text') return 'preview';
  return 'retelling';
};

/** The row a cache key speaks of, on this interface. A plain key that is also an item's own reference is that item. */
export function mediaRowOfCacheKey(db: Db, iface: unknown, key: string): Row | undefined {
  const exact = itemByRef(db, iface, key);
  if (exact) return exact;
  const { ref, kinds } = cacheKeyParts(key);
  if (kinds === null) return undefined;
  const row = itemByRef(db, iface, ref);
  return row && kinds.includes(row.kind as MediaKind) ? row : undefined;
}

const BARE_ID = (sourceId: unknown, position: number): string => `media:bare:${asText(sourceId)}:${position}`;
const NEW_ID = (iface: unknown, ref: string): string => `media:${asText(iface ?? 'none')}:${ref}`;

type LineRow = Row & { id: unknown };

/** A new row for an item of `line`, under the line's scope columns, which name its interface. */
function insertItem(db: Db, line: LineRow, item: MediaItem, id: string): void {
  db.prepare(
    `INSERT INTO media (id, kind, native_ref, path, availability, extra, scope_kind, scope_iface, scope_dm, audience_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    item.kind,
    item.nativeRef,
    item.path ?? null,
    item.availability === 'present' ? 'unknown' : item.availability,
    JSON.stringify(item.extra),
    line.scope_kind ?? null,
    line.scope_iface ?? null,
    line.scope_dm ?? null,
    line.audience_id ?? null
  );
}

/** Brings a held row up to what a writer knows: a kind that changed, the fields of `extra`, and its state and stems. */
function mergeItem(db: Db, row: Row, item: MediaItem): void {
  const extra = { ...parsedObject(row.extra), ...item.extra };
  const availability =
    filled(row.description) || row.availability === 'present'
      ? 'present'
      : item.availability === 'present'
        ? 'unknown'
        : item.availability;
  const stems = filled(row.description) ? stampOf(db, { kind: item.kind, description: row.description, extra }) : null;
  db.prepare(
    'UPDATE media SET kind = ?, native_ref = COALESCE(native_ref, ?), path = COALESCE(path, ?), extra = ?, availability = ?, stems = ? WHERE id = ?'
  ).run(
    item.kind,
    item.nativeRef,
    item.path ?? null,
    JSON.stringify(extra),
    availability,
    stems ?? row.stems ?? null,
    row.id
  );
}

const linkStatement = (db: Db) =>
  db.prepare(
    `INSERT INTO media_links (owner_kind, owner_id, position, media_id) VALUES (?, ?, ?, ?)
     ON CONFLICT(owner_kind, owner_id, position) DO UPDATE SET media_id = excluded.media_id`
  );

/** The media row of one item of `line`: the held one, its retired row, or a new one. */
function itemRowFor(db: Db, line: LineRow, item: MediaItem, position: number): Row {
  const iface = line.scope_iface ?? null;
  const held = item.nativeRef === null ? undefined : itemByRef(db, iface, item.nativeRef);
  if (held) {
    mergeItem(db, held, item);
    return db.prepare('SELECT * FROM media WHERE id = ?').get(held.id) as Row;
  }
  const id = item.nativeRef === null ? BARE_ID(line.id, position) : NEW_ID(iface, item.nativeRef);
  // A row an edit or the trim retired comes back with its description, because the line links it now.
  const retired = db.prepare('SELECT * FROM media WHERE id = ? AND retired_at IS NOT NULL').get(id);
  if (retired) {
    db.prepare('UPDATE media SET retired_at = NULL WHERE id = ?').run(id);
    mergeItem(db, retired, item);
    return db.prepare('SELECT * FROM media WHERE id = ?').get(id) as Row;
  }
  insertItem(db, line, item, id);
  return db.prepare('SELECT * FROM media WHERE id = ?').get(id) as Row;
}

/** What is told of `row` after a line is linked to it: a text form the item brought, and how a still frame reads. */
function tellItem(db: Db, row: Row, item: MediaItem, at: unknown): number {
  if (item.description !== null && item.origin !== null)
    return writeText(db, row, { text: item.description, origin: item.origin, at }) ? 1 : 0;
  // A text the row holds keeps its origin. A cache row's text without one is named by its kind: what it held of a video
  // was a frame, of a voice its transcript, of a text its preview.
  const extra = parsedObject(row.extra);
  if (!filled(row.description) || extra.textOrigin !== undefined) return 0;
  const origin = originOf(row.kind, false);
  db.prepare('UPDATE media SET extra = ? WHERE id = ?').run(JSON.stringify({ ...extra, textOrigin: origin }), row.id);
  return 0;
}

/**
 * Writes a line's items, one link per media: an item the line already links by its reference is told again, a bare row the
 * line held at the item's position gives way to it, and any other item takes the next position. A line read again only
 * gains what it lacks, so a link the platform no longer shows stays. An `edit` of the line keeps only what `items` hold.
 */
export function writeLineMedia(
  db: Db,
  line: LineRow,
  items: ReadonlyArray<MediaItem>,
  { at, ownerKind = 'source', edit = false }: { at: unknown; ownerKind?: MediaOwnerKind; edit?: boolean }
): { told: number } {
  let told = 0;
  const link = linkStatement(db);
  const heldLink = db.prepare(
    `SELECT l.media_id AS media_id, m.native_ref AS native_ref, m.kind AS kind FROM media_links l JOIN media m ON m.id = l.media_id
     WHERE l.owner_kind = ? AND l.owner_id = ? AND l.position = ?`
  );
  const heldByRef = db.prepare(
    `SELECT l.media_id AS media_id FROM media_links l JOIN media m ON m.id = l.media_id
     WHERE l.owner_kind = ? AND l.owner_id = ? AND m.native_ref = ?`
  );
  const nextPosition = db.prepare(
    'SELECT COALESCE(MAX(position) + 1, 0) AS n FROM media_links WHERE owner_kind = ? AND owner_id = ?'
  );
  // A message that shows one custom emoji five times names its media once.
  const distinct = items.filter(
    (item, first) => item.nativeRef === null || items.findIndex((one) => one.nativeRef === item.nativeRef) === first
  );
  distinct.forEach((item, index) => {
    const linked = item.nativeRef === null ? undefined : heldByRef.get(ownerKind, line.id, item.nativeRef);
    if (linked) {
      const row = db.prepare('SELECT * FROM media WHERE id = ?').get(linked.media_id) as Row;
      mergeItem(db, row, item);
      told += tellItem(db, db.prepare('SELECT * FROM media WHERE id = ?').get(linked.media_id) as Row, item, at);
      return;
    }
    const held = heldLink.get(ownerKind, line.id, index);
    const iface = line.scope_iface ?? null;
    const named = item.nativeRef === null ? undefined : itemByRef(db, iface, item.nativeRef);
    // A placeholder at this position becomes the item, unless the reference already names one: then it gives way to it.
    const placeholder =
      held?.native_ref === null ? (db.prepare('SELECT * FROM media WHERE id = ?').get(held.media_id) as Row) : null;
    const position = placeholder ? index : Number(nextPosition.get(ownerKind, line.id)?.n ?? 0);
    let row: Row;
    if (placeholder && !named) {
      mergeItem(db, placeholder, item);
      const id = item.nativeRef === null ? placeholder.id : NEW_ID(iface, item.nativeRef);
      db.prepare('UPDATE media SET id = ? WHERE id = ?').run(id, placeholder.id);
      db.prepare('UPDATE media_links SET media_id = ? WHERE media_id = ?').run(id, placeholder.id);
      row = db.prepare('SELECT * FROM media WHERE id = ?').get(id) as Row;
    } else {
      row = itemRowFor(db, line, item, position);
    }
    link.run(ownerKind, line.id, position, row.id);
    if (held && placeholder && held.media_id !== row.id && named) {
      if (filled(placeholder.description)) {
        const origin = (parsedObject(placeholder.extra).textOrigin as MediaOrigin | undefined) ?? 'retelling';
        writeText(db, row, { text: placeholder.description, origin, at });
        db.prepare('UPDATE media SET description = NULL WHERE id = ?').run(placeholder.id);
      }
      dropIfBare(db, held.media_id);
    }
    told += tellItem(db, db.prepare('SELECT * FROM media WHERE id = ?').get(row.id) as Row, item, at);
  });
  if (edit) dropUnheld(db, ownerKind, line.id, distinct, at);
  return { told };
}

/**
 * A row nothing links any more that holds the same file as `id`, by path and `sha1`, leaves the table with its vector: the
 * picture of a diary entry relinked to the attachment her post made of it. The file stays, since `id` holds it.
 */
function dropTwin(db: Db, mediaId: unknown, id: string): void {
  const gone = db
    .prepare(
      `DELETE FROM media WHERE id = ? AND path IS NOT NULL
         AND EXISTS (SELECT 1 FROM media o WHERE o.id = ? AND o.path = media.path AND o.sha1 IS media.sha1)
         AND NOT EXISTS (SELECT 1 FROM media_links l WHERE l.media_id = media.id)`
    )
    .run(mediaId, id);
  if (Number(gone.changes) > 0) db.prepare('DELETE FROM vectors WHERE chunk_key = ?').run(vectorKey(mediaId));
}

/**
 * The links of an edited line its items no longer name: a referenced item they lack, a bare one past their count. A row
 * left with no link goes: a bare one leaves the table, an item's row retires, unless the GIF library holds it.
 */
function dropUnheld(
  db: Db,
  ownerKind: MediaOwnerKind,
  ownerId: unknown,
  items: ReadonlyArray<MediaItem>,
  at: unknown
): void {
  const refs = new Set(items.map((item) => item.nativeRef));
  const links = db
    .prepare(
      `SELECT l.position AS position, l.media_id AS media_id, m.native_ref AS native_ref
       FROM media_links l JOIN media m ON m.id = l.media_id WHERE l.owner_kind = ? AND l.owner_id = ?`
    )
    .all(ownerKind, ownerId);
  const unlink = db.prepare('DELETE FROM media_links WHERE owner_kind = ? AND owner_id = ? AND position = ?');
  for (const one of links) {
    const gone = one.native_ref === null ? Number(one.position) >= items.length : !refs.has(asText(one.native_ref));
    if (!gone) continue;
    unlink.run(ownerKind, ownerId, one.position);
    dropIfBare(db, one.media_id);
    retireUnlinked(db, one.media_id, at);
  }
}

/**
 * An item's row nothing links any more retires, unless the GIF library holds it. It leaves the cache too, so a late
 * write of the describer never brings it back (writeMediaEntry).
 */
function retireUnlinked(db: Db, mediaId: unknown, at: unknown): void {
  const retired = db
    .prepare(
      `UPDATE media SET retired_at = ?, writer = NULL, holder_id = NULL WHERE id = ? AND retired_at IS NULL
         AND writer IS NOT 'gifs'
         AND NOT EXISTS (SELECT 1 FROM media_links l WHERE l.media_id = media.id)`
    )
    .run(iso(at), mediaId);
  if (Number(retired.changes) > 0) projectRow(db, 'media', { id: mediaId }, { at });
}

/** A placeholder nothing links any more leaves the table. */
function dropIfBare(db: Db, mediaId: unknown): void {
  db.prepare(
    `DELETE FROM media WHERE id = ? AND native_ref IS NULL AND path IS NULL AND description IS NULL
       AND NOT EXISTS (SELECT 1 FROM media_links l WHERE l.media_id = media.id)`
  ).run(mediaId);
}

const LINE_COLUMNS =
  'id, native_id, iface, place_id, occurred_at, extra, scope_kind, scope_iface, scope_dm, audience_id';

/** The columns of a line `writeLineMedia` needs. */
export const sourceLine = (db: Db, sourceId: string): LineRow | undefined =>
  db.prepare(`SELECT ${LINE_COLUMNS} FROM sources WHERE id = ?`).get(sourceId) as LineRow | undefined;

/**
 * What a source row made from a record line holds of its media, taken out of the row: its `media` kinds, the link cards and the
 * voiced words its `extra` carries. Null when it holds none. Edits `row`, which is the writer's own copy.
 */
export function takeRecordMedia(row: Row): Row | null {
  const kinds: unknown = row.media;
  delete row.media;
  const extra = typeof row.extra === 'string' ? parsedObject(row.extra) : {};
  const hasCards = 'links' in extra;
  const hasVoiced = 'voiced' in extra;
  const hasMarks = 'marks' in extra;
  const taken: Row = {
    media: typeof kinds === 'string' ? parsedList(kinds) : kinds,
    links: extra.links,
    voiced: extra.voiced,
    marks: extra.marks,
  };
  if (hasCards || hasVoiced || hasMarks) {
    delete extra.links;
    delete extra.voiced;
    delete extra.marks;
    row.extra = Object.keys(extra).length > 0 ? JSON.stringify(extra) : null;
  }
  return (Array.isArray(taken.media) && taken.media.length > 0) || hasCards || hasVoiced || hasMarks ? taken : null;
}

/** The kinds of item she makes herself: a picture, a clip, a voice message, a file. A GIF, an emoji, a sticker or a link she reposts is not hers. */
const MADE_KINDS = ['image', 'video', 'voice', 'audio', 'text', 'file'];

/**
 * The marks of her record line on the items of its source row (`made`, and `depicts` as person ids): `marks` is
 * `{ self, accounts }`, the accounts native ids of the line's interface. Merged into each item's `extra`.
 */
function writeMarks(db: Db, source: LineRow, marks: unknown): void {
  const given = marks as { self?: unknown; accounts?: unknown } | null;
  if (given === null || typeof given !== 'object') return;
  const iface = asText(source.iface ?? '');
  const accounts = Array.isArray(given.accounts) ? (given.accounts as Array<unknown>).filter(filled) : [];
  const people = accounts.flatMap((native) => {
    const account = accountOfMember(db, iface, native);
    const person = account === null ? null : personOfAccount(db, account);
    return person === null ? [] : [person];
  });
  const depicts = [...new Set([...(given.self === true ? [SELF_PERSON] : []), ...people])];
  const fields = { made: 'self', ...(depicts.length > 0 ? { depicts } : {}) };
  db.prepare(
    `UPDATE media SET extra = json_patch(COALESCE(extra, '{}'), ?)
     WHERE id IN (SELECT l.media_id FROM media_links l WHERE l.owner_kind = 'source' AND l.owner_id = ?)
       AND kind IN (SELECT value FROM json_each(?))`
  ).run(JSON.stringify(fields), source.id, JSON.stringify(MADE_KINDS));
}

/** What a record line brings for its source row: its kinds and cards, the words of her voice message and the marks of what she made. */
export function writeRecordMedia(db: Db, sourceId: string, line: Row, at: unknown): void {
  const source = sourceLine(db, sourceId);
  if (!source) return;
  const links = db.prepare("SELECT COUNT(*) AS n FROM media_links WHERE owner_kind = 'source' AND owner_id = ?");
  // An observation that came first knows more than the record line: it stays, and the line only tells what she voiced.
  if (links.get(sourceId)?.n === 0) writeLineMedia(db, source, recordItems(line), { at });
  writeMarks(db, source, line.marks ?? null);
  if (!filled(line.voiced)) return;
  const voice = db
    .prepare(
      `SELECT m.* FROM media_links l JOIN media m ON m.id = l.media_id
       WHERE l.owner_kind = 'source' AND l.owner_id = ? AND m.kind = 'voice' ORDER BY l.position LIMIT 1`
    )
    .get(sourceId);
  if (voice) writeText(db, voice, { text: line.voiced, origin: 'voiced', at });
}

/**
 * An echo of a line a record line stored first fills what the record could not know: the references of its bare items. The
 * text form told on a bare row moves to the item with it. A line read again gains the items it lacks, and an `edit` that
 * keeps its revision keeps only the items the edit shows.
 */
export function fillLineMedia(
  db: Db,
  sourceId: string,
  items: ReadonlyArray<MediaItem>,
  { at, edit = false }: { at: unknown; edit?: boolean }
): void {
  const line = sourceLine(db, sourceId);
  if (line) writeLineMedia(db, line, items, { at, edit });
}

/**
 * The media rows a stored line misses: a live row no owner links, whose reference `<message id>#<item>` names the message of
 * a live `seen` or `said` line of its interface, while that line links no item of the reference. The describer wrote such a
 * row for an embed the platform unfurled after the line was stored. The line's message id is its locator's, else
 * `native_id`. One pair per line and row, in no order.
 */
export function unlinkedLineItems(db: Db): Array<{ sourceId: string; mediaId: string }> {
  return db
    .prepare(
      `WITH loose AS MATERIALIZED (
         SELECT m.id AS media_id, m.native_ref AS ref, m.scope_iface AS iface,
           substr(m.native_ref, 1, instr(m.native_ref, '#') - 1) AS message
         FROM media m
         WHERE m.retired_at IS NULL AND instr(m.native_ref, '#') > 1
           AND NOT EXISTS (SELECT 1 FROM media_links l WHERE l.media_id = m.id)
       ), lines AS MATERIALIZED (
         SELECT s.id AS source_id, s.scope_iface AS iface,
           COALESCE(CASE WHEN json_valid(s.extra) THEN json_extract(s.extra, '$."$messageLocator".messageId') END, s.native_id)
             AS message
         FROM sources s
         WHERE s.kind IN ('seen', 'said') AND s.retired_at IS NULL
       )
       SELECT lines.source_id AS source_id, loose.media_id AS media_id
       FROM loose JOIN lines ON lines.message = loose.message AND lines.iface IS loose.iface
       WHERE NOT EXISTS (
         SELECT 1 FROM media_links l JOIN media o ON o.id = l.media_id
         WHERE l.owner_kind = 'source' AND l.owner_id = lines.source_id AND o.native_ref = loose.ref
       )`
    )
    .all()
    .map((row) => ({ sourceId: asText(row.source_id), mediaId: asText(row.media_id) }));
}

// ---------- the describer's cache ----------
//
// The describer's cache (src/memory/describe.ts, src/web/lookup.ts) keeps one entry per key on the row of the item the
// key names, in `extra.cache[key]`, and nowhere else: a caption with its stamps, a miss, a link's read or a search's
// answer. A key names a reference and, by its prefix, a kind (`cacheKeyParts`), and every place of an interface reads
// the same rows. A write puts one entry and stamps the row with `writer` `media`, the place as `holder_id` and the
// moment as `used_at`, unless the GIF library holds the row (`writer` `gifs`). The rows a place holds are capped at
// `MEDIA_CACHE_ENTRIES` by last use, the rows a line or a diary entry links aside.

/** Successful describer payloads: a caption, or a question's answer, with their stamp. */
export type MediaDescriptionEntry =
  | { text: string; ts: number; [field: string]: unknown }
  | { answer: string; question: string; ts: number; [field: string]: unknown };

/** Whether a cache entry is a successful description. */
export function isMediaDescriptionEntry(value: unknown): value is MediaDescriptionEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Row;
  return (
    !entry.miss &&
    entry.pending !== true &&
    isFiniteNumber(entry.ts) &&
    ((typeof entry.text === 'string' && entry.text.length > 0) ||
      (typeof entry.answer === 'string' && entry.answer.length > 0 && typeof entry.question === 'string'))
  );
}

/** The rows of a place's cache nothing links are capped at this. Production value, config cut of 2026-10-31. */
export const MEDIA_CACHE_ENTRIES = 5000;

/** The keys of a lookup's own entries (src/web/lookup.ts): a saved description is never one of them. */
const LOOKUP_KEY = /^(?:preview|search|results|page):/;

/** The cache entries a row's `extra` holds. */
const cacheOf = (extra: Row): Row =>
  extra.cache !== null && typeof extra.cache === 'object' && !Array.isArray(extra.cache)
    ? { ...(extra.cache as Row) }
    : {};

/** The parsed `extra` of a row a read selected, parsed once however often the read asks. */
const parsedExtra = new WeakMap<Row, Row>();
function extraOf(row: Row): Row {
  let extra = parsedExtra.get(row);
  if (!extra) parsedExtra.set(row, (extra = parsedObject(row.extra)));
  return extra;
}

/** The references a key may be stored under: the key itself and the reference after its prefix. */
const refsOf = (key: string): Array<string> => {
  const { ref } = cacheKeyParts(key);
  return ref === key ? [key] : [key, ref];
};

/** The entry `key` holds on `row`, as the cache reads it: the row's text form under the entry's own fields. */
function entryOfRow(row: Row, key: string): Row | undefined {
  const extra = extraOf(row);
  const cache = extra.cache as Row | undefined;
  if (cache === null || typeof cache !== 'object' || Array.isArray(cache) || !Object.hasOwn(cache, key))
    return undefined;
  const entry = cache[key];
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
  if (Object.hasOwn(entry, '$raw')) return (entry as Row).$raw as Row;
  const text = row.description;
  return { ...(filled(text) ? { text } : {}), ...(entry as Row) };
}

/** The columns a read of the cache takes of a row. */
const CACHE_COLUMNS = 'rowid AS row_order, id, kind, native_ref, description, extra, writer, retired_at';
const ROWS_UNDER = `SELECT ${CACHE_COLUMNS} FROM media WHERE scope_iface IS ? AND native_ref IN (SELECT value FROM json_each(?))`;

/** The rows of an interface stored under any of `refs`, oldest first: the live ones, or with `retired` every one. */
const rowsUnder = (db: Db, iface: unknown, refs: ReadonlyArray<string>, { retired = false } = {}): Array<Row> =>
  preparedPlace(db, `${ROWS_UNDER}${retired ? '' : ' AND retired_at IS NULL'} ORDER BY rowid`).all(
    iface,
    JSON.stringify(refs)
  );

/** Rows by their reference, each list oldest first. */
function byRefOf(rows: ReadonlyArray<Row>): Map<unknown, Array<Row>> {
  const byRef = new Map<unknown, Array<Row>>();
  for (const row of rows) {
    const list = byRef.get(row.native_ref);
    if (list) list.push(row);
    else byRef.set(row.native_ref, [row]);
  }
  return byRef;
}

/** The rows under the references of `key`, oldest first. */
function candidatesOf(byRef: Map<unknown, Array<Row>>, key: string): Array<Row> {
  const refs = refsOf(key);
  if (refs.length === 1) return byRef.get(key) ?? [];
  return [...(byRef.get(refs[0]) ?? []), ...(byRef.get(refs[1]) ?? [])].sort(
    (a, b) => Number(a.row_order) - Number(b.row_order)
  );
}

/**
 * The live row of `key` among `rows` (the live rows under its references, oldest first): the one a write targets
 * (`mediaRowOfCacheKey`) when it holds the key, else the first that holds it.
 */
function holderOf(rows: ReadonlyArray<Row>, key: string): Row | undefined {
  const { ref, kinds } = cacheKeyParts(key);
  const exact = rows.find((row) => row.native_ref === key);
  const first = rows.find((row) => row.native_ref === ref);
  const target = exact ?? (kinds !== null && first && kinds.includes(first.kind as MediaKind) ? first : undefined);
  if (target && entryOfRow(target, key)) return target;
  return rows.find((row) => entryOfRow(row, key) !== undefined);
}

/** The cache's entry under `key` on this interface, or undefined. One query. */
export function mediaCacheEntry(db: Db, { iface, key }: { iface: unknown; key: string }): Row | undefined {
  const row = holderOf(rowsUnder(db, iface, refsOf(key)), key);
  return row ? entryOfRow(row, key) : undefined;
}

/**
 * The cache's entries under `keys` on this interface, each key that holds one; without `keys` every entry of the live
 * rows of the interface. One query.
 */
export function mediaCacheEntries(
  db: Db,
  { iface, keys }: { iface: unknown; keys?: Iterable<string> }
): Record<string, Row> {
  const out: Record<string, Row> = {};
  const wanted = keys === undefined ? null : [...new Set(keys)];
  if (wanted?.length === 0) return out;
  const rows = wanted
    ? rowsUnder(db, iface, [...new Set(wanted.flatMap(refsOf))])
    : preparedPlace(
        db,
        `SELECT ${CACHE_COLUMNS} FROM media WHERE scope_iface IS ? AND retired_at IS NULL AND json_type(extra, '$.cache') = 'object' ORDER BY rowid`
      ).all(iface);
  const byRef = byRefOf(rows);
  const asked = wanted ?? [...new Set(rows.flatMap((row) => Object.keys(cacheOf(extraOf(row)))))];
  for (const key of asked) {
    const holder = holderOf(candidatesOf(byRef, key), key);
    const entry = holder ? entryOfRow(holder, key) : undefined;
    if (entry !== undefined) out[key] = entry;
  }
  return out;
}

/**
 * The successful description `key` holds on this interface, live or on a row the trim retired: what the describer
 * takes up again rather than describing the item anew. Null for a miss, a lookup's entry or no entry.
 */
export function savedMediaDescription(
  db: Db,
  { iface, key }: { iface: unknown; key: string }
): MediaDescriptionEntry | null {
  if (LOOKUP_KEY.test(key)) return null;
  const rows = rowsUnder(db, iface, refsOf(key), { retired: true }).sort(
    (a, b) => Number(a.retired_at !== null) - Number(b.retired_at !== null)
  );
  for (const row of rows) {
    const entry = entryOfRow(row, key);
    if (isMediaDescriptionEntry(entry)) return entry;
  }
  return null;
}

/** Retires the oldest rows of the place nothing links past the cap, by last use. Returns how many. */
function trimPlace(db: Db, placeId: string, at: unknown): number {
  const held = Number(
    db
      .prepare("SELECT count(*) AS n FROM media WHERE writer = 'media' AND holder_id = ? AND retired_at IS NULL")
      .get(placeId)?.n ?? 0
  );
  if (held <= MEDIA_CACHE_ENTRIES) return 0;
  const victims = db
    .prepare(
      `SELECT id FROM media WHERE writer = 'media' AND holder_id = ? AND retired_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM media_links l WHERE l.media_id = media.id)
       ORDER BY used_at, rowid LIMIT ?`
    )
    .all(placeId, held - MEDIA_CACHE_ENTRIES);
  const retire = db.prepare('UPDATE media SET retired_at = ? WHERE id = ?');
  for (const victim of victims) {
    retire.run(iso(at), victim.id);
    projectRow(db, 'media', { id: victim.id }, { at });
  }
  return victims.length;
}

/** A key no live row holds: a row its item's observation finds by reference, made when none is retired. */
function cacheRowFor(db: Db, iface: unknown, key: string): { row: Row; isNew: boolean } {
  const retired = rowsUnder(db, iface, refsOf(key), { retired: true }).find(
    (row) => row.retired_at !== null && entryOfRow(row, key) !== undefined
  );
  if (retired) return { row: retired, isNew: retired.writer === 'media' };
  const { ref, kinds } = cacheKeyParts(key);
  const id = NEW_ID(iface, key);
  const scope = audienceOf(groupScope(iface === null ? null : asText(iface)));
  ensureAudience(db, scope);
  db.prepare(
    `INSERT OR IGNORE INTO media (id, kind, native_ref, availability, extra, scope_kind, scope_iface, scope_dm, audience_id)
     VALUES (?, ?, ?, 'unknown', '{}', ?, ?, ?, ?)`
  ).run(id, kinds?.[0] ?? 'image', ref, scope.scope_kind, scope.scope_iface, scope.scope_dm, scope.audience_id);
  return { row: db.prepare('SELECT * FROM media WHERE id = ?').get(id) as Row, isNew: true };
}

/** One write of the describer's cache: an entry put on its row, or a key dropped. */
export type MediaEntryWrite =
  { op: 'put'; placeId: string; key: string; entry: Row } | { op: 'drop'; placeId: string; key: string };

/**
 * Puts `entry` under `key` on the row of its item, in the caller's transaction: the entry's text becomes the row's text
 * form when nothing better is held, and the row gets its graph node. A row the cache's trim retired comes back, and may
 * push the place's oldest row past the cap. A row a line released (retireUnlinked) belongs to no cache and stays
 * retired, so a late description of an item an edit replaced shows nowhere.
 */
export function writeMediaEntry(
  db: Db,
  { placeId, iface, key, entry, at }: { placeId: string; iface: unknown; key: string; entry: Row; at: number }
): { written: number; retired: number } {
  const live = mediaRowOfCacheKey(db, iface, key) ?? holderOf(rowsUnder(db, iface, refsOf(key)), key);
  const { row, isNew } = live ? { row: live, isNew: false } : cacheRowFor(db, iface, key);
  const extra = parsedObject(row.extra);
  const cache = { ...cacheOf(extra), [key]: entry };
  db.prepare(
    `UPDATE media SET extra = ?, used_at = ?,
       retired_at = CASE WHEN writer = 'media' THEN NULL ELSE retired_at END,
       writer = CASE WHEN writer = 'gifs' OR (retired_at IS NOT NULL AND writer IS NOT 'media') THEN writer ELSE 'media' END,
       holder_id = CASE WHEN writer = 'gifs' OR (retired_at IS NOT NULL AND writer IS NOT 'media') THEN holder_id ELSE ? END
     WHERE id = ?`
  ).run(JSON.stringify({ ...extra, cache }), at, placeId, row.id);
  if (filled(entry.text)) {
    const fresh = db.prepare('SELECT * FROM media WHERE id = ?').get(row.id) as Row;
    writeText(db, fresh, {
      text: entry.text,
      origin: originOf(fresh.kind, fresh.native_ref !== key && cacheKeyParts(key).watched),
      at: isFiniteNumber(entry.ts) ? entry.ts : at,
    });
  }
  projectRow(db, 'media', { id: row.id }, { at });
  return { written: 1, retired: isNew ? trimPlace(db, placeId, at) : 0 };
}

/** Drops `key` from the row that holds it; a cache row left with no key and no link is retired. */
export function dropMediaEntry(
  db: Db,
  { iface, key, at }: { iface: unknown; key: string; at: number }
): { written: number; retired: number } {
  const row = holderOf(rowsUnder(db, iface, refsOf(key)), key);
  if (!row) return { written: 0, retired: 0 };
  const extra = parsedObject(row.extra);
  const cache = cacheOf(extra);
  delete cache[key];
  db.prepare('UPDATE media SET extra = ? WHERE id = ?').run(JSON.stringify({ ...extra, cache }), row.id);
  const empty =
    Object.keys(cache).length === 0 &&
    row.writer === 'media' &&
    db.prepare('SELECT 1 FROM media_links WHERE media_id = ? LIMIT 1').get(row.id) === undefined;
  if (empty) db.prepare('UPDATE media SET retired_at = ? WHERE id = ?').run(iso(at), row.id);
  projectRow(db, 'media', { id: row.id }, { at });
  return { written: 1, retired: empty ? 1 : 0 };
}

/**
 * At the engine's start, every cache entry still `pending` from a describer's request the stop cut is settled, in the
 * caller's transaction. An entry with no text becomes a miss with the reason `interrupted`: the line then shows that
 * the item could not be looked at, and the describer's handling of a miss applies. An entry that holds a description
 * keeps it, loses the mark and is stamped `refreshFailedAt`, as a failed refresh is. Returns how many entries changed.
 */
export function interruptPendingMediaEntries(db: Db, at: number): number {
  let changed = 0;
  const rows = db
    .prepare(
      `SELECT id, extra FROM media WHERE json_type(extra, '$.cache') = 'object'
         AND EXISTS (SELECT 1 FROM json_each(extra, '$.cache') e WHERE json_extract(e.value, '$.pending') = 1)`
    )
    .all();
  for (const row of rows) {
    const extra = parsedObject(row.extra);
    const cache = cacheOf(extra);
    for (const [key, entry] of Object.entries(cache)) {
      if (entry === null || typeof entry !== 'object' || (entry as Row).pending !== true) continue;
      const kept = Object.fromEntries(Object.entries(entry).filter(([field]) => field !== 'pending'));
      cache[key] = filled(kept.text) ? { ...kept, refreshFailedAt: at } : { miss: true, ts: at, reason: 'interrupted' };
      changed += 1;
    }
    db.prepare('UPDATE media SET extra = ? WHERE id = ?').run(JSON.stringify({ ...extra, cache }), row.id);
    projectRow(db, 'media', { id: row.id }, { at });
  }
  return changed;
}

/** A write of the kind as the writer receives it, checked. */
function mediaEntryWriteOf(update: Row): MediaEntryWrite {
  const coded = (code: string): Error => Object.assign(new Error(code), { code });
  if (!filled(update.placeId) || !filled(update.key)) throw coded('MEDIA_ENTRY_KEY');
  if (update.op === 'drop') return { op: 'drop', placeId: update.placeId, key: update.key };
  const entry = update.entry;
  if (update.op !== 'put' || entry === null || typeof entry !== 'object' || Array.isArray(entry))
    throw coded('MEDIA_ENTRY_OP');
  return { op: 'put', placeId: update.placeId, key: update.key, entry: entry as Row };
}

/**
 * The interface whose rows hold a place's cache: the place's own row's, else the interface the write names (a place
 * with no row, such as the persona's own), else none.
 */
export function cacheIface(db: Db, placeId: string, named: string | null): string | null {
  const iface = preparedPlace(db, 'SELECT iface FROM places WHERE id = ?').get(placeId)?.iface;
  return filled(iface) ? iface : named;
}

/** The write kind `media-entry` on the writer connection (session-write.ts). */
export function applyMediaEntryWrite(connection: Connection, update: Row): { written: number; retired: number } {
  const write = mediaEntryWriteOf(update);
  const at = isFiniteNumber(update.now) ? update.now : Date.now();
  const named = filled(update.iface) ? update.iface : null;
  return transactionOf(connection)(() => {
    const db = dbOf(connection);
    const iface = cacheIface(db, write.placeId, named);
    return write.op === 'put'
      ? writeMediaEntry(db, { placeId: write.placeId, iface, key: write.key, entry: write.entry, at })
      : dropMediaEntry(db, { iface, key: write.key, at });
  });
}

/** Fields of a row's `extra` a library entry does not hold, which its write must not lose: the row is an item too. */
const ITEM_EXTRA = ['textOrigin', 'cache'];

/** What an item's row keeps across a write of its GIF library entry, added to the row the entry makes. */
export function keepItemFields(db: Db, rows: ReadonlyArray<Row>): void {
  for (const row of rows) {
    const held = db.prepare('SELECT extra FROM media WHERE id = ?').get(row.id);
    if (!held) continue;
    const kept = parsedObject(held.extra);
    const fields = Object.fromEntries(ITEM_EXTRA.filter((key) => key in kept).map((key) => [key, kept[key]]));
    if (Object.keys(fields).length > 0) row.extra = JSON.stringify({ ...parsedObject(row.extra), ...fields });
  }
}

/**
 * The GIF library's row `id` and every other row of its item (one of its references on the same interface) become one:
 * the library's row takes their links, their text with its vector, and the describer's cache, and they go. An
 * observation made such a row before the library held the item, an entry that moved to a new key leaves its old row
 * behind, and an entry joined into another by content hash leaves its own (gif-library.ts).
 */
export function adoptSameItem(db: Db, id: string, at: unknown): void {
  const row = db.prepare('SELECT id, native_ref, scope_iface, extra FROM media WHERE id = ?').get(id);
  if (!row || row.native_ref === null) return;
  const listed = parsedObject(row.extra).nativeIds;
  const refs = [...new Set([row.native_ref, ...(Array.isArray(listed) ? listed.filter(filled) : [])])];
  for (const other of db
    .prepare(
      `SELECT * FROM media WHERE native_ref IN (${refs.map(() => '?').join(', ')}) AND scope_iface IS ? AND id <> ?`
    )
    .all(...refs, row.scope_iface, row.id)) {
    db.prepare('UPDATE OR IGNORE media_links SET media_id = ? WHERE media_id = ?').run(row.id, other.id);
    // An owner that linked both rows keeps its link to the library's row.
    db.prepare('DELETE FROM media_links WHERE media_id = ?').run(other.id);
    const otherExtra = parsedObject(other.extra);
    if (filled(other.description)) {
      const held = db.prepare('SELECT * FROM media WHERE id = ?').get(row.id) as Row;
      writeText(db, held, {
        text: other.description,
        origin: (otherExtra.textOrigin as MediaOrigin | undefined) ?? 'retelling',
        at,
      });
    }
    const held = db.prepare('SELECT description, extra FROM media WHERE id = ?').get(row.id) as Row;
    const heldExtra = parsedObject(held.extra);
    const cache = { ...cacheOf(otherExtra), ...cacheOf(heldExtra) };
    if (Object.keys(cache).length > 0)
      db.prepare('UPDATE media SET extra = ? WHERE id = ?').run(JSON.stringify({ ...heldExtra, cache }), row.id);
    // The other row's vector was made from the text the library's row holds now: it moves, unless the row has its own.
    if (filled(other.description) && held.description === other.description)
      db.prepare('UPDATE OR IGNORE vectors SET chunk_key = ?, item_id = ? WHERE chunk_key = ?').run(
        vectorKey(row.id),
        row.id,
        vectorKey(other.id)
      );
    db.prepare('DELETE FROM vectors WHERE chunk_key = ?').run(vectorKey(other.id));
    db.prepare('DELETE FROM media WHERE id = ?').run(other.id);
  }
}

// ---------- a diary entry's files ----------

/** A file of a diary entry, as a post keeps it. */
export type EntryFile = {
  id: string;
  position: number;
  path: string | null;
  attachmentId: string | null;
  messageId: string | null;
  url: string | null;
  description: string | null;
  sha1: string | null;
  bytes: number | null;
  mime: string | null;
  extra: Row;
};

/** The kind of a stored file by its type: her voice message, audio, a GIF, a picture, a video, or a file. Pure. */
export function kindOfFile(mime: unknown, extra: Row): MediaKind {
  const type = asText(mime ?? '').toLowerCase();
  if (type.startsWith('audio/')) return extra.voice === true ? 'voice' : 'audio';
  if (type === 'image/gif') return 'gif';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  return 'file';
}

/**
 * The files of a diary entry as items linked to it at their positions, with their paths. A file the platform names through a
 * message she posted is the same item as that message's, so it has two links. The entry's scope goes on a row it creates.
 */
export function writeEntryFiles(db: Db, entry: Row, files: ReadonlyArray<EntryFile>, at: unknown): void {
  const link = linkStatement(db);
  for (const file of files) {
    const { position } = file;
    const iface = entry.scope_iface ?? null;
    const held = (file.attachmentId !== null ? itemByRef(db, iface, file.attachmentId) : undefined) ?? undefined;
    const previous = db
      .prepare("SELECT media_id FROM media_links WHERE owner_kind = 'diary' AND owner_id = ? AND position = ?")
      .get(entry.id, position);
    const id = held ? String(held.id) : file.id;
    const voiced = filled(file.extra.text) ? file.extra.text : null;
    // A read that named no attachment is not asked again (pendingDiaryRows).
    const extra: Row = {
      ...parsedObject(held?.extra),
      ...file.extra,
      ...defined({ messageId: file.messageId, url: file.url }),
    };
    delete extra.text;
    if (held) {
      db.prepare(
        'UPDATE media SET path = ?, sha1 = ?, bytes = ?, mime = ?, extra = ?, retired_at = NULL WHERE id = ?'
      ).run(file.path, file.sha1, file.bytes, file.mime, JSON.stringify(extra), id);
    } else {
      db.prepare(
        `INSERT INTO media (id, kind, owner, path, native_ref, sha1, bytes, mime, extra, availability, scope_kind, scope_iface, scope_dm, audience_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET path = excluded.path, native_ref = excluded.native_ref, sha1 = excluded.sha1,
           bytes = excluded.bytes, mime = excluded.mime, extra = excluded.extra, retired_at = NULL, scope_kind = excluded.scope_kind,
           scope_iface = excluded.scope_iface, scope_dm = excluded.scope_dm, audience_id = excluded.audience_id`
      ).run(
        id,
        kindOfFile(file.mime, file.extra),
        entry.id ?? null,
        file.path,
        file.attachmentId,
        file.sha1,
        file.bytes,
        file.mime,
        JSON.stringify(extra),
        entry.scope_kind ?? null,
        iface,
        entry.scope_dm ?? null,
        entry.audience_id ?? null
      );
    }
    link.run('diary', entry.id, position, id);
    if (previous && previous.media_id !== id) {
      dropIfBare(db, previous.media_id);
      dropTwin(db, previous.media_id, id);
    }
    const row = db.prepare('SELECT * FROM media WHERE id = ?').get(id) as Row;
    if (voiced !== null) writeText(db, row, { text: voiced, origin: 'voiced', at });
    else if (filled(file.description)) writeText(db, row, { text: file.description, origin: 'retelling', at });
    projectRow(db, 'media', { id }, { at });
  }
}

// ---------- the vector of a text form ----------

/** The `chunk_key` of a row's vector. */
const vectorKey = (mediaId: unknown): string => `media:${asText(mediaId)}`;
// Range bounds of those keys: `;` sorts right after `:`.
/** The `kind` of a media row's vector. */
const VECTOR_KIND = 'media';

/** The items with a text form and no vector yet that a line links or the GIF library holds, oldest first. */
export function pendingMediaEmbeds(db: Db, limit = 50): Array<Row> {
  return db
    .prepare(
      `SELECT m.id AS id, m.description AS description, m.scope_kind AS scope_kind, m.scope_iface AS scope_iface,
         m.scope_dm AS scope_dm, m.audience_id AS audience_id, m.described_at AS described_at
       FROM media m WHERE m.description IS NOT NULL AND m.description <> '' AND m.retired_at IS NULL
         AND (m.writer = 'gifs' OR EXISTS (SELECT 1 FROM media_links l WHERE l.media_id = m.id))
         AND NOT EXISTS (SELECT 1 FROM vectors v WHERE v.chunk_key = 'media:' || m.id)
       ORDER BY m.rowid LIMIT ?`
    )
    .all(Math.max(1, limit));
}

/** Embeds the text forms that wait, each once however many messages link it. A failed embedding request leaves them waiting. */
export async function embedMedia({
  db,
  write,
  embed,
  config,
  now,
  quantize,
  model = null,
  limit = 50,
}: {
  db: Db;
  write: (update: Row) => Promise<unknown>;
  embed: (texts: Array<string>, options: Row) => Promise<unknown>;
  config: unknown;
  now: number;
  quantize: (vector: Float32Array) => { bytes: Uint8Array | Int8Array; scale: number; norm: number };
  model?: string | null;
  limit?: number;
}): Promise<{ embedded: number; written: number; skipped: number; pending: number }> {
  const pending = pendingMediaEmbeds(db, limit);
  if (pending.length === 0) return { embedded: 0, written: 0, skipped: 0, pending: 0 };
  // The embedding client answers one vector per text.
  const vectors = (await embed(
    pending.map((row) => String(row.description)),
    { config, purpose: 'media' }
  )) as ArrayLike<ArrayLike<number>>;
  const rows = pending.map((row, i) => {
    const vector = vectors[i];
    const floats = vector instanceof Float32Array ? vector : Float32Array.from(vector);
    const { bytes, scale, norm } = quantize(floats);
    return { row, bytes, scale, norm, dims: floats.length };
  });
  const done = (await write({
    rows: rows.map(({ row, bytes, scale, norm, dims }) => ({
      mediaId: row.id,
      bytes,
      scale,
      norm,
      dims,
      model,
      description: row.description,
      now,
    })),
  })) as { written?: number } | undefined;
  return { embedded: rows.length, written: done?.written ?? 0, skipped: 0, pending: pending.length };
}

/** Whether a source row (`s`) shows an item with a text form, as SQL. */
export const LINE_HOLDS_TOLD_MEDIA = `EXISTS (SELECT 1 FROM media_links l JOIN media m ON m.id = l.media_id
  WHERE l.owner_kind = 'source' AND l.owner_id = s.id AND m.description IS NOT NULL)`;

/** Whether a source row (`s`) shows any media, as SQL. */
export const LINE_HOLDS_MEDIA =
  "EXISTS (SELECT 1 FROM media_links l WHERE l.owner_kind = 'source' AND l.owner_id = s.id)";

/** Writes the vectors `embedMedia` made, each only while its row still holds the text it was made from. */
export function applyMediaEmbed(connection: Connection, { rows }: Row): { written: number } {
  const db = dbOf(connection);
  return transactionOf(connection)(() => {
    let written = 0;
    for (const row of listOf(rows)) {
      const item = db.prepare('SELECT * FROM media WHERE id = ?').get(row.mediaId);
      if (!item || item.description !== row.description) continue;
      const bytes = row.bytes as { buffer: ArrayBuffer; byteOffset: number; byteLength: number };
      db.prepare(
        `INSERT INTO vectors (source_rowid, item_id, chunk_key, model, dims, scale, norm, bytes, context, occurred_at, scope_kind, scope_iface, scope_dm, audience_id, kind)
         VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, '${VECTOR_KIND}')
         ON CONFLICT(chunk_key) DO UPDATE SET model = excluded.model, dims = excluded.dims, scale = excluded.scale,
           norm = excluded.norm, bytes = excluded.bytes`
      ).run(
        item.id,
        vectorKey(item.id),
        row.model ?? null,
        row.dims,
        row.scale,
        row.norm,
        Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        item.described_at ?? null,
        item.scope_kind ?? null,
        item.scope_iface ?? null,
        item.scope_dm ?? null,
        item.audience_id ?? null
      );
      written += 1;
    }
    return { written };
  });
}

// ---------- search ----------

/** One use of an item a reader may see. */
export type MediaUse = { sourceId: string; rowid: number; messageId: string; placeId: string | null; ts: number };
/** One item a search found: how many visible messages show it, the latest of them, and a few to go to. */
export type MediaHit = {
  mediaId: string;
  kind: string;
  description: string;
  uses: number;
  latest: MediaUse;
  messages: Array<MediaUse>;
  streams: Array<string>;
  score: number;
  terms: number;
  cosine: number | null;
};

/** The messages of an item a hit names: enough to go to, never the whole of a much-reused one. */
const HIT_MESSAGES = 20;
/** The reciprocal-rank constant, as src/behavior/recall.ts fuses message streams. */
const RANK_K = 60;

/** The uses of one item a reader may see, by the filters of the reader's search (`filter`, over alias `s`). */
function visibleUses(
  db: Db,
  mediaId: unknown,
  filter: { sql: string; params: ReadonlyArray<string> }
): { uses: number; messages: Array<MediaUse> } {
  const where = `FROM media_links l CROSS JOIN sources s ON s.id = l.owner_id
    WHERE l.media_id = ? AND l.owner_kind = 'source' AND ${CURRENT_SOURCE} AND ${filter.sql}`;
  const uses = Number(db.prepare(`SELECT COUNT(*) AS n ${where}`).get(mediaId, ...filter.params)?.n ?? 0);
  if (uses === 0) return { uses: 0, messages: [] };
  const messages = db
    .prepare(
      `SELECT s.id AS id, s.rowid AS row_id, s.native_id AS native_id, s.place_id AS place_id, ${LINE_MOMENT} AS occurred_at
       ${where} ORDER BY ${LINE_MOMENT} DESC, ${LINE_ROWID} DESC LIMIT ${HIT_MESSAGES}`
    )
    .all(mediaId as string, ...filter.params)
    .map((row) => ({
      sourceId: String(row.id),
      rowid: Number(row.row_id),
      messageId: String(row.native_id),
      placeId: orNull(row.place_id),
      ts: Date.parse(String(row.occurred_at)),
    }));
  return { uses, messages };
}

/**
 * The items a search's terms and its vector find, one hit per item and one per set of equal bytes, each only through a message
 * the reader may see. `match` is the word stream's FTS query, `fragments` the parts of a word it did not find.
 */
export function mediaHits(
  db: Db,
  {
    match,
    fragments,
    wordOf,
    vector,
    model,
    minMeaning,
    filter,
    limit,
  }: {
    match: string | null;
    fragments: (held: (fragment: string) => boolean) => ReadonlyArray<string>;
    wordOf: (row: Row) => number;
    vector?: ArrayLike<number> | null;
    model?: unknown;
    minMeaning: number;
    filter: { sql: string; params: ReadonlyArray<string> };
    limit: number;
  }
): Array<MediaHit> {
  const streams = new Map<string, { row: Row; ranks: Map<string, number> }>();
  const note = (row: Row, stream: string, rank: number): void => {
    const entry = streams.get(String(row.id)) ?? { row, ranks: new Map<string, number>() };
    if (!entry.ranks.has(stream)) entry.ranks.set(stream, rank);
    streams.set(String(row.id), entry);
  };
  if (match !== null) {
    db.prepare(
      `SELECT m.id AS id, m.kind AS kind, m.description AS description, m.sha1 AS sha1, m.stems AS stems, m.extra AS extra
       FROM media_fts JOIN media m ON m.rowid = media_fts.rowid
       WHERE media_fts MATCH ? AND m.retired_at IS NULL ORDER BY bm25(media_fts, 0.0, 1.0) LIMIT ?`
    )
      .all(match, limit)
      .forEach((row, rank) => note(row, 'words', rank));
  }
  const words = db.prepare(
    `SELECT m.id AS id, m.kind AS kind, m.description AS description, m.sha1 AS sha1, m.stems AS stems, m.extra AS extra
     FROM media_tri JOIN media m ON m.rowid = media_tri.rowid
     WHERE media_tri MATCH ? AND m.retired_at IS NULL ORDER BY bm25(media_tri) LIMIT ?`
  );
  const held = (fragment: string): boolean =>
    [...streams.values()].some(({ row }) =>
      asText(row.description ?? '')
        .toLowerCase()
        .includes(fragment.toLowerCase())
    );
  for (const fragment of fragments(held))
    words.all(`"${fragment.replace(/"/g, '""')}"`, limit).forEach((row, rank) => note(row, 'trigram', rank));
  for (const [rank, row] of meaningRows(db, { vector, model, minMeaning, limit: limit * 4 }).entries())
    note(row, 'meaning', rank);

  const groups = new Map<string, MediaHit>();
  for (const { row, ranks } of streams.values()) {
    const { uses, messages } = visibleUses(db, row.id, filter);
    if (uses === 0) continue;
    const key = filled(row.sha1) ? `sha1:${row.sha1}` : `id:${String(row.id)}`;
    const score = [...ranks.values()].reduce((sum, rank) => sum + 1 / (RANK_K + rank + 1), 0);
    const held2 = groups.get(key);
    const heldMessages = held2?.messages ?? [];
    const seen = new Set(heldMessages.map((one) => one.sourceId));
    const merged = [...heldMessages, ...messages.filter((one) => !seen.has(one.sourceId))]
      .sort((a, b) => b.ts - a.ts)
      .slice(0, HIT_MESSAGES);
    groups.set(key, {
      mediaId: held2?.mediaId ?? String(row.id),
      kind: held2?.kind ?? String(row.kind),
      description: held2?.description ?? asText(row.description ?? ''),
      uses: (held2?.uses ?? 0) + uses,
      latest: merged[0],
      messages: merged,
      streams: [...new Set([...(held2?.streams ?? []), ...ranks.keys()])],
      score: Math.max(held2?.score ?? 0, score),
      terms: Math.max(held2?.terms ?? 0, wordOf(row)),
      cosine: Math.max(held2?.cosine ?? -1, typeof row.cosine === 'number' ? row.cosine : -1),
    });
  }
  return [...groups.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

/** The rows of the media vectors nearest `vector`, best first, at or over `minMeaning`. */
function meaningRows(
  db: Db,
  {
    vector,
    model,
    minMeaning,
    limit,
  }: { vector?: ArrayLike<number> | null; model?: unknown; minMeaning: number; limit: number }
): Array<Row> {
  if (!vector || vector.length === 0) return [];
  const q = vector instanceof Float32Array ? vector : Float32Array.from(vector);
  let qq = 0;
  for (const value of q) qq += value * value;
  const qNorm = Math.sqrt(qq);
  if (!(qNorm > 0)) return [];
  const modelSql = filled(model) ? ' AND (v.model IS NULL OR v.model = ?)' : '';
  const scored: Array<{ row: Row; score: number }> = [];
  for (const row of db
    .prepare(
      `SELECT m.id AS id, m.kind AS kind, m.description AS description, m.sha1 AS sha1, m.stems AS stems, m.extra AS extra,
         v.bytes AS bytes, v.scale AS scale, v.norm AS norm
       FROM vectors v CROSS JOIN media m ON m.id = v.item_id
       WHERE v.kind = '${VECTOR_KIND}' AND v.dims = ?${modelSql}
         AND v.bytes IS NOT NULL AND m.retired_at IS NULL`
    )
    .iterate(q.length, ...(modelSql ? [model as string] : []))) {
    const bytes = row.bytes as Uint8Array;
    const signed = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let dot = 0;
    for (let i = 0; i < q.length; i += 1) dot += signed[i] * q[i];
    const norm = Number(row.norm);
    const score = norm > 0 ? (dot * Number(row.scale)) / (norm * qNorm) : 0;
    if (score >= minMeaning) scored.push({ row, score });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((one) => ({ ...one.row, cosine: one.score }));
}
