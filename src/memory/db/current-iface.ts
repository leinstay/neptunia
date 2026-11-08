// The interface the current event or turn belongs to, carried through its awaits. The memory store addresses a member
// by root and native id, which do not name an interface, so one event's work reads and writes under the interface
// that event came from. Set by the core's event door and at the head of each turn. Outside them, on a wake or a
// startup step, the home interface applies.

import { AsyncLocalStorage } from 'node:async_hooks';

const current = new AsyncLocalStorage<string>();

/** Runs `work` with `iface` as the current interface; an unnamed interface leaves the current one. */
export function withIface<TResult>(iface: unknown, work: () => TResult): TResult {
  return typeof iface === 'string' && iface !== '' ? current.run(iface, work) : work();
}

export function currentIface(): string | null {
  return current.getStore() ?? null;
}
