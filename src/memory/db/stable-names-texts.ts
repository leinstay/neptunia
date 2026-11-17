// The stored texts outside `sources` that the rewrite to stable names covers (stable-names-rewrite.ts calls them). One
// function per kind of column: a free text, where a known emoji name `:pog:` becomes its stable name and raw markup
// `<:name:id>` or `<a:name:id>` becomes the stable name of its id; a JSON column, where every string field is a free text
// and an `emoji` field that holds a bare platform name takes the bare stable name; and the `lastUsed` keys of the emoji
// rails. `TEXT_COLUMNS` lists every table and column the plan reads. `LOG_COLUMNS` lists the stored log of requests
// `model_requests` and the `recall_trace` rows of `operational`, which stable-names-logs.ts reads in batches: each string
// is a free text after its old inline emoji form `[:name: description]` and its old sticker references take today's
// form. The rendered text of a publication stays as it was sent, which the trigger `publications_content_fixed` guards.

import { CUSTOM_EMOJI_MARKUP, replaceNameTokens } from '../../behavior/emoji.ts';
import type { Db, Row } from './types.ts';

/** How a text finds stable names: by a platform name one emoji holds, and by the platform id raw markup names. */
export type Resolver = {
  /** The stable name of the one emoji that holds `platformName`, or null when none or two hold it. */
  name: (platformName: string) => string | null;
  /** The stable name of the emoji of a platform id, issued when nothing holds it; null when no interface is known for it. */
  markup: (iface: string | null, nativeId: string, platformName: string, animated: boolean) => string | null;
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

/** The rows of `operational` a cell may change, by rowid: the emoji rails and the recall traces. */
const OPERATIONAL_WHERE = "kind IN ('emoji_rails', 'recall_trace') AND rowid = ?";

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
  { table: 'operational', column: 'value', kind: 'rails', iface: 'NULL', key: 'rowid', where: OPERATIONAL_WHERE },
];

/** The log columns stable-names-logs.ts rewrites, each with the key of its row. */
export const LOG_COLUMNS: ReadonlyArray<TextColumn> = [
  col('model_requests', 'system_text', 'free', 'NULL'),
  col('model_requests', 'messages', 'json', 'NULL'),
  col('model_requests', 'response_text', 'free', 'NULL'),
  col('model_requests', 'think', 'free', 'NULL'),
  col('model_requests', 'tool_calls', 'json', 'NULL'),
  { table: 'operational', column: 'value', kind: 'json', iface: 'NULL', key: 'rowid', where: OPERATIONAL_WHERE },
];

const MARKUP_RE = new RegExp(CUSTOM_EMOJI_MARKUP, 'g');
const BARE_NAME_RE = /^[A-Za-z0-9_]{2,32}$/;

/** A free text with its raw markup named by id and its known emoji names by the one emoji that holds each. */
export function freeText(text: string, resolver: Resolver, iface: string | null): string {
  const named = text.replace(MARKUP_RE, (all: string, animated: string, name: string, id: string) => {
    const stable = resolver.markup(iface, id, name, animated === 'a');
    return stable === null ? all : `:${stable}:`;
  });
  return replaceNameTokens(named, (name) => {
    const stable = resolver.name(name);
    return stable === null ? null : `:${stable}:`;
  });
}

/** How the logs find stable names: a resolver that also names the one sticker of a platform name. */
export type LogResolver = Resolver & {
  /** The stable name of the one sticker that holds `platformName`, or null when none or two hold it. */
  sticker: (platformName: string) => string | null;
};

const INLINE_EMOJI_RE = /\[:([A-Za-z0-9_]{2,32}):[^\]\n]*\]/g;
const OLD_STICKER_RE = /\[sticker(:?) ([^\]\n]+)\]/g;
const STABLE_STICKER_RE = /^s\d+$/;

/**
 * A text of the logs in today's form: an old inline emoji `[:name: description]` becomes the stable name and drops its
 * description, an old sticker reference `[sticker: name]`, with a description or a note after it, becomes
 * `[sticker s12]`, and the rest follows `freeText`. A form whose name nothing holds alone stays.
 */
function logText(text: string, resolver: LogResolver): string {
  const inline = text.replace(INLINE_EMOJI_RE, (all: string, name: string) => {
    const stable = resolver.name(name);
    return stable === null ? all : `:${stable}:`;
  });
  const stickers = inline.replace(OLD_STICKER_RE, (all: string, colon: string, body: string) => {
    if (colon === '' && STABLE_STICKER_RE.test(body)) return all;
    const stable = resolver.sticker(body.split(/ — |, /)[0].trim());
    return stable === null ? all : `[sticker ${stable}]`;
  });
  return freeText(stickers, resolver, null);
}

/** One value of a JSON column with each string rewritten; a bare platform name under `emoji` takes the bare name. */
function jsonValue(value: unknown, key: string, resolver: Resolver, free: (text: string) => string): unknown {
  if (typeof value === 'string') {
    const bare = key === 'emoji' && BARE_NAME_RE.test(value) ? resolver.name(value) : null;
    return bare ?? free(value);
  }
  if (Array.isArray(value)) return value.map((item: unknown) => jsonValue(item, key, resolver, free));
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).map(([name, item]) => [name, jsonValue(item, name, resolver, free)]);
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
  return jsonWith(raw, resolver, (text) => freeText(text, resolver, iface));
}

function jsonWith(raw: string, resolver: Resolver, free: (text: string) => string): string {
  const value = parsed(raw);
  if (value === undefined) return raw;
  const next = jsonValue(value, '', resolver, free);
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

/** The rewritten text of one cell of a column of `LOG_COLUMNS`. */
export function logCell(column: TextColumn, raw: string, resolver: LogResolver): string {
  return column.kind === 'json' ? jsonWith(raw, resolver, (text) => logText(text, resolver)) : logText(raw, resolver);
}

/**
 * Names every emoji raw markup in a column of `TEXT_COLUMNS` holds, before any text is matched, so a name only markup
 * tells is known to every line and text of the same plan.
 */
export function markupNames(db: Db, markup: Resolver['markup']): void {
  for (const target of TEXT_COLUMNS.filter((one) => one.kind !== 'rails')) {
    const rows = db
      .prepare(
        `SELECT ${target.column} AS value, ${target.iface} AS iface FROM ${target.table} WHERE ${target.column} LIKE '%<%:%>%'`
      )
      .all();
    for (const row of rows) {
      const iface = typeof row.iface === 'string' && row.iface !== '' ? row.iface : null;
      for (const [, animated, name, id] of String(row.value).matchAll(MARKUP_RE))
        markup(iface, id, name, animated === 'a');
    }
  }
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
