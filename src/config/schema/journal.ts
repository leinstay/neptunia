// The settings schema of `journal` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const JOURNAL: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'journal.thinkChars',
    'types': ['number'],
    'reader': 'src/memory/journal.js',
    'default': 4000,
    'text': 'Characters of her hidden reasoning stored. `0` stores it whole',
  },
  {
    'key': 'journal.keepRequests',
    'types': ['number'],
    'reader': 'src/core.js',
    'default': 3,
    'text': 'Days the request dumps are kept. `0` writes none',
  },
  {
    'key': 'journal.offWindowHours',
    'types': ['number'],
    'reader': 'src/memory/journal.js',
    'default': 24,
    'text': "How far back the journal is read for the persona's time away (`features.offPeriods`)",
  },
];
