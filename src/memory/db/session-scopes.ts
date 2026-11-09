// The scopes a memory session sweeps (session.ts): the groups of an interface together, each DM alone. A DM is the place its
// lines' audience names, whatever those lines carry in `scope_dm`: its partner is the person the place names, and a DM whose
// partner account nobody linked has none and is still swept. The key of a DM comes from the place alone, so a link made
// later leaves the scope and its cursor where they are.

import { audienceOf, audienceParts, dmAudienceId, dmContext, groupContext, wellFormed } from './scope.ts';
import type { Context, Scope } from './scope.ts';
import { asText } from './types.ts';
import type { Db, Row } from './types.ts';

/**
 * A scope as the sweep walks it: its key, the triple, the context that reads it and, with `audienceColumn`, its
 * audience. A DM names its `place`, the stored row the sweep found it by.
 */
export type SweepScope = { key: string; scope: Scope; ctx: Context; audienceId?: string; place?: string };

/** What a sweep's run names of its scope, so that a reader of the run never takes it out of the key. */
export type RunColumns = { scopeKind?: string | null; iface?: string | null; place?: string | null };

/** The columns of the scope a run covered: its kind, its interface and, for a DM, its place. */
export const runColumns = (swept: SweepScope): RunColumns => ({
  scopeKind: swept.scope.scope_kind,
  iface: swept.scope.scope_iface,
  place: swept.place ?? null,
});

/** The key of the scope of a DM place on `iface`: the place. No link ever changes it. */
export function dmScopeKey(iface: string, place: string): string {
  return `dm:${iface}:${place}`;
}

/**
 * A DM read through the place its lines' audience names, always through `audience_id`: the triple names no chat. A place
 * that says nothing of its partner is no scope.
 */
function placedScope(row: Row, iface: string, place: Row): SweepScope | null {
  const placeId = String(place.id);
  const person = (place.partner_person ?? row.scope_dm ?? null) as string | null;
  if (person === null && !place.partner_account) return null;
  const scope: Scope = { scope_kind: 'dm', scope_iface: iface, scope_dm: person };
  const ctx = dmContext(person, iface, placeId);
  return {
    key: dmScopeKey(iface, placeId),
    scope,
    ctx: { ...ctx, audienceColumn: true },
    audienceId: dmAudienceId(placeId),
    place: placeId,
  };
}

function groupOf(iface: string, audienceColumn: boolean): SweepScope {
  const scope: Scope = { scope_kind: 'group', scope_iface: iface, scope_dm: null };
  const entry = { key: `group:${asText(iface)}`, scope, ctx: groupContext(iface) };
  if (!audienceColumn) return entry;
  return { ...entry, audienceId: audienceOf(scope).audience_id, ctx: { ...entry.ctx, audienceColumn: true } };
}

/**
 * The scopes that have chat lines, group first, in a stable order. `audienceColumn`: read them through `audience_id`.
 * A DM line whose audience names no stored DM place is not a scope of its own: no chat is worked out of its partner's id.
 */
export function scopesOf(
  dbGiven: unknown,
  { audienceColumn = false }: { audienceColumn?: boolean } = {}
): Array<SweepScope> {
  const db = dbGiven as Db;
  const placeOf = db.prepare(
    "SELECT id, partner_person, partner_account FROM places WHERE id = ? AND (chat = 'dm' OR kind = 'dm')"
  );
  const rows = db
    .prepare(
      `SELECT DISTINCT scope_kind, scope_iface, scope_dm, audience_id FROM sources
      WHERE kind IN ('seen', 'said') AND retired_at IS NULL AND scope_kind IN ('group', 'dm') AND scope_iface IS NOT NULL
      ORDER BY scope_kind, scope_iface, scope_dm, audience_id`
    )
    .all();
  const scopes: Array<SweepScope> = [];
  for (const row of rows) {
    const iface = row.scope_iface as string;
    if (row.scope_kind === 'group') {
      if (wellFormed(row)) scopes.push(groupOf(iface, audienceColumn));
      continue;
    }
    const parts = audienceParts(row.audience_id);
    const place = parts?.kind === 'dm' ? placeOf.get(parts.place_id) : undefined;
    const scope = place ? placedScope(row, iface, place) : null;
    if (scope !== null) scopes.push(scope);
  }
  return [...new Map(scopes.map((one): [string, SweepScope] => [one.key, one])).values()];
}
