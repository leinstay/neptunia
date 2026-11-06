// The settings schema of `spatial` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const SPATIAL: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'spatial.notes',
    'types': ['map'],
    'reader': 'src/turn/request/head.ts',
    'default': {},
    'text':
      "The owner's note on a place, by stored place id, shown in `<spatial_awareness>` of every turn in that place and in every place under it; the nearest place with a note wins. See [Prompt contract](prompt-contract.md)",
  },
];
