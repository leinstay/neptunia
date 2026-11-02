// The settings schema of `selfdev` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const SELFDEV: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'selfdev.mode',
    'types': ['string'],
    'reader': 'src/selfdev/settings.ts',
    'default': 'approve',
    'text':
      'Who merges a pull request she opened for her own code: `approve` waits for the owner once CI is green, `auto` has the engine merge it when CI is green',
  },
  {
    'key': 'selfdev.base',
    'types': ['string'],
    'reader': 'src/selfdev/settings.ts',
    'default': 'main',
    'text': 'The branch her worktrees start from and her pull requests target',
  },
  {
    'key': 'selfdev.checkout',
    'types': ['string', 'null'],
    'reader': 'src/setup/run.ts',
    'default': null,
    'text':
      'The absolute path of the dev checkout that `neptunia setup` renders `neptunia-selfdev.service` and its timer over, so the beat works there. Setup renders no selfdev units while it is unset, relative or the deployed checkout itself',
  },
  {
    'key': 'selfdev.repository',
    'types': ['string', 'null'],
    'reader': 'src/selfdev/settings.ts',
    'default': null,
    'text':
      'The repository her pull requests open against and her branches are pushed to, as `owner/name`. `neptunia setup` asks for it and stores it only when her gh login can push there. While it is unset every selfdev beat pauses',
  },
];
