// The settings schema of `offlineCatchUp` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const OFFLINE_CATCH_UP: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'offlineCatchUp.windowMinutes',
    'types': ['number'],
    'reader': 'src/behavior/catch-up.js',
    'default': 15,
    'text': 'Only a call younger than this is answered. `0` answers none',
  },
  {
    'key': 'offlineCatchUp.maxMessages',
    'types': ['number'],
    'reader': 'src/behavior/catch-up.js',
    'default': 50,
    'text': 'Newest messages fetched per channel (1 to 100)',
  },
];
