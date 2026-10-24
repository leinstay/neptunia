// Deterministic ids for the memory database (spec section 2): the same input gives the same id, so a re-import
// writes the same rows. Pure, no I/O except `resolveAlias` and `survivorOf`, which read `external_keys` and
// `people_merges` on a connection they are given.
//
// Two families live here (schema v7, spec 2026-10-24-memory-schema-v7 sections 1.2 and 11.3):
//   - the legacy Discord-shaped ids (`person:discord:<id>`, `discord:<id>`, `discord:channel:<id>`, `src:discord:...`):
//     the importer's and the aliases' only; `nativeOf` and the helpers below that read them are the one place an id
//     is taken apart, and only for those legacy spellings;
//   - the new ids: `nodeId(kind, parts)` (`<kind>:<32 hex of SHA-256 over the canonical key>`) and `newPersonId()`
//     (`person:<uuid>`). A new id is a stable spelling, never parsed: the tuple it hashes is stored in columns.
// Schema v8 adds the relation target keys (`externalTargetKey`, `sourceTargetKey`) and `survivorOf` (merged people).
// Stage 8a adds the legacy spelling of an observed tuple (`legacyAccountIdOf`, `legacyPlaceOf`, `legacySourceIdOf`).

import { createHash, randomUUID } from 'node:crypto';

export const IFACE = 'discord';
export const SELF_PERSON = 'person:self';

const text = (value) => String(value);

export const personId = (userId) => `person:${IFACE}:${text(userId)}`;
export const accountId = (userId) => `${IFACE}:${text(userId)}`;
export const guildPlaceId = (guildId) => `${IFACE}:guild:${text(guildId)}`;
export const channelPlaceId = (channelId) => `${IFACE}:channel:${text(channelId)}`;
export const dmPlaceId = (userId) => `${IFACE}:dm:${text(userId)}`;

/** The native id inside a person, account or place id; null when the id has another shape. */
export function nativeOf(id) {
  const match = /^(?:person:discord:|discord:(?:guild:|channel:|dm:)?)(.+)$/.exec(String(id));
  return match ? match[1] : null;
}

/** The native authority of an interface: `discord/global` (snowflakes are one namespace), `<iface>/local` for the
 * command line and the core, `<iface>/global` for any other interface until it declares its own. */
export function nativeAuthorityOf(iface) {
  if (typeof iface !== 'string' || !iface) return CORE_AUTHORITY;
  if (iface === 'cli' || iface === 'core') return `${iface}/local`;
  return `${iface}/global`;
}
/** The core's own namespace (`person:self`, rows with no interface). */
export const CORE_AUTHORITY = 'core/local';
/** The namespace of the full legacy id spellings (every row id from before schema v7 is an alias here too). */
export const LEGACY_AUTHORITY = 'legacy/local';
/** The guild-local namespace of a Discord server (nicks, roles). */
export const guildAuthorityOf = (guildId, iface = IFACE) => `${iface}/guild:${text(guildId)}`;

/**
 * The DM place of a DM partner on an interface, from the legacy person spelling `person:<iface>:<native>`
 * (`discord:dm:<native>` today, the same id `dmPlaceId` gives); null for a person id of another shape (a new
 * `person:<uuid>` names its DM place explicitly).
 */
export function dmPlaceOfPerson(person, iface = IFACE) {
  const prefix = `person:${iface}:`;
  const value = String(person ?? '');
  if (!iface || !value.startsWith(prefix) || value.length <= prefix.length) return null;
  return `${iface}:dm:${value.slice(prefix.length)}`;
}

/** The interface and partner of a legacy DM place id (`<iface>:dm:<native>`): `{ iface, person, account }`, or null. */
export function dmPartnerOfPlace(placeId) {
  const match = /^([^:]+):dm:(.+)$/.exec(String(placeId ?? ''));
  return match ? { iface: match[1], person: `person:${match[1]}:${match[2]}`, account: `${match[1]}:${match[2]}` } : null;
}

/** The native key of a legacy person id (`person:<iface>:<native>`) on its interface: `{ iface, native }`, or null. */
export function legacyPersonNative(person) {
  const match = /^person:([^:]+):(.+)$/.exec(String(person ?? ''));
  return match ? { iface: match[1], native: match[2] } : null;
}

/** The native key of a legacy account id (`<iface>:<native>`), or null. */
export function legacyAccountNative(account, iface = IFACE) {
  const prefix = `${iface}:`;
  const value = String(account ?? '');
  return iface && value.startsWith(prefix) && value.length > prefix.length ? value.slice(prefix.length) : null;
}

/**
 * The native key of a place inside its authority: the place kind and the native id (`channel:<id>`, `guild:<id>`,
 * `dm:<partner native>`), so a guild and a channel that share a snowflake never collide.
 */
export function placeNativeKey(place) {
  const kind = typeof place?.kind === 'string' && place.kind ? place.kind : 'place';
  if (kind === 'dm') {
    const partner = dmPartnerOfPlace(place?.id);
    const native = place?.native_id ?? (partner ? legacyAccountNative(partner.account, partner.iface) : null);
    return native === null || native === undefined ? null : `dm:${native}`;
  }
  return place?.native_id === null || place?.native_id === undefined ? null : `${kind}:${place.native_id}`;
}

/** The deterministic id of an account's link to a person (one per pair; a later generation gets its own stage). */
export const linkId = (account, person) => `link:${text(account)}:${text(person)}`;

/**
 * The canonical key of a node tuple: JSON of the ordered array `[kind, ...parts]` (an absent part is null, an empty
 * one ""). A NUL anywhere is refused: it is never part of a native id.
 */
export function canonicalKey(kind, parts = []) {
  const values = [kind, ...(Array.isArray(parts) ? parts : [parts])].map((part) => (part === undefined ? null : part));
  for (const value of values) {
    if (typeof value === 'string' && value.includes('\u0000')) throw Object.assign(new Error('memory db: a NUL in a node key'), { code: 'NUL_IN_KEY' });
    if (value !== null && typeof value === 'object') throw Object.assign(new Error('memory db: a node key part must be a scalar'), { code: 'BAD_KEY_PART' });
  }
  return JSON.stringify(values);
}

/** A new node id: `<kind>:<first 32 hex of SHA-256 over canonicalKey(kind, parts)>`. Never parsed. */
export function nodeId(kind, parts = []) {
  return `${kind}:${createHash('sha256').update(canonicalKey(kind, parts)).digest('hex').slice(0, 32)}`;
}

/** A new person: `person:<uuid v4>` (`uuid` is injected by tests). */
export const newPersonId = (uuid = randomUUID) => `person:${uuid()}`;

/**
 * The node a native key of an authority named at `atIso` (an ISO time; null: the open rows, the current aliases).
 * A row's window is [valid_from_at, valid_to_at), an open end unbounded. Returns the node id when exactly one node's
 * window holds the time; `{ unresolved: true, candidates }` (the rows' `{ node_id, generation, valid_from_at,
 * valid_to_at }`) when several do or none does; null when the key was never registered. Never "the latest".
 */
export function resolveAlias(db, authority, kind, nativeKey, atIso = null) {
  const rows = db.prepare(
    'SELECT node_id, generation, valid_from_at, valid_to_at FROM external_keys WHERE authority_id = ? AND object_kind = ? AND native_key = ? ORDER BY generation',
  ).all(String(authority), String(kind), String(nativeKey)).map((row) => ({ ...row }));
  if (rows.length === 0) return null;
  const holds = (row) => (atIso === null || atIso === undefined
    ? row.valid_to_at === null
    : (row.valid_from_at === null || row.valid_from_at <= atIso) && (row.valid_to_at === null || atIso < row.valid_to_at));
  const matching = rows.filter(holds);
  const nodes = [...new Set(matching.map((row) => row.node_id))];
  if (nodes.length === 1) return nodes[0];
  return { unresolved: true, candidates: matching.length > 0 ? matching : rows };
}

/**
 * The person a person id stands for now: the final survivor of its merges (`people_merges`, from -> into, followed to
 * the end). A person never merged is itself. A loop (refused by the writer, never expected) stops at the first repeat.
 */
export function survivorOf(db, person) {
  const next = db.prepare('SELECT into_person FROM people_merges WHERE from_person = ?');
  const seen = new Set();
  let current = String(person);
  while (!seen.has(current)) {
    seen.add(current);
    const row = next.get(current);
    if (!row) return current;
    current = row.into_person;
  }
  return current;
}

/**
 * The interface's native kind of the objects its legacy record lines name (`message` for Discord: `sources.native_id`
 * is a message id); null for any other interface (an observation names its own kind).
 */
export const legacyNativeKind = (iface) => (iface === IFACE ? 'message' : null);

/**
 * The key of a relation's target named by its native tuple (schema v8, `source_relations.target_key`): JSON of the
 * ordered array `[authority, kind, native key, generation, revision]` (a revision not named is null: any revision).
 * The same spelling as `canonicalKey`, the same refusals. It never changes once written, whether or not the target
 * arrives later.
 */
export function externalTargetKey({ authority, kind, key, generation = 1, revision = null }) {
  return canonicalKey(String(authority), [String(kind), String(key), Number.isInteger(generation) ? generation : 1, Number.isInteger(revision) ? revision : null]);
}
/** The key of a relation's target named by our own source id: `source:<id>`. */
export const sourceTargetKey = (sourceId) => `source:${text(sourceId)}`;

// ---------- the legacy spelling of an observed tuple (stage 8a) ----------
// An observation of the interface the legacy importer reads (Discord) names the same accounts, places and lines the
// JSON files do. While the files are the writer, both must land on ONE row: the observed node takes the importer's
// spelling of its tuple, and the sync adopts the row when its file brings it (sync.js#writeRow). Only the tuples the
// importer itself writes have a legacy spelling; anything else (a thread, a later generation, another interface) is a
// new id (`nodeId`).

const LEGACY_AUTHORITY_OF_IFACE = `${IFACE}/global`;
/** Place kinds the importer writes under their own id spelling, and the spelling. */
const LEGACY_PLACE_IDS = { guild: guildPlaceId, channel: channelPlaceId, dm: dmPlaceId };

/** The importer's account id of a native key (`discord:<user id>`), or null when the tuple is not one it writes. */
export function legacyAccountIdOf(authority, key, generation = 1) {
  if (authority !== LEGACY_AUTHORITY_OF_IFACE || (generation ?? 1) !== 1 || typeof key !== 'string' || key === '') return null;
  return accountId(key);
}

/**
 * The importer's place of a native place key (`channel:<id>`, `dm:<user id>`, `guild:<id>`): `{ id, native_id }` as
 * the importer writes them (a DM place has no native id of its own), or null.
 */
export function legacyPlaceOf(authority, key, generation = 1) {
  if (authority !== LEGACY_AUTHORITY_OF_IFACE || (generation ?? 1) !== 1) return null;
  const match = /^([a-z_]+):(.+)$/.exec(String(key ?? ''));
  const spell = match ? LEGACY_PLACE_IDS[match[1]] : null;
  if (!spell) return null;
  return { id: spell(match[2]), native_id: match[1] === 'dm' ? null : match[2] };
}

/** The importer's source id of an observed line (`src:discord:<message id>:<revision>:<seen|said>`), or null. */
export function legacySourceIdOf({ authority, kind, key, generation = 1, revision, subtype }) {
  if (authority !== LEGACY_AUTHORITY_OF_IFACE || kind !== legacyNativeKind(IFACE) || (generation ?? 1) !== 1) return null;
  if (!Number.isInteger(revision) || revision < 1 || (subtype !== 'seen' && subtype !== 'said') || typeof key !== 'string' || key === '') return null;
  return messageSourceId(key, revision, subtype);
}

/** A message source: `src:discord:<messageId>:<revision>:<kind>`. */
export const messageSourceId = (messageId, revision, kind) => `src:${IFACE}:${text(messageId)}:${text(revision)}:${kind}`;
/** Her answer in a turn: `src:turn:<turnId>:<step>`. */
export const answerSourceId = (turnId, step) => `src:turn:${text(turnId)}:${text(step)}`;
/** Any other kind of source: `src:<kind>:<its id>`. */
export const otherSourceId = (kind, id) => `src:${kind}:${text(id)}`;

/** The first 16 hex digits of the SHA-1 of the parts joined by a NUL. */
export function shortHash(...parts) {
  return createHash('sha1').update(parts.map((part) => text(part)).join('\u0000')).digest('hex').slice(0, 16);
}

/** A claim, episode or description id: the old `itemId` when the item had one, else `<kind>:<owner>:<hash of stable fields>`. */
export function itemOrDerivedId(itemId, kind, owner, ...stable) {
  if (typeof itemId === 'string' && itemId) return itemId;
  return `${kind}:${text(owner)}:${shortHash(...stable)}`;
}

/** Makes ids unique inside one mapping: a repeat gets `-2`, `-3`, ... (the first keeps its id). */
export function uniqueIds() {
  const seen = new Map();
  return (id) => {
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    return n === 1 ? id : `${id}-${n}`;
  };
}
