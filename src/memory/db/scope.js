// Scope: who may see a row (spec section 2). Three columns on every row that can be shown: `scope_kind`
// (`group` | `dm` | `none` | `internal`), `scope_iface` and `scope_dm` (the DM partner's person id, `dm` only).
// `none` has no source and may be shown anywhere; `internal` (a row derived from two different DMs) is never shown
// outward. A read always names its context; a read without one throws.
//
// Contexts: `{ iface, kind: 'group' }`, `{ iface, kind: 'dm', person, place }`, `{ internal: true }`. A context the core
// issues (`issueContext`) also carries an `id` and is recorded in `execution_contexts` by the service; a context with
// `audienceColumn: true` is read through `audience_id` instead of the three columns (`memoryDb.audienceColumn`).
//
// Audiences (schema v7, spec 2026-10-24-memory-schema-v7 sections 2 and 11.2): every scoped row also carries
// `audience_id`, the normalised twin of its three columns: `aud:none`, `aud:internal`, `aud:group:<iface>` and
// `aud:dm:<DM place id>` (a DM audience is the conversation, not the person). `audienceOf(scope)` is the one resolver
// every writer fills both from; `scopeOfAudience(id)` goes back. A malformed triple resolves to `aud:internal`.

import { randomUUID } from 'node:crypto';
import { IFACE, dmPartnerOfPlace, dmPlaceOfPerson, personId } from './ids.js';

export const SCOPE_NONE = Object.freeze({ scope_kind: 'none', scope_iface: null, scope_dm: null });
export const SCOPE_INTERNAL = Object.freeze({ scope_kind: 'internal', scope_iface: null, scope_dm: null });

export const groupScope = (iface = IFACE) => ({ scope_kind: 'group', scope_iface: iface, scope_dm: null });
export const dmScope = (person, iface = IFACE) => ({ scope_kind: 'dm', scope_iface: iface, scope_dm: person });

export const groupContext = (iface = IFACE) => ({ iface, kind: 'group' });
/** A DM context; `place` is the DM place, resolved from the partner as the resolver does when it is not given. */
export const dmContext = (person, iface = IFACE, place = null) => ({
  iface,
  kind: 'dm',
  person,
  place: place ?? dmPlaceOfPerson(person, iface),
});
export const internalContext = () => ({ internal: true });

/**
 * The scope columns of an old scope object (`{ channel }`, `{ guild: true }`, `{ user }`, `{}`).
 * A private layer of user U (`opts.privateUser`) or a scope naming a user is `dm` with that member; a channel or
 * `guild: true` is `group`; anything else (no scope, an empty or unknown one) is `internal`: an unknown legacy scope
 * is never shown outward. `none` is only for a unit that is source-free on purpose (a self fact, her own unprompted
 * line), which its mapper sets itself with SCOPE_NONE.
 * @param {object|null|undefined} oldScope
 * @param {{ privateUser?: string|null }} [opts]
 */
export function scopeColumns(oldScope, opts = {}) {
  const user = opts.privateUser ?? (typeof oldScope?.user === 'string' && oldScope.user ? oldScope.user : null);
  if (user) return dmScope(personId(user));
  if (oldScope && (typeof oldScope.channel === 'string' || oldScope.guild === true)) return groupScope();
  return { ...SCOPE_INTERNAL };
}

/** The user id a scope row's `scope_dm` names, or null. */
export function dmUserOf(row) {
  const match = /^person:[^:]+:(.+)$/.exec(String(row?.scope_dm ?? ''));
  return match ? match[1] : null;
}

function check(ctx) {
  if (!ctx || typeof ctx !== 'object') throw new Error('memory db: a read needs a scope context');
  if (ctx.internal === true) return;
  if (ctx.kind === 'group' && typeof ctx.iface === 'string' && ctx.iface) return;
  if (ctx.kind === 'dm' && typeof ctx.iface === 'string' && ctx.iface && typeof ctx.person === 'string' && ctx.person)
    return;
  throw new Error('memory db: a read needs a valid scope context');
}

/** Whether a row (its three scope columns) may be shown in a context. Throws without a valid context. */
export function allowed(row, ctx) {
  check(ctx);
  if (ctx.internal === true) return true;
  switch (row?.scope_kind) {
    case 'none':
      return true;
    case 'group':
      return row.scope_iface === ctx.iface;
    case 'dm':
      return ctx.kind === 'dm' && row.scope_iface === ctx.iface && row.scope_dm === ctx.person;
    default:
      return false;
  }
}

/**
 * A SQL WHERE fragment (without the word WHERE) and its positional parameters for a context.
 * `alias` prefixes the three columns (`s` gives `s.scope_kind`). Throws without a valid context.
 * @returns {{ sql: string, params: string[] }}
 */
export function whereFor(ctx, alias = '') {
  check(ctx);
  if (ctx.internal === true) return { sql: '1 = 1', params: [] };
  const p = alias ? `${alias}.` : '';
  let sql = `(${p}scope_kind = 'none' OR (${p}scope_kind = 'group' AND ${p}scope_iface = ?)`;
  const params = [ctx.iface];
  if (ctx.kind === 'dm') {
    sql += ` OR (${p}scope_kind = 'dm' AND ${p}scope_iface = ? AND ${p}scope_dm = ?)`;
    params.push(ctx.iface, ctx.person);
  }
  return { sql: `${sql})`, params };
}

/**
 * The narrowest scope of the sources a derived row came from. `none` sources do not narrow. Group is narrower than
 * none, a DM narrower than a group of its interface; two different DMs, or sources of different interfaces that
 * cannot both be shown anywhere, give `internal`.
 * @param {Array<{ scope_kind: string, scope_iface?: string|null, scope_dm?: string|null }>} scopes
 */
export function narrowest(scopes) {
  let result = { ...SCOPE_NONE };
  for (const scope of scopes ?? []) {
    const kind = scope?.scope_kind;
    if (kind === 'none' || kind === undefined || kind === null) continue;
    if (kind === 'internal') return { ...SCOPE_INTERNAL };
    if (kind !== 'group' && kind !== 'dm') return { ...SCOPE_INTERNAL };
    const next = {
      scope_kind: kind,
      scope_iface: scope.scope_iface ?? null,
      scope_dm: kind === 'dm' ? (scope.scope_dm ?? null) : null,
    };
    if (result.scope_kind === 'none') {
      result = next;
    } else if (result.scope_kind === 'group' && next.scope_kind === 'group') {
      if (result.scope_iface !== next.scope_iface) return { ...SCOPE_INTERNAL };
    } else if (result.scope_kind === 'group' && next.scope_kind === 'dm') {
      if (result.scope_iface !== next.scope_iface) return { ...SCOPE_INTERNAL };
      result = next;
    } else if (result.scope_kind === 'dm' && next.scope_kind === 'group') {
      if (result.scope_iface !== next.scope_iface) return { ...SCOPE_INTERNAL };
    } else if (result.scope_iface !== next.scope_iface || result.scope_dm !== next.scope_dm) {
      return { ...SCOPE_INTERNAL };
    }
  }
  return result;
}

// ---------- audiences (schema v7) ----------

export const AUD_NONE = 'aud:none';
export const AUD_INTERNAL = 'aud:internal';
export const groupAudienceId = (iface) => `aud:group:${iface}`;
export const dmAudienceId = (placeId) => `aud:dm:${placeId}`;

const filled = (value) => typeof value === 'string' && value !== '';

/**
 * The one resolver: a scope (its three columns) and its audience id, `{ scope_kind, scope_iface, scope_dm, audience_id }`.
 * The triple comes back as given (it stays the compatibility projection). A DM scope resolves to the DM place of its
 * partner on that interface (`opts.dmPlace` when the writer knows it: then a DM whose partner is no known person, schema
 * v8's observed DM with an account nobody linked, is still its conversation); a triple that names no valid audience (an
 * unknown kind, a group without an interface, a DM with neither a partner nor a known place) is `aud:internal`.
 * @param {{ scope_kind?: string|null, scope_iface?: string|null, scope_dm?: string|null }|null|undefined} scope
 * @param {{ dmPlace?: string|null }} [opts]
 */
export function audienceOf(scope, { dmPlace = null } = {}) {
  const kind = scope?.scope_kind ?? null;
  const iface = scope?.scope_iface ?? null;
  const dm = scope?.scope_dm ?? null;
  const out = { scope_kind: kind, scope_iface: iface, scope_dm: dm, audience_id: AUD_INTERNAL };
  if (kind === 'none') out.audience_id = AUD_NONE;
  else if (kind === 'group' && filled(iface)) out.audience_id = groupAudienceId(iface);
  else if (kind === 'dm' && filled(iface) && (filled(dm) || filled(dmPlace))) {
    const place = filled(dmPlace) ? dmPlace : dmPlaceOfPerson(dm, iface);
    if (place) out.audience_id = dmAudienceId(place);
  }
  return out;
}

/** Whether a triple is one of the four well-formed kinds (a malformed one resolves to internal). */
export function wellFormed(scope) {
  const kind = scope?.scope_kind ?? null;
  if (kind === 'internal') return true;
  return audienceOf(scope).audience_id !== AUD_INTERNAL;
}

/**
 * The parts of an audience id: `{ id, kind, iface, place_id }`. A DM audience's interface comes from its place
 * (`lookup(placeId)` -> `{ iface }` when given, else the legacy place spelling). Null for an id of no known shape.
 */
export function audienceParts(id, lookup = null) {
  const value = String(id ?? '');
  if (value === AUD_NONE) return { id: value, kind: 'none', iface: null, place_id: null };
  if (value === AUD_INTERNAL) return { id: value, kind: 'internal', iface: null, place_id: null };
  if (value.startsWith('aud:group:') && value.length > 'aud:group:'.length)
    return { id: value, kind: 'group', iface: value.slice('aud:group:'.length), place_id: null };
  if (value.startsWith('aud:dm:') && value.length > 'aud:dm:'.length) {
    const place = value.slice('aud:dm:'.length);
    const iface =
      (typeof lookup === 'function' ? lookup(place)?.iface : null) ?? dmPartnerOfPlace(place)?.iface ?? null;
    return { id: value, kind: 'dm', iface, place_id: place };
  }
  return null;
}

/**
 * The three columns of an audience id (the compatibility projection). A DM audience names its partner through its
 * place (`lookup(placeId)` -> `{ iface, partner_person }`, else the legacy place spelling); an unknown id is internal.
 */
export function scopeOfAudience(id, lookup = null) {
  const parts = audienceParts(id);
  if (!parts || parts.kind === 'internal') return { ...SCOPE_INTERNAL };
  if (parts.kind === 'none') return { ...SCOPE_NONE };
  if (parts.kind === 'group') return groupScope(parts.iface);
  const found = typeof lookup === 'function' ? lookup(parts.place_id) : null;
  const partner = found?.partner_person
    ? { iface: found.iface, person: found.partner_person }
    : dmPartnerOfPlace(parts.place_id);
  return partner ? dmScope(partner.person, partner.iface) : { ...SCOPE_INTERNAL };
}

/** The audience ids a context may read (null: every one, the internal context). Throws without a valid context. */
export function audiencesOf(ctx) {
  check(ctx);
  if (ctx.internal === true) return null;
  const ids = [AUD_NONE, groupAudienceId(ctx.iface)];
  if (ctx.kind === 'dm') {
    const place = filled(ctx.place) ? ctx.place : dmPlaceOfPerson(ctx.person, ctx.iface);
    if (place) ids.push(dmAudienceId(place));
  }
  return ids;
}

/** `allowed` on `audience_id`: whether a row may be shown in a context. Throws without a valid context. */
export function allowedAudience(row, ctx) {
  const ids = audiencesOf(ctx);
  return ids === null || ids.includes(row?.audience_id);
}

/**
 * The twin of `whereFor` on `audience_id`: `<alias>.audience_id IN ('aud:none', 'aud:group:<iface>'[, 'aud:dm:<place>'])`
 * as a fragment and its parameters. Throws without a valid context.
 * @returns {{ sql: string, params: string[] }}
 */
export function audienceWhere(ctx, alias = '') {
  const ids = audiencesOf(ctx);
  if (ids === null) return { sql: '1 = 1', params: [] };
  const p = alias ? `${alias}.` : '';
  return { sql: `${p}audience_id IN (${ids.map(() => '?').join(', ')})`, params: ids };
}

/** The read filter of a context: on `audience_id` when the context says so (`audienceColumn`), else the triple. */
export const scopeWhere = (ctx, alias = '') =>
  ctx?.audienceColumn === true ? audienceWhere(ctx, alias) : whereFor(ctx, alias);

/** The row check of a context: on `audience_id` when the context says so (`audienceColumn`), else the triple. */
export const canRead = (row, ctx) => (ctx?.audienceColumn === true ? allowedAudience(row, ctx) : allowed(row, ctx));

/** A context read through `audience_id` or the triple, as the live config says (`memoryDb.audienceColumn`). */
export const withPredicate = (ctx, config) => ({ ...ctx, audienceColumn: config?.memoryDb?.audienceColumn === true });

/**
 * `narrowest` on audiences: the meet of the audiences a derived row came from. none and X = X; internal and X = internal;
 * group(I) and group(I) = group(I); group(I) and dm(I, P) = dm(I, P); dm(P) and dm(P) = dm(P); different DM places, or
 * different interfaces, give internal; an unknown id is internal. Entries are ids or `audienceParts` objects.
 * @param {Array<string|{ id: string, kind: string, iface?: string|null, place_id?: string|null }>} audiences
 * @param {(placeId: string) => ({ iface: string }|null)} [lookup]
 */
export function narrowestAudience(audiences, lookup = null) {
  let result = { id: AUD_NONE, kind: 'none', iface: null, place_id: null };
  for (const entry of audiences ?? []) {
    const next = typeof entry === 'string' ? audienceParts(entry, lookup) : entry;
    if (!next || !next.kind) return AUD_INTERNAL;
    if (next.kind === 'none') continue;
    if (next.kind === 'internal') return AUD_INTERNAL;
    if (next.kind === 'dm' && !next.iface) return AUD_INTERNAL;
    if (result.kind === 'none') {
      result = next;
      continue;
    }
    if (result.iface !== next.iface) return AUD_INTERNAL;
    if (result.kind === 'group' && next.kind === 'dm') result = next;
    else if (result.kind === 'dm' && next.kind === 'dm' && result.place_id !== next.place_id) return AUD_INTERNAL;
  }
  return result.id;
}

// ---------- execution contexts ----------

/** The policy version contexts are issued under (the read rule of spec section 2; a change of the rule bumps it). */
export const CONTEXT_POLICY_VERSION = 1;

/**
 * A context the core issues for one turn, session or wake: a read context (as `groupContext` / `dmContext` /
 * `internalContext`) with an `id`, its `mode` (`outward` for a group or DM, `internal` otherwise), the destination
 * place, the policy version and the time it was issued. Pure: `now` and `newId` are injected; the service records it.
 * @param {{ kind: 'group'|'dm'|'internal', iface?: string, person?: string, place?: string|null, destination?: string|null,
 *   policyVersion?: number, now?: () => number, newId?: () => string, audienceColumn?: boolean }} spec
 */
export function issueContext({
  kind,
  iface = IFACE,
  person = null,
  place = null,
  destination = null,
  policyVersion = CONTEXT_POLICY_VERSION,
  now = Date.now,
  newId = () => `ctx:${randomUUID()}`,
  audienceColumn = false,
} = {}) {
  let base;
  if (kind === 'group') base = groupContext(iface);
  else if (kind === 'dm') base = dmContext(person, iface, place);
  else base = internalContext();
  check(base);
  const ctx = {
    ...base,
    id: newId(),
    mode: base.internal === true ? 'internal' : 'outward',
    destination: base.kind === 'dm' ? (destination ?? base.place ?? null) : (destination ?? null),
    policyVersion,
    issuedAt: new Date(now()).toISOString(),
  };
  if (audienceColumn === true) ctx.audienceColumn = true;
  return ctx;
}

/** The `execution_contexts` row of an issued context. */
export function contextRow(ctx) {
  return {
    id: ctx.id,
    mode: ctx.mode ?? (ctx.internal === true ? 'internal' : 'outward'),
    iface: ctx.internal === true ? null : (ctx.iface ?? null),
    destination_place_id: ctx.destination ?? null,
    partner_person_id: ctx.kind === 'dm' ? (ctx.person ?? null) : null,
    policy_version: Number.isInteger(ctx.policyVersion) ? ctx.policyVersion : CONTEXT_POLICY_VERSION,
    issued_at: ctx.issuedAt ?? null,
  };
}
