// The observation envelope and foreign capture (spec 2026-10-24-memory-schema-v7, sections 1.3, 1.4 and 4; section 11
// items 1, 3, 8 override them). An interface adapter says what it saw as one plain object, versioned
// (`OBSERVATION_VERSION`); the core resolves everything else itself, so a new interface is an adapter, not a schema.
//
//   { v, iface, authority, connection?, native: { kind, key, generation?, revision, subtype? },
//     place: { authority, key, kind, conversation: 'dm' | 'group' | undefined, parent?, title?, partner? },
//     author: { kind: 'account' | 'participant' | 'self', authority?, key?, token_kind?, scope_place?, display?, generation? },
//     occurredAt, observedAt, text, media?, relations?: [{ predicate, target }], capture?: { bundle?, role, reason?, coverage? },
//     extra? }
//
// observe(handle, envelope) checks the envelope, then in ONE transaction resolves or creates the authority, the place,
// the account or participant (never a person: promotion is her session's `people:add`), writes the source with its
// audience (the place's conversation: `group` -> `aud:group:<iface>`, `dm` -> `aud:dm:<place>`, anything else ->
// `aud:internal`), its relations and its bundle membership. Idempotent on the native tuple: the source id is the hash of
// (authority, native kind, key, generation, revision, subtype), and a replay writes nothing. A malformed envelope is
// refused with a code (`{ ok: false, code }`) and writes nothing; a refusal found while writing rolls the whole
// transaction back. Native keys are aliases in `external_keys` (one resolver, ids.js#resolveAlias, at the event time).
//
// Participants (section 1.3): a per-thread token is a participant of that thread (`thread_token`, the thread required);
// a site-scoped token that is not an identity is `site_token`; a bare post number is `post_number` and a display name
// or no token at all is keyed by the observation: one participant per post, never linked to the next. A site-wide stable
// id is an account of the site's authority (author kind `account`), with no person. A token the site reset is a new
// generation (`author.generation`), so the same token string is a new participant.
//
// Capture (section 11.1): a bundle is the context stored around an anchor line in a place the connection does not read
// continuously. The defaults (`capture.ancestors`, `before`, `after`) are the first fetch only, never a ceiling; growth
// is append-only (`capture_events`, one per step, with the coverage after it), members are never removed, a source may
// hold several roles. `capture.pageLines` only pages one expansion: what did not fit is handed back and the coverage
// says `pending_expansion`; no function here declares a bundle sufficient because of a number. Watches (15 min, 2 h,
// 24 h after the anchor by default) are rows the caller runs and closes.
//
// Schema v9: every account, place, participant and source an observation writes is projected into the graph in the same
// transaction (graph.js#projectRow).
//
// Not wired to a live adapter yet: the Discord sync keeps its mappers. Logs carry codes only (`log.debug?.()`).

import { log as engineLog } from '../../log.js';
import { canonicalKey, nodeId, resolveAlias } from './ids.js';
import { addKey, addRelation, deriveRow, ensureAuthority, ensureInterface, resolveRelationsTo } from './rows.js';
import { AUD_INTERNAL, SCOPE_INTERNAL, dmAudienceId, groupAudienceId, groupScope } from './scope.js';
import {
  CAPTURE_REASONS, CAPTURE_ROLES, COVERAGE_STATES, PARTICIPANT_TOKEN_KINDS, RELATION_PREDICATES, WATCH_OUTCOMES,
} from './schema.js';
import { markStemsPending } from './stems.js';
import { projectRow } from './graph.js';

/** The version of the envelope this module reads. */
export const OBSERVATION_VERSION = 1;
/** The capture policy bundles are opened under (a change of the rules bumps it). */
export const CAPTURE_POLICY_VERSION = 1;
/** Place kinds an envelope may name (spec 1.4; `guild` is the legacy Discord server). */
export const PLACE_KINDS = Object.freeze([
  'server', 'workspace', 'category', 'channel', 'room', 'thread', 'dm', 'group_dm', 'wall', 'community', 'board', 'discussion',
  'mailbox', 'local_console', 'guild',
]);
const AUTHOR_KINDS = ['account', 'participant', 'self'];
const TOKENED = new Set(['thread_token', 'site_token', 'post_number']);

const CAPTURE_DEFAULTS = Object.freeze({ ancestors: 2, before: 3, after: 3, pageLines: 60, watch: Object.freeze([15, 120, 1440]), watchSameAuthor: 20 });

/** Refusal codes (a refusal writes nothing). */
export const OBSERVE_CODES = Object.freeze({
  BAD_ENVELOPE: 'BAD_ENVELOPE', BAD_VERSION: 'BAD_VERSION', BAD_IFACE: 'BAD_IFACE', BAD_AUTHORITY: 'BAD_AUTHORITY',
  BAD_NATIVE: 'BAD_NATIVE', BAD_PLACE: 'BAD_PLACE', BAD_AUTHOR: 'BAD_AUTHOR', BAD_TIME: 'BAD_TIME', BAD_TEXT: 'BAD_TEXT',
  BAD_MEDIA: 'BAD_MEDIA', BAD_RELATION: 'BAD_RELATION', BAD_CAPTURE: 'BAD_CAPTURE', BAD_COVERAGE: 'BAD_COVERAGE',
  BAD_EXTRA: 'BAD_EXTRA', BAD_CONNECTION: 'BAD_CONNECTION', BAD_ROLE: 'BAD_ROLE', BAD_REASON: 'BAD_REASON',
  BAD_KIND: 'BAD_KIND', BAD_WATCH: 'BAD_WATCH', BAD_OUTCOME: 'BAD_OUTCOME', UNKNOWN_BUNDLE: 'UNKNOWN_BUNDLE',
  UNKNOWN_SOURCE: 'UNKNOWN_SOURCE', UNKNOWN_PLACE: 'UNKNOWN_PLACE', UNKNOWN_WATCH: 'UNKNOWN_WATCH',
  UNKNOWN_SCOPE_PLACE: 'UNKNOWN_SCOPE_PLACE', AMBIGUOUS_ALIAS: 'AMBIGUOUS_ALIAS', CONVERSATION_CONFLICT: 'CONVERSATION_CONFLICT',
  KEY_COLLISION: 'KEY_COLLISION', AUDIENCE_CONFLICT: 'AUDIENCE_CONFLICT', AUTHOR_COMBINATION: 'AUTHOR_COMBINATION',
  NUL_IN_KEY: 'NUL_IN_KEY', BAD_KEY_PART: 'BAD_KEY_PART',
});
const REFUSALS = new Set(Object.values(OBSERVE_CODES));

const refusal = (code) => Object.assign(new Error(`memory observe: ${code}`), { code });
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const filled = (value) => typeof value === 'string' && value !== '';
const isoOk = (value) => filled(value) && Number.isFinite(Date.parse(value));
const optInt = (value, min) => value === undefined || value === null || (Number.isInteger(value) && value >= min);
const json = (value) => JSON.stringify(value);
const toIso = (ms) => new Date(ms).toISOString();
const dbOf = (handle) => handle?.db ?? handle;

/** Runs `fn` in the handle's transaction; a refusal becomes `{ ok: false, code }` (logged with its code only). */
function guarded(handle, fn, log) {
  try {
    return handle.transaction(fn);
  } catch (error) {
    if (REFUSALS.has(error?.code)) {
      log?.debug?.('memory observe: refused', { code: error.code });
      return { ok: false, code: error.code };
    }
    throw error;
  }
}

// ---------- settings ----------

const nonNeg = (value, fallback) => (Number.isInteger(value) && value >= 0 ? value : fallback);
const posInt = (value, fallback) => (Number.isInteger(value) && value > 0 ? value : fallback);

/**
 * The capture settings of this moment (`capture` in the live config): the first fetch (`ancestors`, `before`,
 * `after`), the page size of one expansion (`pageLines`), the watch offsets in minutes after the anchor (`watch`) and
 * how many later lines of a witnessed author a watch may ask for (`watchSameAuthor`).
 */
export function captureSettings(config) {
  const given = isObject(config?.capture) ? config.capture : {};
  const watch = Array.isArray(given.watch) && given.watch.length > 0 && given.watch.every((m) => Number.isInteger(m) && m > 0) ? [...given.watch] : [...CAPTURE_DEFAULTS.watch];
  return {
    ancestors: nonNeg(given.ancestors, CAPTURE_DEFAULTS.ancestors),
    before: nonNeg(given.before, CAPTURE_DEFAULTS.before),
    after: nonNeg(given.after, CAPTURE_DEFAULTS.after),
    pageLines: posInt(given.pageLines, CAPTURE_DEFAULTS.pageLines),
    watch,
    watchSameAuthor: posInt(given.watchSameAuthor, CAPTURE_DEFAULTS.watchSameAuthor),
  };
}

// ---------- validation ----------

const authorityOk = (iface, authority) => filled(authority) && authority.startsWith(`${iface}/`) && authority.length > iface.length + 1;
/** Whether a coverage object is one the database stores: an object whose `state` is one of the four. */
export const coverageOk = (coverage) => isObject(coverage) && COVERAGE_STATES.includes(coverage.state);

function targetOk(iface, target) {
  if (!isObject(target)) return false;
  if (target.source !== undefined) return filled(target.source);
  return filled(target.kind) && filled(target.key) && (target.authority === undefined || authorityOk(iface, target.authority))
    && optInt(target.generation, 1) && optInt(target.revision, 0);
}

/** The refusal code of an envelope, or null when it can be written. Pure. */
export function checkEnvelope(envelope) {
  const C = OBSERVE_CODES;
  if (!isObject(envelope)) return C.BAD_ENVELOPE;
  const e = envelope;
  if (e.v !== OBSERVATION_VERSION) return C.BAD_VERSION;
  if (!filled(e.iface) || e.iface.includes('/')) return C.BAD_IFACE;
  if (!authorityOk(e.iface, e.authority)) return C.BAD_AUTHORITY;
  if (e.connection !== undefined && e.connection !== null && !filled(e.connection)) return C.BAD_CONNECTION;
  const n = e.native;
  if (!isObject(n) || !filled(n.kind) || !filled(n.key) || !optInt(n.generation, 1) || !Number.isInteger(n.revision) || n.revision < 0
    || (n.subtype !== undefined && n.subtype !== null && !filled(n.subtype))) return C.BAD_NATIVE;
  const p = e.place;
  if (!isObject(p) || !authorityOk(e.iface, p.authority) || !filled(p.key) || !PLACE_KINDS.includes(p.kind)) return C.BAD_PLACE;
  if ((p.parent !== undefined && p.parent !== null && !filled(p.parent)) || (p.title !== undefined && p.title !== null && typeof p.title !== 'string')) return C.BAD_PLACE;
  if (p.partner !== undefined && p.partner !== null
    && (!isObject(p.partner) || !filled(p.partner.key) || (p.partner.authority !== undefined && !authorityOk(e.iface, p.partner.authority)))) return C.BAD_PLACE;
  const a = e.author;
  if (!isObject(a) || !AUTHOR_KINDS.includes(a.kind)) return C.BAD_AUTHOR;
  if (a.authority !== undefined && a.authority !== null && !authorityOk(e.iface, a.authority)) return C.BAD_AUTHOR;
  if (a.display !== undefined && a.display !== null && typeof a.display !== 'string') return C.BAD_AUTHOR;
  if (!optInt(a.generation, 1)) return C.BAD_AUTHOR;
  if (a.kind === 'account' && !filled(a.key)) return C.BAD_AUTHOR;
  if (a.kind === 'self' && a.key !== undefined && a.key !== null && !filled(a.key)) return C.BAD_AUTHOR;
  if (a.kind === 'participant') {
    if (!PARTICIPANT_TOKEN_KINDS.includes(a.token_kind)) return C.BAD_AUTHOR;
    if (TOKENED.has(a.token_kind) && !filled(a.key)) return C.BAD_AUTHOR;
    if (a.scope_place !== undefined && a.scope_place !== null && (!filled(a.scope_place) || a.token_kind === 'site_token')) return C.BAD_AUTHOR;
  }
  if (!isoOk(e.occurredAt) || !isoOk(e.observedAt)) return C.BAD_TIME;
  if (typeof e.text !== 'string') return C.BAD_TEXT;
  if (e.media !== undefined && e.media !== null && !Array.isArray(e.media)) return C.BAD_MEDIA;
  if (e.relations !== undefined && e.relations !== null) {
    if (!Array.isArray(e.relations)) return C.BAD_RELATION;
    for (const relation of e.relations) {
      if (!isObject(relation) || !RELATION_PREDICATES.includes(relation.predicate) || !targetOk(e.iface, relation.target)) return C.BAD_RELATION;
    }
  }
  if (e.capture !== undefined && e.capture !== null) {
    const c = e.capture;
    if (!isObject(c) || !CAPTURE_ROLES.includes(c.role)) return C.BAD_CAPTURE;
    if (c.bundle !== undefined && c.bundle !== null && !filled(c.bundle)) return C.BAD_CAPTURE;
    if (c.coverage !== undefined && c.coverage !== null && !coverageOk(c.coverage)) return C.BAD_COVERAGE;
    if (!filled(c.bundle)) {
      // No bundle yet: this line opens one, as its anchor, with a reason and the coverage of the first fetch.
      if (c.role !== 'anchor' || !CAPTURE_REASONS.includes(c.reason)) return C.BAD_CAPTURE;
      if (!coverageOk(c.coverage)) return C.BAD_COVERAGE;
    }
  }
  if (e.extra !== undefined && e.extra !== null && !isObject(e.extra)) return C.BAD_EXTRA;
  return null;
}

// ---------- resolution ----------

/**
 * The node a native key names: the exact generation when one is given, else the alias that holds at the event time
 * (ids.js#resolveAlias). Null when the key was never registered; an ambiguous alias is a refusal, never "the latest".
 */
function nodeOf(db, authority, kind, key, generation, atIso) {
  if (Number.isInteger(generation)) {
    return db.prepare('SELECT node_id FROM external_keys WHERE authority_id = ? AND object_kind = ? AND native_key = ? AND generation = ?')
      .get(authority, kind, key, generation)?.node_id ?? null;
  }
  const found = resolveAlias(db, authority, kind, key, atIso);
  if (found !== null && typeof found === 'object') throw refusal(OBSERVE_CODES.AMBIGUOUS_ALIAS);
  return found;
}

function insertRow(db, table, row) {
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO "${table}" (${cols.map((col) => `"${col}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...cols.map((col) => (row[col] === undefined ? null : row[col])));
}

/** The account of a native key, created (with no person) when missing. Returns `{ id, person_id }`. */
function accountOf(db, iface, { authority, key, display = null, generation = null, kind = 'user' }, atIso, at) {
  const found = nodeOf(db, authority, 'account', String(key), generation, atIso);
  if (found) {
    const row = db.prepare('SELECT id, person_id FROM accounts WHERE id = ?').get(found);
    if (row) return { id: row.id, person_id: row.person_id ?? null };
  }
  const gen = Number.isInteger(generation) ? generation : 1;
  const id = found ?? nodeId('account', [authority, String(key), gen]);
  const row = deriveRow(db, 'accounts', {
    id, iface, native_id: String(key), person_id: null, link: null, names: filled(display) ? json([display]) : null,
    authority_id: authority, native_key: String(key), generation: gen, kind, owner_file: null,
  }, { at });
  insertRow(db, 'accounts', row);
  addKey(db, authority, 'account', String(key), id, { generation: gen, at });
  projectRow(db, 'accounts', { id }, { at });
  return { id, person_id: null };
}

/** The place of an envelope, created when missing; its conversation filled or checked. Returns its row. */
function placeOf(db, envelope, at) {
  const p = envelope.place;
  const declared = p.conversation === 'dm' || p.conversation === 'group' ? p.conversation : null;
  const id = nodeOf(db, p.authority, 'place', p.key, null, envelope.occurredAt);
  const existing = id ? db.prepare('SELECT id, conversation, partner_person, name, seen_from_at, seen_to_at FROM places WHERE id = ?').get(id) : null;
  if (existing) {
    if (declared && existing.conversation && existing.conversation !== declared) throw refusal(OBSERVE_CODES.CONVERSATION_CONFLICT);
    const conversation = existing.conversation ?? declared;
    const from = existing.seen_from_at && existing.seen_from_at <= envelope.occurredAt ? existing.seen_from_at : envelope.occurredAt;
    const to = existing.seen_to_at && existing.seen_to_at >= envelope.occurredAt ? existing.seen_to_at : envelope.occurredAt;
    if (conversation !== existing.conversation || from !== existing.seen_from_at || to !== existing.seen_to_at) {
      db.prepare('UPDATE places SET conversation = ?, scope_kind = COALESCE(scope_kind, ?), seen_from_at = ?, seen_to_at = ? WHERE id = ?').run(conversation, conversation, from, to, existing.id);
      projectRow(db, 'places', { id: existing.id }, { at });
    }
    return { id: existing.id, conversation, partner_person: existing.partner_person ?? null };
  }
  let partner = null;
  if (declared === 'dm' && isObject(p.partner)) {
    partner = accountOf(db, envelope.iface, { authority: p.partner.authority ?? envelope.authority, key: p.partner.key, display: p.partner.display ?? null }, envelope.occurredAt, at);
  }
  const parent = filled(p.parent) ? nodeOf(db, p.authority, 'place', p.parent, null, envelope.occurredAt) : null;
  const placeId = nodeId('place', [p.authority, p.key, 1]);
  const row = deriveRow(db, 'places', {
    id: placeId, iface: envelope.iface, kind: p.kind, native_id: p.key, parent_id: parent, scope_kind: declared, name: filled(p.title) ? p.title : null,
    authority_id: p.authority, native_key: p.key, generation: 1, conversation: declared,
    partner_person: partner?.person_id ?? null, partner_account: partner?.id ?? null,
    seen_from_at: envelope.occurredAt, seen_to_at: envelope.occurredAt,
    extra: filled(p.parent) && !parent ? json({ parent: p.parent }) : null, owner_file: null,
  }, { at });
  insertRow(db, 'places', row);
  addKey(db, p.authority, 'place', p.key, placeId, { generation: 1, at });
  projectRow(db, 'places', { id: placeId }, { at });
  return { id: placeId, conversation: declared, partner_person: row.partner_person };
}

/** The observation key of a post (its native identity without the revision): what a weak token is keyed by. */
const observationKeyOf = (envelope) => canonicalKey('observation', [envelope.authority, envelope.native.kind, envelope.native.key, envelope.native.generation ?? 1]);

/** The participant of an envelope's author, created when missing. Returns its id. */
function participantOf(db, envelope, place, at) {
  const a = envelope.author;
  const authority = a.authority ?? envelope.authority;
  let scope = place.id;
  if (a.token_kind === 'site_token') scope = null;
  else if (filled(a.scope_place)) {
    scope = nodeOf(db, envelope.place.authority, 'place', a.scope_place, null, envelope.occurredAt);
    if (!scope) throw refusal(OBSERVE_CODES.UNKNOWN_SCOPE_PLACE);
  }
  const token = TOKENED.has(a.token_kind) ? String(a.key) : null;
  const observation = token === null ? observationKeyOf(envelope) : null;
  const generation = Number.isInteger(a.generation) ? a.generation : 1;
  const id = nodeId('participant', [authority, scope, a.token_kind, token ?? observation, generation]);
  const existing = db.prepare('SELECT authority_id, scope_place_id, token_kind, native_token, observation_key, generation, last_seen_at FROM participants WHERE id = ?').get(id);
  if (existing) {
    const same = existing.authority_id === authority && (existing.scope_place_id ?? null) === scope && existing.token_kind === a.token_kind
      && (existing.native_token ?? null) === token && (existing.observation_key ?? null) === observation && existing.generation === generation;
    if (!same) throw refusal(OBSERVE_CODES.KEY_COLLISION);
    if (!existing.last_seen_at || existing.last_seen_at < envelope.occurredAt) db.prepare('UPDATE participants SET last_seen_at = ? WHERE id = ?').run(envelope.occurredAt, id);
    return id;
  }
  insertRow(db, 'participants', {
    id, authority_id: authority, scope_place_id: scope, token_kind: a.token_kind, native_token: token, observation_key: observation, generation,
    continuity: TOKENED.has(a.token_kind) && a.token_kind !== 'post_number' ? 'provider_asserted' : 'unknown',
    display: filled(a.display) ? a.display : null, first_seen_at: envelope.occurredAt, last_seen_at: envelope.occurredAt, extra: null, recorded_at: at,
  });
  addKey(db, authority, 'participant', canonicalKey(a.token_kind, [scope, token ?? observation]), id, { generation, at });
  projectRow(db, 'participants', { id }, { at });
  return id;
}

/** The author columns of an envelope: `{ kind, account, participant }`. */
function authorOf(db, envelope, place, at) {
  const a = envelope.author;
  const authority = a.authority ?? envelope.authority;
  const generation = Number.isInteger(a.generation) ? a.generation : null;
  if (a.kind === 'account') {
    return { kind: 'account', account: accountOf(db, envelope.iface, { authority, key: a.key, display: a.display ?? null, generation }, envelope.occurredAt, at).id, participant: null };
  }
  if (a.kind === 'participant') return { kind: 'participant', account: null, participant: participantOf(db, envelope, place, at) };
  const account = filled(a.key) ? accountOf(db, envelope.iface, { authority, key: a.key, display: a.display ?? null, generation, kind: 'self' }, envelope.occurredAt, at).id : null;
  return { kind: 'self', account, participant: null };
}

/** The scope triple and audience of a line in a place: the place's conversation, else internal (fail closed). */
function audienceOfPlace(iface, place) {
  if (place.conversation === 'group') return { scope: groupScope(iface), audience: groupAudienceId(iface) };
  if (place.conversation === 'dm') return { scope: { scope_kind: 'dm', scope_iface: iface, scope_dm: place.partner_person ?? null }, audience: dmAudienceId(place.id) };
  return { scope: { ...SCOPE_INTERNAL }, audience: AUD_INTERNAL };
}

/** The source id of an envelope's native tuple. */
export function observedSourceId(envelope) {
  const n = envelope.native;
  return nodeId('source', [envelope.authority, n.kind, n.key, n.generation ?? 1, n.revision, n.subtype ?? null]);
}

function writeObservation(db, envelope, at, log) {
  const e = envelope;
  const n = e.native;
  const sourceId = observedSourceId(e);
  if (db.prepare('SELECT 1 AS ok FROM sources WHERE id = ?').get(sourceId)) return { ok: true, replayed: true, sourceId, written: 0 };
  ensureInterface(db, e.iface);
  const authorities = new Set([e.authority, e.place.authority, e.author.authority, e.place.partner?.authority, ...(e.relations ?? []).map((r) => r.target?.authority)]);
  for (const authority of authorities) if (filled(authority)) ensureAuthority(db, authority, e.iface, authority.slice(e.iface.length + 1));
  const connection = filled(e.connection) ? e.connection : null;
  if (connection) {
    const known = db.prepare('SELECT iface FROM connections WHERE id = ?').get(connection);
    if (known && known.iface !== e.iface) throw refusal(OBSERVE_CODES.BAD_CONNECTION);
    if (!known) db.prepare('INSERT INTO connections (id, iface, authority_id) VALUES (?, ?, ?)').run(connection, e.iface, e.authority);
  }
  const place = placeOf(db, e, at);
  const author = authorOf(db, e, place, at);
  const { scope, audience } = audienceOfPlace(e.iface, place);
  const extra = {};
  if (n.subtype) extra.subtype = n.subtype;
  if (e.author.kind === 'participant' && filled(e.author.display)) extra.display = e.author.display;
  if (isObject(e.extra) && Object.keys(e.extra).length > 0) extra.extra = e.extra;
  const row = deriveRow(db, 'sources', {
    id: sourceId, kind: author.kind === 'self' ? 'said' : 'seen', iface: e.iface, native_id: n.key, native_kind: n.kind, generation: n.generation ?? 1,
    revision: n.revision, place_id: place.id, author_account: author.account, author_participant: author.participant, author_kind: author.kind,
    reply_to: null, occurred_at: e.occurredAt, recorded_at: e.observedAt, seen_at: author.kind === 'self' ? null : e.observedAt, observed_at: e.observedAt,
    text: e.text, media: Array.isArray(e.media) && e.media.length > 0 ? json(e.media) : null, mentions: null, direct: 0, connection_id: connection,
    authority_id: e.authority, ...scope, audience_id: audience, origin: 'observation',
    extra: Object.keys(extra).length > 0 ? json(extra) : null, owner_file: null, position: null,
  }, { at, log });
  if (row.audience_id !== audience) throw refusal(OBSERVE_CODES.AUDIENCE_CONFLICT);
  insertRow(db, 'sources', row);
  addKey(db, e.authority, 'source', canonicalKey(n.kind, [n.key, n.revision, n.subtype ?? null]), sourceId, { generation: n.generation ?? 1, at });
  let relations = 0;
  for (const relation of e.relations ?? []) {
    const target = relation.target.source !== undefined ? { source: relation.target.source } : { authority: e.authority, ...relation.target };
    relations += addRelation(db, sourceId, relation.predicate, target, { at });
  }
  const resolved = resolveRelationsTo(db, row, { at });
  projectRow(db, 'sources', { id: sourceId }, { at });
  let bundleId = null;
  if (isObject(e.capture)) {
    const c = e.capture;
    if (filled(c.bundle)) {
      bundleId = c.bundle;
      if (!db.prepare('SELECT 1 AS ok FROM capture_bundles WHERE id = ?').get(bundleId)) throw refusal(OBSERVE_CODES.UNKNOWN_BUNDLE);
      const added = addMember(db, bundleId, sourceId, c.role, at);
      if (coverageOk(c.coverage)) appendEvent(db, bundleId, c.role === 'watch' ? 'watch' : 'expansion', c.coverage, added, at);
    } else {
      bundleId = openIn(db, { anchor: sourceId, place: place.id, reason: c.reason, coverage: c.coverage, connection, at }).bundleId;
    }
  }
  markStemsPending(db);
  return { ok: true, replayed: false, sourceId, placeId: place.id, author, audienceId: audience, relations, resolved, bundleId, written: 1 };
}

/**
 * Writes one observation (see the head of this file). Returns `{ ok: true, replayed, sourceId, placeId, author,
 * audienceId, relations, resolved, bundleId, written }` or `{ ok: false, code }` (nothing written).
 * @param {{ db: object, transaction: (fn: () => any) => any }} handle  an `openMemoryDb` handle (the writer)
 * @param {object} envelope
 * @param {{ now?: () => number, log?: object }} [opts]
 */
export function observe(handle, envelope, { now = Date.now, log = engineLog } = {}) {
  const code = checkEnvelope(envelope);
  if (code) {
    log?.debug?.('memory observe: refused', { code });
    return { ok: false, code };
  }
  return guarded(handle, () => writeObservation(handle.db, envelope, toIso(now()), log), log);
}

// ---------- capture ----------

/** A bundle's id: one per anchor and reason, so a second opening finds the first. */
export const bundleIdOf = (anchor, reason) => nodeId('bundle', [String(anchor), String(reason)]);

function addMember(db, bundleId, sourceId, role, at) {
  if (!CAPTURE_ROLES.includes(role)) throw refusal(OBSERVE_CODES.BAD_ROLE);
  if (!db.prepare('SELECT 1 AS ok FROM sources WHERE id = ?').get(sourceId)) throw refusal(OBSERVE_CODES.UNKNOWN_SOURCE);
  return Number(db.prepare('INSERT OR IGNORE INTO capture_members (bundle_id, source_id, role, added_at) VALUES (?, ?, ?, ?)').run(bundleId, sourceId, role, at).changes);
}

function appendEvent(db, bundleId, kind, coverage, added, at) {
  const done = db.prepare('INSERT INTO capture_events (bundle_id, at, kind, coverage, added) VALUES (?, ?, ?, ?, ?)').run(bundleId, at, kind, json(coverage), added);
  db.prepare('UPDATE capture_bundles SET coverage = ? WHERE id = ?').run(json(coverage), bundleId);
  return Number(done.lastInsertRowid);
}

function openIn(db, { anchor, place = null, reason, coverage, connection = null, at }) {
  if (!CAPTURE_REASONS.includes(reason)) throw refusal(OBSERVE_CODES.BAD_REASON);
  if (!coverageOk(coverage)) throw refusal(OBSERVE_CODES.BAD_COVERAGE);
  const source = filled(anchor) ? db.prepare('SELECT id, place_id FROM sources WHERE id = ?').get(anchor) : null;
  if (!source) throw refusal(OBSERVE_CODES.UNKNOWN_SOURCE);
  const placeId = filled(place) ? place : source.place_id;
  if (!filled(placeId) || !db.prepare('SELECT 1 AS ok FROM places WHERE id = ?').get(placeId)) throw refusal(OBSERVE_CODES.UNKNOWN_PLACE);
  const id = bundleIdOf(anchor, reason);
  if (db.prepare('SELECT 1 AS ok FROM capture_bundles WHERE id = ?').get(id)) return { ok: true, bundleId: id, created: false };
  db.prepare('INSERT INTO capture_bundles (id, anchor_source_id, place_id, reason, policy_version, coverage, created_at, connection_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, anchor, placeId, reason, CAPTURE_POLICY_VERSION, json(coverage), at, connection);
  const added = addMember(db, id, anchor, 'anchor', at);
  const event = appendEvent(db, id, 'initial', coverage, added, at);
  return { ok: true, bundleId: id, created: true, event };
}

/**
 * Opens the bundle of an anchor line (already a stored source): the bundle row, the anchor as its first member and the
 * `initial` event. A second opening for the same anchor and reason writes nothing and returns the first bundle.
 * @param {object} handle
 * @param {{ anchor: string, place?: string, reason: string, coverage: object, connection?: string, now?: () => number, log?: object }} spec
 * @returns {{ ok: true, bundleId: string, created: boolean, event?: number } | { ok: false, code: string }}
 */
export function openBundle(handle, { anchor, place = null, reason, coverage, connection = null, now = Date.now, log = engineLog } = {}) {
  return guarded(handle, () => openIn(handle.db, { anchor, place, reason, coverage, connection, at: toIso(now()) }), log);
}

/**
 * Grows a bundle by one step: the given sources (stored lines, each `{ id, role }`) become members and one event
 * (`expansion` or `watch`) records the coverage after the step. Nothing is ever removed. At most `capture.pageLines`
 * sources are written per call; the rest are handed back (`rest`) and the recorded coverage then says
 * `pending_expansion`, whatever the caller claimed: a page boundary is never sufficiency.
 * @param {object} handle
 * @param {string} bundleId
 * @param {{ sources: Array<{ id: string, role: string }>, coverage: object, kind?: 'expansion'|'watch', config?: object, now?: () => number, log?: object }} spec
 * @returns {{ ok: true, added: number, event: number, rest: object[], coverage: object } | { ok: false, code: string }}
 */
export function expandBundle(handle, bundleId, { sources = [], coverage, kind = 'expansion', config = null, now = Date.now, log = engineLog } = {}) {
  if (kind !== 'expansion' && kind !== 'watch') return { ok: false, code: OBSERVE_CODES.BAD_KIND };
  if (!coverageOk(coverage)) return { ok: false, code: OBSERVE_CODES.BAD_COVERAGE };
  if (!Array.isArray(sources) || !sources.every((entry) => isObject(entry) && filled(entry.id))) return { ok: false, code: OBSERVE_CODES.UNKNOWN_SOURCE };
  const { pageLines } = captureSettings(config);
  const page = sources.slice(0, pageLines);
  const rest = sources.slice(pageLines);
  const after = rest.length > 0 ? { ...coverage, state: 'pending_expansion' } : coverage;
  return guarded(handle, () => {
    const { db } = handle;
    const at = toIso(now());
    if (!db.prepare('SELECT 1 AS ok FROM capture_bundles WHERE id = ?').get(bundleId)) throw refusal(OBSERVE_CODES.UNKNOWN_BUNDLE);
    let added = 0;
    for (const entry of page) added += addMember(db, bundleId, entry.id, entry.role, at);
    const event = appendEvent(db, bundleId, kind, after, added, at);
    return { ok: true, added, event, rest, coverage: after };
  }, log);
}

/**
 * Schedules the watches of a bundle: one per offset in minutes after its anchor line (`capture.watch` by default),
 * `watch:<bundle>:<minutes>`, each scheduled once.
 * @returns {{ ok: true, scheduled: number, ids: string[] } | { ok: false, code: string }}
 */
export function scheduleWatches(handle, bundleId, minutesList = null, { config = null, log = engineLog } = {}) {
  const minutes = minutesList ?? captureSettings(config).watch;
  if (!Array.isArray(minutes) || minutes.length === 0 || !minutes.every((m) => Number.isInteger(m) && m > 0)) return { ok: false, code: OBSERVE_CODES.BAD_WATCH };
  return guarded(handle, () => {
    const { db } = handle;
    const bundle = db.prepare('SELECT b.created_at AS created_at, s.occurred_at AS occurred_at FROM capture_bundles b JOIN sources s ON s.id = b.anchor_source_id WHERE b.id = ?').get(bundleId);
    if (!bundle) throw refusal(OBSERVE_CODES.UNKNOWN_BUNDLE);
    const base = Number.isFinite(Date.parse(bundle.occurred_at)) ? Date.parse(bundle.occurred_at) : Date.parse(bundle.created_at);
    const ids = [];
    let scheduled = 0;
    for (const m of [...new Set(minutes)]) {
      const id = `watch:${bundleId}:${m}`;
      ids.push(id);
      scheduled += Number(db.prepare('INSERT OR IGNORE INTO capture_watches (id, bundle_id, due_at, done_at, outcome, extra) VALUES (?, ?, ?, NULL, NULL, ?)')
        .run(id, bundleId, toIso(base + m * 60_000), json({ minutes: m })).changes);
    }
    return { ok: true, scheduled, ids };
  }, log);
}

/**
 * The watches due at `now` (ms) and not done, oldest first: `[{ id, bundleId, dueAt, anchor, place, sameAuthorMax }]`
 * (`sameAuthorMax`: `capture.watchSameAuthor`, how many later lines of a witnessed author the watch may fetch).
 */
export function dueWatches(handle, now, { config = null, limit = 100 } = {}) {
  const db = dbOf(handle);
  const { watchSameAuthor } = captureSettings(config);
  return db.prepare(`SELECT w.id AS id, w.bundle_id AS bundle_id, w.due_at AS due_at, b.anchor_source_id AS anchor, b.place_id AS place
      FROM capture_watches w JOIN capture_bundles b ON b.id = w.bundle_id WHERE w.done_at IS NULL AND w.due_at <= ? ORDER BY w.due_at, w.id LIMIT ?`)
    .all(toIso(now), Number.isInteger(limit) && limit > 0 ? limit : 100)
    .map((row) => ({ id: row.id, bundleId: row.bundle_id, dueAt: row.due_at, anchor: row.anchor, place: row.place, sameAuthorMax: watchSameAuthor }));
}

/**
 * Closes a watch with its outcome (`fetched`, `nothing_new`, `unavailable`: a watch that could not run says so).
 * A watch already closed is left as it is (`written: 0`).
 * @returns {{ ok: true, written: number } | { ok: false, code: string }}
 */
export function finishWatch(handle, id, outcome, { now = Date.now, log = engineLog } = {}) {
  if (!WATCH_OUTCOMES.includes(outcome)) return { ok: false, code: OBSERVE_CODES.BAD_OUTCOME };
  return guarded(handle, () => {
    const { db } = handle;
    const row = db.prepare('SELECT done_at FROM capture_watches WHERE id = ?').get(id);
    if (!row) throw refusal(OBSERVE_CODES.UNKNOWN_WATCH);
    if (row.done_at) return { ok: true, written: 0 };
    db.prepare('UPDATE capture_watches SET done_at = ?, outcome = ? WHERE id = ?').run(toIso(now()), outcome, id);
    return { ok: true, written: 1 };
  }, log);
}
