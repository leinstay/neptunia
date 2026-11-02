// The settings schema of `watcher` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const WATCHER: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'watcher.dir',
    'types': ['string'],
    'reader': 'src/watcher/read.ts',
    'default': '.agents/watcher',
    'text': 'Folder of the daily watcher, `prompt.md` and `reports/`; relative to the checkout or absolute',
  },
];
