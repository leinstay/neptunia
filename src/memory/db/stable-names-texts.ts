// The stored texts outside `sources` that the rewrite to stable names covers (stable-names-rewrite.ts calls them). One
// function per kind of column: a free text, where a known emoji name `:pog:` becomes its stable name and raw markup
// `<:name:id>` or `<a:name:id>` becomes the stable name of its id; a JSON column, where every string field is a free text
// and an `emoji` field that holds a bare platform name takes the bare stable name; and the `lastUsed` keys of the emoji
// rails. `TEXT_COLUMNS` lists every table and column the plan reads. What was sent stays as it was sent: the rendered
// text of a publication, which the trigger `publications_content_fixed` guards, and the logs `model_requests` and the
// `recall_trace` rows of `operational`.

import { CUSTOM_EMOJI_MARKUP, replaceNameTokens } from '../../behavior/emoji.ts';
import type { Db, Row } from './types.ts';

/** How a text finds stable names: by a platform name one emoji holds, and by the platform id raw markup names. */
export type Resolver = {
  /** The stable name of the one emoji that holds `platformName`, or null when none or two hold it. */
  name: (platformName: string) => string | null;
  /** The stable name of the emoji of a platform id, issued when nothing holds it. */
  markup: (iface: string | null, nativeId: string, platformName: string, animated: boolean) => string;
};

/** One stored cell the plan changes, named by its table, column and the key of its row. */
export type Cell = { table: string; column: string; id: string; from: string; to: string };

type ColumnKind = 'free' | 'json' | 'rails';
type TextColumn = { table: string; column: string; kind: ColumnKind; iface: string; key: string; where: string };

const col = (table: string, column: string, kind: ColumnKind, iface = 'scope_iface'): TextColumn => ({
  table,
  column,
  kind,
  iface,
  key: 'id',
  where: 'id = ?',
});

/** Every column outside `sources` the rewrite reads, with the expression of its interface and the key of its row. */
export const TEXT_COLUMNS: ReadonlyArray<TextColumn> = [
  col('claims', 'text', 'free'),
  col('claims', 'extra', 'json'),
  col('claim_versions', 'text', 'free', 'NULL'),
  col('claim_versions', 'extra', 'json', 'NULL'),
  col('description_versions', 'text', 'free', 'NULL'),
  col('description_versions', 'extra', 'json', 'NULL'),
  col('episodes', 'what', 'free'),
  col('episodes', 'quote', 'free'),
  col('episodes', 'feeling', 'free'),
  col('episodes', 'extra', 'json'),
  col('affinity_events', 'reason', 'free'),
  col('decisions', 'reason', 'free', 'NULL'),
  col('decisions', 'extra', 'json', 'NULL'),
  col('day', 'extra', 'json'),
  col('diary', 'text', 'free'),
  col('places', 'topic', 'free', 'iface'),
  {
    table: 'operational',
    column: 'value',
    kind: 'rails',
    iface: 'NULL',
    key: 'owner',
    where: "kind = 'emoji_rails' AND owner = ?",
  },
];

const MARKUP_RE = new RegExp(CUSTOM_EMOJI_MARKUP, 'g');
const BARE_NAME_RE = /^[A-Za-z0-9_]{2,32}$/;

/** A free text with its raw markup named by id and its known emoji names by the one emoji that holds each. */
export function freeText(text: string, resolver: Resolver, iface: string | null): string {
  const named = text.replace(MARKUP_RE, (_all, animated: string, name: string, id: string) => {
    return `:${resolver.markup(iface, id, name, animated === 'a')}:`;
  });
  return replaceNameTokens(named, (name) => {
    const stable = resolver.name(name);
    return stable === null ? null : `:${stable}:`;
  });
}

/** One value of a JSON column with each string rewritten; a bare platform name under `emoji` takes the bare name. */
function jsonValue(value: unknown, key: string, resolver: Resolver, iface: string | null): unknown {
  if (typeof value === 'string') {
    const bare = key === 'emoji' && BARE_NAME_RE.test(value) ? resolver.name(value) : null;
    return bare ?? freeText(value, resolver, iface);
  }
  if (Array.isArray(value)) return value.map((item: unknown) => jsonValue(item, key, resolver, iface));
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).map(([name, item]) => [name, jsonValue(item, name, resolver, iface)]);
    return Object.fromEntries(entries);
  }
  return value;
}

/** Parsed JSON, or undefined for a cell that holds none. */
function parsed(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // A text column that holds no JSON: nothing structured to rewrite.
    return undefined;
  }
}

/** A JSON column with every string field rewritten, the stored text kept when nothing in it changes. */
export function jsonText(raw: string, resolver: Resolver, iface: string | null): string {
  const value = parsed(raw);
  if (value === undefined) return raw;
  const next = jsonValue(value, '', resolver, iface);
  return JSON.stringify(next) === JSON.stringify(value) ? raw : JSON.stringify(next);
}

/** The emoji rails with each `lastUsed` key under a platform name renamed to its stable name, its time kept. */
export function railKeys(raw: string, resolver: Resolver): string {
  const value = parsed(raw);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return raw;
  const rails: Row = { ...value };
  const { lastUsed } = rails;
  if (lastUsed === null || typeof lastUsed !== 'object' || Array.isArray(lastUsed)) return raw;
  let changed = false;
  const renamed: Row = {};
  for (const [name, at] of Object.entries(lastUsed)) {
    const stable = resolver.name(name);
    if (stable !== null) changed = true;
    const key = stable ?? name;
    renamed[key] = Math.max(Number(renamed[key] ?? 0), Number(at));
  }
  return changed ? JSON.stringify({ ...rails, lastUsed: renamed }) : raw;
}

/** The rewritten text of one cell of `column`. */
function rewriteCell(column: TextColumn, raw: string, resolver: Resolver, iface: string | null): string {
  if (column.kind === 'rails') return railKeys(raw, resolver);
  return column.kind === 'json' ? jsonText(raw, resolver, iface) : freeText(raw, resolver, iface);
}

/** The cells of every column of `TEXT_COLUMNS` the rewrite changes. */
export function textCells(db: Db, resolver: Resolver): Array<Cell> {
  const cells: Array<Cell> = [];
  for (const target of TEXT_COLUMNS) {
    const rows = db
      .prepare(
        `SELECT ${target.key} AS id, ${target.column} AS value, ${target.iface} AS iface FROM ${target.table}
         WHERE ${target.column} LIKE '%:%'${target.kind === 'rails' ? " AND kind = 'emoji_rails'" : ''}`
      )
      .all();
    for (const row of rows) {
      const from = String(row.value);
      const iface = typeof row.iface === 'string' && row.iface !== '' ? row.iface : null;
      const to = rewriteCell(target, from, resolver, iface);
      if (to !== from) cells.push({ table: target.table, column: target.column, id: String(row.id), from, to });
    }
  }
  return cells;
}
