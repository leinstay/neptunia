// The settings schema of `private` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const PRIVATE: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'private.likeServer',
    'types': ['boolean'],
    'reader': 'src/turn/lookup.ts',
    'default': true,
    'text':
      'A private chat works like a server channel: route classifier, channel pull, server search, asked-about episodes. `false`: a private chat has none of them',
  },
  {
    'key': 'private.minAffinity',
    'types': ['number'],
    'reader': 'src/behavior/private.ts',
    'default': 5,
    'text': 'Minimum public attitude score to answer a DM; owners bypass this',
  },
];
