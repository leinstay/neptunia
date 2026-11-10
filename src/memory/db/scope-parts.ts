// How a line or file scope (`{ channel }`, `{ place }`, `{ user }`) becomes a place and the three scope
// columns, and back. A private layer's rows belong to the member's DM place; the channel id such a line carried is
// kept in the remainder (`dmChannel`). A channel is the place its row holds, and reads back from that row. When the
// columns cannot rebuild the old scope exactly, the old scope is kept verbatim in the remainder (`scope`), or `$noScope`
// marks that the line had none, so the round trip is exact either way.

import { mintedChannel } from './native-rows.ts';
import { SCOPE_INTERNAL, dmAudienceId, dmUserOf, scopeColumns } from './scope.ts';
import type { DmScope } from './scope.ts';
import { jsonEqual } from './row-columns.ts';
import type { MapContext } from './row-columns.ts';
import { asText } from './types.ts';
import type { Row } from './types.ts';

/** How a mapper reaches a member's stored DM by platform id, a stored DM place by its id, and a channel's place. */
export type MemberReads = Pick<MapContext, 'dmOfMember' | 'dmPlaceOf' | 'placeOfChannel' | 'channelOfPlace'>;

/** How a scope is read back from its columns: a DM audience's partner and a place's channel. */
export type ScopeReads = Pick<MapContext, 'partnerOfDm' | 'channelOfPlace'>;

/**
 * The scope of a row of a stored DM place: the place's own audience and the partner person the place names, the pair
 * rows.ts#resolveRow accepts. A place nobody linked names no partner person.
 */
export function dmPlaceScope(iface: string | null, place: NonNullable<MapContext['dmPlace']>): DmScope {
  return { scope_kind: 'dm', scope_iface: iface, scope_dm: place.partnerPerson, audience_id: dmAudienceId(place.id) };
}

/**
 * How a mapper scopes a member's DM by the member's platform id: the member's stored DM place (`dmOfMember`, through
 * `places.partner_account`), or null when none is stored, which `scopeColumns` makes internal.
 */
export function memberDmOf(
  iface: string | null,
  dmOfMember: MapContext['dmOfMember']
): ((platformId: string) => DmScope | null) | undefined {
  if (!dmOfMember || iface === null) return undefined;
  return (platformId) => {
    const place = dmOfMember(iface, platformId);
    return place ? dmPlaceScope(iface, place) : null;
  };
}

/** How `scopeColumns` reads a place id an old scope names: the scope of the stored DM place, null for any other. */
export function storedDmOf(
  iface: string | null,
  dmPlaceOf: MapContext['dmPlaceOf']
): ((placeId: string) => DmScope | null) | undefined {
  if (!dmPlaceOf) return undefined;
  return (placeId) => {
    const place = dmPlaceOf(placeId);
    return place ? dmPlaceScope(iface, place) : null;
  };
}

/** The `scope` object of a line: the chat it names, the place it belongs to, or the user. */
export type OldScope = { user?: unknown; channel?: unknown; place?: unknown };

/** The stored DM of the member of a private layer, by its platform id on the interface of the write; null for none. */
function memberDm(
  privateUser: string | null | undefined,
  iface: string | null,
  members: MemberReads
): MapContext['dmPlace'] {
  if (!privateUser || iface === null) return null;
  return members.dmOfMember?.(iface, privateUser) ?? null;
}

/**
 * The place of the channel a line names by its platform id: the stored one, else the id the observation would mint.
 * A channel of a write that names no interface is no place.
 */
function channelPlaces(
  channel: string | null,
  iface: string | null,
  members: MemberReads
): { storedPlace: string | null; channelPlace: string | null } {
  if (channel === null || iface === null) return { storedPlace: null, channelPlace: null };
  const storedPlace = members.placeOfChannel?.(iface, channel) ?? null;
  return { storedPlace, channelPlace: storedPlace ?? mintedChannel(iface, channel) };
}

/**
 * The place and scope columns for an old scope. Notes in `rest` whatever the columns cannot rebuild. A unit of a DM place
 * (`dmPlace`) keeps its rows on that place and in its audience, whatever the partner's native id spells. A private layer
 * of no DM place unit takes the member's stored DM, and is internal with none stored. A scope that names a member takes
 * the member's stored DM (`members`), and is internal with none stored. A channel is its stored place, else the id the
 * observation would give it (`members.placeOfChannel`).
 */
export function scopeInto(
  rest: Row,
  oldScope: OldScope | undefined,
  privateUser: string | null | undefined,
  iface: string | null = null,
  dmPlace: MapContext['dmPlace'] = null,
  members: MemberReads = {}
): Row {
  const channel = typeof oldScope?.channel === 'string' && oldScope.channel ? oldScope.channel : null;
  const placed = dmPlace ?? memberDm(privateUser, iface, members);
  const { storedPlace, channelPlace } = channelPlaces(channel, iface, members);
  const cols = {
    place_id: placed ? placed.id : privateUser ? null : channelPlace,
    ...(placed
      ? dmPlaceScope(iface, placed)
      : privateUser
        ? { ...SCOPE_INTERNAL }
        : scopeColumns(oldScope, {
            iface,
            dmOf: memberDmOf(iface, members.dmOfMember),
            dmOfPlace: storedDmOf(iface, members.dmPlaceOf),
          })),
  };
  if (privateUser && channel) rest.dmChannel = channel;
  // The place found by the channel's key holds that channel, which a read finds without asking again.
  const channelOfPlace = (id: string): string | null =>
    id === storedPlace ? channel : (members.channelOfPlace?.(id) ?? null);
  const rebuilt = scopeFrom(cols, { ...rest }, privateUser, { channelOfPlace });
  if (oldScope === undefined || !jsonEqual(rebuilt, oldScope)) {
    delete rest.dmChannel;
    if (oldScope === undefined) rest.$noScope = true;
    else rest.scope = oldScope;
  }
  return cols;
}

/**
 * The old scope from the columns and the remainder; removes the scope markers from `rest`. `reads.partnerOfDm` reads
 * the partner's platform id of a DM audience and `reads.channelOfPlace` the channel of a place from their stored rows.
 */
export function scopeFrom(
  cols: Row,
  rest: Row,
  privateUser: string | null | undefined,
  reads: ScopeReads = {}
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
  } else {
    const channel = place === '' ? null : (reads.channelOfPlace?.(place) ?? null);
    if (channel !== null) scope.channel = channel;
  }
  if (!privateUser && cols.scope_kind === 'dm') scope.user = dmUserOf(cols, reads.partnerOfDm);
  return scope;
}
