// Which interface answers a read of a community. A community id is native to its interface, so two interfaces may name
// the same one: each interface's communities are kept by interface, and neither hello order nor a reconnect moves them.
// A read inside an event or a turn goes to that event's interface when it serves the community. Any other read, a wake
// or a read across interfaces, goes to the first interface serving it whose link is up. Called by src/core.ts.

export type CommunityRoutes = {
  /** Records what an interface's `hello` says it serves. A later hello of the same interface replaces its list. */
  note(iface: string, communities: ReadonlyArray<string>): void;
  isServed(communityId: string): boolean;
  communitiesOf(iface: string): Array<string>;
  /** The interface that answers a read of `communityId`, null when none serves it or every link serving it is down. */
  ifaceOf(communityId: string, isUp: (iface: string) => boolean): string | null;
  /** Every community some interface says it serves, with that interface. */
  servedList(): Array<{ iface: string; communityId: string }>;
  /** The community of the current event's interface; outside an event, the first any interface serves. */
  inScope(): string | null;
};

export function createCommunityRoutes({ current }: { current: () => string | null }): CommunityRoutes {
  const served = new Map<string, ReadonlySet<string>>();
  const servingOf = (communityId: string): Array<string> =>
    [...served].filter(([, communities]) => communities.has(communityId)).map(([iface]) => iface);
  return {
    note(iface, communities) {
      served.set(iface, new Set(communities));
    },
    isServed: (communityId) => servingOf(communityId).length > 0,
    communitiesOf: (iface) => [...(served.get(iface) ?? [])],
    ifaceOf(communityId, isUp) {
      const serving = servingOf(communityId);
      const own = current();
      if (own !== null && serving.includes(own)) return own;
      return serving.find(isUp) ?? null;
    },
    servedList: () =>
      [...served].flatMap(([iface, communities]) => [...communities].map((communityId) => ({ iface, communityId }))),
    inScope() {
      const own = current();
      const ofOwn = own === null ? undefined : served.get(own);
      if (ofOwn) return [...ofOwn][0] ?? null;
      return [...served.values()].flatMap((communities) => [...communities])[0] ?? null;
    },
  };
}
