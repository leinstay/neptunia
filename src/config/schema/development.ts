// The settings schema of `development` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const DEVELOPMENT: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'development.thinkerTurns',
    'types': ['number'],
    'reader': 'src/development/settings.ts',
    'default': 12,
    'text':
      "The most thinker turns on one task. Past it the task blocks with that reason, and her unblock or the owner's gives it new turns",
  },
  {
    'key': 'development.lookEveryMs',
    'types': ['number'],
    'reader': 'src/development/settings.ts',
    'default': 120000,
    'text':
      'How often the development worker looks at GitHub while a pull request is watched, in milliseconds, at least 10000. With none watched it waits for board events and sets no clock',
  },
  {
    'key': 'development.startedAt',
    'types': ['string', 'null'],
    'reader': 'src/development/settings.ts',
    'default': null,
    'text':
      'The moment the development worker first started, an ISO time it writes itself. A task approved before it waits for the owner: `neptunia worker development held` lists them, and `neptunia tasks update <id> --meta admitted=yes` lets one run',
  },
];
