// The rewrite of stored lines to stable names, run once per deployment by scripts/stable-names-rewrite.ts. A line
// stored before stable names holds a custom emoji as `:pog:` and its emoji and stickers under their platform names.
// `planStableNamesRewrite` reads what would change: each linked emoji or sticker gets its stable name (the one
// `media_names` holds, or the next number of its kind), and a `:name:` token is rewritten only where the line's own
// media links tie that name to one platform id. Nothing is matched by name alone, and a token in code stays, as
// `renderCustomEmoji` leaves it. The write kind `stable-names-rewrite` (session-write.ts) applies a plan in one
// transaction and refuses a plan whose lines or media rows changed since it was read.

import { replaceNameTokens } from '../../behavior/emoji.ts';
import { mediaNameRows, mediaNamesWriteOf, writeMediaNames } from './media-names.ts';
import type { MediaNameRow } from './media-names.ts';
import { markStemsPending } from './stems.ts';
import { dbOf, isFiniteNumber } from './types.ts';
import type { Db, MemoryHandle, Row } from './types.ts';

type Kind = 'emoji' | 'sticker';
type Change<TKey extends string> = Record<TKey, string> & { from: string; to: string };

/** What a rewrite would do: the names to issue, the line texts and media names to change, and counts of each. */
export type StableNamesPlan = {
  issue: Array<MediaNameRow>;
  lines: Array<Change<'sourceId'>>;
  media: Array<Change<'mediaId'>>;
  counts: { lines: number; tokens: number; media: number; untied: number; issue: Record<string, number> };
};

const PREFIX = { emoji: 'e', sticker: 's' } as const;
const keyOf = (iface: string, kind: string, nativeId: string): string => JSON.stringify([iface, kind, nativeId]);
const isKind = (value: unknown): value is Kind => value === 'emoji' || value === 'sticker';
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The `extra` of a media row as an object; an unreadable one holds no name. */
function extraOf(raw: unknown): Row {
  try {
    const value: unknown = JSON.parse(text(raw) || '{}');
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
  } catch {
    // A row written with a malformed extra: no name to rewrite.
    return {};
  }
}

type Linked = { kind: Kind; nativeId: string; platformName: string; stable: string };
type Namer = {
  held: Map<string, MediaNameRow>;
  issue: Array<MediaNameRow>;
  issued: Record<string, number>;
  nameOf: (iface: string, kind: Kind, nativeId: string, name: string, animated: boolean) => MediaNameRow;
};

/** The names `media_names` holds, and the next number of a kind for a thing it does not hold. */
function namerOf(db: Db): Namer {
  const held = new Map<string, MediaNameRow>();
  const highest = { emoji: 0, sticker: 0 };
  const remember = (row: MediaNameRow): void => {
    held.set(keyOf(row.iface, row.kind, row.nativeId), row);
    highest[row.kind] = Math.max(highest[row.kind], Number(row.name.slice(1)) || 0);
  };
  for (const row of mediaNameRows(db)) remember(row);
  const issue: Array<MediaNameRow> = [];
  const issued: Record<string, number> = {};
  const nameOf: Namer['nameOf'] = (iface, kind, nativeId, platformName, animated) => {
    const known = held.get(keyOf(iface, kind, nativeId));
    if (known) return known;
    const row = { name: `${PREFIX[kind]}${highest[kind] + 1}`, kind, iface, nativeId, platformName, animated };
    remember(row);
    issue.push(row);
    issued[`${iface} ${kind}`] = (issued[`${iface} ${kind}`] ?? 0) + 1;
    return row;
  };
  return { held, issue, issued, nameOf };
}

/** The emoji and stickers each stored line links, with their stable names, and the media rows to rename. */
function tiesOf(db: Db, namer: Namer): { byLine: Map<string, Array<Linked>>; media: Map<string, Change<'mediaId'>> } {
  const byLine = new Map<string, Array<Linked>>();
  const media = new Map<string, Change<'mediaId'>>();
  const links = db
    .prepare(
      `SELECT s.id AS source_id, s.iface AS iface, m.id AS media_id, m.kind AS kind,
         m.native_ref AS native_ref, m.extra AS extra
       FROM sources s JOIN media_links l ON l.owner_kind = 'source' AND l.owner_id = s.id
       JOIN media m ON m.id = l.media_id
       WHERE m.kind IN ('emoji', 'sticker') ORDER BY s.rowid, l.position`
    )
    .all();
  for (const link of links) {
    const { kind } = link;
    const extra = extraOf(link.extra);
    const name = text(extra.name);
    const nativeId = text(link.native_ref);
    const iface = text(link.iface);
    if (!isKind(kind) || !name || !nativeId || !iface) continue;
    const row = namer.nameOf(iface, kind, nativeId, name, extra.animated === true);
    const mediaId = text(link.media_id);
    if (name !== row.name) media.set(mediaId, { mediaId, from: name, to: row.name });
    const sourceId = text(link.source_id);
    const linked = byLine.get(sourceId) ?? [];
    byLine.set(sourceId, linked);
    linked.push({ kind, nativeId, platformName: name === row.name ? row.platformName : name, stable: row.name });
  }
  return { byLine, media };
}

/** The platform names of every known custom emoji: a token of one in a line that cannot be tied is counted. */
function knownNames(db: Db, held: Map<string, MediaNameRow>): Set<string> {
  const known = new Set<string>();
  for (const row of held.values()) if (row.kind === 'emoji') known.add(row.platformName);
  for (const row of db.prepare("SELECT extra FROM media WHERE kind = 'emoji'").all()) {
    const name = text(extraOf(row.extra).name);
    if (name) known.add(name);
  }
  for (const row of held.values()) if (row.kind === 'emoji' && row.name !== row.platformName) known.delete(row.name);
  return known;
}

/** One text with each token its emoji tie to one platform id rewritten; `loose` when a known name stays untied. */
function rewriteText(
  from: string,
  emoji: ReadonlyArray<Linked>,
  known: Set<string>
): { to: string; tied: number; loose: boolean } {
  let tied = 0;
  let loose = false;
  const to = replaceNameTokens(from, (name) => {
    const matching = emoji.filter((one) => one.platformName === name);
    const ids = new Set(matching.map((one) => one.nativeId));
    const stable = matching[0]?.stable;
    if (ids.size === 1 && stable !== name) {
      tied += 1;
      return `:${stable}:`;
    }
    if (known.has(name) && ids.size !== 1) loose = true;
    return null;
  });
  return { to, tied, loose };
}

/** What a rewrite of `db` would do, read from its rows alone. */
export function planStableNamesRewrite(db: Db): StableNamesPlan {
  const namer = namerOf(db);
  const { byLine, media } = tiesOf(db, namer);
  const known = knownNames(db, namer.held);
  const lines: StableNamesPlan['lines'] = [];
  let tokens = 0;
  let untied = 0;
  for (const row of db.prepare("SELECT id, text FROM sources WHERE text LIKE '%:%:%' ORDER BY rowid").all()) {
    const sourceId = text(row.id);
    const from = text(row.text);
    const emoji = (byLine.get(sourceId) ?? []).filter((one) => one.kind === 'emoji');
    const { to, tied, loose } = rewriteText(from, emoji, known);
    if (loose) untied += 1;
    else if (to !== from) {
      tokens += tied;
      lines.push({ sourceId, from, to });
    }
  }
  const counts = { lines: lines.length, tokens, media: media.size, untied, issue: namer.issued };
  return { issue: namer.issue, lines, media: [...media.values()], counts };
}

const stale = (): Error => Object.assign(new Error('STABLE_NAMES_STALE'), { code: 'STABLE_NAMES_STALE' });
const malformed = (): Error => Object.assign(new Error('STABLE_NAMES_PLAN'), { code: 'STABLE_NAMES_PLAN' });

/** The changes of one list of a plan as the writer receives them, checked. */
function changesOf<TKey extends 'sourceId' | 'mediaId'>(
  list: unknown,
  key: TKey
): Array<{ id: string; from: string; to: string }> {
  if (!Array.isArray(list)) throw malformed();
  return list.map((item: unknown) => {
    if (item === null || typeof item !== 'object') throw malformed();
    const fields: Row = { ...item };
    const id = fields[key];
    const { from, to } = fields;
    if (typeof id !== 'string' || typeof from !== 'string' || typeof to !== 'string') throw malformed();
    return { id, from, to };
  });
}

/**
 * The write kind `stable-names-rewrite` on the writer connection: issues the plan's names, rewrites its lines and
 * renames its media rows in one transaction. A rewritten line loses its stems, as an upsert of a changed text does, and
 * the stems job stems it again. A line or media row that no longer holds what the plan read refuses the whole write.
 */
export function applyStableNamesRewrite(
  handle: MemoryHandle,
  update: Row
): { issued: number; lines: number; media: number } {
  const lines = changesOf(update.lines, 'sourceId');
  const media = changesOf(update.media, 'mediaId');
  const names = mediaNamesWriteOf({ rows: update.issue });
  const at = isFiniteNumber(update.now) ? update.now : Date.now();
  return handle.transaction(() => {
    const db = dbOf(handle);
    const lineText = db.prepare('SELECT text FROM sources WHERE id = ?');
    const mediaName = db.prepare("SELECT json_extract(extra, '$.name') AS name FROM media WHERE id = ?");
    if (lines.some((line) => lineText.get(line.id)?.text !== line.from)) throw stale();
    if (media.some((row) => mediaName.get(row.id)?.name !== row.from)) throw stale();
    const { written } = writeMediaNames(db, names, at);
    const rewrite = db.prepare('UPDATE sources SET text = ?, stems = NULL WHERE id = ?');
    for (const line of lines) rewrite.run(line.to, line.id);
    const rename = db.prepare("UPDATE media SET extra = json_set(extra, '$.name', ?) WHERE id = ?");
    for (const row of media) rename.run(row.to, row.id);
    if (lines.length > 0) markStemsPending(db);
    return { issued: written, lines: lines.length, media: media.length };
  });
}
