// The settings schema of `typing` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const TYPING: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'typing.reactionDelayMs',
    'types': ['array'],
    'reader': 'src/turn/act.ts',
    'default': [800, 4000],
    'text': 'Reaction delay range (ms)',
  },
  {
    'key': 'typing.msPerChar',
    'types': ['array'],
    'reader': 'src/behavior/random.js',
    'default': [35, 75],
    'text': 'Per-character typing speed (ms)',
  },
  {
    'key': 'typing.minMs',
    'types': ['number'],
    'reader': 'src/behavior/random.js',
    'default': 900,
    'text': 'Min typing duration (ms)',
  },
  {
    'key': 'typing.maxMs',
    'types': ['number'],
    'reader': 'src/behavior/random.js',
    'default': 12000,
    'text': 'Max typing duration (ms)',
  },
  {
    'key': 'typing.betweenMessagesMs',
    'types': ['array'],
    'reader': 'src/turn/act.ts',
    'default': [700, 3500],
    'text': 'Pause between messages (ms)',
  },
];
