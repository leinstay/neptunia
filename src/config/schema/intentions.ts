// The settings schema of `intentions` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const INTENTIONS: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'intentions.expiresDays',
    'types': ['number'],
    'reader': 'src/behavior/inner/queue.ts',
    'default': 14,
    'text': 'Days before an intention expires',
  },
  {
    'key': 'intentions.recurringExpiresDays',
    'types': ['number'],
    'reader': 'src/intentions/model.ts',
    'default': 30,
    'text': 'Days before a recurring intention expires',
  },
  {
    'key': 'intentions.maxOpen',
    'types': ['number'],
    'reader': 'src/intentions/service.ts',
    'default': 20,
    'text': 'Max intentions open at once',
  },
];
