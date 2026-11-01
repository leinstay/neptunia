// The settings schema of `participation` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const PARTICIPATION: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'participation.maxOutputTokens',
    'types': ['number'],
    'reader': 'src/behavior/participation-pick.ts',
    'default': 60,
    'text': 'Max output tokens for the pick classifier',
  },
  {
    'key': 'participation.pickTimeoutMs',
    'types': ['number', 'null'],
    'reader': 'src/behavior/participation-pick.ts',
    'default': 1500,
    'text': 'How long the turn waits for the pick (ms). `null` waits indefinitely',
  },
];
