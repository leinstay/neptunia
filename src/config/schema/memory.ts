// The settings schema of `memory` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const MEMORY: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'memory.probeMinutes',
    'types': ['number'],
    'reader': 'src/subharness/memory-probe.ts',
    'default': 30,
    'text':
      "Minutes between two probes of each of her core, the analyzer and the memory writer, on the route each runs on: one minimal request on its key or one one-word reply through its harness. The probes also run at core start, and the memory writer's right after a refused writer run. A failed probe pauses her with the reason `core-down`, `analyzer-down` or `memory-down`, and the next passing probe of that part resumes her. A value that is no positive number counts as 30",
  },
  {
    'key': 'memory.describeAfterLines',
    'types': ['number'],
    'reader': 'src/memory/db/audit.ts',
    'default': 20,
    'text':
      'The live lines after which the memory audit expects a place to carry `purpose`, `tone` and `topics` (`placeUndescribed`). A value that is no positive whole number counts as 20',
  },
];
