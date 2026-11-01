// The scope of an old record that carries a scope word (`provenance.scope`, a task's `scope`) and the people it
// concerns: 'dm' with exactly one person is that member's DM scope, 'dm' otherwise is internal (never shown
// outward), anything else is group.

import { personId } from '../ids.ts';
import { LEGACY_IFACE } from '../legacy-namespace.ts';
import { SCOPE_INTERNAL, dmScope, groupScope } from '../scope.ts';
import type { Scope } from '../scope.ts';

export function stringScope(
  word: unknown,
  people: ReadonlyArray<unknown> | null | undefined,
  iface = LEGACY_IFACE
): Scope {
  if (word === 'dm') {
    const ids = [...new Set((people ?? []).filter((id): id is string => typeof id === 'string' && id !== ''))];
    return ids.length === 1 ? dmScope(personId(iface, ids[0]), iface) : { ...SCOPE_INTERNAL };
  }
  return groupScope(iface);
}
