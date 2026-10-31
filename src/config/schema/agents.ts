// The settings schema of `agents` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const AGENTS: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'agents',
    'types': ['map'],
    'reader': 'src/agent-runner/profiles.js',
    'default': {},
    'text':
      'Per agent name, overrides of the settings in `agents/<name>/profile.json`, laid over the profile key by key',
  },
];
