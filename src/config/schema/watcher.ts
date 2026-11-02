// The settings schema of `watcher` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const WATCHER: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'watcher.enabled',
    'types': ['boolean'],
    'reader': 'src/watcher/settings.ts',
    'default': false,
    'text':
      'Whether the deployment runs the daily watcher, which only `true` turns on. `neptunia setup` asks. While it is off the selfimprovement wake carries no watcher report',
  },
  {
    'key': 'watcher.at',
    'types': ['string'],
    'reader': 'src/watcher/settings.ts',
    'default': '00:00',
    'text':
      "The time of the watcher's daily run, `HH:MM` of the UTC day: the `OnCalendar=` of `neptunia-watcher.timer` that `neptunia setup` renders. A value that is no `HH:MM` reads as the default",
  },
  {
    'key': 'watcher.dir',
    'types': ['string'],
    'reader': 'src/watcher/read.ts',
    'default': '.agents/watcher',
    'text': 'Folder of the daily watcher, `prompt.md` and `reports/`; relative to the checkout or absolute',
  },
];
