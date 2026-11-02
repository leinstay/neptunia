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
];
