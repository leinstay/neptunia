// The settings schema of `mention` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const ADDRESS: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'address.attentionMinutes',
    'types': ['number'],
    'reader': 'src/pipeline/address-attention.ts',
    'default': 15,
    'text':
      'Minutes after her post in a place during which an unflagged line there goes to the address classifier, and the window of the per-author rail. `0` sends only flagged lines and leaves the rail nothing to count',
  },
  {
    'key': 'address.maxTurnsPerAuthor',
    'types': ['number'],
    'reader': 'src/pipeline/answer.ts',
    'default': 50,
    'text':
      'Started turns of one author in one place within the window before the next is refused. `0` turns the rail off',
  },
];

export const MENTION: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'mention.neverIgnore',
    'types': ['array'],
    'reader': 'src/pipeline/answer.ts',
    'default': [],
    'text': 'User IDs the per-author rail never refuses',
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
    'reader': 'src/behavior/pending.ts',
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
