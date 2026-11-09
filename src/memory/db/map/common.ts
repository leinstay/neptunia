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
import { isFiniteNumber } from '../types.ts';
import type { Row, Rows } from '../types.ts';

export const isPlainObject = (value: unknown): value is Row =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** What a mapper is told about the unit it maps: the interface, the subject and the position a line holds in it. */
export type MapContext = {
  iface?: string;
  position?: number;
  subjectId?: string;
  subjectNativeId?: string;
  subjectPersonId?: string;
  /** The stored row of a place subject, null when the place has none yet. */
  subjectPlace?: Row | null;
  /** The subject's id when it is a DM place. */
  dmPlaceId?: string;
  /** The DM place of the unit (its subject, or a private unit's account's), with the partner person the place names. */
  dmPlace?: { id: string; partnerPerson: string | null } | null;
  privateAccountId?: string | null;
  /** The stored person of the account a platform id names on an interface (meta-person.ts), null when none is stored. */
  personOfMember?: (iface: string, platformId: string) => string | null;
  /** The stored direct chat of the account a platform id names on an interface, null when none is stored. */
  dmOfMember?: (iface: string, platformId: string) => { id: string; partnerPerson: string | null } | null;
  /** A stored DM place by its id, with the partner person it names; null for a place that is no stored DM. */
  dmPlaceOf?: (placeId: string) => { id: string; partnerPerson: string | null } | null;
  /** The platform id of the partner account of the stored DM place an audience names, null when none is stored. */
  partnerOfDm?: (audienceId: string) => string | null;
  /** The stored account of a member an interface names by its id, null when no row holds it. */
  accountOfMember?: (iface: string, platformId: string) => string | null;
  /** The interface's own id of a stored account, null when no row holds it. */
  memberOfAccount?: (accountId: string) => string | null;
  /** The stored place of a channel an interface names by its id, null when no row holds it. */
  placeOfChannel?: (iface: string, native: string) => string | null;
  /** The interface's own id of a stored channel, null for a place that is no stored channel. */
  channelOfPlace?: (placeId: string) => string | null;
  collection?: string;
  versionKind?: string;
  itemId?: string;
  hotClaimIds?: ReadonlySet<string>;
  [key: string]: unknown;
};

/** One column of a mapper: the key of the old object, the column it goes to and how its value is stored. */
export type Spec = {
  col: string;
  key: string;
  type: 'text' | 'num' | 'bool' | 'json';
  enc?: (value: unknown, iface: string) => unknown;
  dec?: (value: unknown) => unknown;
  ok?: (value: unknown) => boolean;
  /** The value is kept beside the column when `dec` cannot read it back from what `enc` stored, so it comes back exact. */
  exact?: true;
};

/** The key of the remainder that keeps a value its column cannot give back (`Spec.exact`). */
const keptKey = (key: string): string => `$kept:${key}`;

const FITS: Record<Spec['type'], (value: unknown) => boolean> = {
  text: (v: unknown) => typeof v === 'string',
  num: (v: unknown) => isFiniteNumber(v),
  bool: (v: unknown) => typeof v === 'boolean',
  json: (v: unknown) => v !== null && typeof v === 'object',
};

function encode(type: Spec['type'], value: unknown): unknown {
  if (type === 'bool') return value ? 1 : 0;
  if (type === 'json') return JSON.stringify(value);
  return value;
}

function decode(type: Spec['type'], value: unknown): unknown {
  if (type === 'bool') return value === 1 || value === true;
  if (type === 'json') return typeof value === 'string' ? JSON.parse(value) : value;
  return value;
}

/**
 * Splits an old object by a spec.
 * Splits can be chained (the remainder of one is the input of the next): a `$null` list in the input is carried on.
 * Returns `rest`, every key no column took, plus `$null` when needed.
 */
export function split(obj: Row, spec: ReadonlyArray<Spec>, iface = LEGACY_IFACE): { cols: Row; rest: Row } {
  const rest: Row = { ...obj };
  const cols: Row = {};
  const nulls: Array<unknown> = Array.isArray(obj.$null) ? [...(obj.$null as Array<unknown>)] : [];
  for (const { col, key, type, enc, dec, ok, exact } of spec) {
    cols[col] = null;
    if (!Object.hasOwn(obj, key)) continue;
    const value = obj[key];
    if (value === null) {
      delete rest[key];
      nulls.push(key);
    } else if (FITS[type](value) && (!ok || ok(value))) {
      delete rest[key];
      const stored = enc ? enc(value, iface) : value;
      cols[col] = encode(type, stored);
      if (exact && dec && !jsonEqual(dec(stored), value)) rest[keptKey(key)] = value;
    }
  }
  if (nulls.length) rest.$null = nulls;
  return { cols, rest };
}

/**
 * Rebuilds an old object from columns and the remainder. A column that is not NULL wins over the same key in
 * the remainder.
 * `rest` is the remainder, as an object or as its JSON text.
 */
export function join(cols: Row | null | undefined, rest: unknown, spec: ReadonlyArray<Spec>): Row {
  const left = parseExtra(rest);
  const nulls: Array<string> = Array.isArray(left.$null) ? (left.$null as Array<string>) : [];
  delete left.$null;
  const obj: Row = {};
  for (const { col, key, type, dec } of spec) {
    const value = cols?.[col];
    const kept = keptKey(key);
    if (Object.hasOwn(left, kept)) {
      obj[key] = left[kept];
      delete left[kept];
    } else if (value !== null && value !== undefined) obj[key] = dec ? dec(decode(type, value)) : decode(type, value);
  }
  for (const key of nulls) if (!Object.hasOwn(obj, key)) obj[key] = null;
  for (const [key, value] of Object.entries(left)) if (!Object.hasOwn(obj, key)) obj[key] = value;
  return obj;
}

/** The remainder as JSON text, or null when it is empty. */
export function extraText(rest: Row | null | undefined): string | null {
  return rest && Object.keys(rest).length ? JSON.stringify(rest) : null;
}

/** A remainder read back: an object (a copy), whatever the column held (JSON text, an object or nothing). */
export function parseExtra(extra: unknown): Row {
  if (extra === null || extra === undefined || extra === '') return {};
  const value: Row = typeof extra === 'string' ? JSON.parse(extra) : extra;
  return isPlainObject(value) ? { ...value } : {};
}

/** The rows of one table in a mapping (never undefined). */
export const rowsOf = (rows: Rows, table: string): Array<Row> => (Array.isArray(rows?.[table]) ? rows[table] : []);

/** The rows of a table sorted by `position` (stable). */
export function ordered(rows: Rows, table: string): Array<Row> {
  return rowsOf(rows, table)
    .map((row, index): [Row, number] => [row, index])
    .sort((a, b) => Number(a[0].position ?? 0) - Number(b[0].position ?? 0) || a[1] - b[1])
    .map(([row]) => row);
}

/** Adds a row to a table of a mapping. */
export function put(rows: Rows, table: string, row: Row): Row {
  (rows[table] ??= []).push(row);
  return row;
}

/** `[{ col, key, type }]` where the column and the key have one name. */
export const same = (type: Spec['type'], ...names: Array<string>): Array<Spec> =>
  names.map((name) => ({ col: name, key: name, type }));

/** Deep equality of two JSON values, key order ignored; absent and undefined are the same. */
export function jsonEqual(a: unknown, b: unknown): boolean {
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
