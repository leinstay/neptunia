// The settings schema of `memory` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const MEMORY: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'memory.vaultDir',
    'types': ['string'],
    'reader': 'src/memory/root.ts',
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
  {
    'key': 'memory.probeMinutes',
    'types': ['number'],
    'reader': 'src/subharness/memory-probe.ts',
    'default': 30,
    'text':
      "Minutes between two probes of the memory writer's path, one minimal request on the memory key or one one-word reply through the subharness. The probe also runs at core start and right after a refused writer run. A failed probe pauses her with the reason `memory-down`, and the next passing one resumes her. A value that is no positive number counts as 30",
  },
];
