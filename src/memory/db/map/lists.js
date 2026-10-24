// The shared half of the mappers that turn an old list of items into `claims` rows (a member's details, interests,
// aliases and closed items; the guild's in-jokes, self facts and learned lessons) and back, plus the profile pieces
// a public member file and a private layer file have in common: the text fields (character, style, relationship) as
// descriptions with one legacy version, the episodes, and the affinity history.
//
// A list is mapped only when every item has the expected shape; otherwise it stays whole in the remainder under its
// own key. The remainder lists what was mapped in `$has`, so an empty list stays an empty list and an absent one
// stays absent. A claim's id is the item's `itemId` when it had one; an item without one gets a derived id and the
// claim's remainder says so (`$derived`), which is what keeps the old item without an `itemId` after the round trip.

import { SELF_PERSON, itemOrDerivedId, shortHash, uniqueIds } from '../ids.js';
import { extraText, isPlainObject, join, ordered, parseExtra, put, rowsOf, split } from './common.js';

const BASE_SPEC = [
  { col: 'weight', key: 'weight', type: 'num' },
  { col: 'first_seen_at', key: 'firstSeen', type: 'text' },
  { col: 'last_seen_at', key: 'lastSeen', type: 'text' },
];

/** The claim lists of a member's file (public or private). */
export const MEMBER_LISTS = [
  { key: 'details', kind: 'detail', spec: [{ col: 'text', key: 'text', type: 'text' }, ...BASE_SPEC], stable: (item) => [item.id ?? item.text] },
  { key: 'interests', kind: 'interest', spec: [{ col: 'text', key: 'topic', type: 'text' }, ...BASE_SPEC], stable: (item) => [item.topic] },
  { key: 'aliases', kind: 'alias', spec: [{ col: 'text', key: 'name', type: 'text' }, ...BASE_SPEC], stable: (item) => [item.name] },
  {
    key: 'closed',
    kind: null,
    closed: true,
    spec: [
      { col: 'kind', key: 'kind', type: 'text' },
      { col: 'text', key: 'text', type: 'text' },
      ...BASE_SPEC,
      { col: 'valid_to', key: 'validTo', type: 'text' },
      { col: 'superseded_by', key: 'supersededBy', type: 'text' },
    ],
    stable: (item) => [item.kind, item.id, item.text],
  },
];

const EPISODE_SPEC = [
  { col: 'date', key: 'date', type: 'text' },
  { col: 'what', key: 'what', type: 'text' },
  { col: 'quote', key: 'quote', type: 'text' },
  { col: 'feeling', key: 'feeling', type: 'text' },
  { col: 'weight', key: 'weight', type: 'num' },
  { col: 'created_at', key: 'addedAt', type: 'text' },
];

const HISTORY_SPEC = [
  { col: 'at', key: 'ts', type: 'text' },
  { col: 'delta', key: 'delta', type: 'num' },
  { col: 'applied', key: 'appliedDelta', type: 'num' },
  { col: 'score', key: 'score', type: 'num' },
  { col: 'reason', key: 'reason', type: 'text' },
];

export const AFFINITY_SPEC = [
  { col: 'affinity', key: 'score', type: 'num' },
  { col: 'affinity_reason', key: 'reason', type: 'text' },
  { col: 'affinity_decayed_at', key: 'decayedAt', type: 'text' },
];

const listOfObjects = (value) => Array.isArray(value) && value.every(isPlainObject);
const listOfStrings = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');

/**
 * Claims rows for one list of items. `o`: { rel, subject_kind, subject_id, owner (id part), scope, how, author,
 * } where `scope` is the three scope columns. Returns false when the list is not mappable.
 */
export function claimRows(rows, items, def, o) {
  const strings = def.strings === true;
  if (!(strings ? listOfStrings(items) : listOfObjects(items))) return false;
  const uniq = uniqueIds();
  items.forEach((item, position) => {
    let id;
    let extra = null;
    let cols = { text: null };
    if (strings) {
      id = uniq(itemOrDerivedId(null, def.kind, o.owner, item));
      cols = { text: item };
    } else {
      const part = split(item, def.spec);
      cols = part.cols;
      const itemId = typeof item.itemId === 'string' && item.itemId ? item.itemId : null;
      const base = itemId ?? itemOrDerivedId(null, def.kind ?? item.kind ?? 'closed', o.owner, ...def.stable(item));
      id = uniq(base);
      if (itemId && id === base) delete part.rest.itemId;
      else part.rest.$derived = true;
      extra = extraText(part.rest);
    }
    put(rows, 'claims', {
      id,
      subject_kind: o.subject_kind,
      subject_id: o.subject_id,
      kind: def.kind ?? cols.kind ?? null,
      from_person: null,
      ...cols,
      extra,
      how: o.how ?? 'legacy',
      author: o.author ?? 'import',
      truth: def.closed ? 'historical' : 'current',
      shown: 1,
      ...o.scope,
      created_at: null,
      retired_at: null,
      origin_file: o.rel,
      owner_file: o.rel,
      position,
    });
  });
  return true;
}

/** The items of one list back from the claim rows of that list (already filtered to it). */
export function claimItems(claims, def) {
  const strings = def.strings === true;
  return claims
    .slice()
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((row) => {
      if (strings) return row.text;
      const rest = parseExtra(row.extra);
      const derived = rest.$derived === true;
      delete rest.$derived;
      const item = join(row, rest, def.spec);
      if (!derived) item.itemId = row.id;
      return item;
    });
}

/**
 * Maps the shared profile pieces of `value` into `rows` and returns what is left.
 * `o`: { rel, person (id), owner (claim/episode id part), tag ('' or ':dm'), scope, descFields }.
 * @returns {{ rest: object, affinity: object|undefined }} `rest` has `$has`; `affinity` is the affinity object without its history.
 */
export function profileRows(rows, value, o) {
  const rest = { ...value };
  const has = [];
  for (const def of MEMBER_LISTS) {
    if (!Object.hasOwn(value, def.key)) continue;
    const ok = claimRows(rows, value[def.key], def, { rel: o.rel, subject_kind: 'person', subject_id: o.person, owner: o.owner, scope: o.scope });
    if (ok) {
      delete rest[def.key];
      has.push(def.key);
    }
  }
  if (listOfObjects(value.episodes)) {
    const uniq = uniqueIds();
    value.episodes.forEach((item, position) => {
      const part = split(item, EPISODE_SPEC);
      const itemId = typeof item.itemId === 'string' && item.itemId ? item.itemId : null;
      const base = itemId ?? itemOrDerivedId(null, 'episode', o.owner, item.date, item.what);
      const id = uniq(base);
      if (itemId && id === base) delete part.rest.itemId;
      else part.rest.$derived = true;
      put(rows, 'episodes', {
        id,
        kind: 'profile',
        subject_id: o.person,
        place_id: null,
        ...part.cols,
        extra: extraText(part.rest),
        ...o.scope,
        retired_at: null,
        owner_file: o.rel,
        position,
      });
    });
    delete rest.episodes;
    has.push('episodes');
  }
  for (const field of o.descFields) {
    if (typeof value[field] !== 'string') continue;
    const id = `desc:${o.person}${o.tag}:${field}`;
    const text = value[field];
    let writtenAt = null;
    if (field === 'relationship' && typeof value.relationshipWrittenAt === 'string') {
      writtenAt = value.relationshipWrittenAt;
      delete rest.relationshipWrittenAt;
    }
    put(rows, 'descriptions', {
      id, subject_kind: 'person', subject_id: o.person, field, ...o.scope, current_version: `${id}:legacy`, owner_file: o.rel,
    });
    put(rows, 'description_versions', {
      id: `${id}:legacy`, description_id: id, text, author: 'import', written_at: writtenAt, chars: [...text].length,
      kept: null, removed: null, added: null, reason: null, origin: 'legacy', extra: null, owner_file: o.rel, position: 0,
    });
    delete rest[field];
  }
  let affinity;
  if (isPlainObject(value.affinity)) {
    affinity = { ...value.affinity };
    delete rest.affinity;
    has.push('affinity');
    if (listOfObjects(affinity.history)) {
      const history = affinity.history;
      delete affinity.history;
      has.push('affinity.history');
      history.forEach((item, position) => {
        const part = split(item, HISTORY_SPEC);
        put(rows, 'affinity_events', {
          id: `aff:${o.owner}:${position}:${shortHash(item.ts ?? '')}`,
          person_id: o.person,
          ...part.cols,
          ...o.scope,
          extra: extraText(part.rest),
          owner_file: o.rel,
          position,
        });
      });
    }
  }
  rest.$has = has;
  return { rest, affinity };
}

/** The inverse of profileRows: the object it consumed, from the rows, `has` (the `$has` list) and the affinity leftovers. */
export function profileFrom(rows, has, o) {
  const obj = {};
  for (const def of MEMBER_LISTS) {
    if (!has.includes(def.key)) continue;
    const mine = rowsOf(rows, 'claims').filter((row) => (def.closed ? row.truth === 'historical' : row.truth !== 'historical' && row.kind === def.kind));
    obj[def.key] = claimItems(mine, def);
  }
  if (has.includes('episodes')) {
    obj.episodes = ordered(rows, 'episodes').map((row) => {
      const rest = parseExtra(row.extra);
      const derived = rest.$derived === true;
      delete rest.$derived;
      const item = join(row, rest, EPISODE_SPEC);
      if (!derived) item.itemId = row.id;
      return item;
    });
  }
  const versions = new Map(rowsOf(rows, 'description_versions').map((row) => [row.description_id, row]));
  for (const description of rowsOf(rows, 'descriptions')) {
    const version = versions.get(description.id);
    if (!version) continue;
    obj[description.field] = version.text;
    if (description.field === 'relationship' && version.written_at !== null && version.written_at !== undefined) obj.relationshipWrittenAt = version.written_at;
  }
  return obj;
}

/** The affinity object back: its columns, leftovers and, when `has` says so, the history rows. */
export function affinityFrom(rows, cols, leftovers, has) {
  const affinity = join(cols, leftovers, AFFINITY_SPEC);
  if (has.includes('affinity.history')) affinity.history = historyFrom(rows);
  return affinity;
}

/** The affinity history array back from the `affinity_events` rows, in order. */
export function historyFrom(rows) {
  return ordered(rows, 'affinity_events').map((row) => join(row, row.extra, HISTORY_SPEC));
}

export { SELF_PERSON };
