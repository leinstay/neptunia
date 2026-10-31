// The settings schema of `graph` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const GRAPH: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'graph.maxDepth',
    'types': ['number'],
    'reader': 'src/memory/db/graph.js',
    'default': 6,
    'text': 'Edges a walk follows from where it starts',
  },
  {
    'key': 'graph.maxRows',
    'types': ['number'],
    'reader': 'src/memory/db/graph.js',
    'default': 2000,
    'text': 'Paths a walk visits before it stops',
  },
];
