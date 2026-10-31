// The settings schema of `capture` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const CAPTURE: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'capture.ancestors',
    'types': ['number'],
    'reader': 'src/memory/db/observe.js',
    'default': 2,
    'text': 'Reply chain above the anchor line in the first fetch',
  },
  {
    'key': 'capture.before',
    'types': ['number'],
    'reader': 'src/memory/db/observe.js',
    'default': 3,
    'text': 'Lines before the anchor',
  },
  {
    'key': 'capture.after',
    'types': ['number'],
    'reader': 'src/memory/db/observe.js',
    'default': 3,
    'text': 'Lines after the anchor',
  },
  {
    'key': 'capture.pageLines',
    'types': ['number'],
    'reader': 'src/memory/db/observe.js',
    'default': 60,
    'text': 'Lines one expansion writes',
  },
  {
    'key': 'capture.watch',
    'types': ['array'],
    'reader': 'src/memory/db/observe.js',
    'default': [15, 120, 1440],
    'text': 'Minutes after the anchor at which a watch looks again',
  },
  {
    'key': 'capture.watchSameAuthor',
    'types': ['number'],
    'reader': 'src/memory/db/observe.js',
    'default': 20,
    'text': 'Later lines of authors already in the bundle that one watch asks for',
  },
];
