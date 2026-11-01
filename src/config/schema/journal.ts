// The settings schema of `journal` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const JOURNAL: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'journal.keepRequests',
    'types': ['number'],
    'reader': 'src/core.js',
    'default': 3,
    'text': 'Days the request dumps are kept. `0` writes none',
  },
];
