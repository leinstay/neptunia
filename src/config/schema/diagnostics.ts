// The settings schema of `diagnostics` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const DIAGNOSTICS: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'diagnostics.loopStallMs',
    'types': ['number'],
    'reader': 'src/loop-watch.ts',
    'default': 1000,
    'text': 'A tick of the event loop watch later than this logs a stall with the operations around it (ms, 0 is off)',
  },
];
