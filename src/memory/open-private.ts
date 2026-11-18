// `context.memory.openPrivate`, read from the live config at the moment of use: whether a turn in any place reads what
// she remembers from every direct chat. A read that holds the turn's issued context decides by the context instead
// (scope.ts#readsAll), which the memory service marks from this same setting.

/** Whether `context.memory.openPrivate` is on in `config`; only `true` turns it on. */
export function opensPrivate(config: unknown): boolean {
  const context: unknown = config && typeof config === 'object' ? Reflect.get(config, 'context') : null;
  const memory: unknown = context && typeof context === 'object' ? Reflect.get(context, 'memory') : null;
  return Boolean(memory && typeof memory === 'object' && Reflect.get(memory, 'openPrivate') === true);
}
