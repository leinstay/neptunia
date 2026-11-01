// The settings schema of `route` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const ROUTE: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'route.maxOutputTokens',
    'types': ['number'],
    'reader': 'src/behavior/route-channel.ts',
    'default': 120,
    'text': 'Max output tokens',
  },
];
