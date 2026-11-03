// Shared synthetic account storage and profile values for ownership persistence tests.
import type { StorageKey } from '../../../src/memory/db/storage-keys.ts';
import { accountId, guildPlaceId } from '../../../src/memory/db/ids.ts';

export const a: StorageKey = {
  kind: 'user',
  subject: { type: 'account', id: accountId('discord', 'u1') },
  scopePlaceId: guildPlaceId('discord', 'g1'),
};

export const profile = {
  id: 'u1',
  names: ['Synthetic'],
  details: [{ itemId: 'shared-detail', text: 'likes café mornings' }],
  affinity: { score: 2, reason: 'legacy' },
};
