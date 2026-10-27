// Deterministic ids for the memory database (spec section 2): the same input gives the same id, so a re-import
// writes the same rows. Pure, no I/O except `resolveAlias` and `survivorOf`, which read `external_keys` and
// `people_merges` on a connection they are given.
//
// Two families live here (schema v7, spec 2026-10-24-memory-schema-v7 sections 1.2 and 11.3):
//   - the legacy-shaped ids (`person:<iface>:<id>`, `<iface>:<id>`, `<iface>:channel:<id>`, `src:<iface>:...`): every
//     builder takes the interface as its first argument, so `discord` gives the strings stored today and another
//     interface its own namespace; `nativeOf` and the functions below that read them are the one place an id is taken
//     apart, and only for the legacy spellings (src/memory/db/legacy-namespace.ts);
//   - the new ids: `nodeId(kind, parts)` (`<kind>:<32 hex of SHA-256 over the canonical key>`) and `newPersonId()`
//     (`person:<uuid>`). A new id is a stable spelling, never parsed: the tuple it hashes is stored in columns.
// Schema v8 adds the relation target keys (`externalTargetKey`, `sourceTargetKey`) and `survivorOf` (merged people).
// Stage 8a adds the legacy spelling of an observed tuple (`legacyAccountIdOf`, `legacyPlaceOf`, `legacySourceIdOf`).
// Stage 4 adds `interfaceAccountId` and `interfacePlaceOf`, the one spelling the observation and the unit mappers share.

import { createHash, randomUUID } from 'node:crypto';
import { LEGACY_IFACE } from './legacy-namespace.ts';

export const SELF_PERSON = 'person:self';

type Row = Record<string, unknown>;
type Db = {
  prepare(sql: string): { all(...params: Array<string>): Array<Row>; get(...params: Array<string>): Row | undefined };
};

const text = (value: unknown): string => String(value);

// The interface and the native id are any value an adapter or a legacy file gave: they are written with `String`.
export const personId = (iface: unknown, userId: unknown): string => `person:${text(iface)}:${text(userId)}`;
export const accountId = (iface: unknown, userId: unknown): string => `${text(iface)}:${text(userId)}`;
export const guildPlaceId = (iface: unknown, guildId: unknown): string => `${text(iface)}:guild:${text(guildId)}`;
export const channelPlaceId = (iface: unknown, channelId: unknown): string =>
  `${text(iface)}:channel:${text(channelId)}`;
export const dmPlaceId = (iface: unknown, userId: unknown): string => `${text(iface)}:dm:${text(userId)}`;

const LEGACY_NATIVE_RE = new RegExp(`^(?:person:${LEGACY_IFACE}:|${LEGACY_IFACE}:(?:guild:|channel:|dm:)?)(.+)$`);

/** The native id inside a legacy person, account or place id (the legacy spellings); null when the id has another shape. */
export function nativeOf(id: unknown): string | null {
  const match = LEGACY_NATIVE_RE.exec(String(id));
  return match ? (match[1] ?? null) : null;
}

const ANY_NATIVE_RE = /^(?:person:[^:]+:|(?!person:|src:)[^:]+:(?:guild:|channel:|dm:)?)(.+)$/;

/**
 * The native id inside a person, account or place id of any interface (`person:<iface>:<id>`, `<iface>:<id>`,
 * `<iface>:channel:<id>`...); null when the id has another shape (`person:self`, `src:...`). The legacy files'
 * mappers read the ids they wrote with it.
 */
export function nativeOfAny(id: unknown): string | null {
  const match = ANY_NATIVE_RE.exec(String(id));
  return match ? (match[1] ?? null) : null;
}

/** The core's own namespace (`person:self`, rows with no interface). */
export const CORE_AUTHORITY = 'core/local';
/** The namespace of the full legacy id spellings (every row id from before schema v7 is an alias here too). */
export const LEGACY_AUTHORITY = 'legacy/local';

/** The native authority of an interface: `<iface>/local` for the command line and the core, `<iface>/global` for any other interface until it declares its own. */
export function nativeAuthorityOf(iface: unknown): string {
  if (typeof iface !== 'string' || !iface) return CORE_AUTHORITY;
  if (iface === 'cli' || iface === 'core') return `${iface}/local`;
  return `${iface}/global`;
}

/** The community-local namespace of an interface (nicks, roles). */
export const guildAuthorityOf = (guildId: unknown, iface: unknown): string => `${text(iface)}/guild:${text(guildId)}`;

/**
 * The DM place of a DM partner on an interface, from the legacy person spelling `person:<iface>:<native>`
 * (`<iface>:dm:<native>`, the same id `dmPlaceId` gives); null for a person id of another shape (a new
 * `person:<uuid>` names its DM place explicitly).
 */
export function dmPlaceOfPerson(person: unknown, iface: unknown): string | null {
  const prefix = `person:${text(iface)}:`;
  const value = text(person ?? '');
  if (!iface || !value.startsWith(prefix) || value.length <= prefix.length) return null;
  return `${text(iface)}:dm:${value.slice(prefix.length)}`;
}

/** The interface and partner of a legacy DM place id (`<iface>:dm:<native>`): `{ iface, person, account }`, or null. */
export function dmPartnerOfPlace(placeId: unknown): { iface: string; person: string; account: string } | null {
  const match = /^([^:]+):dm:(.+)$/.exec(text(placeId ?? ''));
  return match
    ? { iface: match[1] ?? '', person: `person:${match[1]}:${match[2]}`, account: `${match[1]}:${match[2]}` }
    : null;
}

/** The native key of a legacy person id (`person:<iface>:<native>`) on its interface: `{ iface, native }`, or null. */
export function legacyPersonNative(person: unknown): { iface: string; native: string } | null {
  const match = /^person:([^:]+):(.+)$/.exec(text(person ?? ''));
  return match ? { iface: match[1] ?? '', native: match[2] ?? '' } : null;
}

/** The native key of a legacy account id (`<iface>:<native>`), or null. */
export function legacyAccountNative(account: unknown, iface: unknown): string | null {
  const prefix = `${text(iface)}:`;
  const value = text(account ?? '');
  return iface && value.startsWith(prefix) && value.length > prefix.length ? value.slice(prefix.length) : null;
}

/**
 * The native key of a place inside its authority: the place kind and the native id (`channel:<id>`, `guild:<id>`,
 * `dm:<partner native>`), so a guild and a channel that share a snowflake never collide.
 */
export function placeNativeKey(place: Row | null | undefined): string | null {
  const kind = typeof place?.kind === 'string' && place.kind ? place.kind : 'place';
  if (kind === 'dm') {
    const partner = dmPartnerOfPlace(place?.id);
    const native = place?.native_id ?? (partner ? legacyAccountNative(partner.account, partner.iface) : null);
    return native === null || native === undefined ? null : `dm:${text(native)}`;
  }
  return place?.native_id === null || place?.native_id === undefined ? null : `${kind}:${text(place.native_id)}`;
}

/** The deterministic id of an account's link to a person (one per pair; a later generation gets its own stage). */
export const linkId = (account: unknown, person: unknown): string => `link:${text(account)}:${text(person)}`;

/**
 * The canonical key of a node tuple: JSON of the ordered array `[kind, ...parts]` (an absent part is null, an empty
 * one ""). A NUL anywhere is refused: it is never part of a native id.
 */
export function canonicalKey(kind: unknown, parts: unknown = []): string {
  const listed: Array<unknown> = Array.isArray(parts) ? parts : [parts];
  const values = [kind, ...listed].map((part) => (part === undefined ? null : part));
  for (const value of values) {
    if (typeof value === 'string' && value.includes('\u0000'))
      throw Object.assign(new Error('memory db: a NUL in a node key'), { code: 'NUL_IN_KEY' });
    if (value !== null && typeof value === 'object')
      throw Object.assign(new Error('memory db: a node key part must be a scalar'), { code: 'BAD_KEY_PART' });
  }
  return JSON.stringify(values);
}

/** A new node id: `<kind>:<first 32 hex of SHA-256 over canonicalKey(kind, parts)>`. Never parsed. */
export function nodeId(kind: unknown, parts: unknown = []): string {
  return `${text(kind)}:${createHash('sha256').update(canonicalKey(kind, parts)).digest('hex').slice(0, 32)}`;
}

/** A new person: `person:<uuid v4>` (`uuid` is injected by tests). */
export const newPersonId = (uuid: () => string = randomUUID): string => `person:${uuid()}`;

type AliasRow = { node_id: string; generation: number; valid_from_at: string | null; valid_to_at: string | null };

/**
 * The node a native key of an authority named at `atIso` (an ISO time; null: the open rows, the current aliases).
 * A row's window is [valid_from_at, valid_to_at), an open end unbounded. Returns the node id when exactly one node's
 * window holds the time; `{ unresolved: true, candidates }` (the rows' `{ node_id, generation, valid_from_at,
 * valid_to_at }`) when several do or none does; null when the key was never registered. Never "the latest".
 */
export function resolveAlias(
  db: unknown,
  authority: unknown,
  kind: unknown,
  nativeKey: unknown,
  at: unknown = null
): string | { unresolved: true; candidates: Array<AliasRow> } | null {
  const atIso = typeof at === 'string' ? at : null;
  const rows = (db as Db)
    .prepare(
      'SELECT node_id, generation, valid_from_at, valid_to_at FROM external_keys WHERE authority_id = ? AND object_kind = ? AND native_key = ? ORDER BY generation'
    )
    .all(text(authority), text(kind), text(nativeKey))
    .map((row) => ({ ...row }) as AliasRow);
  if (rows.length === 0) return null;
  const holds = (row: AliasRow): boolean =>
    atIso === null || atIso === undefined
      ? row.valid_to_at === null
      : (row.valid_from_at === null || row.valid_from_at <= atIso) &&
        (row.valid_to_at === null || atIso < row.valid_to_at);
  const matching = rows.filter(holds);
  const nodes = [...new Set(matching.map((row) => row.node_id))];
  if (nodes.length === 1) return nodes[0] ?? null;
  return { unresolved: true, candidates: matching.length > 0 ? matching : rows };
}

/**
 * The person a person id stands for now: the final survivor of its merges (`people_merges`, from -> into, followed to
 * the end). A person never merged is itself. A loop (refused by the writer, never expected) stops at the first repeat.
 */
export function survivorOf(db: unknown, person: unknown): string {
  const next = (db as Db).prepare('SELECT into_person FROM people_merges WHERE from_person = ?');
  const seen = new Set<string>();
  let current = text(person);
  while (!seen.has(current)) {
    seen.add(current);
    const row = next.get(current);
    if (!row) return current;
    current = text(row.into_person);
  }
  return current;
}

/**
 * The interface's native kind of the objects its legacy record lines name (`message` for the legacy namespace: `sources.native_id`
 * is a message id); null for any other interface (an observation names its own kind).
 */
export const legacyNativeKind = (iface: unknown): 'message' | null => (iface === LEGACY_IFACE ? 'message' : null);

/**
 * The key of a relation's target named by its native tuple (schema v8, `source_relations.target_key`): JSON of the
 * ordered array `[authority, kind, native key, generation, revision]` (a revision not named is null: any revision).
 * The same spelling as `canonicalKey`, the same refusals. It never changes once written, whether or not the target
 * arrives later.
 */
export function externalTargetKey({
  authority,
  kind,
  key,
  generation = 1,
  revision = null,
}: {
  authority: unknown;
  kind: unknown;
  key: unknown;
  generation?: unknown;
  revision?: unknown;
}): string {
  return canonicalKey(text(authority), [
    text(kind),
    text(key),
    Number.isInteger(generation) ? generation : 1,
    Number.isInteger(revision) ? revision : null,
  ]);
}
/** The key of a relation's target named by our own source id: `source:<id>`. */
export const sourceTargetKey = (sourceId: unknown): string => `source:${text(sourceId)}`;

// ---------- the legacy spelling of an observed tuple (stage 8a) ----------
// An observation of the interface the legacy importer reads (LEGACY_IFACE) names the same accounts, places and lines the
// JSON files do. While the files are the writer, both must land on ONE row: the observed node takes the importer's
// spelling of its tuple, and the sync adopts the row when its file brings it (sync.js#writeRow). Only the tuples the
// importer itself writes have a legacy spelling; anything else (a thread, a later generation, another interface) is a
// new id (`nodeId`).

const LEGACY_AUTHORITY_OF_IFACE = `${LEGACY_IFACE}/global`;
/** Place kinds the importer writes under their own id spelling, and the spelling. */
const LEGACY_PLACE_IDS: Record<string, (iface: unknown, id: unknown) => string> = {
  guild: guildPlaceId,
  channel: channelPlaceId,
  dm: dmPlaceId,
};

/** The importer's account id of a native key (`discord:<user id>`), or null when the tuple is not one it writes. */
export function legacyAccountIdOf(authority: unknown, key: unknown, generation: unknown = 1): string | null {
  if (authority !== LEGACY_AUTHORITY_OF_IFACE || (generation ?? 1) !== 1 || typeof key !== 'string' || key === '')
    return null;
  return accountId(LEGACY_IFACE, key);
}

/**
 * The importer's place of a native place key (`channel:<id>`, `dm:<user id>`, `guild:<id>`): `{ id, native_id }` as
 * the importer writes them (a DM place has no native id of its own), or null.
 */
export function legacyPlaceOf(
  authority: unknown,
  key: unknown,
  generation: unknown = 1
): { id: string; native_id: string | null } | null {
  if (authority !== LEGACY_AUTHORITY_OF_IFACE || (generation ?? 1) !== 1) return null;
  const match = /^([a-z_]+):(.+)$/.exec(text(key ?? ''));
  const spell = match?.[1] ? LEGACY_PLACE_IDS[match[1]] : undefined;
  if (!match || !spell) return null;
  return { id: spell(LEGACY_IFACE, match[2] ?? ''), native_id: match[1] === 'dm' ? null : (match[2] ?? null) };
}

/** The importer's source id of an observed line (`src:discord:<message id>:<revision>:<seen|said>`), or null. */
export function legacySourceIdOf({
  authority,
  kind,
  key,
  generation = 1,
  revision,
  subtype,
}: {
  authority: unknown;
  kind: unknown;
  key: unknown;
  generation?: unknown;
  revision: unknown;
  subtype: unknown;
}): string | null {
  if (authority !== LEGACY_AUTHORITY_OF_IFACE || kind !== legacyNativeKind(LEGACY_IFACE) || (generation ?? 1) !== 1)
    return null;
  if (
    typeof revision !== 'number' ||
    !Number.isInteger(revision) ||
    revision < 1 ||
    (subtype !== 'seen' && subtype !== 'said') ||
    typeof key !== 'string' ||
    key === ''
  )
    return null;
  return messageSourceId(LEGACY_IFACE, key, revision, subtype);
}

/** A message source: `src:<iface>:<messageId>:<revision>:<kind>`. */
export const messageSourceId = (iface: unknown, messageId: unknown, revision: unknown, kind: unknown): string =>
  `src:${text(iface)}:${text(messageId)}:${text(revision)}:${text(kind)}`;
/** Her answer in a turn: `src:turn:<turnId>:<step>`. */
export const answerSourceId = (turnId: unknown, step: unknown): string => `src:turn:${text(turnId)}:${text(step)}`;
/** Any other kind of source: `src:<kind>:<its id>`. */
export const otherSourceId = (kind: unknown, id: unknown): string => `src:${text(kind)}:${text(id)}`;

/** The first 16 hex digits of the SHA-1 of the parts joined by a NUL. */
export function shortHash(...parts: Array<unknown>): string {
  return createHash('sha1')
    .update(parts.map((part) => text(part)).join('\u0000'))
    .digest('hex')
    .slice(0, 16);
}

/** A claim, episode or description id: the old `itemId` when the item had one, else `<kind>:<owner>:<hash of stable fields>`. */
export function itemOrDerivedId(itemId: unknown, kind: unknown, owner: unknown, ...stable: Array<unknown>): string {
  if (typeof itemId === 'string' && itemId) return itemId;
  return `${text(kind)}:${text(owner)}:${shortHash(...stable)}`;
}

/** Makes ids unique inside one mapping: a repeat gets `-2`, `-3`, ... (the first keeps its id). */
export function uniqueIds(): (id: unknown) => string {
  const seen = new Map<string, number>();
  return (value) => {
    const id = text(value);
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    return n === 1 ? id : `${id}-${n}`;
  };
}

// ---------- one id per account and place of an interface ----------
// The observation (observe.js) and the store's unit mappers (map/) name a generation-1 account and a channel, guild or
// DM place of the same interface with the same id: the spelling the mappers write (`accountId`, `channelPlaceId`,
// `guildPlaceId`, `dmPlaceId`), so a unit write that brings a row the observation made lands on that row and a reopen
// replays no conflict. On the legacy interface that spelling is `legacyAccountIdOf` and `legacyPlaceOf`, whose stored
// bytes are frozen. Anything else (a thread, a later generation, the core's own authority) is a node id.

/** The interface of a native authority (`<iface>/global`, `<iface>/local`), or null for the core's and the legacy one. */
function ifaceOfAuthority(authority: unknown): string | null {
  const match = /^([^/]+)\/(?:global|local)$/.exec(text(authority ?? ''));
  const iface = match?.[1] ?? null;
  return iface === null || authority === CORE_AUTHORITY || authority === LEGACY_AUTHORITY ? null : iface;
}

/** The account id the observation and the unit mappers both give member `key` of `authority`. */
export function interfaceAccountId(authority: unknown, key: unknown, generation: unknown = 1): string {
  const gen = Number.isInteger(generation) ? generation : 1;
  const iface = ifaceOfAuthority(authority);
  if (gen === 1 && iface !== null && typeof key === 'string' && key !== '') return accountId(iface, key);
  return nodeId('account', [text(authority), text(key), gen]);
}

/** The place the observation and the unit mappers both give place key `key` (`channel:<id>`, ...) of `authority`. */
export function interfacePlaceOf(
  authority: unknown,
  key: unknown,
  generation: unknown = 1
): { id: string; native_id: string | null } {
  const gen = Number.isInteger(generation) ? generation : 1;
  const iface = ifaceOfAuthority(authority);
  const match = /^([a-z_]+):(.+)$/.exec(text(key ?? ''));
  const spell = match?.[1] ? LEGACY_PLACE_IDS[match[1]] : undefined;
  if (gen === 1 && iface !== null && match && spell)
    return { id: spell(iface, match[2] ?? ''), native_id: match[1] === 'dm' ? null : (match[2] ?? null) };
  return { id: nodeId('place', [text(authority), text(key), gen]), native_id: text(key) };
}
