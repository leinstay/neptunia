// The settings schema of `archive` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const ARCHIVE: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'archive.drainMs',
    'types': ['number'],
    'reader': 'src/core.js',
    'default': 30000,
    'text': 'How often pending copies are retried (ms)',
  },
  {
    'key': 'archive.holdMaxMs',
    'types': ['number'],
    'reader': 'src/core.js',
    'default': 5000,
    'text': 'How long the bot waits on shutdown for an archive write (ms)',
  },
];
