// The scopes a memory session sweeps (session.ts): the groups of an interface together, each DM alone. A DM of an opaque
// partner is its stored place, because one person can hold several and the triple cannot tell them apart.

import {
  audienceOf,
  audienceParts,
  dmAudienceId,
  dmContext,
  groupContext,
  isOpaquePerson,
  wellFormed,
} from './scope.ts';
import type { Context, Scope } from './scope.ts';
import { asText } from './types.ts';
import type { Db, Row } from './types.ts';

/**
 * A scope as the sweep walks it: `{ key, scope: { scope_kind, scope_iface, scope_dm }, ctx }`; read through `audience_id`
 * (`audienceColumn`: the entry also carries `audienceId`, and its context reads that column), else through the triple.
 */
/** A scope as the sweep walks it: its key, the triple, the context that reads it and, with `audienceColumn`, its audience. */
export type SweepScope = { key: string; scope: Scope; ctx: Context; audienceId?: string };

function scopeOf(row: Row, audienceColumn = false): SweepScope {
  // A DM of an opaque partner is its stored place: one person can hold several, and only the audience tells them apart.
  const place = isOpaquePerson(row.scope_dm) ? (audienceParts(row.audience_id)?.place_id ?? null) : null;
  const iface = row.scope_iface as string;
  const entry: SweepScope =
    row.scope_kind === 'group'
      ? {
          key: `group:${asText(iface)}`,
          scope: { scope_kind: 'group', scope_iface: iface, scope_dm: null },
          ctx: groupContext(iface),
        }
      : {
          key: `dm:${asText(iface)}:${asText(place ?? row.scope_dm)}`,
          scope: { scope_kind: 'dm', scope_iface: iface, scope_dm: row.scope_dm as string },
          ctx: dmContext(row.scope_dm as string, iface, place),
        };
  if (audienceColumn !== true && place === null) return entry;
  const audienceId = place === null ? audienceOf(entry.scope).audience_id : dmAudienceId(place);
  return { ...entry, audienceId, ctx: { ...entry.ctx, audienceColumn: true } };
}

/**
 * The scopes that have chat lines, group first, in a stable order. `audienceColumn`: read them through `audience_id`.
 * A triple that names no valid audience (a DM whose partner is not a person id of its interface) is not a scope of its
 * own: its lines are internal (scope.ts#audienceOf), never read as a conversation.
 */
export function scopesOf(
  dbGiven: unknown,
  { audienceColumn = false }: { audienceColumn?: boolean } = {}
): Array<SweepScope> {
  const db = dbGiven as Db;
  const rows = db
    .prepare(
      `SELECT DISTINCT scope_kind, scope_iface, scope_dm, audience_id FROM sources
      WHERE kind IN ('seen', 'said') AND retired_at IS NULL AND scope_kind IN ('group', 'dm') AND scope_iface IS NOT NULL
      ORDER BY scope_kind, scope_iface, scope_dm, audience_id`
    )
    .all();
  const scopes = rows
    .filter(
      (row) => wellFormed(row) && (!isOpaquePerson(row.scope_dm) || audienceParts(row.audience_id)?.kind === 'dm')
    )
    .map((row) => scopeOf(row, audienceColumn));
  return [...new Map(scopes.map((one): [string, SweepScope] => [one.key, one])).values()];
}
