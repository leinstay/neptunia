// Which interface answers a read of a root. A root id is native to its interface, so two interfaces may name
// the same one: each interface's roots are kept by interface, and neither hello order nor a reconnect moves them.
// A read inside an event or a turn goes to that event's interface when it serves the root. Any other read, a wake
// or a read across interfaces, goes to the first interface serving it whose link is up. Called by src/core.ts.

export type RootRoutes = {
  /** Records what an interface's `hello` says it serves. A later hello of the same interface replaces its list. */
  note(iface: string, roots: ReadonlyArray<string>): void;
  isServed(nativeId: string): boolean;
  rootsOf(iface: string): Array<string>;
  /** The interface that answers a read of `nativeId`, null when none serves it or every link serving it is down. */
  ifaceOf(nativeId: string, isUp: (iface: string) => boolean): string | null;
  /** Every root some interface says it serves, with that interface. */
  servedList(): Array<{ iface: string; nativeId: string }>;
};

export function createRootRoutes({ current }: { current: () => string | null }): RootRoutes {
  const served = new Map<string, ReadonlySet<string>>();
  const servingOf = (nativeId: string): Array<string> =>
    [...served].filter(([, roots]) => roots.has(nativeId)).map(([iface]) => iface);
  return {
    note(iface, roots) {
      served.set(iface, new Set(roots));
    },
    isServed: (nativeId) => servingOf(nativeId).length > 0,
    rootsOf: (iface) => [...(served.get(iface) ?? [])],
    ifaceOf(nativeId, isUp) {
      const serving = servingOf(nativeId);
      const own = current();
      if (own !== null && serving.includes(own)) return own;
      return serving.find(isUp) ?? null;
    },
    servedList: () => [...served].flatMap(([iface, roots]) => [...roots].map((nativeId) => ({ iface, nativeId }))),
  };
}
