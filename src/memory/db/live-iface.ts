// The interface a write or a read names: the `iface` of an event, a context or a write, else the live interface of the
// service. A write that names none and has no live interface names no interface, and a row's group scope without one
// resolves to the internal audience (scope.ts#audienceOf), so it is never shown outward.

/** The interface a context, a row or a write names (`source[key]`, `iface` by default), or null when it names none. */
export function namedIface(source: unknown, key = 'iface'): string | null {
  const value = (source as Record<string, unknown> | null | undefined)?.[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** The interface a write names, for a writer whose rows spell it in their ids; throws `IFACE_MISSING` when it names none. */
export function requiredIface(source: unknown): string {
  const iface = namedIface(source);
  if (iface === null) throw Object.assign(new Error('IFACE_MISSING'), { code: 'IFACE_MISSING' });
  return iface;
}

/** The interface a live-interface option names: `read()` when `read` is a function that answers a string, else null. */
export function liveIface(read: unknown): string | null {
  return typeof read === 'function' ? namedIface({ iface: (read as () => unknown)() }) : null;
}

/** `update` with the live interface (`liveIface(read)`) as its `iface` when it names none itself. */
export function withLiveIface<T extends object>(update: T, read: unknown): T & { iface?: string } {
  const live = liveIface(read);
  return namedIface(update) === null && live !== null ? { ...update, iface: live } : update;
}
