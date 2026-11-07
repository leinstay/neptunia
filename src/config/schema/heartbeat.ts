// The settings schema of `heartbeat` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const HEARTBEAT: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'heartbeat.enabled',
    'types': ['boolean'],
    'reader': 'src/behavior/inner/heartbeat.ts',
    'default': true,
    'text': 'Whether she has a periodic heartbeat wake',
  },
  {
    'key': 'heartbeat.schedule',
    'types': ['string'],
    'reader': 'src/behavior/inner/settings.ts',
    'default': 'every 3h',
    'text':
      'When the heartbeat falls due: `every 3h`, `every 90m` or daily UTC times such as `at 06:00,18:00`. `neptunia services heartbeat setup` writes it, and a value that means nothing reads as the default',
  },
  {
    'key': 'heartbeat.jitterMinutes',
    'types': ['number'],
    'reader': 'src/behavior/inner/heartbeat.ts',
    'default': 60,
    'text': 'Minutes an interval of the heartbeat moves either way; daily times stay exact',
  },
  {
    'key': 'heartbeat.tools',
    'types': ['string', 'array'],
    'reader': 'src/tools/access.ts',
    'default': '*',
    'text': 'The tools a heartbeat wake may call: `"*"` for every granted tool or a list of tool names',
  },
  {
    'key': 'heartbeat.maxActs',
    'types': ['number', 'null'],
    'reader': 'src/tools/access.ts',
    'default': null,
    'text': 'The most actions a heartbeat wake may take; null: no cap',
  },
  {
    'key': 'heartbeat.maxTasks',
    'types': ['number', 'null'],
    'reader': 'src/tools/access.ts',
    'default': null,
    'text': 'The most errands a heartbeat wake may start; null: no cap',
  },
  {
    'key': 'heartbeat.inputTokens',
    'types': ['number', 'null'],
    'reader': 'src/tools/access.ts',
    'default': null,
    'text': 'The input token budget of a heartbeat wake; null: the loop budget',
  },
];
