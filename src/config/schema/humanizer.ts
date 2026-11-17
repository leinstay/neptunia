// The settings schema of `humanizer` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const HUMANIZER: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'humanizer.enabled',
    'types': ['boolean'],
    'reader': 'src/behavior/humanizer.ts',
    'default': false,
    'text':
      'Check her text of 40 words or more before it is posted and write it again when the linter finds it reads as composed (see [The humanizer](humanizer.md)). `/humanizer enable` and `/humanizer disable` write it',
  },
];
