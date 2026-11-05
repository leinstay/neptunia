// The settings schema of `mirrors` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const MIRRORS: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'mirrors.claimLeaseMs',
    'types': ['number'],
    'reader': 'src/behavior/mirror.ts',
    'default': 600000,
    'text':
      'How long a claimed selfreflection publication stands with no word from its publisher. Past it the publisher counts as gone and the send as uncertain',
  },
  {
    'key': 'mirrors.sendTimeoutMs',
    'types': ['number'],
    'reader': 'src/behavior/mirror.ts',
    'default': 120000,
    'text':
      'How long one send of a selfreflection publication may take before its result counts as uncertain, at most `mirrors.claimLeaseMs`',
  },
];
