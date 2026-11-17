// The rewrite of what memory keeps to stable names, run once per deployment by scripts/stable-names-rewrite.ts. A row
// stored before stable names holds a custom emoji as `:pog:` and its emoji and stickers under their platform names.
// `planStableNamesRewrite` reads what would change. Every emoji and sticker media row gets its stable name (the one
// `media_names` holds, or the next number of its kind). A `:name:` token in a line or in her think becomes the stable
// name of the emoji the line links under that name; a line that links no emoji of that name is tied by name, when exactly
// one known emoji of its interface holds it or `choose` names one, and gets the link and the media row it misses. A
// sticker reference of a line that links one sticker takes the current form with its stable name. The other stored texts
// follow stable-names-texts.ts. A token in code stays, as `renderCustomEmoji` leaves it. The write kind
// `stable-names-rewrite` (session-write.ts) applies a plan in one transaction and refuses a plan whose rows changed
// since it was read.

import { replaceNameTokens } from '../../behavior/emoji.ts';
import { mediaNameRows, mediaNamesWriteOf, writeMediaNames } from './media-names.ts';
import type { MediaNameRow } from './media-names.ts';
import { TEXT_COLUMNS, textCells } from './stable-names-texts.ts';
import type { Cell, Resolver } from './stable-names-texts.ts';
import { markStemsPending } from './stems.ts';
import { dbOf, isFiniteNumber } from './types.ts';
import type { Db, MemoryHandle, Row } from './types.ts';

type Kind = 'emoji' | 'sticker';
type Change<TKey extends string> = Record<TKey, string> & { from: string; to: string };

/** A link a line misses: the emoji its text names, and its media row, null when the plan makes it. */
export type Tie = {
  sourceId: string;
  mediaId: string | null;
  iface: string;
  nativeId: string;
  name: string;
  animated: boolean;
};

/** What a rewrite would do: the names to issue, the texts, media names and links to change, and counts of each. */
export type StableNamesPlan = {
  issue: Array<MediaNameRow>;
  lines: Array<Change<'sourceId'>>;
  media: Array<Change<'mediaId'>>;
  cells: Array<Cell>;
  ties: Array<Tie>;
  counts: {
    lines: number;
    tokens: number;
    media: number;
    untied: number;
    issue: Record<string, number>;
    left: { sharedName: number; unlinkedSticker: number };
    tables: Record<string, number>;
  };
};

/** The platform id to tie a platform name two emoji hold to, given by the owner. */
export type Choice = Record<string, string>;

const PREFIX = { emoji: 'e', sticker: 's' } as const;
// The interface whose markup `<:name:id>` is, for a text that names no interface of its own; the baseline seeds it.
const MARKUP_IFACE = 'discord';
const STICKER_RE = /\[sticker(:?) ([^\]\n]+)\]/g;
const STABLE_STICKER_RE = /^s\d+$/;
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
function tiesOf(db: Db, namer: Namer, media: Map<string, Change<'mediaId'>>): Map<string, Array<Linked>> {
  const byLine = new Map<string, Array<Linked>>();
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
  return byLine;
}

/** One known emoji a platform name may stand for. */
type Candidate = { iface: string; nativeId: string; stable: string; mediaId: string | null; animated: boolean };
type Known = Map<string, Map<string, Candidate>>;

function addCandidate(known: Known, platformName: string, candidate: Candidate): void {
  const ids = known.get(platformName) ?? new Map<string, Candidate>();
  known.set(platformName, ids);
  const key = keyOf(candidate.iface, 'emoji', candidate.nativeId);
  if (!ids.get(key)?.mediaId) ids.set(key, candidate);
}

/**
 * Every emoji and sticker media row under its stable name, and every known emoji by its platform name. A media row with
 * no interface or reference names nothing: an attachment's row, which no emoji or sticker is.
 */
function knownOf(db: Db, namer: Namer, media: Map<string, Change<'mediaId'>>): Known {
  const known: Known = new Map();
  const rows = db
    .prepare(
      "SELECT id, kind, native_ref, scope_iface, extra FROM media WHERE kind IN ('emoji', 'sticker') ORDER BY rowid"
    )
    .all();
  for (const row of rows) {
    const extra = extraOf(row.extra);
    const iface = text(row.scope_iface);
    const nativeId = text(row.native_ref);
    const name = text(extra.name);
    if (!isKind(row.kind) || !iface || !nativeId || !name) continue;
    const platformName = namer.held.get(keyOf(iface, row.kind, nativeId))?.platformName ?? name;
    const named = namer.nameOf(iface, row.kind, nativeId, platformName, extra.animated === true);
    const mediaId = text(row.id);
    if (name !== named.name) media.set(mediaId, { mediaId, from: name, to: named.name });
    if (row.kind === 'emoji') addCandidate(known, platformName, { ...named, stable: named.name, mediaId });
  }
  for (const row of namer.held.values())
    if (row.kind === 'emoji') addCandidate(known, row.platformName, { ...row, stable: row.name, mediaId: null });
  return known;
}

/** The one candidate of `platformName` in `iface` (any interface when null), a choice settling two; null for none. */
function pick(known: Known, choose: Choice, platformName: string, iface: string | null): Candidate | 'shared' | null {
  const all = [...(known.get(platformName)?.values() ?? [])].filter((one) => iface === null || one.iface === iface);
  if (all.length === 1) return all[0];
  if (all.length === 0) return null;
  return all.find((one) => one.nativeId === choose[platformName]) ?? 'shared';
}

type Rewritten = { to: string; tied: number; loose: boolean; shared: boolean; ties: Array<Candidate> };

/**
 * One text of a line with each token rewritten: by the emoji the line links under that name, else by the one known emoji
 * of its interface. `loose` when the line links two emoji of one name, `shared` when two known emoji hold an unlinked one.
 */
function rewriteText(
  from: string,
  emoji: ReadonlyArray<Linked>,
  iface: string,
  known: Known,
  choose: Choice
): Rewritten {
  const out: Rewritten = { to: from, tied: 0, loose: false, shared: false, ties: [] };
  out.to = replaceNameTokens(from, (name) => {
    const matching = emoji.filter((one) => one.platformName === name);
    const ids = new Set(matching.map((one) => one.nativeId));
    if (ids.size > 1) out.loose = true;
    if (ids.size > 0) {
      const stable = matching[0].stable;
      if (ids.size > 1 || stable === name) return null;
      out.tied += 1;
      return `:${stable}:`;
    }
    const found = pick(known, choose, name, iface);
    if (found === 'shared') out.shared = true;
    if (found === null || found === 'shared') return null;
    out.tied += 1;
    if (!out.ties.some((one) => one.nativeId === found.nativeId)) out.ties.push(found);
    return `:${found.stable}:`;
  });
  return out;
}

/** A line's sticker references in the current form under the stable name of the one sticker it links. */
function rewriteStickers(from: string, linked: ReadonlyArray<Linked>): { to: string; unlinked: boolean } {
  const ids = new Set(linked.filter((one) => one.kind === 'sticker').map((one) => one.nativeId));
  const sticker = linked.find((one) => one.kind === 'sticker');
  let unlinked = false;
  const to = from.replace(STICKER_RE, (all, colon: string, name: string) => {
    if (colon === '' && STABLE_STICKER_RE.test(name)) return all;
    if (ids.size !== 1 || !sticker) {
      unlinked = true;
      return all;
    }
    return `[sticker ${sticker.stable}]`;
  });
  return { to, unlinked };
}

type LinesOut = Pick<StableNamesPlan, 'lines' | 'cells' | 'ties'> & {
  tokens: number;
  untied: number;
  left: StableNamesPlan['counts']['left'];
};

/** One line's text: its tokens, its sticker references and the links it misses. */
function planLineText(row: Row, linked: ReadonlyArray<Linked>, known: Known, choose: Choice, out: LinesOut): void {
  const sourceId = text(row.id);
  const from = text(row.text);
  const emoji = linked.filter((one) => one.kind === 'emoji');
  const result = rewriteText(from, emoji, text(row.iface), known, choose);
  if (result.shared) out.left.sharedName += 1;
  if (result.loose) {
    out.untied += 1;
    return;
  }
  const stickers = rewriteStickers(result.to, linked);
  if (stickers.unlinked) out.left.unlinkedSticker += 1;
  if (stickers.to === from) return;
  out.tokens += result.tied;
  out.lines.push({ sourceId, from, to: stickers.to });
  for (const one of result.ties) out.ties.push({ ...one, sourceId, name: one.stable });
}

/** One line's think, by the rule of its text, with no link: her thought shows nothing. */
function planThink(row: Row, linked: ReadonlyArray<Linked>, known: Known, choose: Choice, out: LinesOut): void {
  const from = text(row.think);
  const emoji = linked.filter((one) => one.kind === 'emoji');
  const result = rewriteText(from, emoji, text(row.iface), known, choose);
  if (result.loose || result.to === from) return;
  out.tokens += result.tied;
  out.cells.push({ table: 'sources', column: 'think', id: text(row.id), from, to: result.to });
}

/** The lines and thinks the rewrite changes, and the links their texts tie. */
function planLines(db: Db, byLine: Map<string, Array<Linked>>, known: Known, choose: Choice): LinesOut {
  const out: LinesOut = {
    lines: [],
    cells: [],
    ties: [],
    tokens: 0,
    untied: 0,
    left: { sharedName: 0, unlinkedSticker: 0 },
  };
  const rows = db
    .prepare(
      "SELECT id, iface, text, think FROM sources WHERE text LIKE '%:%' OR text LIKE '%[sticker%' OR think LIKE '%:%:%' ORDER BY rowid"
    )
    .all();
  for (const row of rows) {
    const linked = byLine.get(text(row.id)) ?? [];
    planLineText(row, linked, known, choose, out);
    if (text(row.think)) planThink(row, linked, known, choose, out);
  }
  return out;
}

/** How the texts outside `sources` find names: a name held once in any interface, markup by its id. */
function resolverOf(namer: Namer, known: Known, choose: Choice, left: LinesOut['left']): Resolver {
  const ifaceOfId = (nativeId: string): string | undefined =>
    [...namer.held.values()].find((row) => row.kind === 'emoji' && row.nativeId === nativeId)?.iface;
  return {
    name: (platformName) => {
      const found = pick(known, choose, platformName, null);
      if (found === 'shared') left.sharedName += 1;
      return found === null || found === 'shared' ? null : found.stable;
    },
    markup: (iface, nativeId, platformName, animated) =>
      namer.nameOf(iface ?? ifaceOfId(nativeId) ?? MARKUP_IFACE, 'emoji', nativeId, platformName, animated).name,
  };
}

/** The rows of each table a plan touches, a table it leaves alone left out. */
function tablesOf(plan: Omit<StableNamesPlan, 'counts'>): Record<string, number> {
  const ids = new Map<string, Set<string>>();
  const add = (table: string, id: string): void => {
    ids.set(table, (ids.get(table) ?? new Set<string>()).add(id));
  };
  for (const line of plan.lines) add('sources', line.sourceId);
  for (const cell of plan.cells) add(cell.table, cell.id);
  for (const row of plan.media) add('media', row.mediaId);
  for (const tie of plan.ties) add('media', tie.mediaId ?? keyOf(tie.iface, 'emoji', tie.nativeId));
  plan.ties.forEach((tie, at) => add('media_links', `${tie.sourceId} ${at}`));
  plan.issue.forEach((row) => add('media_names', keyOf(row.iface, row.kind, row.nativeId)));
  return Object.fromEntries([...ids].map(([table, set]) => [table, set.size]));
}

/** What a rewrite of `db` would do, read from its rows alone; `choose` ties a platform name two emoji hold. */
export function planStableNamesRewrite(db: Db, { choose = {} }: { choose?: Choice } = {}): StableNamesPlan {
  const namer = namerOf(db);
  const renames = new Map<string, Change<'mediaId'>>();
  const byLine = tiesOf(db, namer, renames);
  const known = knownOf(db, namer, renames);
  const planned = planLines(db, byLine, known, choose);
  const cells = [...planned.cells, ...textCells(db, resolverOf(namer, known, choose, planned.left))];
  const plan = { issue: namer.issue, lines: planned.lines, media: [...renames.values()], cells, ties: planned.ties };
  const counts = {
    lines: planned.lines.length,
    tokens: planned.tokens,
    media: renames.size,
    untied: planned.untied,
    issue: namer.issued,
    left: planned.left,
    tables: tablesOf(plan),
  };
  return { ...plan, counts };
}

const stale = (): Error => Object.assign(new Error('STABLE_NAMES_STALE'), { code: 'STABLE_NAMES_STALE' });
const malformed = (): Error => Object.assign(new Error('STABLE_NAMES_PLAN'), { code: 'STABLE_NAMES_PLAN' });

/** The fields of one item of a plan's list, as the writer receives it. */
function fieldsOf(item: unknown): Row {
  if (item === null || typeof item !== 'object') throw malformed();
  return { ...item };
}

const listOf = (list: unknown): Array<unknown> => {
  if (!Array.isArray(list)) throw malformed();
  return list;
};

/** The changes of one list of a plan as the writer receives them, checked. */
function changesOf(list: unknown, key: 'sourceId' | 'mediaId'): Array<{ id: string; from: string; to: string }> {
  return listOf(list).map((item) => {
    const fields = fieldsOf(item);
    const id = fields[key];
    const { from, to } = fields;
    if (typeof id !== 'string' || typeof from !== 'string' || typeof to !== 'string') throw malformed();
    return { id, from, to };
  });
}

/** Where each column a cell may change finds its row: `sources.think` and every column of stable-names-texts.ts. */
const CELL_WHERE = new Map<string, string>([
  ['sources.think', 'id = ?'],
  ...TEXT_COLUMNS.map(({ table, column, where }): [string, string] => [`${table}.${column}`, where]),
]);

type CheckedCell = Cell & { where: string };

function cellsOf(list: unknown): Array<CheckedCell> {
  return listOf(list).map((item) => {
    const { table, column, id, from, to } = fieldsOf(item);
    const where = CELL_WHERE.get(`${text(table)}.${text(column)}`);
    if (!where || typeof id !== 'string' || typeof from !== 'string' || typeof to !== 'string') throw malformed();
    return { table: text(table), column: text(column), id, from, to, where };
  });
}

function tiesListOf(list: unknown): Array<Tie> {
  return listOf(list).map((item) => {
    const { sourceId, mediaId, iface, nativeId, name, animated } = fieldsOf(item);
    const strings = [sourceId, iface, nativeId, name];
    if (!strings.every((one) => typeof one === 'string' && one !== '')) throw malformed();
    if (mediaId !== null && typeof mediaId !== 'string') throw malformed();
    return {
      sourceId: text(sourceId),
      mediaId,
      iface: text(iface),
      nativeId: text(nativeId),
      name: text(name),
      animated: animated === true,
    };
  });
}

/** Links one line to the emoji a tie names, making its media row when the plan found none. */
function writeTie(db: Db, tie: Tie): void {
  const mediaId = tie.mediaId ?? `media:${tie.iface}:${tie.nativeId}`;
  db.prepare(
    `INSERT OR IGNORE INTO media (id, kind, native_ref, availability, extra, scope_iface)
     VALUES (?, 'emoji', ?, 'unknown', ?, ?)`
  ).run(mediaId, tie.nativeId, JSON.stringify({ name: tie.name, animated: tie.animated }), tie.iface);
  db.prepare(
    `INSERT INTO media_links (owner_kind, owner_id, position, media_id)
     SELECT 'source', ?, COALESCE(MAX(position) + 1, 0), ? FROM media_links WHERE owner_kind = 'source' AND owner_id = ?`
  ).run(tie.sourceId, mediaId, tie.sourceId);
}

/** Writes the plan's cells. */
function writeCells(db: Db, cells: ReadonlyArray<CheckedCell>): void {
  for (const cell of cells)
    db.prepare(`UPDATE ${cell.table} SET ${cell.column} = ? WHERE ${cell.where}`).run(cell.to, cell.id);
}

type Checked = {
  lines: ReturnType<typeof changesOf>;
  media: ReturnType<typeof changesOf>;
  cells: Array<CheckedCell>;
};

/** Refuses the whole write when a row of the plan no longer holds what the plan read. */
function checkFresh(db: Db, { lines, media, cells }: Checked): void {
  const lineText = db.prepare('SELECT text FROM sources WHERE id = ?');
  const mediaName = db.prepare("SELECT json_extract(extra, '$.name') AS name FROM media WHERE id = ?");
  if (lines.some((line) => lineText.get(line.id)?.text !== line.from)) throw stale();
  if (media.some((row) => mediaName.get(row.id)?.name !== row.from)) throw stale();
  for (const cell of cells) {
    const held = db.prepare(`SELECT ${cell.column} AS value FROM ${cell.table} WHERE ${cell.where}`).get(cell.id);
    if (held?.value !== cell.from) throw stale();
  }
}

/**
 * The write kind `stable-names-rewrite` on the writer connection: issues the plan's names, rewrites its lines and other
 * texts, renames its media rows and makes the links its lines miss, in one transaction. A rewritten line loses its stems,
 * as an upsert of a changed text does, and the stems job stems it again. A row that no longer holds what the plan read
 * refuses the whole write.
 */
export function applyStableNamesRewrite(
  handle: MemoryHandle,
  update: Row
): { issued: number; lines: number; media: number; cells: number; ties: number } {
  const checked = {
    lines: changesOf(update.lines, 'sourceId'),
    media: changesOf(update.media, 'mediaId'),
    cells: cellsOf(update.cells),
  };
  const ties = tiesListOf(update.ties);
  const names = mediaNamesWriteOf({ rows: update.issue });
  const at = isFiniteNumber(update.now) ? update.now : Date.now();
  return handle.transaction(() => {
    const db = dbOf(handle);
    checkFresh(db, checked);
    const { written } = writeMediaNames(db, names, at);
    const rewrite = db.prepare('UPDATE sources SET text = ?, stems = NULL WHERE id = ?');
    for (const line of checked.lines) rewrite.run(line.to, line.id);
    const rename = db.prepare("UPDATE media SET extra = json_set(extra, '$.name', ?) WHERE id = ?");
    for (const row of checked.media) rename.run(row.to, row.id);
    writeCells(db, checked.cells);
    for (const tie of ties) writeTie(db, tie);
    if (checked.lines.length > 0) markStemsPending(db);
    const { lines, media, cells } = checked;
    return { issued: written, lines: lines.length, media: media.length, cells: cells.length, ties: ties.length };
  });
}
