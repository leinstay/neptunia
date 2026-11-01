// The settings schema of `missed` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const MISSED: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'missed.expireMinutes',
    'types': ['number'],
    'reader': 'src/behavior/missed.ts',
    'default': 5,
    'text': 'Minutes before a candidate expires. A question mark uses `questionExpireMinutes`',
  },
  {
    'key': 'missed.maxOutputTokens',
    'types': ['number'],
    'reader': 'src/behavior/missed.ts',
    'default': 2000,
    'text': 'Max output tokens for the analyzer',
  },
];
