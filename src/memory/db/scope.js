// Scope: who may see a row (spec section 2). Three columns on every row that can be shown: `scope_kind`
// (`group` | `dm` | `none` | `internal`), `scope_iface` and `scope_dm` (the DM partner's person id, `dm` only).
// `none` has no source and may be shown anywhere; `internal` (a row derived from two different DMs) is never shown
// outward. A read always names its context; a read without one throws.
//
// Contexts: `{ iface, kind: 'group' }`, `{ iface, kind: 'dm', person }`, `{ internal: true }`.

import { IFACE, personId } from './ids.js';

export const SCOPE_NONE = Object.freeze({ scope_kind: 'none', scope_iface: null, scope_dm: null });
export const SCOPE_INTERNAL = Object.freeze({ scope_kind: 'internal', scope_iface: null, scope_dm: null });

export const groupScope = (iface = IFACE) => ({ scope_kind: 'group', scope_iface: iface, scope_dm: null });
export const dmScope = (person, iface = IFACE) => ({ scope_kind: 'dm', scope_iface: iface, scope_dm: person });

export const groupContext = (iface = IFACE) => ({ iface, kind: 'group' });
export const dmContext = (person, iface = IFACE) => ({ iface, kind: 'dm', person });
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
  if (ctx.kind === 'dm' && typeof ctx.iface === 'string' && ctx.iface && typeof ctx.person === 'string' && ctx.person) return;
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
    const next = { scope_kind: kind, scope_iface: scope.scope_iface ?? null, scope_dm: kind === 'dm' ? scope.scope_dm ?? null : null };
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
