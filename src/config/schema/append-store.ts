// The settings schema of `appendStore` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const APPEND_STORE: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'appendStore.retryMax',
    'types': ['number'],
    'reader': 'src/core.ts',
    'default': 1000,
    'text': 'Lines kept in memory while the disk refuses writes',
  },
];
