// The settings schema of `memory` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const MEMORY: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'memory.vaultDir',
    'types': ['string'],
    'reader': 'src/memory/root.js',
    'default': 'vault',
    'text':
      'Directory under `data/` that an older install may have used for copies of deleted memory. Nothing in the engine writes here now; the setting tells `memory.snapshot` where to find it so the vault is skipped when copying',
  },
  {
    'key': 'memory.mainChannelIds',
    'types': ['array'],
    'reader': 'src/behavior/elsewhere.ts',
    'default': [],
    'text':
      'Channels where people talk to each other; used for character/style portraits and as the destination for calls from read-only channels. Empty means every channel counts',
  },
];
