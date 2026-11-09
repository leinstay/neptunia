// The one store of media: the table `media`, one row per item, and `media_links(owner_kind, owner_id, position, media_id)`, which
// ties an item to the messages and selfreflection entries that show it. `kind` is the closed list `MEDIA_KINDS`, `native_ref` the
// interface's reference, opaque here, and `path` null or a file under `media/`. An item's text form is `description`, in English
// with speech and on-screen text quoted, and its origin `extra.textOrigin` (`MEDIA_ORIGINS`); what else a kind has sits in
// `extra`. Audience comes only from a link: an item is read through an owner the reader may open.
//
// `lineMedia` is the one read of a line's or an entry's media, `tellMedia` the one write of a text form, and the describer's
// cache (`src/memory/describe.ts`, through `writeMediaCache` and `tellFromCacheKey`) writes the same rows. A text form is
// stemmed and embedded once on its row: `media_fts`, `media_tri` and a vector whose `chunk_key` names the row. `mediaHits` turns
// the rows a search finds into one hit per item, with its use count and its latest visible use, grouping re-uploads by `sha1`.

import fs from 'node:fs';
import path from 'node:path';
import { projectRow } from './graph.ts';
import { audienceOf, groupScope, scopeWhere } from './scope.ts';
import { ensureAudience } from './rows.ts';
import { CURRENT_SOURCE } from './source-current.ts';
import { safeFileName } from '../../media/classify.ts';
import { keptPathOf } from '../../media/kept-files.ts';
import { mediaStamp } from './media-stems.ts';
import { loadStemmer } from './stems.ts';
import { asText, dbOf, isFiniteNumber, transactionOf } from './types.ts';
import type { Connection, Db, Row } from './types.ts';

/** The prefix of the id of a picture of a selfreflection entry, `media:selfreflection:<entry>-<n>`. */
export const ENTRY_MEDIA = 'media:selfreflection:';

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
export type MediaOwnerKind = 'source' | 'selfreflection';

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
};

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
      extra: defined({ name: orNull(emoji.name) }),
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
  const fromCard = (card: Row): MediaItem =>
    linkItem({ ...card, id: card.id, title: card.title, site: card.site, url: card.url, text: card.description });
  const kinds = Array.isArray(line.media) ? (line.media as Array<unknown>).filter(filled) : [];
  const items = kinds.map((kind): MediaItem => {
    if (kind === 'link' && cards.length > 0) return fromCard(cards.shift()!);
    return { ...BARE, ...closedKind(kind) };
  });
  return [...items, ...cards.map(fromCard)];
}

// ---------- the read ----------

const OWNER_TABLE: Readonly<Record<MediaOwnerKind, string>> = { source: 'sources', selfreflection: 'selfreflection' };

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
    const list = found.get(String(row.owner_id));
    if (list) list.push(item);
    else found.set(String(row.owner_id), [item]);
  }
  return found;
}

/** A line's media item as a request reads it: its kind and its text form, null while it has none. */
export type LineMediaItem = { kind: string; text: string | null };

/** A line's media rows as a request reads them, in position order. Pure. */
export const lineMediaItems = (rows: ReadonlyArray<MediaRow>): Array<LineMediaItem> =>
  rows.map((row) => ({ kind: row.kind, text: row.description }));

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
      availability: item.text === null ? 'unknown' : 'present',
      extra: {},
    })),
    lineId
  );
}

/** A line's text forms in position order, nothing of a bare item. */
export function mediaText(rows: ReadonlyArray<MediaRow>): string {
  return rows
    .map((row) => row.description ?? '')
    .filter(Boolean)
    .join(' ');
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
  rows: ReadonlyArray<Pick<MediaRow, 'kind' | 'position' | 'nativeRef' | 'description' | 'availability' | 'extra'>>,
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
    const held = told;
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
        parts.emojis.push({ id, name: name ?? '', stored: true, ...held });
        break;
      case 'text':
        parts.attachments.push({
          id,
          kind: 'text',
          name: name ?? row.kind,
          ...(row.description === null ? {} : { previewText: row.description }),
        });
        break;
      case 'file':
        parts.attachments.push({ id, kind: 'file', name: name ?? row.kind });
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

/**
 * The cache keys of every item a live owner links: the trim of the describer's cache leaves these alone. A row's own cap lives in
 * writeMediaCache, and these keep the in-memory cache from forgetting them too.
 */
export function linkedAttachmentIds(db: Db): Set<string> {
  const keys = new Set<string>();
  for (const row of db
    .prepare(
      `SELECT DISTINCT m.native_ref AS ref, m.kind AS kind FROM media_links l JOIN media m ON m.id = l.media_id
       WHERE m.native_ref IS NOT NULL AND m.retired_at IS NULL`
    )
    .all()) {
    const ref = asText(row.ref);
    keys.add(ref);
    if (row.kind === 'video' || row.kind === 'link') keys.add(`video:${ref}`);
    if (row.kind === 'sticker') keys.add(`sticker:${ref}`);
    if (row.kind === 'emoji') keys.add(`emoji:${ref}`);
    if (row.kind === 'link') keys.add(`link:${ref}`);
  }
  return keys;
}

/** The items of a selfreflection entry in its order, with what its post keeps of each. */
export function entryMedia(db: Db, entryId: string): Array<Row> {
  return db
    .prepare(
      `SELECT l.position AS position, m.id AS id, m.kind AS kind, m.native_ref AS native_ref, m.path AS path, m.mime AS mime,
         m.bytes AS bytes, m.extra AS extra
       FROM media_links l JOIN media m ON m.id = l.media_id
       WHERE l.owner_kind = 'selfreflection' AND l.owner_id = ? AND m.retired_at IS NULL ORDER BY l.position`
    )
    .all(entryId);
}

/**
 * The description of each entry's first linked picture, by entry id: the image at the lowest position of its
 * `media_links`, retired ones left out. An entry whose first picture has no description has no entry.
 */
export function entryPictureDescriptions(db: Db, entryIds: ReadonlyArray<string>): Map<string, string> {
  const found = new Map<string, string>();
  if (entryIds.length === 0) return found;
  const rows = db
    .prepare(
      `SELECT l.owner_id AS owner_id, m.description AS description
       FROM media_links l JOIN media m ON m.id = l.media_id
       WHERE l.owner_kind = 'selfreflection' AND l.owner_id IN (SELECT value FROM json_each(?))
         AND m.kind = 'image' AND m.retired_at IS NULL
       ORDER BY l.owner_id, l.position`
    )
    .all(JSON.stringify(entryIds));
  const seen = new Set<string>();
  for (const row of rows) {
    const id = asText(row.owner_id);
    if (seen.has(id)) continue;
    seen.add(id);
    const description = asText(row.description ?? '').trim();
    if (description) found.set(id, description);
  }
  return found;
}

/** Whether an entry holds a file its post has not named on the platform, and whether it holds a voice file. */
export function entryFilesPending(db: Db, entryId: string): { unnamed: boolean; voice: boolean } {
  const rows = entryMedia(db, entryId);
  return {
    unnamed: rows.some((row) => row.native_ref === null),
    voice: rows.some((row) => asText(row.mime ?? '').startsWith('audio/')),
  };
}

/** Puts a restricted selfreflection entry's own files under the internal audience. */
export function restrictEntryMedia(db: Db, entryId: string, audience: string): Array<Row> {
  const media = entryMedia(db, entryId);
  const update = db.prepare(
    "UPDATE media SET scope_kind = 'internal', scope_iface = NULL, scope_dm = NULL, audience_id = ? WHERE id = ?"
  );
  for (const item of media) update.run(audience, item.id);
  return media;
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
         (SELECT 1 FROM media_links l WHERE l.media_id = m.id AND l.owner_kind = 'selfreflection') AS in_selfreflection
       FROM media m WHERE m.retired_at IS NULL`
    )
    .iterate()) {
    if (!row.in_selfreflection || !filled(row.path)) {
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
  db.prepare('DELETE FROM vectors WHERE chunk_key = ?').run(vectorKey(row.id));
  return true;
}

/** Tells the item with this reference on this interface its text form. Returns how many rows changed. Runs on the writer. */
export function tellMedia(
  connection: Connection,
  {
    iface,
    nativeRef,
    description,
    origin,
    at = null,
  }: { iface: string | null; nativeRef: string; description: string; origin: MediaOrigin; at?: unknown }
): number {
  const db = dbOf(connection);
  return transactionOf(connection)(() => {
    const row = itemByRef(db, iface, nativeRef);
    return row && writeText(db, row, { text: description, origin, at }) ? 1 : 0;
  });
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

/**
 * The describer's write reaching an item: its cache key names a reference and, for a prefixed key, the kinds the prefix
 * belongs to. A plain key is the reference as it came, so a reference that looks like a key is still only a reference.
 */
export function tellFromCacheKey(
  db: Db,
  { iface, key, text, at }: { iface: unknown; key: string; text: string; at: unknown }
): number {
  const row = mediaRowOfCacheKey(db, iface, key);
  if (!row) return 0;
  const watched = itemByRef(db, iface, key) === undefined && cacheKeyParts(key).watched;
  return writeText(db, row, { text, origin: originOf(row.kind, watched), at }) ? 1 : 0;
}

/** Whether the item a describer's key names holds a text form on this interface. */
export function itemTold(db: Db, iface: unknown, key: string): boolean {
  return filled(mediaRowOfCacheKey(db, iface, key)?.description);
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

/** The media row of one item of `line`: the held one, or a new one. */
function itemRowFor(db: Db, line: LineRow, item: MediaItem, position: number): Row {
  const iface = line.scope_iface ?? null;
  const held = item.nativeRef === null ? undefined : itemByRef(db, iface, item.nativeRef);
  if (held) {
    mergeItem(db, held, item);
    return db.prepare('SELECT * FROM media WHERE id = ?').get(held.id) as Row;
  }
  const id = item.nativeRef === null ? BARE_ID(line.id, position) : NEW_ID(iface, item.nativeRef);
  insertItem(db, line, item, id);
  return db.prepare('SELECT * FROM media WHERE id = ?').get(id) as Row;
}

/** What is told of `row` after a line is linked to it: a text form the item brought, and how a still frame reads. */
function tellItem(db: Db, row: Row, item: MediaItem, at: unknown): number {
  if (item.description !== null && item.origin !== null)
    return writeText(db, row, { text: item.description, origin: item.origin, at }) ? 1 : 0;
  // A cache row knew no kind: what it held of a video was a frame, of a voice its transcript, of a text its preview.
  const extra = parsedObject(row.extra);
  if (!filled(row.description)) return 0;
  const held = extra.textOrigin;
  if (held === 'voiced' || held === 'embed' || held === 'page') return 0;
  const origin = originOf(row.kind, extra.watched === true);
  if (held !== origin) {
    db.prepare('UPDATE media SET extra = ? WHERE id = ?').run(JSON.stringify({ ...extra, textOrigin: origin }), row.id);
  }
  return 0;
}

/**
 * Writes a line's items position by position: the item a reference already names, or a new row, and its link. A bare row the
 * line held at that position gives way to the item, and a line that now holds fewer items loses the rest.
 */
export function writeLineMedia(
  db: Db,
  line: LineRow,
  items: ReadonlyArray<MediaItem>,
  { at, ownerKind = 'source' }: { at: unknown; ownerKind?: MediaOwnerKind }
): { told: number } {
  let told = 0;
  const link = linkStatement(db);
  const heldLink = db.prepare(
    `SELECT l.media_id AS media_id, m.native_ref AS native_ref, m.kind AS kind FROM media_links l JOIN media m ON m.id = l.media_id
     WHERE l.owner_kind = ? AND l.owner_id = ? AND l.position = ?`
  );
  items.forEach((item, position) => {
    const held = heldLink.get(ownerKind, line.id, position);
    if (held && item.nativeRef !== null && held.native_ref === item.nativeRef) {
      const row = db.prepare('SELECT * FROM media WHERE id = ?').get(held.media_id) as Row;
      mergeItem(db, row, item);
      told += tellItem(db, db.prepare('SELECT * FROM media WHERE id = ?').get(held.media_id) as Row, item, at);
      return;
    }
    const iface = line.scope_iface ?? null;
    const named = item.nativeRef === null ? undefined : itemByRef(db, iface, item.nativeRef);
    // A placeholder at this position becomes the item, unless the reference already names one: then it gives way to it.
    const placeholder =
      held?.native_ref === null ? (db.prepare('SELECT * FROM media WHERE id = ?').get(held.media_id) as Row) : null;
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
      if (placeholder && filled(placeholder.description)) {
        const origin = (parsedObject(placeholder.extra).textOrigin as MediaOrigin | undefined) ?? 'retelling';
        writeText(db, row, { text: placeholder.description, origin, at });
        db.prepare('UPDATE media SET description = NULL WHERE id = ?').run(placeholder.id);
      }
      dropIfBare(db, held.media_id);
    }
    told += tellItem(db, db.prepare('SELECT * FROM media WHERE id = ?').get(row.id) as Row, item, at);
  });
  const rest = db
    .prepare('SELECT position, media_id FROM media_links WHERE owner_kind = ? AND owner_id = ? AND position >= ?')
    .all(ownerKind, line.id, items.length);
  for (const one of rest) {
    db.prepare('DELETE FROM media_links WHERE owner_kind = ? AND owner_id = ? AND position = ?').run(
      ownerKind,
      line.id,
      one.position
    );
    dropIfBare(db, one.media_id);
  }
  return { told };
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
  const taken: Row = {
    media: typeof kinds === 'string' ? parsedList(kinds) : kinds,
    links: extra.links,
    voiced: extra.voiced,
  };
  if (hasCards || hasVoiced) {
    delete extra.links;
    delete extra.voiced;
    row.extra = Object.keys(extra).length > 0 ? JSON.stringify(extra) : null;
  }
  return (Array.isArray(taken.media) && taken.media.length > 0) || hasCards || hasVoiced ? taken : null;
}

/** What a record line brings for its source row: its kinds and cards, and the words of her voice message. */
export function writeRecordMedia(db: Db, sourceId: string, line: Row, at: unknown): void {
  const source = sourceLine(db, sourceId);
  if (!source) return;
  const links = db.prepare("SELECT COUNT(*) AS n FROM media_links WHERE owner_kind = 'source' AND owner_id = ?");
  // An observation that came first knows more than the record line: it stays, and the line only tells what she voiced.
  if (links.get(sourceId)?.n === 0) writeLineMedia(db, source, recordItems(line), { at });
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
 * text form told on a bare row moves to the item with it.
 */
export function fillLineMedia(db: Db, sourceId: string, items: ReadonlyArray<MediaItem>, at: unknown): void {
  const line = sourceLine(db, sourceId);
  if (line) writeLineMedia(db, line, items, { at });
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

/** The fields of a cache entry kept on its row beside the text. */
const entryRest = (entry: Row): Row => {
  const rest = { ...entry };
  if (filled(rest.text)) delete rest.text;
  return rest;
};

/**
 * The describer's cache of a place written onto the items: an entry becomes the text form of its item, or a new row the
 * observation of its message will find by reference. A key absent from `value` is trimmed, unless an owner links its row.
 */
export function writeMediaCache(
  db: Db,
  { owner, iface, value, at }: { owner: string; iface: unknown; value: Row; at: unknown }
): { upserted: number; retired: number } {
  const groupOf = groupScope(iface === null ? null : asText(iface));
  const kept = new Set<string>();
  let upserted = 0;
  /** A key whose message was not observed yet: a row its observation will find by reference. */
  const newCacheRow = (key: string): Row => {
    const { ref, kinds } = cacheKeyParts(key);
    const id = NEW_ID(iface, key);
    const scope = audienceOf(groupOf);
    ensureAudience(db, scope);
    db.prepare(
      `INSERT OR IGNORE INTO media (id, kind, native_ref, availability, extra, scope_kind, scope_iface, scope_dm, audience_id, owner_key)
       VALUES (?, ?, ?, 'unknown', '{}', ?, ?, ?, ?, ?)`
    ).run(
      id,
      kinds?.[0] ?? 'image',
      ref,
      scope.scope_kind,
      scope.scope_iface,
      scope.scope_dm,
      scope.audience_id,
      owner
    );
    return db.prepare('SELECT * FROM media WHERE id = ?').get(id) as Row;
  };
  for (const [key, given] of Object.entries(value)) {
    const entry: Row =
      given !== null && typeof given === 'object' && !Array.isArray(given) ? (given as Row) : { $raw: given };
    const { watched } = cacheKeyParts(key);
    const row = mediaRowOfCacheKey(db, iface, key) ?? newCacheRow(key);
    kept.add(String(row.id));
    const extra = parsedObject(row.extra);
    const entries = { ...((extra.cache as Row | undefined) ?? {}), [key]: entryRest(entry) };
    db.prepare('UPDATE media SET extra = ?, owner_key = ? WHERE id = ?').run(
      JSON.stringify({ ...extra, cache: entries }),
      owner,
      row.id
    );
    if (filled(entry.text)) {
      const fresh = db.prepare('SELECT * FROM media WHERE id = ?').get(row.id) as Row;
      const isExact = fresh.native_ref === key;
      writeText(db, fresh, {
        text: entry.text,
        origin: originOf(fresh.kind, !isExact && watched),
        at: isFiniteNumber(entry.ts) ? entry.ts : at,
      });
    }
    upserted += 1;
  }
  const absent = db
    .prepare(
      `SELECT id FROM media WHERE owner_key = ? AND retired_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM media_links l WHERE l.media_id = media.id)`
    )
    .all(owner)
    .filter((row) => !kept.has(String(row.id)));
  const retire = db.prepare('UPDATE media SET retired_at = ? WHERE id = ?');
  for (const row of absent) retire.run(iso(at), row.id);
  return { upserted, retired: absent.length };
}

/** Fields a library's mapper does not hold, which its write must not lose: the row is an item too. */
const ITEM_EXTRA = ['textOrigin', 'frame', 'watched', 'cache'];

/** What an item's row keeps across a write of its GIF library, added to the row the mapper made. */
export function keepItemFields(db: Db, rows: ReadonlyArray<Row>): void {
  for (const row of rows) {
    const held = db.prepare('SELECT extra FROM media WHERE id = ?').get(row.id);
    if (!held) continue;
    const kept = parsedObject(held.extra);
    const fields = Object.fromEntries(ITEM_EXTRA.filter((key) => key in kept).map((key) => [key, kept[key]]));
    if (Object.keys(fields).length > 0) row.extra = JSON.stringify({ ...parsedObject(row.extra), ...fields });
  }
}

/** A GIF library's row and an observed item of the same reference become one: the library's row takes its links and its text. */
export function adoptLibraryRows(db: Db, owner: string, at: unknown): void {
  const rows = db
    .prepare(
      "SELECT id, native_ref, scope_iface FROM media WHERE owner_key = ? AND kind = 'gif' AND native_ref IS NOT NULL"
    )
    .all(owner);
  for (const snapshot of rows) {
    // An earlier iteration may have adopted this row into another and deleted it.
    const row = db.prepare('SELECT id, native_ref, scope_iface FROM media WHERE id = ?').get(snapshot.id);
    if (!row) continue;
    for (const other of db
      .prepare('SELECT * FROM media WHERE native_ref = ? AND scope_iface IS ? AND id <> ?')
      .all(row.native_ref, row.scope_iface, row.id)) {
      db.prepare('UPDATE OR IGNORE media_links SET media_id = ? WHERE media_id = ?').run(row.id, other.id);
      if (filled(other.description)) {
        const held = db.prepare('SELECT * FROM media WHERE id = ?').get(row.id) as Row;
        writeText(db, held, {
          text: other.description,
          origin: (parsedObject(other.extra).textOrigin as MediaOrigin | undefined) ?? 'retelling',
          at,
        });
      }
      db.prepare('DELETE FROM vectors WHERE chunk_key = ?').run(vectorKey(other.id));
      db.prepare('DELETE FROM media WHERE id = ?').run(other.id);
    }
  }
}

// ---------- a selfreflection entry's files ----------

/** A file of a selfreflection entry, as a post keeps it. */
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
 * The files of a selfreflection entry as items linked to it at their positions, with their paths. A file the platform names through a
 * message she posted is the same item as that message's, so it has two links. The entry's scope goes on a row it creates.
 */
export function writeEntryFiles(db: Db, entry: Row, files: ReadonlyArray<EntryFile>, at: unknown): void {
  const link = linkStatement(db);
  for (const file of files) {
    const { position } = file;
    const iface = entry.scope_iface ?? null;
    const held = (file.attachmentId !== null ? itemByRef(db, iface, file.attachmentId) : undefined) ?? undefined;
    const previous = db
      .prepare("SELECT media_id FROM media_links WHERE owner_kind = 'selfreflection' AND owner_id = ? AND position = ?")
      .get(entry.id, position);
    const id = held ? String(held.id) : file.id;
    const voiced = filled(file.extra.text) ? file.extra.text : null;
    // A read that named no attachment is not asked again (pendingSelfreflectionRows).
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
    link.run('selfreflection', entry.id, position, id);
    if (previous && previous.media_id !== id) dropIfBare(db, previous.media_id);
    const row = db.prepare('SELECT * FROM media WHERE id = ?').get(id) as Row;
    if (voiced !== null) writeText(db, row, { text: voiced, origin: 'voiced', at });
    else if (filled(file.description)) writeText(db, row, { text: file.description, origin: 'retelling', at });
    projectRow(db, 'media', { id }, { at });
  }
}

/** What the describer's cache holds for a reference, for an entry whose file her post named. */
export const heldDescription = (db: Db, iface: unknown, ref: unknown): string | null =>
  filled(ref) ? orNull(itemByRef(db, iface, ref)?.description) : null;

// ---------- the vector of a text form ----------

/** The `chunk_key` of a row's vector. */
const vectorKey = (mediaId: unknown): string => `media:${asText(mediaId)}`;
// Range bounds of those keys: `;` sorts right after `:`.
const VECTOR_FROM = 'media:';
const VECTOR_TO = 'media;';

/** The linked items with a text form and no vector yet, oldest first. */
export function pendingMediaEmbeds(db: Db, limit = 50): Array<Row> {
  return db
    .prepare(
      `SELECT m.id AS id, m.description AS description, m.scope_kind AS scope_kind, m.scope_iface AS scope_iface,
         m.scope_dm AS scope_dm, m.audience_id AS audience_id, m.described_at AS described_at
       FROM media m WHERE m.description IS NOT NULL AND m.description <> '' AND m.retired_at IS NULL
         AND EXISTS (SELECT 1 FROM media_links l WHERE l.media_id = m.id)
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
        `INSERT INTO vectors (source_rowid, item_id, chunk_key, model, dims, scale, norm, bytes, context, occurred_at, scope_kind, scope_iface, scope_dm, audience_id)
         VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?)
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
      `SELECT s.id AS id, s.rowid AS row_id, s.native_id AS native_id, s.place_id AS place_id, s.occurred_at AS occurred_at
       ${where} ORDER BY s.occurred_at DESC, s.rowid DESC LIMIT ${HIT_MESSAGES}`
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
       WHERE v.chunk_key >= '${VECTOR_FROM}' AND v.chunk_key < '${VECTOR_TO}' AND v.dims = ?${modelSql}
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
