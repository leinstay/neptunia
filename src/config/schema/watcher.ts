// The settings schema of `watcher` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const WATCHER: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'watcher.enabled',
    'types': ['boolean'],
    'reader': 'src/watcher/settings.ts',
    'default': false,
    'text':
      'Whether the deployment runs the watcher, which only `true` turns on. `neptunia service watcher enable` and `disable` move it with the timer. While it is off the selfimprovement wake carries no watcher report',
  },
  {
    'key': 'watcher.schedule',
    'types': ['string'],
    'reader': 'src/watcher/settings.ts',
    'default': 'at 00:00',
    'text':
      'When the watcher runs: daily UTC times such as `at 00:00,12:00`, or `every 6h`. `neptunia service watcher setup` writes it and renders `neptunia-watcher.timer`, and a value that means nothing reads as the default',
  },
];
