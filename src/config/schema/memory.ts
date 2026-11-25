// The settings schema of `memory` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const MEMORY: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'memory.probeMinutes',
    'types': ['number'],
    'reader': 'src/subharness/memory-probe.ts',
    'default': 30,
    'text':
      "Minutes between two probes of each of the persona's core, the analyzer and the memory writer, on the route each runs on: one minimal request on its key or one one-word reply through its harness. The probes also run at core start, and the memory writer's right after a refused writer run. A failed probe pauses the persona with the reason `core-down`, `analyzer-down` or `memory-down`, and the next passing probe of that part resumes them. A value that is no positive number counts as 30",
  },
];
