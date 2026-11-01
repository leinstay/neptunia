// How an old line or file scope (`{ channel }`, `{ guild: true }`, `{ user }`) becomes a place and the three scope
// columns, and back. A private layer's rows belong to the member's DM place; the channel id such a line carried is
// kept in the remainder (`dmChannel`). When the columns cannot rebuild the old scope exactly, the old scope is kept
// verbatim in the remainder (`scope`), or `$noScope` marks that the line had none, so the round trip is exact either way.

import { channelPlaceId, dmPlaceId } from '../ids.ts';
import { LEGACY_IFACE } from '../legacy-namespace.ts';
import { dmUserOf, scopeColumns } from '../scope.ts';
import { jsonEqual } from './common.ts';
import { asText } from '../types.ts';
import type { Row } from '../types.ts';

/** The member id of a private layer file or directory path (`private/<id>.json`, `private/<id>/...`, with or without the `guilds/<g>/` prefix of a full unit path), else null. */
export function privateUserOf(rel: string): string | null {
  const match = /^(?:guilds\/[^/]+\/)?private\/([^/]+?)(?:\.json$|\/)/.exec(String(rel));
  return match ? match[1] : null;
}

/**
 * The place and scope columns for an old scope. Notes in `rest` whatever the columns cannot rebuild.
 */
/** The old `scope` object of a file: the channel it names, the guild flag or the user. */
export type OldScope = { user?: unknown; channel?: unknown; guild?: unknown };

export function scopeInto(
  rest: Row,
  oldScope: OldScope | undefined,
  privateUser: string | null | undefined,
  iface = LEGACY_IFACE
): Row {
  const channel = typeof oldScope?.channel === 'string' && oldScope.channel ? oldScope.channel : null;
  const cols = {
    place_id: privateUser ? dmPlaceId(iface, privateUser) : channel ? channelPlaceId(iface, channel) : null,
    ...scopeColumns(oldScope, { privateUser, iface }),
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
  } else if (cols.scope_kind === 'group') {
    scope.guild = true;
  }
  if (!privateUser && cols.scope_kind === 'dm') scope.user = dmUserOf(cols);
  return scope;
}
