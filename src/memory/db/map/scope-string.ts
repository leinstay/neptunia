// The scope of an old record that carries a scope word (`provenance.scope`, a task's `scope`) and the people it
// concerns: 'dm' with exactly one person is that member's DM scope, 'dm' otherwise is internal (never shown
// outward), anything else is group. The member's DM is the stored one for the platform id, internal when none is stored
// (scope-parts.ts#memberDmOf).

import { LEGACY_IFACE } from '../legacy-namespace.ts';
import { SCOPE_INTERNAL, groupScope, scopeColumns } from '../scope.ts';
import type { DmScope } from '../scope.ts';
import { memberDmOf } from './scope-parts.ts';
import type { MemberReads } from './scope-parts.ts';

export function stringScope(
  word: unknown,
  people: ReadonlyArray<unknown> | null | undefined,
  iface = LEGACY_IFACE,
  members: MemberReads = {}
): DmScope {
  if (word === 'dm') {
    const ids = [...new Set((people ?? []).filter((id): id is string => typeof id === 'string' && id !== ''))];
    return ids.length === 1
      ? scopeColumns(undefined, { privateUser: ids[0], iface, dmOf: memberDmOf(iface, members.dmOfMember) })
      : { ...SCOPE_INTERNAL };
  }
  return groupScope(iface);
}
