// The settings schema of `split` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const SPLIT: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'split.minChars',
    'types': ['number'],
    'reader': 'src/behavior/split.js',
    'default': 80,
    'text': 'Minimum characters before the splitter is asked',
  },
  {
    'key': 'split.maxTasks',
    'types': ['number'],
    'reader': 'src/behavior/split.js',
    'default': 4,
    'text': 'Maximum parts. Below 2 the splitter is off',
  },
  {
    'key': 'split.contextMessages',
    'types': ['number'],
    'reader': 'src/turn/lookup.ts',
    'default': 6,
    'text': 'Recent channel messages for the classifier',
  },
  {
    'key': 'split.maxOutputTokens',
    'types': ['number'],
    'reader': 'src/turn/lookup.ts',
    'default': 300,
    'text': 'Max output tokens',
  },
  {
    'key': 'split.minPartChars',
    'types': ['number'],
    'reader': 'src/behavior/split.js',
    'default': 20,
    'text': 'A part shorter than this is folded into the next. `0` = no folding',
  },
];
