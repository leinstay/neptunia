// How an old line or file scope (`{ channel }`, `{ guild: true }`, `{ user }`) becomes a place and the three scope
// columns, and back. A private layer's rows belong to the member's DM place; the channel id such a line carried is
// kept in the remainder (`dmChannel`). When the columns cannot rebuild the old scope exactly, the old scope is kept
// verbatim in the remainder (`scope`), or `$noScope` marks that the line had none, so the round trip is exact either way.

import { channelPlaceId, dmPlaceId, nativeOf } from '../ids.js';
import { dmUserOf, scopeColumns } from '../scope.js';
import { jsonEqual } from './common.js';

/** The member id of a private layer file or directory path (`private/<id>.json`, `private/<id>/...`), else null. */
export function privateUserOf(rel) {
  const match = /^private\/([^/]+?)(?:\.json$|\/)/.exec(String(rel));
  return match ? match[1] : null;
}

/**
 * The place and scope columns for an old scope. Notes in `rest` whatever the columns cannot rebuild.
 * @returns {{ place_id: string|null, scope_kind: string, scope_iface: string|null, scope_dm: string|null }}
 */
export function scopeInto(rest, oldScope, privateUser) {
  const channel = typeof oldScope?.channel === 'string' && oldScope.channel ? oldScope.channel : null;
  const cols = {
    place_id: privateUser ? dmPlaceId(privateUser) : channel ? channelPlaceId(channel) : null,
    ...scopeColumns(oldScope, { privateUser }),
  };
  if (privateUser && channel) rest.dmChannel = channel;
  const rebuilt = scopeFrom(cols, { ...rest }, privateUser);
  if (oldScope === undefined || !jsonEqual(rebuilt, oldScope)) {
    delete rest.dmChannel;
    if (oldScope === undefined) rest.$noScope = true;
    else rest.scope = oldScope;
  }
  return cols;
}

/** The old scope from the columns and the remainder; removes the scope markers from `rest`. */
export function scopeFrom(cols, rest, privateUser) {
  const verbatim = Object.hasOwn(rest, 'scope');
  const verbatimScope = rest.scope;
  const none = rest.$noScope === true;
  const dmChannel = rest.dmChannel;
  delete rest.scope;
  delete rest.$noScope;
  delete rest.dmChannel;
  if (verbatim) return verbatimScope;
  if (none) return undefined;
  const scope = {};
  const place = String(cols.place_id ?? '');
  if (privateUser) {
    if (typeof dmChannel === 'string') scope.channel = dmChannel;
  } else if (place.startsWith('discord:channel:')) {
    scope.channel = nativeOf(place);
  } else if (cols.scope_kind === 'group') {
    scope.guild = true;
  }
  if (!privateUser && cols.scope_kind === 'dm') scope.user = dmUserOf(cols);
  return scope;
}
