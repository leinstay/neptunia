// `context.memory.openPrivate`, read from the live config at the moment of use: whether a turn in any place reads what
// she remembers from every direct chat. A read that holds the turn's issued context decides by the context instead
// (scope.ts#readsAll), which the memory service marks from this same setting.

import { groupsContext, internalContext } from './db/scope.ts';
import type { Context } from './db/scope.ts';

/** Whether `context.memory.openPrivate` is on in `config`; only `true` turns it on. */
export function opensPrivate(config: unknown): boolean {
  const context: unknown = config && typeof config === 'object' ? Reflect.get(config, 'context') : null;
  const memory: unknown = context && typeof context === 'object' ? Reflect.get(context, 'memory') : null;
  return Boolean(memory && typeof memory === 'object' && Reflect.get(memory, 'openPrivate') === true);
}

/** The read context of the diary's stored facts: the groups', or every audience with `context.memory.openPrivate`. */
export function diaryReadContext(config: unknown): Context {
  return opensPrivate(config) ? internalContext() : groupsContext();
}
