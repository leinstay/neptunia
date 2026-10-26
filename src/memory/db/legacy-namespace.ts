// The interface namespace of every row written before the memory database took its interface from the event: the
// Discord spelling (`person:discord:<id>`, `discord:channel:<id>`, `src:discord:<message>`, `discord/global`). The
// importer of the legacy JSON files, the readers of those spellings and the frozen migrations name it through this one
// module. Live code takes the interface from the event's `iface` and never from here.

/** The namespace of the legacy record files and of every id the importer wrote. */
export const LEGACY_IFACE = 'discord';

/** The interface a context, a row or a unit write names (`source[key]`, `iface` by default), or null when it names none. */
export function namedIface(source: unknown, key = 'iface'): string | null {
  const value = (source as Record<string, unknown> | null | undefined)?.[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** `namedIface`, the legacy namespace when the source names none: what the record files and old rows are read in. */
export function ifaceOrLegacy(source: unknown, key = 'iface'): string {
  return namedIface(source, key) ?? LEGACY_IFACE;
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
