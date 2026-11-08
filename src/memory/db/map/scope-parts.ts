// How a line or file scope (`{ channel }`, `{ place }`, `{ user }`) becomes a place and the three scope
// columns, and back. A private layer's rows belong to the member's DM place; the channel id such a line carried is
// kept in the remainder (`dmChannel`). When the columns cannot rebuild the old scope exactly, the old scope is kept
// verbatim in the remainder (`scope`), or `$noScope` marks that the line had none, so the round trip is exact either way.

import { channelPlaceId, dmPlaceId, personId } from '../ids.ts';
import { LEGACY_IFACE } from '../legacy-namespace.ts';
import { dmAudienceId, dmScope, dmUserOf, scopeColumns } from '../scope.ts';
import type { DmScope } from '../scope.ts';
import { jsonEqual } from './common.ts';
import type { MapContext } from './common.ts';
import { asText } from '../types.ts';
import type { Row } from '../types.ts';

/** The member id of a private layer path (`private/<id>.json`, `private/<id>/...`, under any prefix), else null. */
export function privateUserOf(rel: string): string | null {
  const match = /^(?:[^/]+\/[^/]+\/)?private\/([^/]+?)(?:\.json$|\/)/.exec(String(rel));
  return match ? match[1] : null;
}

/** How a mapper reaches a member's stored DM by platform id, and a stored DM place by its id. */
export type MemberReads = Pick<MapContext, 'dmOfMember' | 'dmPlaceOf'>;

/**
 * The scope of a row of a stored DM place: the place's own audience and the partner person the place names, the pair
 * rows.ts#resolveRow accepts. A place nobody linked names no partner person.
 */
export function dmPlaceScope(iface: string, place: NonNullable<MapContext['dmPlace']>): DmScope {
  return { scope_kind: 'dm', scope_iface: iface, scope_dm: place.partnerPerson, audience_id: dmAudienceId(place.id) };
}

/**
 * How a mapper scopes a member's DM by the member's platform id: the member's stored DM place (`dmOfMember`, through
 * `places.partner_account`), or null when none is stored, which `scopeColumns` makes internal.
 */
export function memberDmOf(
  iface: string,
  dmOfMember: MapContext['dmOfMember']
): ((platformId: string) => DmScope | null) | undefined {
  if (!dmOfMember) return undefined;
  return (platformId) => {
    const place = dmOfMember(iface, platformId);
    return place ? dmPlaceScope(iface, place) : null;
  };
}

/** How `scopeColumns` reads a place id an old scope names: the scope of the stored DM place, null for any other. */
export function storedDmOf(
  iface: string,
  dmPlaceOf: MapContext['dmPlaceOf']
): ((placeId: string) => DmScope | null) | undefined {
  if (!dmPlaceOf) return undefined;
  return (placeId) => {
    const place = dmPlaceOf(placeId);
    return place ? dmPlaceScope(iface, place) : null;
  };
}

/**
 * The place and scope of a private layer no stored DM holds. Such a layer is a legacy file of the member's direct chat,
 * imported before its place exists: it keeps the place and the partner its member id spells (legacy-namespace.ts),
 * which the writer stores with it. A private layer of a live member always finds its stored DM.
 */
export function legacyPrivateScope(iface: string, privateUser: string): { place: string; scope: DmScope } {
  return { place: dmPlaceId(iface, privateUser), scope: dmScope(personId(iface, privateUser), iface) };
}

/** The `scope` object of a line: the chat it names, the place it belongs to, or the user. */
export type OldScope = { user?: unknown; channel?: unknown; place?: unknown };

/**
 * The place and scope columns for an old scope. Notes in `rest` whatever the columns cannot rebuild. A unit of a DM place
 * (`dmPlace`) keeps its rows on that place and in its audience, whatever the partner's native id spells. A private layer
 * of no DM place unit takes the member's stored DM, else its legacy spelling (`legacyPrivateScope`). A scope that names a
 * member takes the member's stored DM (`members`), and is internal with none stored.
 */
export function scopeInto(
  rest: Row,
  oldScope: OldScope | undefined,
  privateUser: string | null | undefined,
  iface = LEGACY_IFACE,
  dmPlace: MapContext['dmPlace'] = null,
  members: MemberReads = {}
): Row {
  const channel = typeof oldScope?.channel === 'string' && oldScope.channel ? oldScope.channel : null;
  const placed = privateUser ? (dmPlace ?? members.dmOfMember?.(iface, privateUser) ?? null) : null;
  const legacy = privateUser && !placed ? legacyPrivateScope(iface, privateUser) : null;
  const cols = {
    place_id: placed ? placed.id : legacy ? legacy.place : channel ? channelPlaceId(iface, channel) : null,
    ...(placed
      ? dmPlaceScope(iface, placed)
      : legacy
        ? legacy.scope
        : scopeColumns(oldScope, {
            iface,
            dmOf: memberDmOf(iface, members.dmOfMember),
            dmOfPlace: storedDmOf(iface, members.dmPlaceOf),
          })),
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

/**
 * The old scope from the columns and the remainder; removes the scope markers from `rest`. `partnerOfDm` reads the
 * partner's platform id of a DM audience from the stored place.
 */
export function scopeFrom(
  cols: Row,
  rest: Row,
  privateUser: string | null | undefined,
  iface = LEGACY_IFACE,
  partnerOfDm: MapContext['partnerOfDm'] = undefined
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
  if (!privateUser && cols.scope_kind === 'dm') scope.user = dmUserOf(cols, partnerOfDm);
  return scope;
}
