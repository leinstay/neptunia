// The settings schema of `mention` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const MENTION: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'mention.neverIgnore',
    'types': ['array'],
    'reader': 'src/pipeline/answer.ts',
    'default': [],
    'text': 'User IDs never ignored',
  },
  {
    'key': 'mention.pendingMinutes',
    'types': ['number'],
    'reader': 'src/pipeline/drain.ts',
    'default': 10,
    'text': 'Minutes before a held ping expires',
  },
  {
    'key': 'mention.maxPending',
    'types': ['number'],
    'reader': 'src/behavior/pending.js',
    'default': 6,
    'text': 'Total pending calls held across all channels',
  },
  {
    'key': 'mention.followUpMaxOutputTokens',
    'types': ['number'],
    'reader': 'src/pipeline/merge.ts',
    'default': 2000,
    'text': 'Max output tokens for the address classifier',
  },
];
