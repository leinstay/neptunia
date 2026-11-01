// The settings schema of `split` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const SPLIT: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'split.maxOutputTokens',
    'types': ['number'],
    'reader': 'src/turn/lookup.ts',
    'default': 300,
    'text': 'Max output tokens',
  },
];
