// The settings schema of `private` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const PRIVATE: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'private.minAffinity',
    'types': ['number'],
    'reader': 'src/behavior/private.js',
    'default': 5,
    'text': 'Minimum public attitude score to answer a DM; owners bypass this',
  },
  {
    'key': 'private.maxPerUserPerDay',
    'types': ['number'],
    'reader': 'src/behavior/private.js',
    'default': 20,
    'text': 'DM turns per member per day',
  },
  {
    'key': 'private.maxPerOwnerPerDay',
    'types': ['number'],
    'reader': 'src/behavior/private.js',
    'default': 200,
    'text': 'DM turns per day for owners',
  },
];
