// The settings schema of `private` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const PRIVATE: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'private.enabled',
    'types': ['boolean'],
    'reader': 'src/behavior/private.js',
    'default': false,
    'text':
      'Answer direct messages from guild members. Needs a stored public profile and `affinity.score >= private.minAffinity`',
  },
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
    'reader': 'src/behavior/private.js',
    'default': 5,
    'text': 'Minimum public attitude score to answer a DM; owners bypass this',
  },
];
