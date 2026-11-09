// The settings schema of `watcher` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const WATCHER: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'watcher.degradedAfterMinutes',
    'types': ['number'],
    'reader': 'src/watcher/settings.ts',
    'default': 60,
    'text':
      'Minutes a route of the core may stay down before `services watcher evidence` lists it under `routes`: the engine proxy, the YouTube check and a harness login, read from the core journal',
  },
];
