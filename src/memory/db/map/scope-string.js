// The scope of an old record that carries a scope word (`provenance.scope`, a task's `scope`) and the people it
// concerns: 'dm' with exactly one person is that member's DM scope, 'dm' otherwise is internal (never shown
// outward), anything else is group.

import { personId } from '../ids.ts';
import { LEGACY_IFACE } from '../legacy-namespace.ts';
import { SCOPE_INTERNAL, dmScope, groupScope } from '../scope.ts';

export function stringScope(word, people, iface = LEGACY_IFACE) {
  if (word === 'dm') {
    const ids = [...new Set((people ?? []).filter((id) => typeof id === 'string' && id))];
    return ids.length === 1 ? dmScope(personId(iface, ids[0]), iface) : { ...SCOPE_INTERNAL };
  }
  return groupScope(iface);
}
