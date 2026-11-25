// The settings schema of `agents` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const AGENTS: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'agents',
    'types': ['map'],
    'reader': 'src/agent-runner/profiles.ts',
    'default': {},
    'text':
      'Per agent name, `enabled` (the agent is off while it is not `true`, `/agent enable <name>` writes it) and overrides of `limits` and `daily` of `agents/<name>/profile.json`, laid over the profile key by key',
  },
];
