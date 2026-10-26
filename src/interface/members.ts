// The members of each community as an interface reported them through `membership.changed`: the core reads the name
// a member goes by here (the persona's own display name in every request, the names the embedding queue shows),
// never from a platform object. A nickname change arrives as an `updated` change and replaces the name at once; a
// member who left is forgotten. Names are kept per community, so one member of two communities has two names.

import type { MembershipChanged } from '../protocol/events.js';

export function createMemberDirectory(): {
  apply(event: MembershipChanged): void;
  nameOf(communityId: string, userId: string): string | null;
} {
  const communities = new Map<string, Map<string, string>>();
  return {
    apply(event) {
      const { communityId, userId } = event;
      if (event.change === 'left') {
        communities.get(communityId)?.delete(userId);
        return;
      }
      const name = event.member?.name;
      if (typeof name !== 'string' || name === '') return;
      let members = communities.get(communityId);
      if (members === undefined) {
        members = new Map();
        communities.set(communityId, members);
      }
      members.set(userId, name);
    },
    nameOf: (communityId, userId) => communities.get(communityId)?.get(userId) ?? null,
  };
}
