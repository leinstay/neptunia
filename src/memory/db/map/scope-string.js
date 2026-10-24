// The scope of an old record that carries a scope word (`provenance.scope`, a task's `scope`) and the people it
// concerns: 'dm' with exactly one person is that member's DM scope, 'dm' otherwise is internal (never shown
// outward), anything else is group.

import { personId } from '../ids.js';
import { SCOPE_INTERNAL, dmScope, groupScope } from '../scope.js';

export function stringScope(word, people) {
  if (word === 'dm') {
    const ids = [...new Set((people ?? []).filter((id) => typeof id === 'string' && id))];
    return ids.length === 1 ? dmScope(personId(ids[0])) : { ...SCOPE_INTERNAL };
  }
  return groupScope();
}
