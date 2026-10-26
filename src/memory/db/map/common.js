// The shared half of every mapper: how an old JSON object is split into column values plus an `extra` remainder,
// and put back together. Pure, no I/O.
//
// A spec is a list of `{ col, key, type, enc?, dec?, ok? }` (`ok` narrows what fits; `enc`/`dec` convert). `type` is 'text' | 'num' | 'bool' | 'json'; a value that does not
// fit its type (a number where text was expected) is NOT put in the column: it stays in the remainder under its
// own key, so the column's type is always honest. An absent key leaves its column NULL; a key that is present
// with the value null leaves the column NULL too and is named in the remainder's `$null` list, which is how absent
// and null stay apart. Markers in a remainder start with `$` (no old field does) and never reach the rebuilt object
// unless a mapper puts them back on purpose.
//
// Rows are plain objects of column -> value; JSON columns hold JSON text and booleans are 0/1, so a row can be
// bound to SQLite as it is and read back without a conversion step.
import { LEGACY_IFACE } from '../legacy-namespace.ts';

export const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const FITS = {
  text: (v) => typeof v === 'string',
  num: (v) => typeof v === 'number' && Number.isFinite(v),
  bool: (v) => typeof v === 'boolean',
  json: (v) => v !== null && typeof v === 'object',
};

function encode(type, value) {
  if (type === 'bool') return value ? 1 : 0;
  if (type === 'json') return JSON.stringify(value);
  return value;
}

function decode(type, value) {
  if (type === 'bool') return value === 1 || value === true;
  if (type === 'json') return typeof value === 'string' ? JSON.parse(value) : value;
  return value;
}

/**
 * Splits an old object by a spec.
 * Splits can be chained (the remainder of one is the input of the next): a `$null` list in the input is carried on.
 * @returns {{ cols: object, rest: object }} `rest` holds every key no column took, plus `$null` when needed.
 */
export function split(obj, spec, iface = LEGACY_IFACE) {
  const rest = { ...obj };
  const cols = {};
  const nulls = Array.isArray(obj.$null) ? [...obj.$null] : [];
  for (const { col, key, type, enc, ok } of spec) {
    cols[col] = null;
    if (!Object.hasOwn(obj, key)) continue;
    const value = obj[key];
    if (value === null) {
      delete rest[key];
      nulls.push(key);
    } else if (FITS[type](value) && (!ok || ok(value))) {
      delete rest[key];
      cols[col] = encode(type, enc ? enc(value, iface) : value);
    }
  }
  if (nulls.length) rest.$null = nulls;
  return { cols, rest };
}

/**
 * Rebuilds an old object from columns and the remainder. A column that is not NULL wins over the same key in
 * the remainder.
 * @param {object} cols
 * @param {object|string|null|undefined} rest  the remainder, as an object or as its JSON text
 * @param {Array} spec
 */
export function join(cols, rest, spec) {
  const left = parseExtra(rest);
  const nulls = Array.isArray(left.$null) ? left.$null : [];
  delete left.$null;
  const obj = {};
  for (const { col, key, type, dec } of spec) {
    const value = cols?.[col];
    if (value !== null && value !== undefined) obj[key] = dec ? dec(decode(type, value)) : decode(type, value);
  }
  for (const key of nulls) if (!Object.hasOwn(obj, key)) obj[key] = null;
  for (const [key, value] of Object.entries(left)) if (!Object.hasOwn(obj, key)) obj[key] = value;
  return obj;
}

/** The remainder as JSON text, or null when it is empty. */
export function extraText(rest) {
  return rest && Object.keys(rest).length ? JSON.stringify(rest) : null;
}

/** A remainder read back: an object (a copy), whatever the column held (JSON text, an object or nothing). */
export function parseExtra(extra) {
  if (extra === null || extra === undefined || extra === '') return {};
  const value = typeof extra === 'string' ? JSON.parse(extra) : extra;
  return isPlainObject(value) ? { ...value } : {};
}

/** The rows of one table in a mapping (never undefined). */
export const rowsOf = (rows, table) => (Array.isArray(rows?.[table]) ? rows[table] : []);

/** The rows of a table sorted by `position` (stable). */
export function ordered(rows, table) {
  return rowsOf(rows, table)
    .map((row, index) => [row, index])
    .sort((a, b) => (a[0].position ?? 0) - (b[0].position ?? 0) || a[1] - b[1])
    .map(([row]) => row);
}

/** Adds a row to a table of a mapping. */
export function put(rows, table, row) {
  (rows[table] ??= []).push(row);
  return row;
}

/** `[{ col, key, type }]` where the column and the key have one name. */
export const same = (type, ...names) => names.map((name) => ({ col: name, key: name, type }));

/** Deep equality of two JSON values, key order ignored; absent and undefined are the same. */
export function jsonEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
  if (isPlainObject(a)) {
    if (!isPlainObject(b)) return false;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      if (a[key] === undefined && b[key] === undefined) continue;
      if (!jsonEqual(a[key], b[key])) return false;
    }
    return true;
  }
  return false;
}

export { ifaceOrLegacy as ifaceOf } from '../legacy-namespace.ts';
