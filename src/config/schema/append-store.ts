// The settings schema of `appendStore` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const APPEND_STORE: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'appendStore.fsyncMs',
    'types': ['number'],
    'reader': 'src/core.js',
    'default': 500,
    'text': 'Milliseconds before a write is flushed to disk',
  },
  {
    'key': 'appendStore.retryMax',
    'types': ['number'],
    'reader': 'src/core.js',
    'default': 1000,
    'text': 'Lines kept in memory while the disk refuses writes',
  },
];
