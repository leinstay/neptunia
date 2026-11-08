// The members of each root as an interface reported them through `membership.changed`: the core reads the name
// a member goes by here (the persona's own display name in every request, the names the embedding queue shows), and
// whether the member is a bot (the reactors named on her lines), never from a platform object. A nickname change
// arrives as an `updated` change and replaces the name at once; a member who left is forgotten. Names are kept per
// root, so one member of two roots has two names.

import type { MembershipChanged } from '../protocol/events.ts';

export function createMemberDirectory(): {
  apply(event: MembershipChanged): void;
  nameOf(placeId: string, accountId: string): string | null;
  infoOf(placeId: string, accountId: string): { name: string; bot: boolean } | null;
  /** Every member of the root the directory holds, with the id. */
  list(placeId: string): Array<{ id: string; name: string; bot: boolean }>;
} {
  const roots = new Map<string, Map<string, { name: string; bot: boolean }>>();
  return {
    apply(event) {
      const { placeId, accountId } = event;
      if (event.change === 'left') {
        roots.get(placeId)?.delete(accountId);
        return;
      }
      const name = event.member?.name;
      if (typeof name !== 'string' || name === '') return;
      let members = roots.get(placeId);
      if (members === undefined) {
        members = new Map();
        roots.set(placeId, members);
      }
      members.set(accountId, { name, bot: event.member?.bot === true });
    },
    nameOf: (placeId, accountId) => roots.get(placeId)?.get(accountId)?.name ?? null,
    infoOf: (placeId, accountId) => roots.get(placeId)?.get(accountId) ?? null,
    list: (placeId) => [...(roots.get(placeId) ?? [])].map(([id, member]) => ({ id, ...member })),
  };
}
