// Her selfreflection: the dated entries she wrote and the message ids each was mirrored as (src/memory/store.ts,
// `getSelfreflection`, `appendSelfreflectionPost`), owned by the unit `personaKey('selfreflection')`. The store writes
// the whole value through the write kind `selfreflection-entries` (session-write.ts); an append adds one post and keeps
// the newest `max`. `selfreflectionValue` below reads it back.
//
//   selfreflection           one per post: `at` as at_ms, `picture` as picture_prompt, kind, gist and search; its
//                            `itemId` as the id, a derived id marked `$derived` when it has none; the post's `text`,
//                            when it carries one, as the text column (a re-map without it leaves the column alone);
//                            the rest in `extra`. A post with a saved publication boundary is internal, the others
//                            group-scoped.
//   selfreflection_mirrors   one per post with `messageIds`, the ids in `native_ids`; each derives its publication
//                            (publish.ts#deriveMirrorPublication)
//   operational              kind selfreflection: the rest of the value (`updatedAt`)
//
// Every row names the writer `selfreflection` and her as holder (place-owner.ts), the mirrors' publications too. A
// write replaces the value: what it no longer holds is retired, a mirror with its publication. A write that names a
// destination gives her publications with none that channel (publish.ts#assignSelfreflectionDestination).

import { itemOrDerivedId, uniqueIds } from './ids.ts';
import { namedIface } from './live-iface.ts';
import { selfreflectionRestricted } from '../../tools/publication.ts';
import { groupScope, SCOPE_INTERNAL } from './scope.ts';
import { extraText, isPlainObject, join, ordered, parseExtra, put, rowsOf, split } from './row-columns.ts';
import type { Spec } from './row-columns.ts';
import {
  heldPlaceRows,
  holdsPlace,
  placeOwnerOf,
  preparedPlace,
  retirePlaceAbsent,
  stampPlaceRows,
} from './place-owner.ts';
import type { PlaceOwner } from './place-owner.ts';
import { assignSelfreflectionDestination } from './publish.ts';
import { personaKey } from './storage-keys.ts';
import type { StorageKey } from './storage-keys.ts';
import { ensureUnit, noteUnit } from './storage-units.ts';
import { writeMapping } from './upsert.ts';
import { dbOf, isFiniteNumber, isWholeNumber } from './types.ts';
import type { Db, MemoryHandle, Row, Rows } from './types.ts';

/** One write of the kind: the whole value, or one post appended with a cap; either may name a destination. */
export type SelfreflectionWrite =
  { value: Row; destination?: string } | { append: Row; max?: number; updatedAt?: number; destination?: string };

const SPEC: Array<Spec> = [
  { col: 'at_ms', key: 'at', type: 'num' },
  { col: 'kind', key: 'kind', type: 'text' },
  { col: 'gist', key: 'gist', type: 'text' },
  { col: 'picture_prompt', key: 'picture', type: 'text' },
  { col: 'search', key: 'search', type: 'text' },
];

const coded = (code: string): Error & { code: string } => Object.assign(new Error(code), { code });
const filled = (value: unknown): value is string => typeof value === 'string' && value !== '';
const isIds = (value: unknown): boolean => Array.isArray(value) && value.every((id) => typeof id === 'string');

/** The entry rows and mirrors of `posts` into `rows`. */
function putPosts(rows: Rows, posts: ReadonlyArray<Row>, iface: string, owner: string): void {
  const uniq = uniqueIds();
  posts.forEach((post: Row, position: number) => {
    const body = { ...post };
    delete body.pictureDescription;
    const mirrored = isIds(post.messageIds);
    if (mirrored) delete body.messageIds;
    // The entry's text, when the post carries it (a post recorded before it is sent), is the row's.
    const text = typeof post.text === 'string' ? post.text : null;
    if (text !== null) delete body.text;
    const part = split(body, SPEC);
    const itemId = typeof post.itemId === 'string' && post.itemId ? post.itemId : null;
    const base = itemId ?? itemOrDerivedId(null, 'selfreflection', '', post.at ?? '', post.gist ?? position);
    const id = uniq(base);
    if (itemId && id === base) delete part.rest.itemId;
    else part.rest.$derived = true;
    put(rows, 'selfreflection', {
      id,
      ...part.cols,
      ...(text !== null ? { text } : {}),
      topic: null,
      world: null,
      status: null,
      perspective: null,
      ...(selfreflectionRestricted(post) ? SCOPE_INTERNAL : groupScope(iface)),
      extra: extraText(part.rest),
      owner_key: owner,
      position,
    });
    if (mirrored)
      put(rows, 'selfreflection_mirrors', {
        selfreflection_id: id,
        iface,
        place_id: null,
        native_ids: JSON.stringify(post.messageIds),
        posted_at: null,
      });
  });
}

/** The rows of the selfreflection `value`, owned by `owner` (the unit's id) and `holder`. */
function selfreflectionRows(db: Db, value: Row, iface: string, owner: string, holder: PlaceOwner): Rows {
  const rows: Rows = {};
  const rest = { ...value };
  const has = [];
  if (Array.isArray(value.posts) && value.posts.every(isPlainObject)) {
    putPosts(rows, value.posts, iface, owner);
    delete rest.posts;
    has.push('posts');
  }
  rest.$has = has;
  // The operational row keeps the owner it was first stored under, the unit's id.
  const stored = preparedPlace(
    db,
    "SELECT owner FROM operational WHERE kind = 'selfreflection' AND writer = ? AND holder_id = ? ORDER BY rowid LIMIT 1"
  ).get(holder.writer, holder.holder_id);
  put(rows, 'operational', {
    kind: 'selfreflection',
    owner: stored ? stored.owner : owner,
    value: JSON.stringify(rest),
    owner_key: owner,
  });
  return stampPlaceRows(rows, holder);
}

/** The selfreflection its rows give back. */
function selfreflectionOf(rows: Rows): Row {
  const rest = parseExtra(rowsOf(rows, 'operational')[0]?.value);
  const has = Array.isArray(rest.$has) ? rest.$has : [];
  delete rest.$has;
  const obj = { ...rest };
  if (has.includes('posts')) {
    const mirrors = new Map(rowsOf(rows, 'selfreflection_mirrors').map((row) => [row.selfreflection_id, row]));
    obj.posts = ordered(rows, 'selfreflection').map((row) => {
      const extra = parseExtra(row.extra);
      const derived = extra.$derived === true;
      delete extra.$derived;
      const post = join(row, extra, SPEC);
      if (!derived) post.itemId = row.id;
      const mirror = mirrors.get(row.id);
      if (mirror) post.messageIds = JSON.parse(String(mirror.native_ids));
      return post;
    });
  }
  return obj;
}

/** The rows the holder holds: the entries, the operational row and the live mirrors of its live entries. */
function heldSelfreflectionRows(db: Db, holder: PlaceOwner): Rows {
  const rows = heldPlaceRows(db, holder, ['selfreflection', 'operational']);
  rows.selfreflection_mirrors = preparedPlace(
    db,
    `SELECT c.* FROM selfreflection_mirrors c JOIN selfreflection p ON p.id = c.selfreflection_id
     WHERE p.writer = ? AND p.holder_id = ? AND p.retired_at IS NULL AND c.retired_at IS NULL ORDER BY c.rowid`
  )
    .all(holder.writer, holder.holder_id)
    .map((row) => ({ ...row }));
  return rows;
}

/**
 * Stores the whole selfreflection `value` inside the caller's transaction, retires what it no longer holds and gives
 * her publications with no destination `destination` when one is named.
 */
export function writeSelfreflectionValue(
  db: Db,
  value: Row,
  { at, iface, destination }: { at: string; iface: string; destination?: unknown }
): { upserted: number; retired: number; destinations: number } {
  const key: StorageKey = personaKey('selfreflection');
  const id = ensureUnit(db, key);
  const holder = placeOwnerOf(key)!; // her selfreflection unit always has its owner columns (place-owner.ts)
  const mapping = selfreflectionRows(db, value, iface, id, holder);
  const upserted = writeMapping(db, mapping, id, { at, holder });
  const retired = retirePlaceAbsent(db, holder, mapping, at);
  noteUnit(db, id, 'selfreflection', { at });
  const destinations = filled(destination) ? assignSelfreflectionDestination(db, destination, { holder, at }) : 0;
  return { upserted, retired, destinations };
}

/** Appends one post to the stored selfreflection, keeps the newest `max` and stores it whole. */
export function appendSelfreflectionPost(
  db: Db,
  { post, max, updatedAt }: { post: unknown; max?: unknown; updatedAt?: unknown },
  opts: { at: string; iface: string; destination?: unknown }
): { upserted: number; retired: number; posts: number; destinations: number } {
  const held = selfreflectionValue(db, personaKey('selfreflection'));
  const stored = held.found ? (held.value as { posts?: unknown }).posts : [];
  const posts = [...(Array.isArray(stored) ? (stored as Array<unknown>) : []), ...(isPlainObject(post) ? [post] : [])];
  const cap = isWholeNumber(max) && max > 0 ? max : posts.length;
  const value = { posts: posts.slice(-cap), updatedAt: isFiniteNumber(updatedAt) ? updatedAt : Date.parse(opts.at) };
  const written = writeSelfreflectionValue(db, value, opts);
  return {
    upserted: written.upserted,
    retired: written.retired,
    posts: value.posts.length,
    destinations: written.destinations,
  };
}

/** A write as the writer receives it, checked. */
export function selfreflectionWriteOf(update: Row): SelfreflectionWrite {
  const destination = filled(update.destination) ? { destination: update.destination } : {};
  // A value of another shape, such as a list a hand edit left, is stored as its fields and read back malformed.
  if (typeof update.value === 'object' && update.value !== null) return { value: update.value as Row, ...destination };
  if (isPlainObject(update.append))
    return {
      append: update.append,
      ...(isWholeNumber(update.max) ? { max: update.max } : {}),
      ...(isFiniteNumber(update.updatedAt) ? { updatedAt: update.updatedAt } : {}),
      ...destination,
    };
  throw coded('SELFREFLECTION_VALUE');
}

/** The write of a unit update of her selfreflection (a value write of her own unit), else null. */
export function selfreflectionOfUnit(update: Row): SelfreflectionWrite | null {
  const key = update.key as StorageKey | undefined;
  if (update.op !== 'value' || key?.kind !== 'selfreflection' || key.subject?.type !== 'persona') return null;
  if (key.selector || key.partition || key.scopePlaceId) return null;
  return selfreflectionWriteOf({ value: update.value ?? {}, destination: update.destination });
}

/** The write kind `selfreflection-entries` on the writer connection (session-write.ts). */
export function applySelfreflectionWrite(handle: MemoryHandle, update: Row): unknown {
  const write = selfreflectionWriteOf(update);
  const at = new Date(isFiniteNumber(update.now) ? update.now : Date.now()).toISOString();
  const opts = { at, iface: namedIface(update), ...(write.destination ? { destination: write.destination } : {}) };
  const db = dbOf(handle);
  return handle.transaction(() =>
    'value' in write
      ? writeSelfreflectionValue(db, write.value, opts)
      : appendSelfreflectionPost(db, { post: write.append, max: write.max, updatedAt: write.updatedAt }, opts)
  );
}

/** Her selfreflection, or not found when the database holds none. */
export function selfreflectionValue(db: Db, key: StorageKey): { found: true; value: unknown } | { found: false } {
  const holder = placeOwnerOf(key);
  if (!holder || !holdsPlace(db, holder, 'operational')) return { found: false };
  return { found: true, value: selfreflectionOf(heldSelfreflectionRows(db, holder)) };
}
