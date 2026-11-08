// The scopes a memory session sweeps (session.ts): the groups of an interface together, each DM alone. A DM is the place its
// lines' audience names, whatever those lines carry in `scope_dm`: its partner is the person the place names, and a DM whose
// partner account nobody linked has none and is still swept. The key of a DM comes from the place alone, so a link made
// later leaves the scope and its cursor where they are.

import { dmPartnerOfPlace } from './ids.ts';
import {
  audienceOf,
  audienceParts,
  dmAudienceId,
  dmContext,
  dmContextPerson,
  groupContext,
  namesNoPlaceOn,
  wellFormed,
} from './scope.ts';
import type { Context, Scope } from './scope.ts';
import { asText } from './types.ts';
import type { Db, Row } from './types.ts';

/** A scope as the sweep walks it: its key, the triple, the context that reads it and, with `audienceColumn`, its audience. */
export type SweepScope = { key: string; scope: Scope; ctx: Context; audienceId?: string };

/** The key of the scope of a DM place on `iface`: the partner its id spells, else the place. No link ever changes it. */
export function dmScopeKey(iface: string, place: string): string {
  const spelled = dmPartnerOfPlace(place);
  return `dm:${iface}:${spelled !== null && spelled.iface === iface ? spelled.person : place}`;
}

/** A DM read through the place its lines' audience names. A place that says nothing of its partner is no scope. */
function placedScope(row: Row, iface: string, place: Row, audienceColumn: boolean): SweepScope | null {
  const placeId = String(place.id);
  const person = (place.partner_person ?? row.scope_dm ?? null) as string | null;
  if (person === null && !place.partner_account) return null;
  const scope: Scope = { scope_kind: 'dm', scope_iface: iface, scope_dm: person };
  const key = dmScopeKey(iface, placeId);
  const ctx = dmContext(dmContextPerson(person, iface, placeId), iface, placeId);
  if (!audienceColumn && person !== null && audienceOf(scope).audience_id === dmAudienceId(placeId))
    return { key, scope, ctx };
  return { key, scope, ctx: { ...ctx, audienceColumn: true }, audienceId: dmAudienceId(placeId) };
}

/** A DM whose audience names no stored place: its partner's spelling is all there is, and an id that spells none is internal. */
function spelledScope(row: Row, iface: string, audienceColumn: boolean): SweepScope | null {
  if (!wellFormed(row) || namesNoPlaceOn(row.scope_dm, iface)) return null;
  const person = row.scope_dm as string;
  const scope: Scope = { scope_kind: 'dm', scope_iface: iface, scope_dm: person };
  const entry = { key: `dm:${asText(iface)}:${asText(person)}`, scope, ctx: dmContext(person, iface) };
  if (!audienceColumn) return entry;
  return { ...entry, audienceId: audienceOf(scope).audience_id, ctx: { ...entry.ctx, audienceColumn: true } };
}

function groupOf(iface: string, audienceColumn: boolean): SweepScope {
  const scope: Scope = { scope_kind: 'group', scope_iface: iface, scope_dm: null };
  const entry = { key: `group:${asText(iface)}`, scope, ctx: groupContext(iface) };
  if (!audienceColumn) return entry;
  return { ...entry, audienceId: audienceOf(scope).audience_id, ctx: { ...entry.ctx, audienceColumn: true } };
}

/**
 * The scopes that have chat lines, group first, in a stable order. `audienceColumn`: read them through `audience_id`.
 * A triple that names no valid audience and no stored DM place is not a scope of its own: its lines are internal
 * (scope.ts#audienceOf), never read as a chat.
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
    const scope = place ? placedScope(row, iface, place, audienceColumn) : spelledScope(row, iface, audienceColumn);
    if (scope !== null) scopes.push(scope);
  }
  return [...new Map(scopes.map((one): [string, SweepScope] => [one.key, one])).values()];
}
