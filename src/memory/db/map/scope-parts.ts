// How a line or file scope (`{ channel }`, `{ place }`, `{ user }`) becomes a place and the three scope
// columns, and back. A private layer's rows belong to the member's DM place; the channel id such a line carried is
// kept in the remainder (`dmChannel`). When the columns cannot rebuild the old scope exactly, the old scope is kept
// verbatim in the remainder (`scope`), or `$noScope` marks that the line had none, so the round trip is exact either way.

import { channelPlaceId, dmPlaceId, personId } from '../ids.ts';
import { LEGACY_IFACE } from '../legacy-namespace.ts';
import { audienceOf, dmAudienceId, dmScope, dmUserOf, scopeColumns } from '../scope.ts';
import { jsonEqual } from './common.ts';
import type { MapContext } from './common.ts';
import { asText } from '../types.ts';
import type { Row } from '../types.ts';

/** The member id of a private layer path (`private/<id>.json`, `private/<id>/...`, under any prefix), else null. */
export function privateUserOf(rel: string): string | null {
  const match = /^(?:[^/]+\/[^/]+\/)?private\/([^/]+?)(?:\.json$|\/)/.exec(String(rel));
  return match ? match[1] : null;
}

/**
 * The scope of a row of a DM. A person id that spells this DM place is the whole answer. Any other person (an opaque id,
 * a place under another authority, an account bound to someone) gets the place's own audience and the partner the place
 * names, the pair rows.ts#resolveRow accepts.
 */
export function dmPlaceScope(person: string, iface: string, place: NonNullable<MapContext['dmPlace']>): Row {
  const scope = dmScope(person, iface);
  if (audienceOf(scope).audience_id === dmAudienceId(place.id)) return scope;
  return { scope_kind: 'dm', scope_iface: iface, scope_dm: place.partnerPerson, audience_id: dmAudienceId(place.id) };
}

/** The `scope` object of a line: the conversation it names, the place it belongs to, or the user. */
export type OldScope = { user?: unknown; channel?: unknown; place?: unknown };

/**
 * The place and scope columns for an old scope. Notes in `rest` whatever the columns cannot rebuild. A unit of a DM place
 * (`dmPlace`) keeps its rows on that place and in its audience, whatever the partner's native id spells.
 */
export function scopeInto(
  rest: Row,
  oldScope: OldScope | undefined,
  privateUser: string | null | undefined,
  iface = LEGACY_IFACE,
  dmPlace: MapContext['dmPlace'] = null
): Row {
  const channel = typeof oldScope?.channel === 'string' && oldScope.channel ? oldScope.channel : null;
  const placed = privateUser && dmPlace ? dmPlace : null;
  const cols = {
    place_id: placed
      ? placed.id
      : privateUser
        ? dmPlaceId(iface, privateUser)
        : channel
          ? channelPlaceId(iface, channel)
          : null,
    ...(placed
      ? dmPlaceScope(personId(iface, privateUser), iface, placed)
      : scopeColumns(oldScope, { privateUser, iface })),
  };
  if (privateUser && channel) rest.dmChannel = channel;
  const rebuilt = scopeFrom(cols, { ...rest }, privateUser, iface);
  if (oldScope === undefined || !jsonEqual(rebuilt, oldScope)) {
    delete rest.dmChannel;
    if (oldScope === undefined) rest.$noScope = true;
    else rest.scope = oldScope;
  }
  return cols;
}

/** The old scope from the columns and the remainder; removes the scope markers from `rest`. */
export function scopeFrom(
  cols: Row,
  rest: Row,
  privateUser: string | null | undefined,
  iface = LEGACY_IFACE
): OldScope | undefined {
  const verbatim = Object.hasOwn(rest, 'scope');
  const verbatimScope = rest.scope as OldScope | undefined; // a file's own scope object, handed back as it was read
  const none = rest.$noScope === true;
  const dmChannel = rest.dmChannel;
  delete rest.scope;
  delete rest.$noScope;
  delete rest.dmChannel;
  if (verbatim) return verbatimScope;
  if (none) return undefined;
  const scope: OldScope = {};
  const place = asText(cols.place_id ?? '');
  if (privateUser) {
    if (typeof dmChannel === 'string') scope.channel = dmChannel;
  } else if (place.startsWith(`${iface}:channel:`)) {
    scope.channel = place.slice(`${iface}:channel:`.length);
  }
  if (!privateUser && cols.scope_kind === 'dm') scope.user = dmUserOf(cols);
  return scope;
}
