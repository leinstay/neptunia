// The settings schema of `dm` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const DM: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'dm.enabled',
    'types': ['boolean'],
    'reader': 'src/behavior/private.ts',
    'default': false,
    'text':
      'Answer direct messages from place members. Needs a stored public profile and `affinity.score >= private.minAffinity`',
  },
];
