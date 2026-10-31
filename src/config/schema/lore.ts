// The settings schema of `lore` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const LORE: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'lore.maxEntries',
    'types': ['number'],
    'reader': 'src/tools/impl/lore.ts',
    'default': 500,
    'text': 'Max lorebook entries per server',
  },
  {
    'key': 'lore.scanMessages',
    'types': ['number'],
    'reader': 'src/turn/request/server.ts',
    'default': 30,
    'text': 'Messages scanned for key matches',
  },
  {
    'key': 'lore.maxMatches',
    'types': ['number'],
    'reader': 'src/memory/lore.js',
    'default': 8,
    'text': 'Max entries shown per request',
  },
  {
    'key': 'lore.textChars',
    'types': ['number'],
    'reader': 'src/memory/lore.js',
    'default': 600,
    'text': 'Lore entry text limit',
  },
];
