// Shared synthetic account storage and profile values for ownership persistence tests.
import type { UnitKey } from '../../../src/memory/db/unit-keys.ts';
import { accountId, } from '../../../src/memory/db/ids.ts';

export const a: UnitKey = {
  kind: 'user',
  subject: { type: 'account', id: accountId('discord', 'u1') },
};

export const profile = {
  id: 'u1',
  names: ['Synthetic'],
  details: [{ itemId: 'shared-detail', text: 'likes café mornings' }],
  affinity: { score: 2, reason: 'legacy' },
};
