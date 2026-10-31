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
  {
    'key': 'intentions.maxCandidates',
    'types': ['number'],
    'reader': 'src/intentions/service.ts',
    'default': 5,
    'text': 'Max candidates from her lines per batch, and open at once',
  },
  {
    'key': 'intentions.candidateExpiresHours',
    'types': ['number'],
    'reader': 'src/intentions/model.ts',
    'default': 48,
    'text': 'Hours before an unhandled candidate expires',
  },
  {
    'key': 'intentions.waitHours',
    'types': ['number'],
    'reader': 'src/intentions/service.ts',
    'default': 2,
    'text': 'Wait deadline when a wait names none',
  },
  {
    'key': 'intentions.expiryNoticeDays',
    'types': ['number'],
    'reader': 'src/intentions/blocks.ts',
    'default': 2,
    'text': "Days before expiry at which the expiry shows on the intention's line",
  },
];
