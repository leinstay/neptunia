// The neutral addresses of a place and an account: the interface, the authority inside it that issued the native id, and
// the native id, with the generation for an account (a reused native id is a new generation). Equal native ids stay
// apart until the owner links them. A key is a structured tuple, so no character inside a native id can forge another
// address. Plain data with no platform in it: the memory database and the core read these, and an interface may declare
// its authority on a chat (events.ts).

export type AccountAddress = { interfaceId: string; authorityId: string; nativeId: string; generation: number };

/** The core's own namespace (`person:self`, rows with no interface). */
export const CORE_AUTHORITY = 'core/local';

/** The native authority of an interface: `<iface>/local` for the command line and the core, `<iface>/global` for any other interface until it declares its own. */
export function nativeAuthorityOf(iface: unknown): string {
  if (typeof iface !== 'string' || !iface) return CORE_AUTHORITY;
  if (iface === 'cli' || iface === 'core') return `${iface}/local`;
  return `${iface}/global`;
}
