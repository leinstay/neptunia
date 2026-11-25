// The settings schema of `embed` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const EMBED: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'embed.dimensions',
    'types': ['number'],
    'reader': 'src/llm/embed.ts',
    'default': 1024,
    'text': 'Dimensions requested from the embedding model',
  },
];
