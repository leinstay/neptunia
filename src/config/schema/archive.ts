// The settings schema of `archive` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const ARCHIVE: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'archive.drainMs',
    'types': ['number'],
    'reader': 'src/core.ts',
    'default': 30000,
    'text': 'How often pending copies are retried (ms)',
  },
];
